/**
 * A clip manifest and the frame list it expands into. Pure: no browser, no
 * ffmpeg. See `docs/clip-tool-spec.md`.
 *
 * Ply numbers count positions, not moves: ply n is the position after the nth
 * move. Captions and the eval TSV both use that.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Color, Square } from "chess.js";
import { EvoChessGame, parseMoveToken } from "../../src/evochess/game";
import { deserializeGame } from "../../src/evochess/serialize";
import {
  MAX_SHARE_PARAM_CHARS,
  SHARE_PARAM,
  decodeShareLink,
  encodeShareLinkWithHistory,
} from "../../src/evochess/shareLink";
import { replayAll, tokenize } from "./replay";

export interface ClipEvo {
  minorRights?: Partial<Record<Color, number>>;
  rookRights?: Partial<Record<Color, number>>;
  pawnMoveProgress?: Partial<Record<Color, number>>;
  minorMoveProgress?: Partial<Record<Color, number>>;
  rookCharges?: Partial<Record<Square, number>>;
  rookLocked?: Square[];
}

/** A full-screen picture cut into the clip. See `ClipManifest.images`. */
export interface ClipImage {
  /** Path to the image, relative to the manifest. */
  src: string;
  /** The ply it hangs off, or the ends of the line. */
  at: number | "start" | "end";
  /** `before` puts it ahead of the move into `at`. Default `after`. */
  when?: "before" | "after";
  /** Milliseconds on screen. Default 1200. */
  hold?: number;
}

export interface ClipManifest {
  out?: string;
  /** Start state. The standard opening when `fen` is absent. */
  fen?: string;
  evo?: ClipEvo;
  /**
   * A `?p=` payload, or a whole share URL, instead of `fen` + `evo`. A link
   * carrying history supplies the move line too, and its cursor becomes the
   * default `from`, so a link shared at a moment starts the clip there.
   */
  p?: string;
  /** Move source. Carries on past a `p` link that already has moves. */
  moves?: string;
  line?: string;
  from?: number;
  to?: number;
  /** Annotated TSV from `training/annotate_game.ts`. Turns the eval bar on. */
  evals?: string;
  evalColumn?: string;
  captions?: Record<string, string>;
  hold?: Record<string, number>;
  dwell?: number;
  captionHold?: number;
  /** Eval jump, in pawns, that earns a ply extra time on screen. */
  swing?: number;
  swingHold?: number;
  finalHold?: number;
  titleCard?: string;
  titleHold?: number;
  /**
   * A generated colour gradient behind the title card. `true` seeds it from the
   * title text; a number seeds it explicitly, so changing the number rerolls
   * the colours. Always deterministic: the same manifest renders the same clip.
   */
  titleGradient?: boolean | number;
  /**
   * Large text under the title, e.g. a chess glyph. Any string; it is set at
   * display size, so one or two characters is what it is for.
   */
  titleGlyph?: string;
  /** CSS colour for `titleGlyph`. Defaults to the card's white. */
  titleGlyphColor?: string;
  /**
   * Brand the cards: an app-icon tile above the end card's text, and a small
   * watermark on the image cards. The title card is left alone, since it has
   * its own glyph. Board frames are never touched. Default off.
   */
  logo?: boolean;
  endCard?: string;
  endHold?: number;
  /**
   * The same generated background behind the end card. `true` seeds it from the
   * end card's text, so it differs from the title's; pass both the same number
   * to make the two cards match.
   */
  endGradient?: boolean | number;
  /**
   * Pictures cut into the clip as full-screen cards, in the order given when
   * two land on the same anchor. Held for `hold`, scaled by `speed`.
   */
  images?: ClipImage[];
  /** Slide the piece to its square instead of cutting to it. Default true. */
  animate?: boolean;
  /** How long a piece takes to cross, in milliseconds. Default 250. */
  animationMs?: number;
  /** Whole-clip pace. 2 is twice as fast, 0.5 half. Default 1. */
  speed?: number;
  /**
   * Pace over a ply range, e.g. `{"0-12": 2}`. Inclusive, single plies allowed.
   * Multiplies with `speed`, and with any other range that overlaps.
   */
  speeds?: Record<string, number>;
  baseUrl?: string;
  fps?: number;
}

const DEFAULTS = {
  dwell: 600,
  captionHold: 2600,
  swing: 1.5,
  swingHold: 2000,
  finalHold: 2500,
  titleHold: 1800,
  endHold: 2200,
  imageHold: 1200,
  animationMs: 250,
  speed: 1,
  fps: 30,
};

