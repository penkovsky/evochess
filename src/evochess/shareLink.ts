/**
 * Share links: a whole EvoChess position in a `?p=` query parameter.
 *
 * This is the position-only subset of `docs/share-links-spec.md`. The wire
 * format is v1's, unchanged: a payload produced here is byte-identical to what
 * a full v1 encoder produces for the same position with `history = absent` and
 * `extras = absent`.
 *
 *   +---------+---------+------------------------+----------+
 *   | version | flags   | position bitstream     | CRC-16   |
 *   | 1 byte  | 1 byte  | variable, byte-padded  | 2 bytes  |
 *   +---------+---------+------------------------+----------+
 *
 * What is deliberately missing is the history block (spec §4.4) and the extras
 * block (§4.5). The encoder writes flags `0x00`. The decoder *refuses* a
 * payload that claims history (rendering the base position of a game link would
 * misrepresent the link rather than fail it) but *skips* an extras block, so a
 * link written by a later encoder still opens here, just without the sharer's
 * view preferences.
 *
 * Pure functions: no DOM, no `localStorage`, no logging. The caller decides
 * what to do with a failure and what to log (see `App.tsx`).
 */
import type { Color, PieceSymbol, Square } from "chess.js";
import { EvoChessGame, ROOK_CHARGES, type EvolvedEnPassant } from "./game";

/** Version byte. Bump on any encoding change *and* on any rules change that
 *  alters what the encoded fields mean (spec §4.1). */
export const SHARE_VERSION = 0x01;

/** The query parameter carrying the payload (spec §3). */
export const SHARE_PARAM = "p";

/**
 * Decoder-side length cap (spec §7). `?p=` is entirely attacker-controlled, so
 * an over-long value is refused before any base64 or bit parsing runs. Set
 * independently of the encoder's own limit and deliberately generous: a
 * position-only payload is ~36 characters, and even a full 1000-ply history
 * link stays inside the ~2 kB every browser handles.
 */
export const MAX_SHARE_PARAM_CHARS = 4096;

// ---------------------------------------------------------------- results

/** Why a payload could not be turned into a board at all (spec §5.1). */
export type ShareStructuralCode =
  | "TOO_LONG"
  | "BAD_BASE64"
  | "TOO_SHORT"
  | "BAD_CRC"
  | "BAD_VERSION"
  | "HISTORY_UNSUPPORTED"
  | "RESERVED_FLAG"
  | "BITSTREAM_TRUNCATED"
  | "PADDING_NOT_ZERO"
  | "TRAILING_BYTES"
  | "BAD_PIECE_CODE"
  | "BAD_ROOK_CHARGES"
  | "BAD_PROGRESS"
  | "BAD_RIGHTS"
  | "BAD_EP_TAG"
  | "BAD_HALFMOVE"
  | "BAD_FULLMOVE";

/** Why a decoded position could not have occurred (spec §5.2). */
export type ShareLegalityCode =
  | "NO_WHITE_KING"
  | "NO_BLACK_KING"
  | "TWO_WHITE_KINGS"
  | "TWO_BLACK_KINGS"
  | "PAWN_ON_RANK_1"
  | "PAWN_ON_RANK_8"
  | "TOO_MANY_WHITE_PIECES"
  | "TOO_MANY_BLACK_PIECES"
  | "SIDE_NOT_TO_MOVE_IN_CHECK"
  | "EP_SKIPPED_NOT_EMPTY"
  | "EP_ORIGIN_NOT_EMPTY"
  | "EP_VICTIM_NOT_PAWN"
  | "EP_VICTIM_IS_PAWN"
  | "EP_VICTIM_MISSING";

export interface ShareDecodeSuccess {
  ok: true;
  /** The shared position, ready to play from. */
  game: EvoChessGame;
  /** False when the position could not have occurred (spec §5.2). The board is
   *  still rendered, but engine search must be disabled for it. */
  legal: boolean;
  /** Empty when `legal`. Worth logging verbatim: a report of "the link is
   *  weird" is then diagnosable from a screenshot of the console. */
  reasons: ShareLegalityCode[];
  /** True when the payload carried an extras block that was skipped. */
  extrasSkipped: boolean;
}

