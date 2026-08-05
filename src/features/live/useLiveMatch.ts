import { useEffect, useRef, useState, type RefObject } from "react";
import type { Color, Square } from "chess.js";
import type { ApplyMoveOptions, EvoChessGame } from "../../evochess/game";
import { encodeShareLink } from "../../evochess/shareLink";
import type { LoadedGame } from "../../evochess/persistence";
import {
  POLL_MS,
  clearSeat,
  inviteUrl,
  lmCreate,
  lmFetch,
  lmJoin,
  loadSeat,
  newMatchState,
  replay,
  saveSeat,
  sendMove,
  shouldPoll,
  type LiveState,
  type LiveView,
} from "../../liveMatch";
import type { AdoptOptions } from "../share/useSharedPosition";

/** Applies a move to the board. `remote` marks one that arrived from the opponent. */
export type ApplyMove = (from: Square, to: Square, options: ApplyMoveOptions, remote?: boolean) => void;

export interface UseLiveMatch {
  /** The match on the board, or null. */
  live: LiveView | null;
  /**
   * The same, readable from a timer callback: the poll and the move path both
   * run from closures React has not refreshed.
   */
  liveRef: RefObject<LiveView | null>;
  /** The free seat is being claimed, so the button cannot race itself. */
  joining: boolean;
  /** `?lm=` on load, and a reload with it. Read-only until the seat is taken. */
  openLiveMatch: (matchId: string, saved: LoadedGame | null) => Promise<void>;
  joinLiveMatch: () => Promise<void>;
  createLiveMatch: (seatColor: Color) => Promise<string | null>;
  /** Leaves the match on the board, if there is one. The seat goes with it. */
  leaveLiveMatch: () => void;
  /** Sends a move of ours, and resyncs if the server will not take it. */
  sendLocalMove: (game: EvoChessGame, from: Square, to: Square, options: ApplyMoveOptions) => void;
}

export interface UseLiveMatchArgs {
  gameRef: RefObject<EvoChessGame>;
  historyRef: RefObject<EvoChessGame[]>;
  clockRef: RefObject<Record<Color, number>>;
  clockHistoryRef: RefObject<Record<Color, number>[]>;
  rerender: () => void;
  adoptPosition: (opts: AdoptOptions) => void;
  savedGameRef: RefObject<LoadedGame | null>;
  setLinkNotice: (notice: string | null) => void;
  /** A match is two people at one board, whatever the pickers say. */
  setSetupMode: (mode: "human-human") => void;
  clearPrompts: () => void;
  resetPonder: () => void;
  /**
   * The move path. A box rather than a value, because it is defined after this
   * hook and the poll reaches it from a timer.
   */
  applyMoveRef: RefObject<ApplyMove>;
}

/**
 * A match played over a link (docs/live-match.md, M1). Owns which match is on
 * the board, the poll that brings the opponent's moves in, and the seat.
 * Putting the position on the board goes through `adoptPosition`, the same path
 * a `?p=` link takes, so the opener's own game is held and restorable exactly
 * as it is for one.
 */