/** `"7"` or `"12-20"`, inclusive, to the plies it covers. */
function inRange(ply: number, key: string): boolean {
  const [lo, hi] = key.split("-");
  if (hi === undefined) return ply === Number(lo);
  if (!/^\d+$/.test(lo) || !/^\d+$/.test(hi)) throw new Error(`bad ply range "${key}"`);
  return ply >= Number(lo) && ply <= Number(hi);
}

/** `hero` is the big app-icon tile, `mark` the corner watermark. */
export type Logo = "hero" | "mark" | null;

export type Frame =
  | { kind: "card"; text: string; background: string | null; logo: Logo; glyph: string | null; glyphColor: string | null; durationMs: number }
  /** A full-screen picture. `src` is an absolute path, read at render time. */
  | { kind: "image"; src: string; logo: Logo; durationMs: number }
  | {
      kind: "board";
      ply: number;
      /** Occupied squares, sorted. Checks the board finished updating. */
      squares: string[];
      caption: string | null;
      /** White-relative pawns. Infinite for a mate score. Null when unknown. */
      score: number | null;
      durationMs: number;
    }
  /**
   * A piece part-way to its square, drawn on the board of `ply`, the position
   * *before* the move. That is what makes an evolution read right: the bishop
   * travels as a bishop.
   */
  | {
      kind: "move";
      ply: number;
      from: string;
      to: string;
      /** Fraction of the way across, strictly between 0 and 1. */
      t: number;
      /** The eval of the board it is drawn on, so the bar holds still. */
      score: number | null;
      durationMs: number;
    };

export interface Clip {
  out: string;
  frames: Frame[];
  /**
   * The whole line in one payload, opened at ply 0 and then browsed. Not one
   * link per ply: a link hands the recipient the side to move (`App.tsx`), so
   * that would flip the board every ply.
   */
  link: string;
  /** Plies in the line, so a browse step can be checked against the app. */
  totalPlies: number;
  hasEvalBar: boolean;
  baseUrl?: string;
  fps: number;
}

/** Scores are white-relative already (`annotate_game.ts` signs them). */
function parseScore(cell: string): number | null {
  if (cell === "+M") return Infinity;
  if (cell === "-M") return -Infinity;
  const n = Number(cell);
  return Number.isFinite(n) ? n : null;
}

/** Ply to white-relative score. Row `ply` is the position *before* move `ply`. */
function readEvals(path: string, column: string): Map<number, number> {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const header = lines[0].split("\t");
  const col = header.indexOf(column);
  if (col === -1) throw new Error(`no column "${column}" in ${path}; have: ${header.join(", ")}`);
  const plyCol = header.indexOf("ply");
  const out = new Map<number, number>();
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const score = parseScore(cells[col]);
    if (score !== null) out.set(Number(cells[plyCol]), score);
  }
  return out;
}

/**
 * Which squares hold a piece. Every move vacates its origin, so this set
 * changes on every ply, which is enough to tell one ply's board from the last.
 */
function occupiedSquares(game: EvoChessGame): string[] {
  return game.chess
    .board()
    .flat()
    .flatMap((sq) => (sq ? [sq.square as string] : []))
    .sort();
}

/** mulberry32: small, seeded, and good enough to pick colours with. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * A card background: two harmonious hues on a diagonal, lit from one corner.
 *
 * Colours are picked in OKLCH rather than HSL. HSL's midpoints go grey and its
 * lightness lies about how bright a hue looks, which is what makes a naive
 * random gradient muddy. Lightness is held in a band that keeps white text
 * readable over every stop.
 */
export function cardGradient(seed: number): string {
  const rand = rng(seed);
  const h0 = rand() * 360;
  // Mostly neighbouring hues, which always agree; sometimes a wide jump.
  const h1 = h0 + (rand() < 0.72 ? 25 + rand() * 45 : 150 + rand() * 45);
  const angle = 100 + rand() * 160;
  const chroma = 0.15 + rand() * 0.06;
  const lo = `oklch(0.46 ${chroma.toFixed(3)} ${h1.toFixed(1)})`;
  const hi = `oklch(0.64 ${chroma.toFixed(3)} ${h0.toFixed(1)})`;
  const g = (a: number) => `oklch(0.82 ${(chroma * 0.8).toFixed(3)} ${h0.toFixed(1)} / ${a})`;
  const x = (20 + rand() * 30).toFixed(0);
  const y = (15 + rand() * 25).toFixed(0);
  // Interpolated `in oklch`, not sRGB. A wide hue jump mixed in sRGB passes
  // through grey, which is what turns a blue-to-orange pair into mud. The glow
  // fades to its own colour at zero alpha rather than to `transparent`, which
  // is transparent *black* and would darken the middle of the fade.
  return (
    `radial-gradient(circle at ${x}% ${y}% in oklch, ${g(0.5)}, ${g(0)} 62%), ` +
    `linear-gradient(${angle.toFixed(0)}deg in oklch, ${hi}, ${lo})`
  );
}