export interface ShareDecodeFailure {
  ok: false;
  code: ShareStructuralCode;
  /** User-facing text. Three distinct messages: a different version, a newer
   *  version needed, and an incomplete link. */
  message: string;
}

export type ShareDecodeResult = ShareDecodeSuccess | ShareDecodeFailure;

const MESSAGE_INCOMPLETE =
  "This link looks incomplete or was created with a different version of EvoChess.";
const MESSAGE_OTHER_VERSION = "This link was created with a different version of EvoChess.";
const MESSAGE_NEWER_VERSION = "This link needs a newer version of EvoChess.";

function fail(code: ShareStructuralCode): ShareDecodeFailure {
  const message =
    code === "BAD_VERSION"
      ? MESSAGE_OTHER_VERSION
      : code === "HISTORY_UNSUPPORTED"
      ? MESSAGE_NEWER_VERSION
      : MESSAGE_INCOMPLETE;
  return { ok: false, code, message };
}

/** Thrown by the encoder for a position it cannot represent. */
export class ShareEncodeError extends Error {}

// ------------------------------------------------------------ bit plumbing

/** MSB-first bit writer, zero-padded to a byte boundary on `finish()`. */
class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private filled = 0;

  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((value >>> i) & 1);
      if (++this.filled === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.filled = 0;
      }
    }
  }

  finish(): Uint8Array {
    if (this.filled > 0) this.bytes.push(this.cur << (8 - this.filled));
    this.cur = 0;
    this.filled = 0;
    return Uint8Array.from(this.bytes);
  }
}

/** MSB-first bit reader. `read` returns null once the stream is exhausted, so
 *  a truncated payload fails rather than reading zeros off the end. */
