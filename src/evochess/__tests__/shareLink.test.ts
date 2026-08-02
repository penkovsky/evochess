/**
 * Tests for the position-only share-link codec (`share-links-spec.md` §8).
 *
 * The payloads the decoder is fed here are built by a *second*, test-local
 * encoder (`buildPayload`) rather than by mutating the shipped encoder's
 * output. Two reasons: an independent writer catches a bug the round-trip test
 * cannot see, since a round trip passes when both directions are wrong the same
 * way; and every §5.2 legality check needs a position the real encoder would
 * refuse to produce, which means writing the bits by hand anyway.
 */
import { describe, expect, it } from "vitest";
import type { Square } from "chess.js";
import { EvoChessGame, ROOK_CHARGES, parseMoveToken, type PlyRecord } from "../game";
import { serializeGame, type SerializedGame } from "../serialize";
import { legalTurns } from "../ai";
import {
  crc16Ccitt,
  decodeShareLink,
  encodeShareLink,
  encodeShareLinkWithHistory,
  fromBase64Url,
  MAX_SHARE_PARAM_CHARS,
  readShareParam,
  SHARE_VERSION,
  shareLinkPayloadBytes,
  toBase64Url,
} from "../shareLink";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function push(game: EvoChessGame, uci: string, options = {}) {
  return game.applyMove(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, options);
}

// ------------------------------------------------ normalization for round-trips

/**
 * The codec is lossless about the *position*, not about the exact map
 * contents: `game.ts` treats a rook with no `rookCharges` entry as fully
 * charged, so a decoded game carries an explicit 5 where the original carried
 * no entry, and the encoder drops entries no rook stands on. A raw
 * field-for-field comparison therefore fails on a correct codec. `moveLog` is
 * dropped too: a position-only link carries no history, so the decoded log is
 * empty by design and is asserted separately.
 *
 * `epEvolved.index` is recomputed on both sides for the same kind of reason.
 * The spec has the decoder compute it from the skipped square rather than trust
 * it from the URL, while chess.js only fills its own `_epSquare` when an enemy
 * pawn actually stands beside the destination — so an opportunity no pawn can
 * take carries `-1` in the original and a real index after decoding. That
 * difference is unobservable in play: `matchEvolvedEnPassant` requires the
 * adjacent enemy pawn before it ever looks at `index`.
 */
/** chess.js's 0x88 index for a square name. */
function ox88(sq: string): number {
  return (8 - Number(sq[1])) * 16 + (sq.charCodeAt(0) - 97);
}

function normalize(s: SerializedGame): Omit<SerializedGame, "moveLog"> {
  const board = new Map<string, string>();
  for (const [i, row] of s.fen.split(" ")[0].split("/").entries()) {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += Number(ch);
        continue;
      }
      board.set(`${String.fromCharCode(97 + file)}${8 - i}`, ch);
      file++;
    }
  }
  const charges: Record<string, number> = {};
  for (const [sq, piece] of board) {
    if (piece !== "r" && piece !== "R") continue;
    charges[sq] = s.rookCharges[sq] ?? ROOK_CHARGES;
  }
  return {
    fen: s.fen,
    minorRights: s.minorRights,
    rookRights: s.rookRights,
    pawnMoveProgress: s.pawnMoveProgress,
    minorMoveProgress: s.minorMoveProgress,
    rookCharges: charges,
    rookLocked: [...s.rookLocked].sort(),
    epEvolved: s.epEvolved
      ? { ...s.epEvolved, index: ox88(s.epEvolved.skipped) }
      : null,
  };
}

// ------------------------------------------- test-local payload builder

class Bits {
  bits: number[] = [];
  write(value: number, n: number) {
    for (let i = n - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
    return this;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => {
      if (b) out[i >> 3] |= 1 << (7 - (i & 7));
    });
    return out;
  }
}

interface RawPosition {
  /** [square index a1=0…h8=63, piece nibble] pairs, any order. */
  pieces: Array<[number, number]>;
  /** 3-bit charge values, in ascending rook square order. Defaults to all 5. */
  charges?: number[];
  /** 1-bit locked flags, in ascending knight/bishop square order. */
  locked?: number[];
  turn?: 0 | 1;
  /** pawn w, pawn b, minor w, minor b. */
  progress?: [number, number, number, number];
  /** minor w, minor b, rook w, rook b. Values >= 15 use the 4+8-bit escape. */
  rights?: [number, number, number, number];
  /** Force the rights escape even for a value that fits in 4 bits, which is how
   *  a non-canonical payload gets built. */
  escapeRights?: boolean;
  epTag?: 0 | 1 | 2 | 3;
  epFile?: number;
  halfmove?: number;
  /** Values >= 255 use the 8+16-bit escape. */
  fullmove?: number;
  /** Force the fullmove escape even for a number that fits in 8 bits. */
  escapeFullmove?: boolean;
}

// Piece nibbles, spec §4.3 step 2. The queen codes (4 and 10) are left out
// rather than declared unused: no case here needs one.
const WP = 0, WN = 1, WB = 2, WR = 3, WK = 5;
const BP = 6, BN = 7, BB = 8, BR = 9, BK = 11;

/** The standard EvoChess start: 8 pawns and a king per side. */
function startPieces(): Array<[number, number]> {
  const pieces: Array<[number, number]> = [[4, WK], [60, BK]];
  for (let f = 0; f < 8; f++) {
    pieces.push([8 + f, WP]);
    pieces.push([48 + f, BP]);
  }
  return pieces;
}

