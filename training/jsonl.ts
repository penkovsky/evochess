/**
 * Shared JSONL plumbing for the NNUE data generators (`gen.ts`, `augment.ts`):
 * the on-disk record shape (mirrors `Position.to_json` in `position.py`),
 * gzip-aware sink handling with backpressure, and the `stateKey()`-based
 * dedup key. Split out once a second generator (`augment.ts`, mechanism 2 of
 * `nnue-data-coverage-spec.md`) needed the exact same plumbing around a
 * different sampling loop.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { createGzip } from "node:zlib";
import { dirname } from "node:path";
import type { Writable } from "node:stream";
import type { Color } from "chess.js";
import { EvoChessGame } from "../src/evochess/game";
import { stateKey } from "../src/evochess/ai";

export type Termination =
  | "checkmate"
  | "stalemate"
  | "insufficient"
  | "fifty_moves"
  | "repetition"
  | "cap";

// -- record format (mirrors Position.to_json in position.py) ----------------

export interface PositionRecord {
  fen: string;
  minorRights?: [number, number];
  rookRights?: [number, number];
  pawnMoveProgress?: [number, number];
  minorMoveProgress?: [number, number];
  rookCharges?: Record<string, number>;
  rookLocked?: string[];
  epEvolved?: [string, string, Color];
  score?: number; // root search score, White-positive, pawn units
  outcome?: number; // {0, 0.5, 1}, White-positive; backfilled at game end
  termination?: Termination;
  // Not read by position.py (unknown fields round-trip through Python's
  // plain dict.get() untouched); purely for dataset inspection, e.g.
  // distinguishing augmented positions from self-play in a quick `jq` count.
  source?: string;
}

export function pair(counts: Record<Color, number>): [number, number] {
  return [counts.w, counts.b];
}

export function round(x: number): number {
  // Keep the file compact; a hundredth of a pawn is far finer than the label
  // noise, and the target passes the score through a sigmoid anyway.
  return Math.round(x * 100) / 100;
}

/**
 * Snapshot a position with its White-positive search score. Outcome and
 * termination are the caller's responsibility to attach (a full self-play
 * game backfills them at the end; a score-only augmentation record leaves
 * them absent on purpose — see augment.ts).
 */
export function toRecord(game: EvoChessGame, whiteScore: number): PositionRecord {
  const record: PositionRecord = { fen: game.chess.fen(), score: round(whiteScore) };
  if (game.minorRights.w || game.minorRights.b) record.minorRights = pair(game.minorRights);
  if (game.rookRights.w || game.rookRights.b) record.rookRights = pair(game.rookRights);
  if (game.pawnMoveProgress.w || game.pawnMoveProgress.b)
    record.pawnMoveProgress = pair(game.pawnMoveProgress);
  if (game.minorMoveProgress.w || game.minorMoveProgress.b)
    record.minorMoveProgress = pair(game.minorMoveProgress);
  if (game.rookCharges.size) record.rookCharges = Object.fromEntries(game.rookCharges);
  if (game.rookLocked.size) record.rookLocked = [...game.rookLocked].sort();
  if (game.epEvolved) {
    record.epEvolved = [game.epEvolved.skipped, game.epEvolved.victim, game.epEvolved.color];
  }
  return record;
}

// -- prng (mulberry32) -------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -- sink plumbing ------------------------------------------------------------

export function openSink(path: string): { sink: Writable; done: Promise<void> } {
  mkdirSync(dirname(path), { recursive: true });
  const file = createWriteStream(path);
  if (!path.endsWith(".gz")) {
    return { sink: file, done: streamFinished(file) };
  }
  const gzip = createGzip();
  gzip.pipe(file);
  // The file stream is what actually flushes to disk, so wait on it.
  return { sink: gzip, done: streamFinished(file) };
}

function streamFinished(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

/**
 * Write a line, awaiting a `drain` if the stream's buffer is full. The
 * generation loop is CPU-bound and never awaits on its own, so without this
 * the event loop never turns: the file is never actually opened, nothing
 * flushes to disk, and every line piles up in memory until the run ends.
 * Backpressure-aware writes plus `yieldToIO` keep the buffer small and the
 * file growing.
 */
export function writeLine(stream: Writable, line: string): Promise<void> {
  if (stream.write(line)) return Promise.resolve();
  return new Promise((resolve) => stream.once("drain", resolve));
}

/** Hand control back to the event loop so queued disk I/O can make progress. */
export function yieldToIO(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Force a gzip stream's buffered output to disk (no-op for a plain file). */
export function flushSink(sink: Writable): void {
  (sink as Writable & { flush?: () => void }).flush?.();
}

/**
 * Dedup key for a written record. Rebuilds the engine's `stateKey()` from the
 * stored fields so two records of the same EvoChess position collide even when
 * their labels differ — exactly the key `stateKey()` produces, so dedup here
 * matches dedup anywhere else.
 */
export function recordKey(record: PositionRecord): string {
  const game = new EvoChessGame();
  game.chess.load(record.fen);
  const [mw, mb] = record.minorRights ?? [0, 0];
  const [rw, rb] = record.rookRights ?? [0, 0];
  game.minorRights = { w: mw, b: mb };
  game.rookRights = { w: rw, b: rb };
  const [pw, pb] = record.pawnMoveProgress ?? [0, 0];
  const [nw, nb] = record.minorMoveProgress ?? [0, 0];
  game.pawnMoveProgress = { w: pw, b: pb };
  game.minorMoveProgress = { w: nw, b: nb };
  game.rookCharges = new Map(Object.entries(record.rookCharges ?? {})) as typeof game.rookCharges;
  game.rookLocked = new Set(record.rookLocked ?? []) as typeof game.rookLocked;
  game.epEvolved = record.epEvolved
    ? {
        skipped: record.epEvolved[0] as never,
        victim: record.epEvolved[1] as never,
        color: record.epEvolved[2],
        index: 0,
      }
    : null;
  return stateKey(game);
}