class BitReader {
  private pos = 0;
  private readonly bytes: Uint8Array;
  private readonly limit: number;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.limit = bytes.length * 8;
  }

  read(bits: number): number | null {
    if (this.pos + bits > this.limit) return null;
    let value = 0;
    for (let i = 0; i < bits; i++) {
      const byte = this.bytes[this.pos >> 3];
      value = (value << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return value;
  }

  get remaining(): number {
    return this.limit - this.pos;
  }

  /** Every bit left is zero — spec §5.1's canonical-encoding requirement. */
  restIsZero(): boolean {
    while (this.remaining > 0) {
      if (this.read(1) !== 0) return false;
    }
    return true;
  }
}

/** CRC-16/CCITT-FALSE: polynomial 0x1021, init 0xFFFF (spec §4.6). */
export function crc16Ccitt(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// Hand-rolled rather than btoa/Buffer: this runs in the browser, in a worker,
// and under vitest, and the base64url alphabet needs a translation step in
// every one of them anyway.
const B64URL_INDEX: Record<string, number> = {};
for (let i = 0; i < B64URL.length; i++) B64URL_INDEX[B64URL[i]] = i;

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes.length - i;
    const b0 = bytes[i];
    const b1 = n > 1 ? bytes[i + 1] : 0;
    const b2 = n > 2 ? bytes[i + 2] : 0;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (n > 1) out += B64URL[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (n > 2) out += B64URL[b2 & 0x3f];
  }
  return out;
}

/** null on any character outside the alphabet, an impossible length, or
 *  non-zero bits in the final character (which would make two strings decode
 *  to the same bytes). */
export function fromBase64Url(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let acc = 0;
  let accBits = 0;
  let o = 0;
  for (const ch of s) {
    const v = B64URL_INDEX[ch];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    accBits += 6;
    if (accBits >= 8) {
      accBits -= 8;
      out[o++] = (acc >> accBits) & 0xff;
    }
  }
  if (accBits > 0 && (acc & ((1 << accBits) - 1)) !== 0) return null;
  return out.subarray(0, o);
}

// --------------------------------------------------------- position fields

/** Piece nibble codes, spec §4.3 step 2. White 0-5, black 6-11. */
const PIECE_ORDER: PieceSymbol[] = ["p", "n", "b", "r", "q", "k"];

function pieceCode(type: PieceSymbol, color: Color): number {
  return PIECE_ORDER.indexOf(type) + (color === "w" ? 0 : 6);
}

/** Square index a1 = 0 … h8 = 63, matching `nameToSq` in `evoBitboard.ts`. */
function squareIndex(sq: Square): number {
  return (Number(sq[1]) - 1) * 8 + (sq.charCodeAt(0) - 97);
}

function squareName(index: number): Square {
  return `${String.fromCharCode(97 + (index & 7))}${(index >> 3) + 1}` as Square;
}

/** chess.js's internal 0x88 index, recomputed on decode rather than trusted
 *  from the URL (spec §4.3 step 7). */
function ox88Index(sq: Square): number {
  const file = sq.charCodeAt(0) - 97;
  const rank = Number(sq[1]);
  return (8 - rank) * 16 + file;
}

interface BoardPiece {
  index: number;
  type: PieceSymbol;
  color: Color;
}

/** A rights counter: 4 bits, with `15` escaping to a following 8-bit value. */
function writeRights(w: BitWriter, value: number, what: string): void {
  if (value < 0 || value > 255 || !Number.isInteger(value)) {
    throw new ShareEncodeError(`${what} out of range: ${value}`);
  }
  if (value < 15) {
    w.write(value, 4);
  } else {
    w.write(15, 4);
    w.write(value, 8);
  }
}

/**
 * `null` for a truncated stream, a code for a value the format cannot mean.
 *
 * A value below 15 in the escape is rejected rather than accepted, because it
 * fits in the 4-bit field and so would be a second encoding of the same count.
 * The encoder never writes one. Allowing it would leave the format canonical in
 * one place and not another: §5.1 rejects non-zero padding on the grounds that
 * one position has exactly one payload, and that is what makes a byte-length or
 * fixture assertion mean anything.
 */
function readRights(r: BitReader): number | { code: ShareStructuralCode } | null {
  const v = r.read(4);
  if (v === null) return null;
  if (v !== 15) return v;
  const escaped = r.read(8);
  if (escaped === null) return null;
  if (escaped < 15) return { code: "BAD_RIGHTS" };
  return escaped;
}

// ------------------------------------------------------------------ encode

/**
 * Encode a position as a `?p=` value: base64url, no padding. The move log is
 * not carried (there is no history block), so the recipient gets the position
 * and nothing about how it was reached.
 *
 * Throws `ShareEncodeError` for a position the format cannot represent.
 */
export function encodeShareLink(game: EvoChessGame): string {
  const chess = game.chess;
  const fields = chess.fen().split(" ");
  const turn: Color = chess.turn();
  const epField = fields[3];
  const halfmove = Number(fields[4]);
  const fullmove = Number(fields[5]);

  const pieces: BoardPiece[] = [];
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq) continue;
      pieces.push({ index: squareIndex(sq.square), type: sq.type, color: sq.color });
    }
  }
  pieces.sort((a, b) => a.index - b.index);

  const w = new BitWriter();

  // 1. occupancy, 64 bits
  const occupied = new Set(pieces.map((p) => p.index));
  for (let i = 0; i < 64; i++) w.write(occupied.has(i) ? 1 : 0, 1);

  // 2. piece nibbles, ascending square index
  for (const p of pieces) w.write(pieceCode(p.type, p.color), 4);

  // 3. rook charges, 3 bits per rook. A rook with no map entry is treated as
  //    fully charged (`game.ts`), and any entry no rook stands on is stale and
  //    dropped here — that is what makes the per-rook encoding lossless.
  for (const p of pieces) {
    if (p.type !== "r") continue;
    const charges = game.rookCharges.get(squareName(p.index)) ?? ROOK_CHARGES;
    if (!Number.isInteger(charges) || charges < 1 || charges > 5) {
      throw new ShareEncodeError(`rook charges out of range on ${squareName(p.index)}: ${charges}`);
    }
    w.write(charges, 3);
  }

  // 4. rook-locked bits, 1 bit per knight or bishop
  for (const p of pieces) {
    if (p.type !== "n" && p.type !== "b") continue;
    w.write(game.rookLocked.has(squareName(p.index)) ? 1 : 0, 1);
  }

  // 5. side to move
  w.write(turn === "w" ? 0 : 1, 1);

  // 6. evolution counters
  for (const value of [
    game.pawnMoveProgress.w,
    game.pawnMoveProgress.b,
    game.minorMoveProgress.w,
    game.minorMoveProgress.b,
  ]) {
    if (!Number.isInteger(value) || value < 0 || value > 2) {
      throw new ShareEncodeError(`move progress out of range: ${value}`);
    }
    w.write(value, 2);
  }
  writeRights(w, game.minorRights.w, "minorRights.w");
  writeRights(w, game.minorRights.b, "minorRights.b");
  writeRights(w, game.rookRights.w, "rookRights.w");
  writeRights(w, game.rookRights.b, "rookRights.b");

  // 7. en passant tag. A standard and an evolved opportunity can never
  //    coexist: each is created by the same single double-pawn move.
  const ep = game.epEvolved;
  if (ep) {
    w.write(2, 2);
    w.write(ep.skipped.charCodeAt(0) - 97, 3);
  } else if (epField !== "-") {
    w.write(1, 2);
    w.write(epField.charCodeAt(0) - 97, 3);
  } else {
    w.write(0, 2);
  }

  // 8. halfmove clock
  if (!Number.isInteger(halfmove) || halfmove < 0 || halfmove > 100) {
    throw new ShareEncodeError(`halfmove clock out of range: ${halfmove}`);
  }
  w.write(halfmove, 7);

  // 9. fullmove number, 8 bits with a 16-bit escape
  if (!Number.isInteger(fullmove) || fullmove < 1 || fullmove > 65535) {
    throw new ShareEncodeError(`fullmove number out of range: ${fullmove}`);
  }
  if (fullmove < 255) {
    w.write(fullmove, 8);
  } else {
    w.write(255, 8);
    w.write(fullmove, 16);
  }

  const bitstream = w.finish();
  const payload = new Uint8Array(2 + bitstream.length + 2);
  payload[0] = SHARE_VERSION;
  payload[1] = 0x00; // no history, no extras
  payload.set(bitstream, 2);
  const crc = crc16Ccitt(payload.subarray(0, 2 + bitstream.length));
  payload[payload.length - 2] = crc >> 8;
  payload[payload.length - 1] = crc & 0xff;
  return toBase64Url(payload);
}