function positionBits(p: RawPosition): Bits {
  const pieces = [...p.pieces].sort((a, b) => a[0] - b[0]);
  const b = new Bits();
  const occupied = new Set(pieces.map(([i]) => i));
  for (let i = 0; i < 64; i++) b.write(occupied.has(i) ? 1 : 0, 1);
  for (const [, code] of pieces) b.write(code, 4);

  const rooks = pieces.filter(([, c]) => c === WR || c === BR);
  rooks.forEach((_, i) => b.write(p.charges?.[i] ?? ROOK_CHARGES, 3));
  const minors = pieces.filter(([, c]) => c === WN || c === WB || c === BN || c === BB);
  minors.forEach((_, i) => b.write(p.locked?.[i] ?? 0, 1));

  b.write(p.turn ?? 0, 1);
  for (const v of p.progress ?? [0, 0, 0, 0]) b.write(v, 2);
  for (const v of p.rights ?? [0, 0, 0, 0]) {
    if (v < 15 && !p.escapeRights) b.write(v, 4);
    else b.write(15, 4).write(v, 8);
  }
  const tag = p.epTag ?? 0;
  b.write(tag, 2);
  if (tag !== 0) b.write(p.epFile ?? 0, 3);
  b.write(p.halfmove ?? 0, 7);
  const fullmove = p.fullmove ?? 1;
  if (fullmove < 255 && !p.escapeFullmove) b.write(fullmove, 8);
  else b.write(255, 8).write(fullmove, 16);
  return b;
}

/** Assemble a `?p=` value. `extraBits`/`padBits` exist to build the malformed
 *  payloads the corruption and flags cases need. */
function buildPayload(
  p: RawPosition,
  opts: {
    version?: number;
    flags?: number;
    /** Appended after the position block, before padding (extras, history). */
    extraBits?: Array<[number, number]>;
    /** Overrides the zero padding to the byte boundary. */
    padWith?: 0 | 1;
    /** Corrupt the CRC instead of computing it. */
    badCrc?: boolean;
  } = {}
): string {
  const bits = positionBits(p);
  for (const [value, n] of opts.extraBits ?? []) bits.write(value, n);
  if (opts.padWith === 1) {
    while (bits.bits.length % 8 !== 0) bits.write(1, 1);
  }
  const stream = bits.bytes();
  const body = new Uint8Array(2 + stream.length);
  body[0] = opts.version ?? SHARE_VERSION;
  body[1] = opts.flags ?? 0x00;
  body.set(stream, 2);
  const crc = crc16Ccitt(body) ^ (opts.badCrc ? 0xffff : 0);
  const payload = new Uint8Array(body.length + 2);
  payload.set(body);
  payload[body.length] = crc >> 8;
  payload[body.length + 1] = crc & 0xff;
  return toBase64Url(payload);
}

function decodeOk(param: string) {
  const result = decodeShareLink(param);
  if (!result.ok) throw new Error(`expected a decode, got ${result.code}`);
  return result;
}

// -------------------------------------------------------- fixed vectors

/** `data/games/game1.txt` replayed to a given ply, so the fixed vectors and
 *  the canonical game in the spec cannot drift apart. */
function game1(plies: number): EvoChessGame {
  const moves: Array<[string, object]> = [
    ["e2e4", {}], ["g7g5", {}], ["d2d4", {}], ["b7b6", {}],
    ["g2g3", { minorPromo: "b" }], ["c7c6", {}], ["g3b8", {}], ["a7a6", {}],
    ["b8c7", {}], ["a6a5", { minorPromo: "b" }], ["c2c3", {}], ["g5g4", {}],
    ["c7b8", { rookPromo: true }],
  ];
  const game = new EvoChessGame();
  for (const [uci, options] of moves.slice(0, plies)) push(game, uci, options);
  return game;
}

// Generated by the encoder and checked in as fixtures: an
// accidental encoding change then breaks a test instead of passing a
// round-trip that changed on both sides at once.
/** Vector A, after ply 11. Black to move, `pawnMoveProgress.b` is 2. */
const VECTOR_A = "AQAIxSAYgmA9CFAAAACGZiZmay0AAAAAYEmJ";
/** Vector B, after ply 12. White to move, `minorMoveProgress.w` is 2. */
const VECTOR_B = "AQAIxSAagGA9CFAAAABoZiZmawkAIAAAcKxZ";