export function useLiveMatch({
  gameRef,
  historyRef,
  clockRef,
  clockHistoryRef,
  rerender,
  adoptPosition,
  savedGameRef,
  setLinkNotice,
  setSetupMode,
  clearPrompts,
  resetPonder,
  applyMoveRef,
}: UseLiveMatchArgs): UseLiveMatch {
  const [live, setLive] = useState<LiveView | null>(null);
  const liveRef = useRef<LiveView | null>(null);
  liveRef.current = live;
  const [joining, setJoining] = useState(false);

  /**
   * Puts a match on the board, replayed from its start position. The `?lm=`
   * bootstrap, a reload and the resync all come through here, so there is one
   * implementation of what a match looks like now.
   *
   * `initial` is the first time, which is the handover. A resync keeps all of
   * that and only swaps the moves.
   */
  function showLiveMatch(matchId: string, state: LiveState, saved: LoadedGame | null, initial: boolean) {
    const built = replay(state.startPayload, state.moves);
    if (!built) {
      console.warn("evochess: live match would not replay, so it is out of sync");
      return false;
    }
    if (initial) {
      adoptPosition({
        game: built.game,
        history: built.snapshots,
        payload: state.startPayload,
        saved,
        legal: true,
      });
      setSetupMode("human-human");
    } else {
      gameRef.current = built.game;
      historyRef.current = built.snapshots;
      clockHistoryRef.current = built.snapshots.map(() => ({ ...clockRef.current }));
      clearPrompts();
      resetPonder(); // a position from outside this session (ponder-spec.md §5.3)
    }
    setLive({
      matchId,
      status: state.status,
      firstMover: state.firstMover,
      startPayload: state.startPayload,
      joined: state.joined,
      freeSeat: state.freeSeat,
      seat: loadSeat(matchId),
    });
    rerender();
    return true;
  }

  async function openLiveMatch(matchId: string, saved: LoadedGame | null) {
    const state = await lmFetch(matchId, 0);
    if (!state) {
      setLinkNotice("That match link could not be opened.");
      return;
    }
    showLiveMatch(matchId, state, saved, true);
  }

  /** A gap, or a move the engine rejects: throw the line away and replay. */
  async function resyncLive(lv: LiveView) {
    const state = await lmFetch(lv.matchId, 0);
    if (state) showLiveMatch(lv.matchId, state, null, false);
  }

  /**
   * One poll. Silent on the local turn (nothing can arrive), while hidden, and
   * once the game is over. The interval keeps running and does nothing, which
   * is cheaper than tearing it down and rebuilding it on every ply.
   */
  async function pollLive() {
    const lv = liveRef.current;
    if (!lv) return;
    const game = gameRef.current;
    const plies = game.moveLog.length;
    if (!shouldPoll(lv, plies, game.isGameOver(), document.hidden)) return;
    const state = await lmFetch(lv.matchId, plies);
    if (!state || gameRef.current !== game) return;
    setLive({ ...lv, status: state.status, joined: state.joined, freeSeat: state.freeSeat });
    for (const m of state.moves) {
      if (m.ply !== gameRef.current.moveLog.length + 1) return void resyncLive(lv); // a gap
      const before = gameRef.current.moveLog.length;
      applyMoveRef.current(m.from as Square, m.to as Square, m.opts, true);
      // The move path swallows an illegal move into an alert, so the ply count
      // is what says whether the engine took it.
      if (gameRef.current.moveLog.length === before) return void resyncLive(lv);
    }
  }

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void pollLive(), POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void pollLive();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.matchId]);

  function leaveLiveMatch() {
    if (!liveRef.current) return;
    // Nothing in M1 can reclaim a seat, so keeping the token would only mislead.
    clearSeat();
    setLive(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("lm");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  /**
   * Creates a match from the position on the board, then puts that match on the
   * board through the same path everyone else uses. It has to be the same path:
   * ply numbering is per match and starts at 1, so the creator has to be playing
   * a game whose `moveLog` is empty and whose base is `start_payload`, exactly
   * as the joiner is. Keeping the old board would make their first send ply
   * N+1, which the server rejects as a gap.
   *
   * M1's only entry point is the console (`evoLive.create`); `?lm=` goes into
   * the address bar so a reload resumes it the way the invited player's does.
   */
  async function createLiveMatch(seatColor: Color): Promise<string | null> {
    const game = gameRef.current;
    const payload = game.moveLog.length === 0 ? null : encodeShareLink(game);
    const seat = await lmCreate(payload, game.turn, seatColor);
    saveSeat(seat);
    const url = new URL(window.location.href);
    url.searchParams.set("lm", seat.matchId);
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    const shown = showLiveMatch(
      seat.matchId,
      newMatchState(payload, game.turn, seatColor),
      savedGameRef.current,
      true
    );
    // The row exists, but the position will not replay, so there is no board to
    // play it on. `showLiveMatch` has logged why.
    if (!shown) {
      setLinkNotice("That position could not start a live match.");
      return null;
    }
    const invite = inviteUrl(seat.matchId);
    try {
      await navigator.clipboard.writeText(invite);
    } catch {
      /* the URL is returned either way */
    }
    return invite;
  }

  /**
   * Takes the free seat. Deliberately a press and never a page load: the link
   * is a read capability until someone acts on it, so the first person to open
   * one pasted into a group chat does not become the opponent.
   */
  async function joinLiveMatch() {
    const lv = liveRef.current;
    if (!lv || lv.seat || joining) return;
    setJoining(true);
    try {
      const state = await lmFetch(lv.matchId, 0);
      if (!state) return;
      const seat = await lmJoin(lv.matchId, state);
      saveSeat(seat);
      setLive({ ...lv, status: "live", joined: true, freeSeat: null, seat });
      rerender();
    } catch {
      // Taken, unknown or over. The client stays read-only; a refetch on the
      // next poll is what corrects the button.
      setLinkNotice("That seat has already been taken.");
    } finally {
      setJoining(false);
    }
  }

  function sendLocalMove(game: EvoChessGame, from: Square, to: Square, options: ApplyMoveOptions) {
    const lv = liveRef.current;
    if (!lv?.seat) return;
    // Not awaited: the board never waits on the network, and `sendMove` retries.
    void sendMove(lv.seat, game.moveLog.length, from, to, options).then((sent) => {
      // A terminal rejection: a gap, a conflict, not-your-seat, or an
      // unconfigured collector. M1 has no out-of-sync UI, so the signal is a
      // console line and the same resync a gap in the poll triggers. Worst case
      // it rolls this move back off the board, which is honest, since the
      // server never took it.
      if (sent || gameRef.current !== game) return;
      console.warn("evochess: live move was not accepted, so the board is out of sync");
      void resyncLive(lv);
    });
  }

  useEffect(() => {
    // M1 has no UI for creating a match (docs/live-match.md §"Milestone 1").
    (window as unknown as Record<string, unknown>).evoLive = {
      create: (seatColor: Color = "w") => createLiveMatch(seatColor),
      state: () => liveRef.current,
      leave: () => {
        clearSeat();
        setLive(null);
      },
    };
  });

  return { live, liveRef, joining, openLiveMatch, joinLiveMatch, createLiveMatch, leaveLiveMatch, sendLocalMove };
}