/** Zero for both colours, the default for every counter `evo` omits. */
function pair(partial: Partial<Record<Color, number>> | undefined): Record<Color, number> {
  return { w: partial?.w ?? 0, b: partial?.b ?? 0 };
}

/** A whole share URL, a query string, or a bare payload. */
function sharePayload(input: string): string {
  const q = input.indexOf("?");
  if (q === -1) return input.trim();
  return new URLSearchParams(input.slice(q + 1)).get(SHARE_PARAM) ?? input.trim();
}

/**
 * The plies a `?p=` link already holds: its base, then one per ply it carries.
 * A link without history is just its position, at ply 0.
 */
function sharedPositions(input: string): { positions: EvoChessGame[]; cursor: number } {
  const link = decodeShareLink(sharePayload(input));
  if (!link.ok) throw new Error(`bad share link: ${link.message} (${link.code})`);
  if (!link.legal) {
    process.stderr.write(`warning: shared position is unverified [${link.reasons.join(", ")}]\n`);
  }
  const positions = link.snapshots ?? [link.game];
  // A cursor at the end of the line is what sharing a finished game produces,
  // and means no particular moment. Only a cursor short of it points at one.
  const cursor = link.cursor ?? 0;
  return { positions, cursor: cursor < positions.length - 1 ? cursor : 0 };
}

/** A FEN plus the evolution state a FEN cannot carry. */
function startGame(m: ClipManifest): EvoChessGame {
  if (!m.fen) return new EvoChessGame();
  const evo = m.evo ?? {};
  return deserializeGame({
    fen: m.fen,
    minorRights: pair(evo.minorRights),
    rookRights: pair(evo.rookRights),
    pawnMoveProgress: pair(evo.pawnMoveProgress),
    minorMoveProgress: pair(evo.minorMoveProgress),
    moveLog: [],
    rookCharges: (evo.rookCharges ?? {}) as Record<string, number>,
    rookLocked: evo.rookLocked ?? [],
  });
}