describe("share links: fixed vectors from spec §8.1's game", () => {
  it("vector A encodes to 27 bytes and 36 characters", () => {
    const param = encodeShareLink(game1(11));
    expect(shareLinkPayloadBytes(game1(11))).toBe(27);
    expect(param).toHaveLength(36);
    expect(param).toBe(VECTOR_A);
  });

  it("vector B encodes to 27 bytes and 36 characters", () => {
    const param = encodeShareLink(game1(12));
    expect(shareLinkPayloadBytes(game1(12))).toBe(27);
    expect(param).toHaveLength(36);
    expect(param).toBe(VECTOR_B);
  });

  it("the start position is also 27 bytes and 36 characters, matching spec §7", () => {
    const param = encodeShareLink(new EvoChessGame());
    expect(shareLinkPayloadBytes(new EvoChessGame())).toBe(27);
    expect(param).toHaveLength(36);
  });

  it("the flags byte is 0x00: no history, no extras", () => {
    const payload = fromBase64Url(encodeShareLink(game1(11)))!;
    expect(payload[0]).toBe(SHARE_VERSION);
    expect(payload[1]).toBe(0x00);
  });

  it("vector A decodes to the stated state", () => {
    const { game, legal, reasons } = decodeOk(VECTOR_A);
    expect(legal).toBe(true);
    expect(reasons).toEqual([]);
    expect(game.chess.fen()).toBe("4k3/2Bppp1p/1pp5/b5p1/3PP3/2P5/PP3P1P/4K3 b - - 0 6");
    expect(game.minorRights).toEqual({ w: 0, b: 0 });
    expect(game.rookRights).toEqual({ w: 0, b: 0 });
    expect(game.pawnMoveProgress).toEqual({ w: 1, b: 2 });
    expect(game.minorMoveProgress).toEqual({ w: 2, b: 0 });
    expect([...game.rookCharges]).toEqual([]);
    expect([...game.rookLocked]).toEqual([]);
    expect(game.epEvolved).toBeNull();
    expect(game.moveLog).toEqual([]);
    expect(game.chess.isCheck()).toBe(false);
  });

  it("vector B decodes to the stated state", () => {
    const { game, legal } = decodeOk(VECTOR_B);
    expect(legal).toBe(true);
    expect(game.chess.fen()).toBe("4k3/2Bppp1p/1pp5/b7/3PP1p1/2P5/PP3P1P/4K3 w - - 0 7");
    expect(game.minorRights).toEqual({ w: 0, b: 1 });
    expect(game.rookRights).toEqual({ w: 0, b: 0 });
    expect(game.pawnMoveProgress).toEqual({ w: 1, b: 0 });
    expect(game.minorMoveProgress).toEqual({ w: 2, b: 0 });
    expect([...game.rookCharges]).toEqual([]);
    expect([...game.rookLocked]).toEqual([]);
    expect(game.epEvolved).toBeNull();
    expect(game.chess.isCheck()).toBe(false);
  });
});

describe("share links: acceptance criteria, spec §8.1", () => {
  it("vector B lets a human play Bb8=R# and see mate", () => {
    const { game } = decodeOk(VECTOR_B);
    const keys = legalTurns(game).map((c) => `${c.from}${c.to}${c.options.rookPromo ? "=R" : ""}`);
    expect(keys).toContain("c7b8=R");
    expect(push(game, "c7b8", { rookPromo: true })).toBe("Bb8=R#");
    expect(game.minorMoveProgress.w).toBe(0);
    expect(game.rookRights.w).toBe(0);
    expect(Object.fromEntries(game.rookCharges)).toEqual({ b8: 5 });
    expect(game.isGameOver()).toBe(true);
    expect(game.resultString()).toBe("Checkmate - White wins");
  });

  it("vector A offers g4, g4=N and g4=B", () => {
    const { game } = decodeOk(VECTOR_A);
    const keys = legalTurns(game)
      .filter((c) => c.from === "g5" && c.to === "g4")
      .map((c) => `g4${c.options.minorPromo ? `=${c.options.minorPromo.toUpperCase()}` : ""}`);
    expect(keys.sort()).toEqual(["g4", "g4=B", "g4=N"]);
  });
});

describe("share links: round-trip property test, spec §8", () => {
  it("survives every ply of 12 random legal games", () => {
    const rng = mulberry32(20260730);
    let plies = 0;
    let sawRook = false;
    let sawLocked = false;
    let sawEvolvedEp = false;

    for (let g = 0; g < 12; g++) {
      const game = new EvoChessGame();
      for (let ply = 0; ply < 60 && !game.isGameOver(); ply++) {
        const before = serializeGame(game);
        const decoded = decodeOk(encodeShareLink(game));
        expect(decoded.legal).toBe(true);
        expect(decoded.game.moveLog).toEqual([]);
        expect(normalize(serializeGame(decoded.game))).toEqual(normalize(before));
        plies++;
        if (game.rookCharges.size > 0) sawRook = true;
        if (game.rookLocked.size > 0) sawLocked = true;
        if (game.epEvolved) sawEvolvedEp = true;

        const turns = legalTurns(game);
        if (turns.length === 0) break;
        const t = turns[Math.floor(rng() * turns.length)];
        game.applyMove(t.from, t.to, t.options);
      }
    }

    // Guards against a vacuous pass: the fields a FEN alone loses must
    // actually have been exercised.
    expect(plies).toBeGreaterThan(400);
    expect(sawRook).toBe(true);
    expect(sawLocked).toBe(true);
    expect(sawEvolvedEp).toBe(true);
  });
});