/** Byte length of the payload `encodeShareLink` would produce. Exists for the
 *  size assertions in the spec's fixed vectors. */
export function shareLinkPayloadBytes(game: EvoChessGame): number {
  const param = encodeShareLink(game);
  return fromBase64Url(param)!.length;
}

// ------------------------------------------------------------------ decode

/** Decode a `?p=` value. Never throws: every failure is a returned result. */
export function decodeShareLink(param: string): ShareDecodeResult {
  if (param.length > MAX_SHARE_PARAM_CHARS) return fail("TOO_LONG");
  const payload = fromBase64Url(param);
  if (!payload) return fail("BAD_BASE64");
  // version + flags + CRC, with room for at least some bitstream.
  if (payload.length < 5) return fail("TOO_SHORT");

  const body = payload.subarray(0, payload.length - 2);
  const crc = (payload[payload.length - 2] << 8) | payload[payload.length - 1];
  if (crc16Ccitt(body) !== crc) return fail("BAD_CRC");

  if (body[0] !== SHARE_VERSION) return fail("BAD_VERSION");

  const flags = body[1];
  if (flags & 0b1111_1100) return fail("RESERVED_FLAG");
  // Bit 0, history present. Refuse: the base position of a game link is not
  // the position the sharer was pointing at, so rendering it would
  // misrepresent the link rather than fail it.
  if (flags & 0b01) return fail("HISTORY_UNSUPPORTED");
  const hasExtras = (flags & 0b10) !== 0;

  const r = new BitReader(body.subarray(2));
  const decoded = readPosition(r);
  if ("code" in decoded) return fail(decoded.code);

  // Bit 1, extras present. Skipped, not refused: extras is a fixed 6 bits at a
  // known offset, so a link from a later encoder that carries extras but no
  // history still opens here. The recipient keeps their own orientation, mode
  // and level.
  if (hasExtras && r.read(6) === null) return fail("BITSTREAM_TRUNCATED");

  if (r.remaining > 7) return fail("TRAILING_BYTES");
  if (!r.restIsZero()) return fail("PADDING_NOT_ZERO");

  // En passant coherence is settled first: `buildGame` must know whether the
  // claimed right is real before it writes the FEN.
  const epReasons = epCoherenceReasons(decoded);
  const game = buildGame(decoded, epReasons.length === 0);
  const reasons = [...checkLegality(game, decoded), ...epReasons];
  return { ok: true, game, legal: reasons.length === 0, reasons, extrasSkipped: hasExtras };
}