export function buildClip(manifestPath: string): Clip {
  const path = resolve(manifestPath);
  const m: ClipManifest = JSON.parse(readFileSync(path, "utf8"));
  const rel = (p: string) => resolve(dirname(path), p);

  if (m.p && m.fen) throw new Error("give either `p` or `fen`, not both");
  // The link's plies first, then anything written carries on from the last one.
  const shared = m.p ? sharedPositions(m.p) : { positions: [startGame(m)], cursor: 0 };
  const start = shared.positions[0];
  const written = tokenize(m.line ?? (m.moves ? readFileSync(rel(m.moves), "utf8") : ""));
  const positions = [
    ...shared.positions.slice(0, -1),
    ...replayAll(shared.positions[shared.positions.length - 1], written),
  ];

  const evals = m.evals ? readEvals(rel(m.evals), m.evalColumn ?? "") : null;
  const dwell = m.dwell ?? DEFAULTS.dwell;
  const swing = m.swing ?? DEFAULTS.swing;
  // A link shared at a moment starts the clip there, unless the manifest says.
  const first = Math.max(0, m.from ?? shared.cursor);
  const last = Math.min(positions.length - 1, m.to ?? positions.length - 1);
  if (first > last) throw new Error(`empty clip: from ${first} is past ply ${last}`);

  const fps = m.fps ?? DEFAULTS.fps;
  const animationMs = m.animate === false ? 0 : m.animationMs ?? DEFAULTS.animationMs;
  const globalSpeed = m.speed ?? DEFAULTS.speed;
  const speedAt = (ply: number) =>
    Object.entries(m.speeds ?? {}).reduce((s, [key, mult]) => (inRange(ply, key) ? s * mult : s), globalSpeed);

  // The engine's tokens, not the written SAN: these carry from/to squares.
  const moveTokens = positions[positions.length - 1].moveTokens;
  const moves = moveTokens.map((t) => {
    const record = parseMoveToken(t);
    if (!record) throw new Error(`malformed move token: ${t}`);
    return record;
  });

  // Anchored images, grouped so each anchor keeps its manifest order.
  const imagesAt = new Map<string, Frame[]>();
  for (const img of m.images ?? []) {
    const path = rel(img.src);
    if (!existsSync(path)) throw new Error(`no such image: ${img.src} (looked in ${path})`);
    const key = `${img.at}:${img.when ?? "after"}`;
    const frame: Frame = {
      kind: "image",
      src: path,
      logo: m.logo ? "mark" : null,
      durationMs: (img.hold ?? DEFAULTS.imageHold) / globalSpeed,
    };
    (imagesAt.get(key) ?? imagesAt.set(key, []).get(key)!).push(frame);
  }
  const take = (key: string): Frame[] => imagesAt.get(key) ?? [];

  const frames: Frame[] = [];
  if (m.titleCard) {
    const g = m.titleGradient;
    const seed = typeof g === "number" ? g : hashString(m.titleCard);
    frames.push({
      kind: "card",
      text: m.titleCard,
      background: g === undefined || g === false ? null : cardGradient(seed),
      logo: null,
      glyph: m.titleGlyph ?? null,
      glyphColor: m.titleGlyphColor ?? null,
      durationMs: (m.titleHold ?? DEFAULTS.titleHold) / globalSpeed,
    });
  }

  frames.push(...take("start:after"), ...take("start:before"));

  for (let ply = first; ply <= last; ply++) {
    const speed = speedAt(ply);
    frames.push(...take(`${ply}:before`));
    // The flight into this ply, drawn on the board before it. Speed changes how
    // many sub-frames there are, so each one stays exactly one output frame.
    if (ply > first) {
      const { from, to } = moves[ply - 1];
      const score = evals?.get(ply - 1) ?? null;
      const strides = Math.max(1, Math.round((animationMs * fps) / (1000 * speed)));
      for (let i = 1; i < strides; i++) {
        frames.push({ kind: "move", ply: ply - 1, from, to, t: i / strides, score, durationMs: 1000 / fps });
      }
    }

    const squares = occupiedSquares(positions[ply]);
    const score = evals?.get(ply) ?? null;
    const prev = evals?.get(ply - 1) ?? null;
    let durationMs = m.hold?.[String(ply)] ?? dwell;
    if (m.hold?.[String(ply)] === undefined) {
      // A jump the viewer would otherwise miss. A mate score always qualifies.
      if (score !== null && prev !== null && Math.abs(score - prev) >= swing) {
        durationMs = Math.max(durationMs, m.swingHold ?? DEFAULTS.swingHold);
      }
      if (ply === last) durationMs = Math.max(durationMs, m.finalHold ?? DEFAULTS.finalHold);
    }
    frames.push({ kind: "board", ply, squares, caption: null, score, durationMs: durationMs / speed });

    // The move lands first and is read afterwards, so a caption is its own beat
    // over the position rather than something covering the move as it arrives.
    const caption = m.captions?.[String(ply)] ?? null;
    if (caption) {
      const hold = (m.captionHold ?? DEFAULTS.captionHold) / speed;
      frames.push({ kind: "board", ply, squares, caption, score, durationMs: hold });
    }

    frames.push(...take(`${ply}:after`));
  }

  frames.push(...take("end:after"), ...take("end:before"));

  if (m.endCard) {
    const eg = m.endGradient;
    frames.push({
      kind: "card",
      text: m.endCard,
      background:
        eg === undefined || eg === false
          ? null
          : cardGradient(typeof eg === "number" ? eg : hashString(m.endCard)),
      logo: m.logo ? "hero" : null,
      glyph: null,
      glyphColor: null,
      durationMs: (m.endHold ?? DEFAULTS.endHold) / globalSpeed,
    });
  }

  const link = encodeShareLinkWithHistory(start, moveTokens, 0);
  if (link.length > MAX_SHARE_PARAM_CHARS) {
    throw new Error(`line is too long to share: ${link.length} chars, limit ${MAX_SHARE_PARAM_CHARS}`);
  }

  return {
    out: rel(m.out ?? path.replace(/\.json$/, ".mp4")),
    frames,
    link,
    totalPlies: positions.length - 1,
    hasEvalBar: evals !== null,
    baseUrl: m.baseUrl,
    fps,
  };
}
