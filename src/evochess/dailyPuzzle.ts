/**
 * Today's puzzle, fetched from the collector.
 *
 * The client never sends a date. The row-level policy on `puzzles` caps the
 * result at today, so a wrong or tampered clock can neither reach tomorrow's
 * puzzle nor break today's. That policy is the whole security model: the key
 * below ships in the bundle.
 *
 * Every failure is silent, as in `telemetry.ts`: null means no puzzle and the
 * app carries on as if `?daily` were not there.
 */

import type { Color } from "chess.js";

export interface DailyPuzzle {
  /** "2026-08-01", from the row, never computed locally. */
  date: string;
  /** A `?p=` share-link payload — the whole position. */
  param: string;
  /** The number of the solver's moves in the mating line. */
  mateIn: number;
}

/** The newest row visible to `anon`, which the policy caps at today. */
const QUERY = "/rest/v1/puzzles?select=publish_date,param,mate_in&order=publish_date.desc&limit=1";

function parseRow(row: unknown): DailyPuzzle | null {
  if (!row || typeof row !== "object") return null;
  const { publish_date: date, param, mate_in: mateIn } = row as Record<string, unknown>;
  if (typeof date !== "string" || date.length === 0) return null;
  if (typeof param !== "string" || param.length === 0) return null;
  if (typeof mateIn !== "number" || !Number.isFinite(mateIn)) return null;
  return { date, param, mateIn };
}

export async function fetchDailyPuzzle(): Promise<DailyPuzzle | null> {
  // Read per call rather than at module load, so a test can vary the config.
  const endpoint = import.meta.env.VITE_TELEMETRY_URL ?? "";
  const key = import.meta.env.VITE_TELEMETRY_KEY ?? "";
  if (!endpoint || !key) return null;
  try {
    const res = await fetch(`${endpoint}${QUERY}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return parseRow(rows[0]);
  } catch {
    return null;
  }
}

// ------------------------------------------------------- solved / failed

/** The attempt in progress. `resolved` is the once-per-load guard. */
export interface PuzzleState {
  date: string;
  mateIn: number;
  /** `moveLog.length` when the puzzle was loaded. */
  startPly: number;
  resolved: boolean;
}

/** The board as it stands, at the moment the attempt is checked. */
export interface PuzzlePosition {
  /** True once the game is over by any means. */
  gameOver: boolean;
  isCheckmate: boolean;
  /** Side to move now. */
  turn: Color;
  humanColor: Color;
  /** `moveLog.length` now. */
  plies: number;
}

export type PuzzleProgress = PuzzlePosition & Pick<PuzzleState, "startPly" | "mateIn">;

/**
 * The event to fire for this attempt, or null, marking the attempt resolved on
 * the way past.
 *
 * Solved and failed fire at most once per load. Takeback is available and can
 * walk the ply count backwards; this guard is what stops that becoming a second
 * event.
 */
export function resolvePuzzle(puzzle: PuzzleState, position: PuzzlePosition): "solved" | "failed" | null {
  if (puzzle.resolved) return null;
  const outcome = puzzleOutcome({ ...position, startPly: puzzle.startPly, mateIn: puzzle.mateIn });
  if (outcome) puzzle.resolved = true;
  return outcome;
}

/**
 * Whether the attempt has resolved, checked straight after a move and before
 * the reply.
 *
 * The ply arithmetic is the part worth stating: `moveLog` holds one entry per
 * ply, so the solver's `k`-th move is ply `startPly + 2k - 1`, and the attempt
 * has run out once `plies - startPly >= 2 * mateIn - 1`. A ply later would call
 * a mate-in-2 failed on the very move that delivers mate — hence the checkmate
 * test coming first.
 */
export function puzzleOutcome(p: PuzzleProgress): "solved" | "failed" | null {
  if (p.gameOver) {
    // Mate against the engine's side is the solve. Everything else that ends
    // the game — stalemate, a draw, the solver being mated — is a failure.
    return p.isCheckmate && p.turn !== p.humanColor ? "solved" : "failed";
  }
  return p.plies - p.startPly >= 2 * p.mateIn - 1 ? "failed" : null;
}