interface DecodedPosition {
  pieces: BoardPiece[];
  charges: Map<number, number>;
  locked: Set<number>;
  turn: Color;
  pawnMoveProgress: Record<Color, number>;
  minorMoveProgress: Record<Color, number>;
  minorRights: Record<Color, number>;
  rookRights: Record<Color, number>;
  epTag: 0 | 1 | 2;
  epFile: number;
  halfmove: number;
  fullmove: number;
}

function readPosition(r: BitReader): DecodedPosition | { code: ShareStructuralCode } {
  const truncated = { code: "BITSTREAM_TRUNCATED" as ShareStructuralCode };

  const indices: number[] = [];
  for (let i = 0; i < 64; i++) {
    const bit = r.read(1);
    if (bit === null) return truncated;
    if (bit) indices.push(i);
  }

  const pieces: BoardPiece[] = [];
  for (const index of indices) {
    const code = r.read(4);
    if (code === null) return truncated;
    if (code > 11) return { code: "BAD_PIECE_CODE" };
    pieces.push({
      index,
      type: PIECE_ORDER[code % 6],
      color: code < 6 ? "w" : "b",
    });
  }

  const charges = new Map<number, number>();
  for (const p of pieces) {
    if (p.type !== "r") continue;
    const c = r.read(3);
    if (c === null) return truncated;
    if (c < 1 || c > 5) return { code: "BAD_ROOK_CHARGES" };
    charges.set(p.index, c);
  }

  const locked = new Set<number>();
  for (const p of pieces) {
    if (p.type !== "n" && p.type !== "b") continue;
    const bit = r.read(1);
    if (bit === null) return truncated;
    if (bit) locked.add(p.index);
  }

  const turnBit = r.read(1);
  if (turnBit === null) return truncated;
  const turn: Color = turnBit === 0 ? "w" : "b";

  const progress: number[] = [];
  for (let i = 0; i < 4; i++) {
    const v = r.read(2);
    if (v === null) return truncated;
    // N_MINOR and M_ROOK are both 3, so a progress counter is 0-2 by
    // construction and 3 cannot occur.
    if (v > 2) return { code: "BAD_PROGRESS" };
    progress.push(v);
  }

  const rights: number[] = [];
  for (let i = 0; i < 4; i++) {
    const v = readRights(r);
    if (v === null) return truncated;
    if (typeof v === "object") return v;
    rights.push(v);
  }

  const epTag = r.read(2);
  if (epTag === null) return truncated;
  if (epTag === 3) return { code: "BAD_EP_TAG" };
  let epFile = -1;
  if (epTag !== 0) {
    const f = r.read(3);
    if (f === null) return truncated;
    epFile = f;
  }

  const halfmove = r.read(7);
  if (halfmove === null) return truncated;
  if (halfmove > 100) return { code: "BAD_HALFMOVE" };

  let fullmove = r.read(8);
  if (fullmove === null) return truncated;
  if (fullmove === 255) {
    fullmove = r.read(16);
    if (fullmove === null) return truncated;
    // Canonicality, as in `readRights`: the escape is for numbers the 8-bit
    // field cannot hold, so anything below 255 here is a second encoding.
    if (fullmove < 255) return { code: "BAD_FULLMOVE" };
  }
  if (fullmove < 1) return { code: "BAD_FULLMOVE" };

  return {
    pieces,
    charges,
    locked,
    turn,
    pawnMoveProgress: { w: progress[0], b: progress[1] },
    minorMoveProgress: { w: progress[2], b: progress[3] },
    minorRights: { w: rights[0], b: rights[1] },
    rookRights: { w: rights[2], b: rights[3] },
    epTag: epTag as 0 | 1 | 2,
    epFile,
    halfmove,
    fullmove,
  };
}

/** The skipped square, victim square and origin square implied by an en
 *  passant tag. Everything but the file is derivable (spec §4.3 step 7). */
function epSquares(turn: Color, file: number): { skipped: Square; victim: Square; origin: Square } {
  const f = String.fromCharCode(97 + file);
  // The double-mover is the side *not* to move: the right lasts one ply.
  const [skippedRank, victimRank, originRank] = turn === "w" ? [6, 5, 7] : [3, 4, 2];
  return {
    skipped: `${f}${skippedRank}` as Square,
    victim: `${f}${victimRank}` as Square,
    origin: `${f}${originRank}` as Square,
  };
}

