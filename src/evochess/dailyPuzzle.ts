/**
 * Today's puzzle, fetched from the collector.
 *
 * The client never sends a date. The row-level policy on `puzzles` caps the
 * result at today, so a wrong or tampered clock can neither reach tomorrow's
 * puzzle nor break today's. The key below ships in the bundle, so that policy
 * and the column grant beside it are the whole security model.
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

/**
 * The newest row visible to `anon`, which the policy caps at today. These three
 * columns are the only ones granted; asking for `solution` fails with 42501.
 */
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

// ------------------------------------------------------------------ cache

const CACHE_KEY = "evochess-puzzle-v1";

/**
 * The last row that came back, if any.
 *
 * The cache is a fallback for offline and for the moment before the response
 * lands, so the entry point can be on screen from the first paint. It is not a
 * reason to skip the request: the client cannot tell whether its own idea of
 * today is right, and one request per load is cheap.
 *
 * Nothing expires it. The row's own `date` is what the UI shows, so a stale
 * entry reads as an old puzzle rather than a wrong one.
 */
export function loadCachedPuzzle(): DailyPuzzle | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return parseCached(JSON.parse(raw));
  } catch {
    // Malformed, unparseable, or storage unavailable: no cache.
    return null;
  }
}

export function cachePuzzle(puzzle: DailyPuzzle): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...puzzle, fetchedAt: Date.now() }));
  } catch {
    // A full or blocked store costs the entry point one paint, nothing more.
  }
}

function parseCached(entry: unknown): DailyPuzzle | null {
  if (!entry || typeof entry !== "object") return null;
  const { date, param, mateIn } = entry as Record<string, unknown>;
  if (typeof date !== "string" || date.length === 0) return null;
  if (typeof param !== "string" || param.length === 0) return null;
  if (typeof mateIn !== "number" || !Number.isFinite(mateIn)) return null;
  return { date, param, mateIn };
}

/**
 * "1 August 2026", from the row's own date string.
 *
 * Parsed as UTC and formatted in UTC. Never in the local zone: a player just
 * west of Greenwich would otherwise be told the puzzle is for yesterday. One
 * global boundary is what makes "today's puzzle" mean the same thing
 * everywhere, which is also why the UI says so.
 */
export function formatPuzzleDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// --------------------------------------------------------------- attempts

/** How many times this date has been loaded in this session. */
export interface PuzzleAttempts {
  date: string;
  count: number;
}

/**
 * The attempt number of the load about to happen, counting from 1. Nothing
 * persists, so a reload starts the count over — consistent with the attempt
 * itself not surviving a reload.
 */
export function countAttempt(prev: PuzzleAttempts | null, date: string): PuzzleAttempts {
  return prev && prev.date === date ? { date, count: prev.count + 1 } : { date, count: 1 };
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