describe("share links: evolved en passant, spec §8", () => {
  /** White plays h4 as the third pawn move and evolves the pawn on that same
   *  move, so the en passant victim on h4 is a bishop, not a pawn. */
  function evolvedEpPosition(): EvoChessGame {
    const game = new EvoChessGame();
    push(game, "a2a3");
    push(game, "g7g5");
    push(game, "b2b3");
    push(game, "g5g4");
    push(game, "h2h4", { minorPromo: "b" });
    return game;
  }

  it("round-trips the opportunity, with `-` in the FEN and the right in epEvolved", () => {
    const original = evolvedEpPosition();
    expect(original.epEvolved).not.toBeNull();
    const { game } = decodeOk(encodeShareLink(original));

    expect(game.epEvolved).toEqual(original.epEvolved);
    expect(game.chess.fen().split(" ")[3]).toBe("-");
    expect(game.chess.get("h4")).toEqual({ type: "b", color: "w" });

    // The assertion that actually fails if the FEN's en passant field were
    // reassembled mechanically: every legality trial inside fen() makes and
    // unmakes the capture and would stamp a pawn over the bishop.
    game.chess.fen();
    game.chess.fen();
    expect(game.chess.get("h4")).toEqual({ type: "b", color: "w" });
  });

  it("leaves the capture available to the opponent after decoding", () => {
    const { game } = decodeOk(encodeShareLink(evolvedEpPosition()));
    const ep = game.legalMoves().filter((m) => m.evolvedEp);
    expect(ep.map((m) => `${m.from}${m.to}`)).toEqual(["g4h3"]);
    expect(push(game, "g4h3")).toBe("gxh3");
    expect(game.chess.get("h4")).toBeUndefined();
  });

  it("is a legal position in the decoder's eyes", () => {
    expect(decodeOk(encodeShareLink(evolvedEpPosition())).reasons).toEqual([]);
  });
});

