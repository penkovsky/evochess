import { useEffect, useRef, useState, type RefObject } from "react";
import type { Color, Square } from "chess.js";
import type { ApplyMoveOptions, EvoChessGame } from "../../evochess/game";
import { encodeShareLink } from "../../evochess/shareLink";
import type { LoadedGame } from "../../evochess/persistence";
import {
  POLL_MS,
  clearSeat,
  countFailure,
  isConnectionLost,
  inviteUrl,
  lmCreate,
  lmFetch,
  lmJoin,
  lmRematch,
  loadSeat,
  mergeLive,
  newMatchState,
  rematchState,
  replay,
  saveSeat,
  setMatchParam,
  sendMove,
  shouldPoll,
  type FetchResult,
  type LiveSeat,
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
  /** Three polls in a row failed. The board stays, the poll keeps trying. */
  connectionLost: boolean;
  /** `?lm=` on load, and a reload with it. Read-only until the seat is taken. */
  openLiveMatch: (matchId: string, saved: LoadedGame | null) => Promise<void>;
  joinLiveMatch: () => Promise<void>;
  createLiveMatch: (seatColor: Color) => Promise<string | null>;
  /** Leaves the match on the board, if there is one. The seat goes with it. */
  leaveLiveMatch: () => void;
  /** Sends a move of ours, and breaks the match if the server refuses it. */
  sendLocalMove: (game: EvoChessGame, from: Square, to: Square, options: ApplyMoveOptions) => void;
  /** Asks for a rematch, or accepts the opponent's. Both are the same call. */
  askRematch: () => Promise<void>;
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
  /** A rematch has put a fresh game on the board: whatever the last one left. */
  onRematchStart: () => void;
  /**
   * The move path. A box rather than a value, because it is defined after this
   * hook and the poll reaches it from a timer.
   */
  applyMoveRef: RefObject<ApplyMove>;
}