/**
 * The en passant coherence part of spec §5.2, decided from the decoded fields
 * rather than from a built board, because `buildGame` needs the answer *before*
 * it can choose whether to write the en passant field at all (see there).
 */
function epCoherenceReasons(d: DecodedPosition): ShareLegalityCode[] {
  if (d.epTag === 0) return [];
  const reasons: ShareLegalityCode[] = [];
  const at = new Map(d.pieces.map((p) => [p.index, p]));
  const { skipped, victim, origin } = epSquares(d.turn, d.epFile);
  // The double-mover is the side not to move, so the victim is theirs.
  const waiting: Color = d.turn === "w" ? "b" : "w";
  if (at.has(squareIndex(skipped))) reasons.push("EP_SKIPPED_NOT_EMPTY");
  if (at.has(squareIndex(origin))) reasons.push("EP_ORIGIN_NOT_EMPTY");
  const victimPiece = at.get(squareIndex(victim));
  if (!victimPiece || victimPiece.color !== waiting) {
    reasons.push("EP_VICTIM_MISSING");
  } else if (d.epTag === 1 && victimPiece.type !== "p") {
    reasons.push("EP_VICTIM_NOT_PAWN");
  } else if (d.epTag === 2 && victimPiece.type === "p") {
    // The evolved variant exists precisely because the victim is no longer a
    // pawn; a pawn there means the link should have used tag 1.
    reasons.push("EP_VICTIM_IS_PAWN");
  }
  return reasons;
}

/**
 * `epCoherent` false means the payload claimed an en passant right that its own
 * board contradicts, so no right is created in either representation.
 *
 * Dropping it is not tidiness, it is the only safe option. chess.js's
 * en-passant *undo* hardcodes restoring a pawn on the victim square, so an
 * `_epSquare` pointing past a non-pawn corrupts the board on the first `fen()`
 * or `moves()` call: every legality trial makes and unmakes the capture and
 * stamps a pawn over whatever was standing there. The engine lockout does not
 * protect against that, because the UI calls `moves()` itself. So the position
 * renders without the right, is flagged illegal, and keeps the engine locked
 * out — which is strictly better than rendering a board that rewrites itself.
 */
