import { useRef, useState, type RefObject } from "react";
import type { Color } from "chess.js";
import type { EvoChessGame } from "../../evochess/game";
import type { LoadedGame } from "../../evochess/persistence";
import {
  cachePuzzle,
  cachePuzzleList,
  countAttempt,
  fetchPuzzles,
  loadPuzzleOutcomes,
  loadPuzzleSeen,
  markPuzzleSeen,
  recordPuzzleOutcome,
  resolvePuzzle,
  type DailyPuzzle,
  type PuzzleAttempts,
  type PuzzleOutcomes,
  type PuzzleState,
} from "../../evochess/dailyPuzzle";
import { track } from "../../telemetry";

export interface UseDailyPuzzle {
  /**
   * The puzzle the entry point offers, from the cache on the first paint and
   * from the response once it lands. Null hides the entry point entirely: a
   * player who has never loaded a puzzle and is offline sees the app exactly as
   * it was before this existed.
   */
  puzzle: DailyPuzzle | null;
  /**
   * The published puzzles, newest first, for the history list. Same source as
   * `puzzle`, which is its first row. Empty until a response or a cache lands.
   */
  history: DailyPuzzle[];
  /** What happened on each date here, which the list shows against the rows. */
  outcomes: PuzzleOutcomes;
  /** True until the offered puzzle has been opened once. Highlights the button. */
  puzzleFresh: boolean;
  /**
   * The attempt on the board, if any. A ref, because the move path and the
   * engine chain both read it from timer callbacks. Nothing persists: a reload
   * resumes the puzzle as an ordinary shared game and it stops counting as one.
   */
  puzzleRef: RefObject<PuzzleState | null>;
  /** The outcome of the attempt on the board, which the banner over it reads. */
  puzzleResult: null | "solved" | "failed";
  /** Starts a fresh attempt at `row` on the position already on the board. */
  beginAttempt: (row: DailyPuzzle, startPly: number, aiColor: Color) => void;
  /** Leaves the puzzle, so no tag and no stale banner outlive the position. */
  clearPuzzle: () => void;
  checkPuzzle: (aiColor: Color) => "solved" | "failed" | null;
  /** The date to tag `game_end` and the `games` row with, or null. */
  puzzleDate: () => string | null;
  bootstrapPuzzle: (opts: BootstrapPuzzleOptions) => void;
}

export interface BootstrapPuzzleOptions {
  /** Whether the page was opened with `?daily`. */
  daily: boolean;
  /** The cached puzzle, which is what puts the entry point on the first paint. */
  cached: DailyPuzzle | null;
  /** The cached history, so the list is not empty before the response lands. */
  cachedList: DailyPuzzle[];
  /**
   * The cached puzzle `?daily` asked to have put on the board, or null. Decided
   * by `resolveStartup`, so the precedence lives in one place.
   */
  auto: DailyPuzzle | null;
  /** The autosave read at page load, handed to `load` so it can be held. */
  saved: LoadedGame | null;
  /** The ply count the fetch is racing. */
  plyAtLoad: number;
  /** Puts a puzzle on the board. Owned by the caller, since it hands the board over. */
  load: (row: DailyPuzzle, saved: LoadedGame | null) => void;
  /** The game already being held for the puzzle on the board, if there is one. */
  heldGame: () => LoadedGame | null;
}

export interface UseDailyPuzzleArgs {
  gameRef: RefObject<EvoChessGame>;
}

/**
 * The puzzle of the day: which one is on offer, which one is being attempted,
 * and whether the attempt has resolved. Putting one on the board is the
 * caller's job, since that is the shared-position handover, not a puzzle
 * concern.
 */