/**
 * A match played over a link (docs/live-match.md). Owns which match is on
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
  onRematchStart,
  applyMoveRef,
}: UseLiveMatchArgs): UseLiveMatch {
  const [live, setLive] = useState<LiveView | null>(null);
  const liveRef = useRef<LiveView | null>(null);
  liveRef.current = live;
  const [joining, setJoining] = useState(false);
  // A rematch call is in flight. The press and the poll both make it, and only
  // one of them may.
  const rematchingRef = useRef(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const failuresRef = useRef(0);

  /** Every read goes through here: a failure counts, an answer clears. */
  function noteRead(result: FetchResult) {
    failuresRef.current = countFailure(failuresRef.current, result);
    setConnectionLost(isConnectionLost(failuresRef.current));
  }

  /**
   * The boards have diverged. Terminal: `canMoveNow` and `shouldPoll` both
   * refuse on it, so the only way out is a new game, which drops the match.
   * Written through the ref as well, since the poll reads it before React has
   * re-rendered.
   */
  function markOutOfSync() {
    console.warn("evochess: live match is out of sync");
    if (liveRef.current) liveRef.current = { ...liveRef.current, outOfSync: true };
    setLive((v) => (v ? { ...v, outOfSync: true } : v));
  }

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
    if (!built) return false;
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
      rematchW: state.rematchW,
      rematchB: state.rematchB,
      rematchId: state.rematchId,
      seat: loadSeat(matchId),
      outOfSync: false,
    });
    rerender();
    return true;
  }

  async function openLiveMatch(matchId: string, saved: LoadedGame | null) {
    const state = await lmFetch(matchId, 0);
    if (state === null) {
      setLinkNotice("Could not reach that match. Check your connection and reload.");
      return;
    }
    if (state === "unknown" || !showLiveMatch(matchId, state, saved, true)) {
      setLinkNotice("That match link could not be opened.");
    }
  }

  /** A gap: throw the line away and replay. A failed read is just retried. */
  async function resyncLive(lv: LiveView) {
    const state = await lmFetch(lv.matchId, 0);
    noteRead(state);
    if (state === null) return;
    if (state === "unknown" || !showLiveMatch(lv.matchId, state, null, false)) markOutOfSync();
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
    if (!shouldPoll(lv, plies, game.isGameOver(), document.hidden, isConnectionLost(failuresRef.current))) return;
    const state = await lmFetch(lv.matchId, plies);
    if (gameRef.current !== game) return;
    noteRead(state);
    if (state === null) return;
    // A match that is not there is an answer, not a failure. Nothing to apply.
    if (state === "unknown") return;
    // Functional: this poll started before the seat was taken or the match
    // broke, and `lv` is that old view. Merging onto the current one is what
    // keeps a join, and out of sync, from being undone by a slow read.
    setLive((v) => (v ? mergeLive(v, state) : v));
    // The opponent accepted, so the next match exists and holds a seat of ours.
    // Collecting it is the same call the ask is.
    if (state.rematchId && lv.seat) return void askRematch();
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
    // Nothing here can reclaim a seat, so keeping the token would only mislead.
    clearSeat();
    setLive(null);
    liveRef.current = null;
    failuresRef.current = 0;
    setConnectionLost(false);
    window.history.replaceState(null, "", setMatchParam(window.location.href, null));
  }

  /**
   * Creates a match from the position on the board, then puts that match on the
   * board through the same path everyone else uses. It has to be the same path:
   * ply numbering is per match and starts at 1, so the creator has to be playing
   * a game whose `moveLog` is empty and whose base is `start_payload`, exactly
   * as the joiner is. Keeping the old board would make their first send ply
   * N+1, which the server rejects as a gap.
   *
   * New Game resets the board first, so a match started there has no
   * `start_payload`. `?lm=` goes into the address bar so a reload resumes it
   * the way the invited player's does.
   */
  async function createLiveMatch(seatColor: Color): Promise<string | null> {
    const game = gameRef.current;
    const payload = game.moveLog.length === 0 ? null : encodeShareLink(game);
    const seat = await lmCreate(payload, game.turn, seatColor);
    saveSeat(seat);
    window.history.replaceState(null, "", setMatchParam(window.location.href, seat.matchId));
    const shown = showLiveMatch(
      seat.matchId,
      newMatchState(payload, game.turn, seatColor),
      savedGameRef.current,
      true
    );
    // The row exists, but the position will not replay, so there is no board to
    // play it on.
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
      if (state === null || state === "unknown") return;
      const seat = await lmJoin(lv.matchId, state);
      saveSeat(seat);
      setLive((v) => (v ? { ...v, status: "live", joined: true, freeSeat: null, seat } : v));
      rerender();
    } catch {
      // Taken, unknown or over. The client stays read-only; a refetch on the
      // next poll is what corrects the button.
      setLinkNotice("That seat has already been taken.");
    } finally {
      setJoining(false);
    }
  }

  /** The next match, on the board, with our swapped seat in it. */
  function startRematch(next: LiveSeat) {
    saveSeat(next);
    window.history.replaceState(null, "", setMatchParam(window.location.href, next.matchId));
    failuresRef.current = 0;
    setConnectionLost(false);
    if (!showLiveMatch(next.matchId, rematchState(next), null, false)) {
      markOutOfSync();
      return;
    }
    onRematchStart();
  }

  /**
   * The ask and the accept, which are one call: the second one to arrive is
   * what creates the next match. Also how each side collects its token for it,
   * since `lm_fetch` hands out no tokens.
   */
  async function askRematch() {
    const lv = liveRef.current;
    if (!lv?.seat || rematchingRef.current) return;
    rematchingRef.current = true;
    try {
      const result = await lmRematch(lv.matchId, lv.seat.token);
      if (result === null) return;
      if (result === "asked") {
        const me = lv.seat.seat;
        setLive((v) => (v ? { ...v, rematchW: me === "w" || v.rematchW, rematchB: me === "b" || v.rematchB } : v));
        return;
      }
      startRematch(result);
    } finally {
      rematchingRef.current = false;
    }
  }

  function sendLocalMove(game: EvoChessGame, from: Square, to: Square, options: ApplyMoveOptions) {
    const lv = liveRef.current;
    if (!lv?.seat) return;
    // Not awaited: the board never waits on the network, and `sendMove` retries.
    void sendMove(lv.seat, game.moveLog.length, from, to, options).then((sent) => {
      // A gap, a conflict, not-your-seat, or an unconfigured collector. The
      // move is on our board and will never be on theirs, and no refetch can
      // undo that, so the match is over as a match.
      if (!sent && gameRef.current === game) markOutOfSync();
    });
  }

  useEffect(() => {
    // New Game creates a match from the opening. Creating one from the position
    // on the board has no UI, and stays here (docs/live-match.md §Milestone 2).
    (window as unknown as Record<string, unknown>).evoLive = {
      create: (seatColor: Color = "w") => createLiveMatch(seatColor),
      state: () => liveRef.current,
      leave: () => leaveLiveMatch(),
    };
  });

  return {
    live,
    liveRef,
    joining,
    connectionLost,
    openLiveMatch,
    joinLiveMatch,
    createLiveMatch,
    leaveLiveMatch,
    sendLocalMove,
    askRematch,
  };
}