function buildGame(d: DecodedPosition, epCoherent: boolean): EvoChessGame {
  const rows: string[] = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = d.pieces.find((p) => p.index === (rank - 1) * 8 + file);
      if (!piece) {
        empty++;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      row += piece.color === "w" ? piece.type.toUpperCase() : piece.type;
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  // Castling is always `-`: castling is undefined in EvoChess. The en passant
  // field is only written for a *coherent* tag 1. Tag 2's opportunity lives in
  // `epEvolved` instead — a FEN naming the skipped square while a minor piece
  // stands on the victim square is exactly the corruption `EvolvedEnPassant`
  // exists to prevent, and `load()` never runs `_updateEnPassantSquare` to catch
  // it. An incoherent tag 1 is the same hazard with a hand-built payload in
  // place of the evolution, so it gets the same treatment.
  const epField = d.epTag === 1 && epCoherent ? epSquares(d.turn, d.epFile).skipped : "-";
  const fen = `${rows.join("/")} ${d.turn} - ${epField} ${d.halfmove} ${d.fullmove}`;

  const game = new EvoChessGame();
  // skipValidation because an illegal position is still rendered (spec §5.2),
  // and chess.js rejects an invalid FEN outright. One thing it refuses even
  // here is a second king of the same colour, so a payload claiming two loses
  // one on the board. Nothing can be done about that from this side, and such a
  // payload is flagged illegal with the engine locked out anyway.
  game.chess.load(fen, { skipValidation: true });
  game.minorRights = { ...d.minorRights };
  game.rookRights = { ...d.rookRights };
  game.pawnMoveProgress = { ...d.pawnMoveProgress };
  game.minorMoveProgress = { ...d.minorMoveProgress };
  // No history block, so there is no move log to regenerate.
  game.moveLog = [];
  game.rookCharges = new Map([...d.charges].map(([i, c]) => [squareName(i), c]));
  game.rookLocked = new Set([...d.locked].map(squareName));
  game.epEvolved = null;
  // Same rule as the FEN field above, for the same reason: `epEvolved`'s own
  // invariant is that the victim is a non-pawn piece of the double-mover's
  // colour, and `applyEvolvedEnPassant` puts a pawn back on that square to hand
  // chess.js an en passant it understands. Nothing good comes of populating the
  // right from a payload whose board contradicts it.
  if (d.epTag === 2 && epCoherent) {
    const { skipped, victim } = epSquares(d.turn, d.epFile);
    const ep: EvolvedEnPassant = {
      skipped,
      victim,
      // The victim's owner is the side that made the double move, i.e. the
      // side not to move.
      color: d.turn === "w" ? "b" : "w",
      // Computed, not carried. chess.js only fills its own `_epSquare` when an
      // enemy pawn stands beside the destination, so an original game can hold
      // `-1` here for an opportunity nobody can take. A real index in its place
      // changes nothing: `matchEvolvedEnPassant` needs that adjacent pawn
      // before it ever reads `index`.
      index: ox88Index(skipped),
    };
    game.epEvolved = ep;
  }
  return game;
}

/**
 * Spec §5.2's list, minus the rook-locked invariant: step 4 writes exactly one
 * bit per knight or bishop on the board, so this format cannot encode a locked
 * bit on any other piece type. It becomes a real check only if a later
 * version encodes those bits some other way.
 */
function checkLegality(game: EvoChessGame, d: DecodedPosition): ShareLegalityCode[] {
  const reasons: ShareLegalityCode[] = [];

  const kings: Record<Color, number> = { w: 0, b: 0 };
  const counts: Record<Color, number> = { w: 0, b: 0 };
  for (const p of d.pieces) {
    counts[p.color]++;
    if (p.type === "k") kings[p.color]++;
    if (p.type === "p") {
      const rank = (p.index >> 3) + 1;
      if (rank === 1) reasons.push("PAWN_ON_RANK_1");
      if (rank === 8) reasons.push("PAWN_ON_RANK_8");
    }
  }
  if (kings.w === 0) reasons.push("NO_WHITE_KING");
  else if (kings.w > 1) reasons.push("TWO_WHITE_KINGS");
  if (kings.b === 0) reasons.push("NO_BLACK_KING");
  else if (kings.b > 1) reasons.push("TWO_BLACK_KINGS");
  // Eight pawns plus a king, and no way to gain material: evolution replaces a
  // piece, it never adds one.
  if (counts.w > 9) reasons.push("TOO_MANY_WHITE_PIECES");
  if (counts.b > 9) reasons.push("TOO_MANY_BLACK_PIECES");

  // The side not to move must not be in check: otherwise the position is
  // unreachable and the side to move could just capture the king. Needs one
  // king each to even ask, so it is skipped when that already failed.
  const waiting: Color = d.turn === "w" ? "b" : "w";
  if (kings.w === 1 && kings.b === 1) {
    const kingSq = squareName(d.pieces.find((p) => p.type === "k" && p.color === waiting)!.index);
    if (game.chess.isAttacked(kingSq, d.turn)) reasons.push("SIDE_NOT_TO_MOVE_IN_CHECK");
  }

  // En passant coherence is not checked here. It is settled by
  // `epCoherenceReasons` before the board is built, and its codes are appended
  // by the caller. Asking chess.js about it after the fact is what allowed a
  // board to be built with an `_epSquare` that rewrites a piece on the first
  // `fen()` call.

  return reasons;
}

// ------------------------------------------------------------------ helpers

/**
 * Read the `?p=` value out of a query string (`window.location.search`), or
 * null if there isn't one. Unknown parameters are ignored (spec §3).
 */
export function readShareParam(search: string): string | null {
  const value = new URLSearchParams(search).get(SHARE_PARAM);
  return value && value.length > 0 ? value : null;
}

/** Convenience for building a full share URL from the current location. */
export function shareUrlFor(game: EvoChessGame, base: string): string {
  const url = new URL(base);
  url.search = "";
  // None of the base64url alphabet needs percent-encoding, so the value
  // survives verbatim and the link can be pasted raw.
  url.searchParams.set(SHARE_PARAM, encodeShareLink(game));
  return url.toString();
}