describe("share links: structural failures, spec §5.1", () => {
  const valid = VECTOR_A;

  it("accepts the baseline the corruption cases are derived from", () => {
    expect(decodeShareLink(valid).ok).toBe(true);
  });

  it("refuses a flipped bit with a CRC mismatch", () => {
    const bytes = fromBase64Url(valid)!;
    bytes[6] ^= 0b0001_0000;
    const result = decodeShareLink(toBase64Url(bytes));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BAD_CRC");
  });

  it("refuses a truncated string", () => {
    for (const cut of [1, 4, 12, 30]) {
      const result = decodeShareLink(valid.slice(0, cut));
      expect(result.ok).toBe(false);
    }
  });

  it("refuses a base64url string with characters outside the alphabet", () => {
    const result = decodeShareLink(valid.slice(0, -1) + "*");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BAD_BASE64");
  });

  it("refuses an unknown version byte, with its own message", () => {
    const result = decodeShareLink(buildPayload({ pieces: startPieces() }, { version: 0x02 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("BAD_VERSION");
      expect(result.message).toBe("This link was created with a different version of EvoChess.");
    }
  });

  it("refuses a non-zero reserved flag bit", () => {
    for (const bit of [2, 3, 4, 5, 6, 7]) {
      const result = decodeShareLink(buildPayload({ pieces: startPieces() }, { flags: 1 << bit }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("RESERVED_FLAG");
    }
  });

  it("refuses non-zero padding bits", () => {
    const result = decodeShareLink(buildPayload({ pieces: startPieces() }, { padWith: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PADDING_NOT_ZERO");
  });

  it("refuses a whole trailing byte after the last field", () => {
    const result = decodeShareLink(
      buildPayload({ pieces: startPieces() }, { extraBits: [[0, 8]] })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRAILING_BYTES");
  });

  it("refuses a bad CRC", () => {
    const result = decodeShareLink(buildPayload({ pieces: startPieces() }, { badCrc: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BAD_CRC");
  });

  it("refuses an over-length ?p= before decoding anything", () => {
    const result = decodeShareLink("A".repeat(MAX_SHARE_PARAM_CHARS + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TOO_LONG");
  });

  it("refuses out-of-range fields", () => {
    const cases: Array<[string, RawPosition]> = [
      ["BAD_PIECE_CODE", { pieces: [...startPieces(), [20, 12]] }],
      ["BAD_PROGRESS", { pieces: startPieces(), progress: [3, 0, 0, 0] }],
      ["BAD_EP_TAG", { pieces: startPieces(), epTag: 3 }],
      ["BAD_HALFMOVE", { pieces: startPieces(), halfmove: 101 }],
      ["BAD_ROOK_CHARGES", { pieces: [...startPieces(), [24, WR]], charges: [0] }],
      ["BAD_ROOK_CHARGES", { pieces: [...startPieces(), [24, WR]], charges: [6] }],
    ];
    for (const [code, raw] of cases) {
      const result = decodeShareLink(buildPayload(raw));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(code);
    }
  });

  it("accepts the escape values for rights and the fullmove number", () => {
    const param = buildPayload({
      pieces: startPieces(),
      rights: [15, 200, 0, 0],
      fullmove: 400,
    });
    const { game } = decodeOk(param);
    expect(game.minorRights).toEqual({ w: 15, b: 200 });
    expect(game.chess.fen().split(" ")[5]).toBe("400");
  });

  it("accepts the smallest value each escape is allowed to carry", () => {
    // 15 and 255 are the boundary the canonicality rule turns on: the short
    // field cannot hold either, so the escape is the only encoding and both must
    // still decode. Without this, the check below could be satisfied by a
    // decoder that rejected every escape.
    const { game } = decodeOk(
      buildPayload({ pieces: startPieces(), rights: [15, 0, 0, 0], fullmove: 255 })
    );
    expect(game.minorRights.w).toBe(15);
    expect(game.chess.fen().split(" ")[5]).toBe("255");
  });

  it("refuses an escape carrying a value that fits in the short field", () => {
    // One position, exactly one payload. A 3 written through the rights escape
    // decodes to the same count as a 3 written directly, so accepting it would
    // leave the format canonical in one place and not another: the padding rule
    // above is justified on precisely this ground, and it is what makes the
    // byte-length and fixture assertions mean anything.
    const rights = decodeShareLink(
      buildPayload({ pieces: startPieces(), rights: [3, 0, 0, 0], escapeRights: true })
    );
    expect(rights.ok).toBe(false);
    if (!rights.ok) expect(rights.code).toBe("BAD_RIGHTS");

    const fullmove = decodeShareLink(
      buildPayload({ pieces: startPieces(), fullmove: 7, escapeFullmove: true })
    );
    expect(fullmove.ok).toBe(false);
    if (!fullmove.ok) expect(fullmove.code).toBe("BAD_FULLMOVE");

    // The same two counts written the way the encoder writes them are fine, so
    // the rejections above are about the encoding and not about the values.
    const canonical = decodeOk(
      buildPayload({ pieces: startPieces(), rights: [3, 0, 0, 0], fullmove: 7 })
    );
    expect(canonical.game.minorRights.w).toBe(3);
    expect(canonical.game.chess.fen().split(" ")[5]).toBe("7");
  });
});

describe("share links: flags forward compatibility, spec §4.2", () => {
  it("skips an extras block and still decodes the position", () => {
    const withExtras = buildPayload(
      { pieces: startPieces(), turn: 1, progress: [1, 2, 0, 0] },
      // autoFlip 1, view side 1, mode 1, aiColor 1, level 2: every extras
      // field set to something the recipient did not choose.
      { flags: 0b10, extraBits: [[0b111110, 6]] }
    );
    const plain = buildPayload({ pieces: startPieces(), turn: 1, progress: [1, 2, 0, 0] });

    const withExtrasResult = decodeOk(withExtras);
    const plainResult = decodeOk(plain);
    expect(withExtrasResult.extrasSkipped).toBe(true);
    expect(plainResult.extrasSkipped).toBe(false);
    // The recipient's own preferences are untouched, because the decoder
    // reports nothing about them: the only difference between the two results
    // is the flag saying an extras block was stepped over.
    expect(serializeGame(withExtrasResult.game)).toEqual(serializeGame(plainResult.game));
    expect(withExtrasResult.game.chess.turn()).toBe("b");
    expect(withExtrasResult.game.pawnMoveProgress).toEqual({ w: 1, b: 2 });
  });

  it("refuses an extras block that is not there", () => {
    // The position block has to end at least 7 bits into its last byte for a
    // missing 6-bit extras block to be visible at all: below that, the zero
    // padding is indistinguishable from an all-zero extras block. The start
    // position with one pawn swapped for a knight is 179 bits, which leaves
    // 5 padding bits — one short.
    const pieces: Array<[number, number]> = [
      ...startPieces().filter(([i]) => i !== 8),
      [8, WN],
    ];
    const missing = decodeShareLink(buildPayload({ pieces }, { flags: 0b10 }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("BITSTREAM_TRUNCATED");

    // Same payload with the six bits actually present decodes, which is what
    // makes the case above a real check rather than an accident of length.
    const present = decodeShareLink(
      buildPayload({ pieces }, { flags: 0b10, extraBits: [[0b101010, 6]] })
    );
    expect(present.ok).toBe(true);
  });
});

describe("share links: illegal positions, spec §5.2", () => {
  // Each case is the legal baseline with exactly one rule broken, and the
  // baseline itself is asserted clean — a check that cannot be made to fail is
  // a check that is not running (the `seededNet` lesson).
  const baseline: RawPosition = { pieces: startPieces() };

  it("passes the legal baseline with no reasons", () => {
    const result = decodeOk(buildPayload(baseline));
    expect(result.legal).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  const cases: Array<[string, RawPosition]> = [
    ["NO_WHITE_KING", { pieces: startPieces().filter(([i]) => i !== 4) }],
    ["NO_BLACK_KING", { pieces: startPieces().filter(([i]) => i !== 60) }],
    ["TWO_WHITE_KINGS", { pieces: [...startPieces(), [24, WK]] }],
    ["TWO_BLACK_KINGS", { pieces: [...startPieces(), [40, BK]] }],
    // A pawn cannot stand on the rank it would have had to promote on.
    ["PAWN_ON_RANK_1", { pieces: [...startPieces(), [0, WP]] }],
    ["PAWN_ON_RANK_8", { pieces: [...startPieces(), [63, BP]] }],
    // Nine pieces per side is the ceiling: evolution replaces a piece, never
    // adds one.
    ["TOO_MANY_WHITE_PIECES", { pieces: [...startPieces(), [24, WN]] }],
    ["TOO_MANY_BLACK_PIECES", { pieces: [...startPieces(), [40, BN]] }],
  ];

  for (const [code, raw] of cases) {
    it(`reports ${code}`, () => {
      const result = decodeOk(buildPayload(raw));
      expect(result.legal).toBe(false);
      expect(result.reasons).toContain(code);
    });
  }

  it("reports SIDE_NOT_TO_MOVE_IN_CHECK", () => {
    // Black king on e8, white rook on e7 giving check, and White to move.
    const pieces: Array<[number, number]> = [
      [4, WK],
      [60, BK],
      [52, WR],
    ];
    const result = decodeOk(buildPayload({ pieces, charges: [ROOK_CHARGES] }));
    expect(result.legal).toBe(false);
    expect(result.reasons).toEqual(["SIDE_NOT_TO_MOVE_IN_CHECK"]);

    // The same board with Black to move is legal: it is Black's own king in
    // check, which is an ordinary position.
    const flipped = decodeOk(buildPayload({ pieces, charges: [ROOK_CHARGES], turn: 1 }));
    expect(flipped.legal).toBe(true);
  });

  describe("en passant coherence", () => {
    // White to move, so a black pawn double-moved g7-g5: skipped g6, victim
    // g5, origin g7. The baseline is that position, encoded with tag 1. The
    // white pawn stands on f5 so the capture is actually available: chess.js
    // prints the en passant field only when some pawn can take it.
    function epPieces(): Array<[number, number]> {
      return [
        [4, WK],
        [60, BK],
        [37, WP], // f5, the capturer
        [38, BP], // g5, the victim
      ];
    }
    const epBase: RawPosition = { pieces: epPieces(), epTag: 1, epFile: 6 };

    it("passes a coherent standard en passant", () => {
      const result = decodeOk(buildPayload(epBase));
      expect(result.reasons).toEqual([]);
      expect(result.legal).toBe(true);
      expect(result.game.chess.fen().split(" ")[3]).toBe("g6");
    });

    it("reports EP_SKIPPED_NOT_EMPTY", () => {
      const pieces: Array<[number, number]> = [...epPieces(), [46, WP]]; // g6
      const result = decodeOk(buildPayload({ ...epBase, pieces }));
      expect(result.reasons).toContain("EP_SKIPPED_NOT_EMPTY");
    });

    it("reports EP_ORIGIN_NOT_EMPTY", () => {
      const pieces: Array<[number, number]> = [...epPieces(), [54, BP]]; // g7
      const result = decodeOk(buildPayload({ ...epBase, pieces }));
      expect(result.reasons).toContain("EP_ORIGIN_NOT_EMPTY");
    });

    it("reports EP_VICTIM_MISSING when nothing of the right colour is there", () => {
      const pieces = epPieces().filter(([i]) => i !== 38);
      const result = decodeOk(buildPayload({ ...epBase, pieces }));
      expect(result.reasons).toContain("EP_VICTIM_MISSING");
    });

    it("reports EP_VICTIM_NOT_PAWN for tag 1 over an evolved piece", () => {
      const pieces = [...epPieces().filter(([i]) => i !== 38), [38, BB] as [number, number]];
      const result = decodeOk(buildPayload({ ...epBase, pieces }));
      expect(result.reasons).toContain("EP_VICTIM_NOT_PAWN");
    });

    it("reports EP_VICTIM_IS_PAWN for tag 2 over a pawn", () => {
      // Tag 2 exists precisely because the victim evolved and is no longer a
      // pawn, so a pawn there means the link should have said tag 1.
      const result = decodeOk(buildPayload({ ...epBase, epTag: 2 }));
      expect(result.reasons).toContain("EP_VICTIM_IS_PAWN");
    });

    it("creates no en passant right at all when the payload is incoherent", () => {
      // The reason codes above are not enough on their own. chess.js's
      // en-passant *undo* hardcodes restoring a pawn on the victim square, so an
      // `_epSquare` pointing past a non-pawn rewrites that piece on the first
      // fen()/moves() call: every legality trial makes and unmakes the capture.
      // The white pawn on f5 is what makes the trial run at all, so this is the
      // arrangement that actually corrupts. The engine lockout is no defence,
      // because the UI calls moves() itself.
      const pieces = [...epPieces().filter(([i]) => i !== 38), [38, BB] as [number, number]];
      const { game, reasons } = decodeOk(buildPayload({ ...epBase, pieces }));
      expect(reasons).toContain("EP_VICTIM_NOT_PAWN");

      expect(game.chess.fen().split(" ")[3]).toBe("-");
      game.chess.fen();
      game.chess.moves();
      expect(game.chess.get("g5")).toEqual({ type: "b", color: "b" });
      // No right in the other representation either: `epEvolved`'s own invariant
      // is a non-pawn victim, and the tag-2 form of the same incoherence
      // violates it just as badly.
      expect(game.epEvolved).toBeNull();
      const tag2 = decodeOk(buildPayload({ ...epBase, epTag: 2 }));
      expect(tag2.reasons).toContain("EP_VICTIM_IS_PAWN");
      expect(tag2.game.epEvolved).toBeNull();
      expect(tag2.game.chess.fen().split(" ")[3]).toBe("-");
    });

    it("passes a coherent evolved en passant, and keeps the FEN field `-`", () => {
      const pieces = [...epPieces().filter(([i]) => i !== 38), [38, BB] as [number, number]];
      const result = decodeOk(buildPayload({ ...epBase, pieces, epTag: 2 }));
      expect(result.reasons).toEqual([]);
      expect(result.game.chess.fen().split(" ")[3]).toBe("-");
      expect(result.game.epEvolved).toEqual({
        skipped: "g6",
        victim: "g5",
        color: "b",
        index: 38, // g6 in chess.js's 0x88 layout: (8 - 6) * 16 + 6
      });
    });
  });

  it("renders the board even when the position is illegal", () => {
    // The whole point of §5.2: a position someone wants to argue about is
    // worth showing even if it was hand-built.
    // The h7 pawn moves to h8 rather than being added, so the nine-piece cap
    // is not broken as well and this stays a single-reason case.
    const pieces: Array<[number, number]> = [
      ...startPieces().filter(([i]) => i !== 55),
      [63, BP],
    ];
    const result = decodeOk(buildPayload({ pieces }));
    expect(result.legal).toBe(false);
    expect(result.reasons).toEqual(["PAWN_ON_RANK_8"]);
    expect(result.game.chess.get("h8")).toEqual({ type: "p", color: "b" });
    expect(result.game.chess.get("e1")).toEqual({ type: "k", color: "w" });
    expect(result.game.chess.get("e8")).toEqual({ type: "k", color: "b" });
  });

  it("keeps only one of two same-coloured kings, and still flags the payload", () => {
    // chess.js refuses a second king of a colour even on the skipValidation
    // path, and `load()` fills the board from a8 downwards, so the one on the
    // higher rank is the one that survives. The rendered board therefore
    // differs from the payload here. That is chess.js's floor, not something
    // the decoder can paper over, and it only affects a position that is
    // already flagged illegal with the engine locked out.
    const pieces: Array<[number, number]> = [
      ...startPieces().filter(([i]) => i !== 8),
      [24, WK],
    ];
    const result = decodeOk(buildPayload({ pieces }));
    expect(result.legal).toBe(false);
    expect(result.reasons).toEqual(["TWO_WHITE_KINGS"]);
    expect(result.game.chess.get("a4")).toEqual({ type: "k", color: "w" });
    expect(result.game.chess.get("e1")).toBeUndefined();
  });
});

describe("share links: base64url and the query parameter", () => {
  it("round-trips arbitrary bytes without padding", () => {
    const rng = mulberry32(7);
    for (let len = 0; len < 40; len++) {
      const bytes = Uint8Array.from({ length: len }, () => Math.floor(rng() * 256));
      const encoded = toBase64Url(bytes);
      expect(encoded).not.toContain("=");
      expect([...fromBase64Url(encoded)!]).toEqual([...bytes]);
    }
  });

  it("rejects a final character carrying non-zero bits", () => {
    // "AB" decodes to one byte from 12 bits, so the low 4 bits of `B` must be
    // zero or two strings would decode to the same bytes.
    expect(fromBase64Url("AA")).not.toBeNull();
    expect(fromBase64Url("AB")).toBeNull();
    expect(fromBase64Url("A")).toBeNull();
  });

  it("reads ?p= and ignores unknown parameters", () => {
    expect(readShareParam(`?x=1&p=${VECTOR_A}&y=2`)).toBe(VECTOR_A);
    expect(readShareParam("?q=abc")).toBeNull();
    expect(readShareParam("")).toBeNull();
    expect(readShareParam("?p=")).toBeNull();
  });
});

// -------------------------------------------------------- history block

function squareIdx(sq: string): number {
  return (Number(sq[1]) - 1) * 8 + (sq.charCodeAt(0) - 97);
}

/** Independent of `historyTag` in shareLink.ts, same reason as `buildPayload`
 *  above: a shared bug in both directions is invisible to a round trip. */
function tagForRecord(record: PlyRecord): { tag: number; extra?: number } {
  const { forcedPromo, minorPromo, rookPromo, downgradeTo } = record.options;
  if (forcedPromo) return { tag: 6, extra: { q: 0, r: 1, b: 2, n: 3 }[forcedPromo] };
  if (minorPromo === "n") return { tag: 1 };
  if (minorPromo === "b") return { tag: 2 };
  if (rookPromo) return { tag: 3 };
  if (downgradeTo === "n") return { tag: 4 };
  if (downgradeTo === "b") return { tag: 5 };
  return { tag: 0 };
}

/** Hand-built history block bits, spec §4.4. `flat: true` omits tag 6's extra
 *  2 bits even when present, to build the desynchronising payload §7's
 *  promotion-stride test needs. */
function historyExtraBits(tokens: string[], cursor: number, opts: { flat?: boolean } = {}): Array<[number, number]> {
  const out: Array<[number, number]> = [[tokens.length, 12]];
  for (const token of tokens) {
    const record = parseMoveToken(token)!;
    const { tag, extra } = tagForRecord(record);
    out.push([squareIdx(record.from), 6], [squareIdx(record.to), 6], [tag, 3]);
    if (tag === 6 && !opts.flat) out.push([extra ?? 0, 2]);
  }
  out.push([cursor, 12]);
  return out;
}

/** A game with an 8th-rank promotion mid-stream, not on the last ply, so a
 *  flat-15-bit encoder would desynchronise on the plies after it (spec §4.4,
 *  the trap named alongside the 17-bit stride). */
function promotionGame(): EvoChessGame {
  const game = new EvoChessGame();
  push(game, "e2e4"); push(game, "d7d5");
  push(game, "e4d5"); push(game, "c7c6");
  push(game, "d5c6"); push(game, "g7g5");
  push(game, "c6b7"); push(game, "a7a6");
  // Bishop, not queen or rook: either of those would check the black king
  // along the 8th rank from b8, which a7a5 (the next ply) doesn't answer.
  push(game, "b7b8", { forcedPromo: "b" }); push(game, "a6a5");
  push(game, "e1e2"); push(game, "a5a4");
  return game;
}

describe("share links: history block", () => {
  it("Link 3 (cursor 11) matches vector A's position exactly", () => {
    const full = game1(13);
    const link = encodeShareLinkWithHistory(new EvoChessGame(), full.moveTokens, 11);
    const decoded = decodeOk(link);
    expect(decoded.snapshots).toBeDefined();
    expect(decoded.cursor).toBe(11);
    expect(normalize(serializeGame(decoded.snapshots![11]))).toEqual(normalize(serializeGame(game1(11))));
    const positionOnly = decodeOk(encodeShareLink(game1(11)));
    expect(normalize(serializeGame(decoded.snapshots![11]))).toEqual(normalize(serializeGame(positionOnly.game)));
  });

  it("Link 4 (cursor 12) matches vector B's position exactly", () => {
    const full = game1(13);
    const link = encodeShareLinkWithHistory(new EvoChessGame(), full.moveTokens, 12);
    const decoded = decodeOk(link);
    expect(decoded.cursor).toBe(12);
    expect(normalize(serializeGame(decoded.snapshots![12]))).toEqual(normalize(serializeGame(game1(12))));
  });

  it("the live game is the end of the line, not the cursor", () => {
    const full = game1(13);
    const decoded = decodeOk(encodeShareLinkWithHistory(new EvoChessGame(), full.moveTokens, 0));
    expect(decoded.cursor).toBe(0);
    expect(decoded.game.chess.fen()).toBe(full.chess.fen());
    expect(decoded.game).toBe(decoded.snapshots![decoded.snapshots!.length - 1]);
  });

  it("every cursor from 0 to plyCount decodes to the matching replay ply, 14 snapshots throughout", () => {
    const full = game1(13);
    for (let cursor = 0; cursor <= 13; cursor++) {
      const decoded = decodeOk(encodeShareLinkWithHistory(new EvoChessGame(), full.moveTokens, cursor));
      expect(decoded.snapshots).toHaveLength(14);
      expect(decoded.cursor).toBe(cursor);
      expect(normalize(serializeGame(decoded.snapshots![cursor]))).toEqual(normalize(serializeGame(game1(cursor))));
    }
  });

  it("promotion stride: the real encoder round-trips a mid-game 8th-rank promotion", () => {
    const game = promotionGame();
    const link = encodeShareLinkWithHistory(new EvoChessGame(), game.moveTokens, game.moveTokens.length);
    const decoded = decodeOk(link);
    expect(decoded.game.chess.fen()).toBe(game.chess.fen());
    expect(decoded.game.minorRights).toEqual(game.minorRights);
  });

  it("promotion stride: a flat-15-bit encoding of the same game desynchronises", () => {
    const game = promotionGame();
    const flatPayload = buildPayload(
      { pieces: startPieces() },
      { flags: 0b01, extraBits: historyExtraBits(game.moveTokens, game.moveTokens.length, { flat: true }) }
    );
    const flatResult = decodeShareLink(flatPayload);
    // Either the misaligned tail fails a structural check, or it "succeeds"
    // into a different game than the one encoded. Either way it must not
    // match. That is what proves the 17-bit stride is load-bearing.
    if (flatResult.ok) {
      expect(flatResult.game.chess.fen()).not.toBe(game.chess.fen());
    } else {
      expect(flatResult.ok).toBe(false);
    }
  });

  it("cursor > plyCount fails with BAD_CURSOR", () => {
    const tokens = game1(2).moveTokens;
    const payload = buildPayload(
      { pieces: startPieces() },
      { flags: 0b01, extraBits: historyExtraBits(tokens, 5) }
    );
    const result = decodeShareLink(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BAD_CURSOR");
  });

  it("an illegal base cannot carry history: HISTORY_ILLEGAL_BASE, nothing rendered", () => {
    // Two white kings, exactly as the illegal-positions suite above.
    const pieces: Array<[number, number]> = [
      ...startPieces().filter(([i]) => i !== 8),
      [24, WK],
    ];
    const payload = buildPayload({ pieces }, { flags: 0b01, extraBits: historyExtraBits([], 0) });
    const result = decodeShareLink(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("HISTORY_ILLEGAL_BASE");
      expect(result.message).toContain("starting position could not have occurred");
    }

    // The same shape over a legal base decodes fine, so the check above is
    // discriminating on the base and not just always failing.
    const legalPayload = buildPayload({ pieces: startPieces() }, { flags: 0b01, extraBits: historyExtraBits([], 0) });
    expect(decodeShareLink(legalPayload).ok).toBe(true);
  });

  it("a token that will not apply fails with HISTORY_REPLAY_FAILED", () => {
    // e2e5: a bare from/to/tag triple the format accepts structurally, but no
    // pawn can play. chess.js refuses it inside replayLine.
    const payload = buildPayload(
      { pieces: startPieces() },
      { flags: 0b01, extraBits: historyExtraBits(["e2e5"], 1) }
    );
    const result = decodeShareLink(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("HISTORY_REPLAY_FAILED");
      expect(result.message).toBe("This link was created with a different version of EvoChess.");
    }
  });

  it("position-only links are untouched: vectors A and B still decode and encode byte-identically", () => {
    expect(encodeShareLink(game1(11))).toBe(VECTOR_A);
    expect(encodeShareLink(game1(12))).toBe(VECTOR_B);
    const a = decodeOk(VECTOR_A);
    const b = decodeOk(VECTOR_B);
    expect(a.snapshots).toBeUndefined();
    expect(a.cursor).toBeUndefined();
    expect(b.snapshots).toBeUndefined();
  });
});
