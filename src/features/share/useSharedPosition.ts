import { useRef, useState, type RefObject } from "react";
import type { Color } from "chess.js";
import type { EvoChessGame } from "../../evochess/game";
import {
  clearParkedGame,
  loadParkedGame,
  parkSavedGame,
  type LoadedGame,
} from "../../evochess/persistence";
import { newGameMeta, type GameMeta } from "../../telemetry";

export interface AdoptOptions {
  /** The position to put on the board. */
  game: EvoChessGame;
  /** Positions strictly before it, if the line that led there is known. */
  history?: EvoChessGame[];
  /** The payload it arrived on, which the finished-game log replays from. */
  payload: string | null;
  /** The player's own game, held for "back to my game". */
  saved: LoadedGame | null;
  /** False for a position that could not have occurred (spec §5.2). */
  legal: boolean;
}

/** The clock a position with no clock of its own starts on. */
const DEFAULT_MINUTES = 10;

export interface UseSharedPosition {
  /**
   * Whether the board holds a position from outside this session that the
   * recipient has not yet played from. Until they do it lives in memory only,
   * so their own game is still in localStorage and still restorable (spec §6.4).
   */
  sharedPending: boolean;
  /** The autosave a shared position arrived on top of, for "back to my game". */
  savedGameRef: RefObject<LoadedGame | null>;
  /** Whether a game of the player's own is sitting in the parked slot. */
  parked: boolean;
  setParked: (parked: boolean) => void;
  /**
   * Why a link was refused (spec §5.1), or what went wrong with a match.
   * Purely informational: startup has already fallen back by the time it shows.
   */
  linkNotice: string | null;
  setLinkNotice: (notice: string | null) => void;
  /**
   * Stays true after `sharedPending` clears, for as long as the game on the
   * board is the one that arrived from elsewhere. A game played from someone
   * else's position is not a game against the AI from the opening, so its
   * result is not recorded against the level's score and no score is shown when
   * it ends. Persisted with the save, so a reload does not turn it back into a
   * scored game (persistence.ts `fromShared`).
   */
  fromShared: boolean;
  setFromShared: (from: boolean) => void;
  /** Hands the board to a position from outside this session. */
  adoptPosition: (opts: AdoptOptions) => void;
  goLive: () => void;
  parkOwnGameAndGoLive: () => void;
  /** The game to go back to, or null. Clears the parked slot as it hands it over. */
  takeOwnGame: () => LoadedGame | null;
  /** Whether there is a game of the player's own to go back to at all. */
  hasSavedGame: boolean;
}

export interface UseSharedPositionArgs {
  gameRef: RefObject<EvoChessGame>;
  historyRef: RefObject<EvoChessGame[]>;
  gameMetaRef: RefObject<GameMeta>;
  resumedRef: RefObject<boolean>;
  clockRef: RefObject<Record<Color, number>>;
  clockHistoryRef: RefObject<Record<Color, number>[]>;
  resetClock: (minutes: number) => void;
  /** A position from outside this session (ponder-spec.md §5.3). */
  resetPonder: () => void;
  setLockout: (locked: boolean) => void;
  clearPuzzle: () => void;
  clearPrompts: () => void;
}

/**
 * Positions that arrive from somewhere else: a `?p=` link, the puzzle of the
 * day, a live match. All three take the board the same way
 * (docs/share-links-spec.md §6), and the point of doing it once is that the
 * recipient's own game is held rather than lost, whichever of them it was.
 */
export function useSharedPosition({
  gameRef,
  historyRef,
  gameMetaRef,
  resumedRef,
  clockRef,
  clockHistoryRef,
  resetClock,
  resetPonder,
  setLockout,
  clearPuzzle,
  clearPrompts,
}: UseSharedPositionArgs): UseSharedPosition {
  const [sharedPending, setSharedPending] = useState(false);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [fromShared, setFromShared] = useState(false);
  const [parked, setParked] = useState(false);
  const savedGameRef = useRef<LoadedGame | null>(null);

  function adoptPosition({ game, history, payload, saved, legal }: AdoptOptions) {
    savedGameRef.current = saved;
    gameRef.current = game;
    historyRef.current = history ?? [];
    gameMetaRef.current = newGameMeta(game.chess.fen(), payload);
    resumedRef.current = false;
    setSharedPending(true);
    setFromShared(true);
    setLinkNotice(null);
    // The game about to be displaced may have been a puzzle. Its tag must not
    // follow onto this one, nor its banner outlive the position it described.
    clearPuzzle();
    setLockout(!legal);
    // Whatever time was left on the recipient's own clock has nothing to do
    // with this position.
    resetClock(saved?.timerMinutes ?? DEFAULT_MINUTES);
    // One reading per replayed ply, all of them the clock just reset above.
    // The array has to be as long as the history: `playFromHere` indexes it by
    // ply, and a short one would hand an early ply a later move's reading.
    clockHistoryRef.current = historyRef.current.map(() => ({ ...clockRef.current }));
    clearPrompts();
    resetPonder();
  }

  /**
   * Drops `?p=` from the address bar: the shared game has just become the live
   * one, so a reload must not put the base position back over moves the
   * recipient has played (spec §3, §6.5).
   *
   * Until this point the parameter is deliberately left in the URL. Stripping
   * it on load would mean a reload or a mobile tab restore silently discarded
   * the shared game, since it is only ever held in memory before now.
   */
  function goLive() {
    setSharedPending(false);
    savedGameRef.current = null;
    const url = new URL(window.location.href);
    url.searchParams.delete("p");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  /**
   * The recipient's first move on a shared board, which is the moment the
   * autosave changes hands. Their own game moves to the parked slot first, so
   * "back to my game" survives both the move and any later reload.
   */
  function parkOwnGameAndGoLive() {
    // Only when there is a game of the player's own being held. `parkSavedGame`
    // copies the autosave, and `savedGameRef` is null in exactly the cases
    // where the autosave is no longer theirs: a retried puzzle, or a second
    // link opened on top of a first. Parking then would put the position they
    // have just left over their real game, and "back to my game" would hand
    // back the failed attempt.
    if (savedGameRef.current) setParked(parkSavedGame());
    goLive();
  }

  /**
   * The game to put back, discarding the shared one. Reads the parked slot once
   * the shared game has gone live, and the in-memory copy before that, when
   * nothing has been parked because nothing was at risk.
   */
  function takeOwnGame(): LoadedGame | null {
    const saved = savedGameRef.current ?? loadParkedGame();
    if (!saved) return null;
    clearParkedGame();
    setParked(false);
    return saved;
  }

  return {
    sharedPending,
    savedGameRef,
    parked,
    setParked,
    linkNotice,
    setLinkNotice,
    fromShared,
    setFromShared,
    adoptPosition,
    goLive,
    parkOwnGameAndGoLive,
    takeOwnGame,
    // The parked slot counts: retrying a puzzle sets `sharedPending` again, and
    // by then their own game has already moved there, so without the second
    // half the way back would vanish for the rest of the session.
    hasSavedGame: savedGameRef.current !== null || parked,
  };
}