export function useDailyPuzzle({ gameRef }: UseDailyPuzzleArgs): UseDailyPuzzle {
  const [puzzle, setPuzzle] = useState<DailyPuzzle | null>(null);
  const [history, setHistory] = useState<DailyPuzzle[]>([]);
  const [outcomes, setOutcomes] = useState<PuzzleOutcomes>(() => loadPuzzleOutcomes());
  const [puzzleResult, setPuzzleResult] = useState<null | "solved" | "failed">(null);
  // Date of the last puzzle opened, persisted so the highlight survives a reload.
  const [seen, setSeen] = useState<string | null>(() => loadPuzzleSeen());
  // `resolved` is the once-per-load guard on the solved/failed event: a takeback
  // can walk the ply count backwards, and the guard is what stops that becoming
  // a second event. The row itself is kept after that, since `game_end` and the
  // `games` row are still to be tagged.
  const puzzleRef = useRef<PuzzleState | null>(null);
  // Loads of one date within this session, counting from 1. Nothing persists,
  // consistent with the attempt itself not surviving a reload.
  const attemptsRef = useRef<PuzzleAttempts | null>(null);

  function beginAttempt(row: DailyPuzzle, startPly: number, aiColor: Color) {
    puzzleRef.current = { date: row.date, mateIn: row.mateIn, startPly, aiColor, resolved: false };
    // A fresh attempt, so the next outcome fires again and the banner from the
    // last one goes.
    attemptsRef.current = countAttempt(attemptsRef.current, row.date);
    setPuzzleResult(null);
    markPuzzleSeen(row.date);
    setSeen(row.date);
    track("puzzle_open", { date: row.date, mate_in: row.mateIn, attempts: attemptsRef.current.count });
  }

  function clearPuzzle() {
    puzzleRef.current = null;
    setPuzzleResult(null);
  }

  /**
   * Fires `puzzle_solved` or `puzzle_failed`, once, and raises the banner over
   * the board. Called straight after a move and before the reply: a ply later
   * would call a mate-in-2 failed on the move that delivers mate.
   *
   * Returns the outcome so the caller can hold the engine back: a failure can
   * land with the game still playable, since running out of moves is not the
   * game ending.
   *
   * `aiColor` is passed rather than read, because the callers that matter run
   * from timers holding a colour React state has not caught up to.
   */
  function checkPuzzle(aiColor: Color): "solved" | "failed" | null {
    const attempt = puzzleRef.current;
    if (!attempt) return null;
    const game = gameRef.current;
    const outcome = resolvePuzzle(attempt, {
      gameOver: game.isGameOver(),
      isCheckmate: game.chess.isCheckmate(),
      turn: game.turn,
      humanColor: aiColor === "w" ? "b" : "w",
      plies: game.moveLog.length,
    });
    if (!outcome) return null;
    setPuzzleResult(outcome);
    // Kept per date, so the history list shows what has been done here. Local
    // only: the events below are what leaves the browser.
    setOutcomes(recordPuzzleOutcome(attempt.date, outcome));
    track(outcome === "solved" ? "puzzle_solved" : "puzzle_failed", {
      date: attempt.date,
      mate_in: attempt.mateIn,
      // The same number the open carried. Redundant, and it means a solve or a
      // failure can be read on its own without joining back to the open.
      attempts: attemptsRef.current?.count ?? 1,
    });
    return outcome;
  }

  /**
   * The cache handover and the fetch, run once from the startup path.
   *
   * The cache puts the button on screen from the first paint; `?daily` takes
   * its puzzle from there too, rather than waiting for a response it already
   * has an answer for. The fetch fires on every load all the same, and is not
   * awaited: the client cannot tell whether its own idea of today is right, and
   * one request per load is cheap.
   */
  function bootstrapPuzzle({ daily, cached, cachedList, auto, saved, plyAtLoad, load, heldGame }: BootstrapPuzzleOptions) {
    if (cached) setPuzzle(cached);
    if (cachedList.length > 0) setHistory(cachedList);
    // Deferred rather than applied here, so it lands at the same point in the
    // life of the page the response's own load does. The startup path is still
    // applying what the board holds, and swapping the position in before that
    // would leave the mount-time engine chain running against the colours of
    // the game the puzzle displaced, which is the engine taking the solver's
    // first move.
    if (auto) setTimeout(() => load(auto, saved), 0);
    void fetchPuzzles().then((rows) => {
      // Empty: keep whatever the cache held.
      if (rows.length === 0) return;
      setHistory(rows);
      cachePuzzleList(rows);
      // Newest first, so this is today's, and everything below is unchanged:
      // the history rides along on the same request but decides nothing.
      const row = rows[0];
      cachePuzzle(row);
      // A response that lands while a puzzle is already on the board stops
      // here: it must not swap the position out from under a player who is
      // mid-solve. The exception is the puzzle it has just found to be a day
      // stale, sitting untouched on the board because the cache is what
      // `?daily` and the button had to go on. That one is replaced with
      // today's, which is the puzzle the player asked for.
      const onBoard = puzzleRef.current;
      const staleOnBoard =
        onBoard !== null && onBoard.date < row.date && gameRef.current.moveLog.length === onBoard.startPly;
      if (onBoard && !staleOnBoard) return;
      setPuzzle(row);
      // A game in progress wins, and only under `?daily`: the player never
      // asked for the puzzle at that moment, and taking the board would lose
      // the moves they just made, since the game being held would be the
      // snapshot from page load and "back to my game" would rewind past them. A
      // dropped puzzle is a load without one, and the next `?daily` gets it.
      // The button is the player asking, so it has no such rule.
      //
      // The replacement takes the game already being held for the puzzle on the
      // board, not the page-load autosave: the player may have reached the
      // stale one through the button after twenty moves, and `saved` would
      // rewind past them.
      if (staleOnBoard) load(row, heldGame());
      else if (daily && gameRef.current.moveLog.length === plyAtLoad) load(row, saved);
    });
  }

  return {
    puzzle,
    history,
    outcomes,
    puzzleFresh: puzzle !== null && seen !== puzzle.date,
    puzzleRef,
    puzzleResult,
    beginAttempt,
    clearPuzzle,
    checkPuzzle,
    puzzleDate: () => puzzleRef.current?.date ?? null,
    bootstrapPuzzle,
  };
}
