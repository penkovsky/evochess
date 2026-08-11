import { useEffect, useRef, useState } from "react";
import type { Color, Square } from "chess.js";
import { EvoChessError, type ApplyMoveOptions } from "./evochess/game";
import { NEXT_LEVEL, type AiLevel } from "./evochess/ai";
import { planMove } from "./evochess/moveOptions";
import { decodeShareLink } from "./evochess/shareLink";
import {
  saveGame,
  loadGame,
  clearSavedGame,
  clearParkedGame,
  hasParkedGame,
  markSavedGameAbandoned,
  resumeHistory,
  resumeMeta,
} from "./evochess/persistence";
import { loadProgress } from "./evochess/tutorialProgress";
import { canMoveNow, drawOffered, inviteUrl, rematchAsks, rematchOffered } from "./liveMatch";
import { formatPuzzleDate, loadCachedPuzzle, type DailyPuzzle } from "./evochess/dailyPuzzle";
import {
  accruePlyTime,
  initTelemetry,
  logFinishedGame,
  msSinceSessionStart,
  newGameMeta,
  reportedDurationMs,
  track,
  trackOnce,
  trackSessionOnce,
} from "./telemetry";
import { Fireworks } from "./Fireworks";
import { Tutorial } from "./Tutorial";
import {
  NEW_GAME_MODE,
  PUZZLE_LEVEL,
  type BoardViewProps,
  type BrowseProps,
  type ClockProps,
  type ConfirmState,
  type LiveProps,
  type Mode,
  type NewGameChoice,
  type PromoModalState,
  type PuzzleProps,
  type RestartReason,
  type ScoreProps,
} from "./appTypes";
import { deriveBoardView } from "./boardView";
import { buildSquareStyles } from "./boardStyles";
import { useEvoGame } from "./hooks/useEvoGame";
import { useShareModal } from "./hooks/useShareModal";
import { useGameClock } from "./hooks/useGameClock";
import { useMobileWidget } from "./hooks/useMobileWidget";
import { useHistoryBrowse } from "./hooks/useHistoryBrowse";
import { useGameOutcome } from "./hooks/useGameOutcome";
import { useAiWorker } from "./hooks/useAiWorker";
import { useTutorialInvite } from "./hooks/useTutorialInvite";
import { useEngineLockout } from "./features/share/useEngineLockout";
import { useSharedPosition } from "./features/share/useSharedPosition";
import { useDailyPuzzle } from "./features/puzzle/useDailyPuzzle";
import { resolveStartup } from "./features/startup/resolveStartup";
import { useLiveMatch, type ApplyMove } from "./features/live/useLiveMatch";
import { TopBanners } from "./components/TopBanners";
import { BoardArea } from "./components/BoardArea";
import { AppPanel } from "./components/AppPanel";
import { MobileWidgetSheet } from "./components/MobileWidgetSheet";
import { MobileSheetContent } from "./components/MobileSheetContent";
import { Dialogs } from "./components/Dialogs";
import "./App.css";

function App() {
  // The game itself: the position, the line to it, and the telemetry identity.
  const { gameRef, historyRef, gameMetaRef, resumedRef, rerender, resetGame } = useEvoGame();
  // The player's own setup: what the pickers hold and what the autosave
  // carries. The position on the board can override it (see `play` below), and
  // never writes into it.
  const [setupMode, setSetupMode] = useState<Mode>("human-ai");
  const [setupAiColor, setSetupAiColor] = useState<Color>("b");
  const [setupLevel, setSetupLevel] = useState<AiLevel>("chill");
  const [modal, setModal] = useState<PromoModalState | null>(null);
  // The action waiting on confirmation, or null. Both of these throw away
  // moves, and neither can be undone. `play-here` carries its ply rather than
  // reading `browsePly` at the end, so the dialog commits to the position the
  // player was looking at when they asked, even if the AI moves meanwhile.
  const [confirmAction, setConfirmAction] = useState<ConfirmState | null>(null);
  // Whether the invite dialog is up. The link itself is derived from the match
  // on the board, so closing this loses nothing.
  const [inviteOpen, setInviteOpen] = useState(false);
  const confirmCancelBtnRef = useRef<HTMLButtonElement>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // In human-vs-human, flip the board after every move so the side to move sees
  // their pieces at the bottom. Off by default: more intuitive behavior.
  const [autoFlip, setAutoFlip] = useState(false);
  // Let the AI keep searching the current position in the background while it's
  // the human's turn, warming the TT for its next real search
  // (docs/ponder-spec.md). Only takes effect at Fun level; persisted like the
  // other settings, default on.
  const [ponderEnabled, setPonderEnabled] = useState(true);
  const boardWrapRef = useRef<HTMLDivElement>(null);
  // Rules summary and move log share panel space, so only one is expanded at a
  // time — opening one collapses the other.
  const [openPanel, setOpenPanel] = useState<"rules" | "log" | null>("log");
  // On a phone the side panel is hidden entirely (CSS) and its widgets are
  // reached through the icon bar under the board, which opens one of them in a
  // bottom sheet over the page. null = no sheet open.
  const { widget, setWidget } = useMobileWidget(!!modal || !!confirmAction || inviteOpen);
  // Click-to-move: square selected by tapping a piece, awaiting a target square
  // tap. Cleared on every move attempt (successful or not).
  const [selected, setSelected] = useState<Square | null>(null);
  // `browsePly` in a ref, so the share dialog can read the cursor at click
  // time. `useHistoryBrowse` cannot be called above `useShareModal`, since it
  // takes `shareModal` as part of `blocked`. Kept in sync just below it.
  const browsePlyRef = useRef<number | null>(null);
  const share = useShareModal(gameRef, browsePlyRef, gameMetaRef);
  // Which ply of the current game is on screen, and the ways to step through
  // them. null means live (the actual gameRef.current position); otherwise an
  // index into historyRef, which holds the position after that many plies.
  const {
    browsePly,
    enterBrowse,
    browsePrev,
    browseNext,
    browseHome,
    browseLive,
    holdable,
    onBoardTouchStart,
    onBoardTouchEnd,
  } = useHistoryBrowse({
    historyRef,
    setSelected,
    blocked: !!modal || !!share.shareModal || !!widget || !!confirmAction || inviteOpen,
  });
  browsePlyRef.current = browsePly;

  // Whether the engine is allowed near the position at all. Declared before
  // both the worker and the handover, since both need it and neither owns it.
  const { unverified, engineLockedRef, setLockout } = useEngineLockout();
  // The puzzle of the day, and the attempt on the board if there is one.
  const puzzle = useDailyPuzzle({ gameRef });
  const puzzleOnBoard = puzzle.puzzleRef.current;

  // What the board is actually played at. A puzzle is a mate to find against
  // the engine, and an unverified position has no engine at all (spec §5.2):
  // both belong to the position, so they are derived here rather than written
  // into the setup, and leaving the position leaves nothing behind to undo.
  const play: { mode: Mode; aiColor: Color; level: AiLevel } = puzzleOnBoard
    ? { mode: "human-ai", aiColor: puzzleOnBoard.aiColor, level: PUZZLE_LEVEL }
    : { mode: unverified ? "human-human" : setupMode, aiColor: setupAiColor, level: setupLevel };
  const { mode, aiColor, level } = play;

  // Human-vs-human clock. Off by default; the promotion prompt pauses it.
  const {
    clockRef,
    clockHistoryRef,
    timerEnabled,
    setTimerEnabled,
    timerMinutes,
    setTimerMinutes,
    timeUp,
    setTimeUp,
    resetClock,
  } = useGameClock({ gameRef, loaded, mode, paused: !!modal, rerender });
  // The search worker and its ponder protocol (docs/ponder-spec.md).
  const { nnueReady, searchInWorker, resetPonder, stopPonder, maybeStartPonder } = useAiWorker({
    gameRef,
    engineLockedRef,
    mode,
    aiColor,
    level,
    ponderEnabled,
  });

  /** Everything a position handover clears off the screen. */
  function clearPrompts() {
    setModal(null);
    setSelected(null);
    setTimeUp(null);
  }

  // Positions that arrive from elsewhere: a `?p=` link, the puzzle, a match.
  const shared = useSharedPosition({
    gameRef,
    historyRef,
    gameMetaRef,
    resumedRef,
    clockRef,
    clockHistoryRef,
    resetClock,
    resetPonder,
    setLockout,
    clearPuzzle: puzzle.clearPuzzle,
    clearPrompts,
  });
  const { sharedPending, savedGameRef, fromShared, linkNotice, setLinkNotice } = shared;

  const tutorial = useTutorialInvite({ resetPonder });

  // The poll applies the opponent's moves down the same path a local move
  // takes. `applyAndAdvance` is declared below, so the poll reaches it here.
  const applyMoveRef = useRef<ApplyMove>(() => {});
  const live = useLiveMatch({
    gameRef,
    historyRef,
    clockRef,
    clockHistoryRef,
    rerender,
    adoptPosition: shared.adoptPosition,
    savedGameRef,
    setLinkNotice,
    setSetupMode,
    clearPrompts,
    resetPonder,
    onRematchStart,
    applyMoveRef,
  });
  const liveRef = live.liveRef;
  const liveActive = live.live !== null;

  // A match is untimed (docs/live-match.md §Shape). It is human-vs-human, so
  // the clock would otherwise run, and a clock that only one side keeps means a
  // flag fall the opponent never sees: two boards, two results. The switch is
  // hidden with it, so nothing turns it back on mid-match.
  useEffect(() => {
    if (!liveActive) return;
    setTimerEnabled(false);
    setTimeUp(null);
  }, [liveActive, setTimerEnabled, setTimeUp]);

  // What happens when a game ends: the score record, the fireworks, and the
  // delayed reveal of the score overlay. Declared after the live hook because
  // the fireworks need to know which seat is ours.
  const { scores, scoreOverlayReady, showFireworks, setShowFireworks, justWonLevel, scoredGameRef } = useGameOutcome({
    gameRef,
    loaded,
    mode,
    aiColor,
    level,
    fromShared,
    timeUp,
    liveSeat: live.live?.seat?.seat ?? null,
  });

  /**
   * A rematch has replaced the board with a fresh game. The match hook has
   * already swapped the position; what is left is everything the finished game
   * left lying around (docs/live-match.md §Milestone 2b).
   */
  function onRematchStart() {
    gameMetaRef.current = newGameMeta(gameRef.current.chess.fen());
    setShowFireworks(false);
    resetClock(timerMinutes);
    browseLive();
    setInviteOpen(false);
  }

  function togglePanel(key: "rules" | "log", isOpen: boolean) {
    setOpenPanel((prev) => (isOpen ? key : prev === key ? null : prev));
  }

  /**
   * Puts the recipient's own game back, discarding the shared one.
   */
  function backToMyGame() {
    const saved = shared.takeOwnGame();
    if (!saved) return;
    setConfirmAction(null);
    // The board is about to hold a game of this player's own. The poll must not
    // keep applying the opponent's moves onto it.
    live.leaveLiveMatch();
    // The game coming back is the player's own, not the puzzle, so the tag must
    // not follow it onto the `games` row — nor the banner the position it
    // described has just left.
    puzzle.clearPuzzle();
    const resumed = resumeHistory(saved);
    gameRef.current = resumed.game;
    historyRef.current = resumed.history;
    // One clock reading per rebuilt ply, all of them the save's own. Per-ply
    // readings were never persisted, so that is the only reading there is, but
    // the array has to be as long as `historyRef`: `playFromHere` indexes it by
    // ply, and a short one would hand an early ply a later move's reading.
    clockHistoryRef.current = resumed.history.map(() => ({ ...saved.clock }));
    gameMetaRef.current = resumeMeta(saved);
    resumedRef.current = true;
    if (gameRef.current.isGameOver()) scoredGameRef.current = gameRef.current;
    // Usually false, since the game being restored is the recipient's own. Not
    // always: open a second link after playing on a first, and the game parked
    // for this button is itself from an unverified position. The lockout
    // follows the position, not the sequence of events.
    const lockedOut = saved.unverified;
    setLockout(lockedOut);
    setLinkNotice(null);
    shared.setFromShared(saved.fromShared);
    setSetupMode(saved.mode);
    setSetupAiColor(saved.aiColor);
    setSetupLevel(saved.level);
    clockRef.current = saved.clock;
    clearPrompts();
    resetPonder(); // a different position entirely (ponder-spec.md §5.3, §6.2)
    // The shared position is gone, so a reload must not bring it back over the
    // game just restored.
    shared.goLive();
    rerender();
    setTimeout(
      () =>
        maybeAiMove({
          mode: lockedOut ? "human-human" : saved.mode,
          aiColor: saved.aiColor,
          level: saved.level,
        }),
      0
    );
  }

  /**
   * Puts a puzzle on the board, down the same path a `?p=` link takes
   * (share-links-spec.md §6). Reusing it verbatim is what makes `fromShared`
   * keep the result off the local score — so failing a puzzle is not a loss —
   * and what parks the player's own game on their first move, so "back to my
   * game" still works.
   *
   * Runs from a promise, well after mount, so `saved` is passed in rather than
   * re-read: it is the same autosave the startup path decided about.
   *
   * A row that fails to decode, or decodes but fails the legality check, is
   * treated as no puzzle at all. An unverified position locks the engine out
   * (share-links-spec.md §5.2), which would leave an unplayable board.
   *
   * A live match refuses outright: the poll would apply the opponent's moves
   * onto the puzzle. The button is hidden too, so this guards `?daily` and the
   * fetch that lands later.
   */
  function loadDailyPuzzle(row: DailyPuzzle, saved: ReturnType<typeof loadGame>) {
    if (liveRef.current) {
      console.warn(`evochess: daily puzzle ${row.date} refused, a live match is on the board`);
      return;
    }
    const decoded = decodeShareLink(row.param);
    if (!decoded.ok) {
      console.warn(`evochess: daily puzzle ${row.date} failed to decode [${decoded.code}]`);
      return;
    }
    if (!decoded.legal) {
      console.warn(`evochess: daily puzzle ${row.date} failed the legality check [${decoded.reasons.join(", ")}]`);
      return;
    }
    shared.adoptPosition({ game: decoded.game, payload: row.param, saved, legal: true });
    // The solver always moves first, which is also what keeps loading a puzzle
    // from triggering an engine search. Mode and level come with it, off `play`.
    puzzle.beginAttempt(row, decoded.game.moveLog.length, decoded.game.turn === "w" ? "b" : "w");
    rerender();
  }

  /**
   * The entry point, and "Try again" with it: one call site, so the button,
   * `?daily` and the retry all go down the same path.
   *
   * No confirmation, ever. Loading a puzzle over a game in progress does not
   * lose it — the shared-position path holds the player's own game and "back to
   * my game" brings it back — so a dialog here would be asking about a risk
   * that does not exist.
   *
   * Which game is handed over is the one thing that differs from `?daily`,
   * which passes the autosave read at page load. By the time this runs the
   * player may have played twenty moves, and that snapshot would rewind past
   * them, so the live save is read at the moment of the press. Once a puzzle
   * already owns the board, `loadGame()` would return the puzzle itself, so the
   * game already being held is passed through unchanged.
   */
  function openPuzzle() {
    if (!puzzle.puzzle) return;
    loadDailyPuzzle(puzzle.puzzle, puzzle.puzzleRef.current ? savedGameRef.current : loadGame());
  }

  useEffect(() => {
    initTelemetry();
    // A game parked by an earlier visit on a link, if the recipient never went
    // back to it. The offer outlives the reload that made it necessary.
    shared.setParked(hasParkedGame());
    // Everything the four sources are decided from is read here, and the
    // decision itself is pure (`resolveStartup`). What follows only applies it,
    // in order: the order below is load-bearing (docs/refactor-startup.md).
    const progress = loadProgress();
    const saved = loadGame();
    const cache = loadCachedPuzzle();
    const startup = resolveStartup({ search: window.location.search, saved, cache, progress });
    const { board } = startup;
    if (startup.notice) {
      console.warn(`evochess: shared link refused [${startup.refusedCode}]`);
      setLinkNotice(startup.notice);
    }
    // Before `page_load`, which reports it. The device class is the pointer and
    // the viewport: no user agent string, which is a fingerprint and answers
    // nothing these do not.
    resumedRef.current = startup.resumed;
    trackOnce("page_load", "page_load", {
      from_share: startup.fromShare,
      share_refused: startup.shareRefused,
      resumed_game: resumedRef.current,
      viewport_w: window.innerWidth,
      viewport_h: window.innerHeight,
      dpr: Math.round(window.devicePixelRatio * 100) / 100,
      coarse_pointer: window.matchMedia("(pointer: coarse)").matches,
      tutorial_seen: progress.seen,
      lessons_done: progress.completed.length,
    });
    if (startup.settings) {
      // Applied before whichever game wins the board below: a position-only
      // link carries no extras block (share-links-spec.md §4.5), so
      // orientation, mode and level are the recipient's own.
      const s = startup.settings;
      setSetupMode(s.mode);
      setSetupAiColor(s.aiColor);
      setSetupLevel(s.level);
      setAutoFlip(s.autoFlip);
      setTimerEnabled(s.timerEnabled);
      setTimerMinutes(s.timerMinutes);
      clockRef.current = s.clock;
      setPonderEnabled(s.ponderEnabled);
    }
    if (board.kind === "shared") {
      const { link, param } = board;
      // A history link's `game` is already the end of the line (spec §6.1);
      // the history holds everything strictly before it.
      shared.adoptPosition({
        game: link.game,
        history: link.snapshots?.slice(0, -1),
        payload: param,
        saved,
        legal: link.legal,
      });
      // Nothing in the payload says who moves next, and there is no extras
      // block to lean on, so the rule is positional: the recipient always moves
      // first. This is also what keeps loading a link from triggering an engine
      // search. Read at the cursor.
      const atCursor = link.snapshots?.[link.cursor ?? 0] ?? link.game;
      setSetupAiColor(atCursor.turn === "w" ? "b" : "w");
      if (!link.legal) {
        // Logged verbatim so "the link is weird" is diagnosable from a
        // screenshot of the console (spec §5.2).
        console.warn(`evochess: shared link failed legality check [${link.reasons.join(", ")}]`);
      }
    } else if (board.kind === "resume") {
      const saved = board.saved;
      const resumed = resumeHistory(saved);
      gameRef.current = resumed.game;
      historyRef.current = resumed.history;
      clockHistoryRef.current = resumed.history.map(() => ({ ...saved.clock }));
      gameMetaRef.current = resumeMeta(saved);
      shared.setFromShared(saved.fromShared);
      // The lockout has to come back with the position. It is memory-only, and
      // three of the legality failures (over nine pieces per side,
      // side-not-to-move-in-check, en passant incoherence) produce FENs
      // chess.js loads happily, so a reload would otherwise hand the search a
      // board it must never see. The save carries the player's own setup, so
      // `unverified` is what puts the board back in human-vs-human.
      if (saved.unverified) {
        console.warn("evochess: resuming a game played from an unverified shared position");
        setLockout(true);
      }
      // A finished game was already scored live before the page was saved/
      // reloaded (the scores effect runs the moment isGameOver() first goes
      // true). Mark it pre-scored so that effect doesn't record it again on
      // every subsequent reload of the same finished game.
      if (gameRef.current.isGameOver()) scoredGameRef.current = gameRef.current;
      resetPonder(); // loading a save (ponder-spec.md §5.3, §6.2)
    } else if (board.offerTutorial) {
      tutorial.offerInvite();
    }
    if (startup.match) void live.openLiveMatch(startup.match, saved);
    if (startup.daily) {
      // Stripped after `?lm=` has been read, and exactly as `?p=` is stripped
      // once it goes live: a reload must not re-enter the puzzle over a game in
      // progress.
      const url = new URL(window.location.href);
      url.searchParams.delete("daily");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    // After the board is decided, and applied on a timer.
    // `?lm=` beats `?daily`: the match takes the board when its fetch lands,
    // and neither claim may depend on which response is first.
    puzzle.bootstrapPuzzle({
      daily: startup.daily && !startup.match,
      cached: cache,
      auto: startup.match ? null : startup.puzzle,
      saved,
      // gameRef is whichever game took the board above, so this is the ply
      // count the request is racing.
      plyAtLoad: gameRef.current.moveLog.length,
      load: loadDailyPuzzle,
      heldGame: () => savedGameRef.current,
    });
    setLoaded(true);
    // A history link's cursor (docs/share-links-spec.md §4.4): `enterBrowse`
    // already clamps to live, so a cursor at the end of the line needs no
    // special case.
    if (board.kind === "shared" && board.link.cursor !== undefined && board.link.cursor < historyRef.current.length) {
      enterBrowse(board.link.cursor);
    }
    rerender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loaded) return;
    // A shared position stays in memory until the recipient commits to it, so
    // their own game is still in localStorage and still restorable (spec §6.4).
    if (sharedPending) return;
    const meta = gameMetaRef.current;
    accruePlyTime(meta, gameRef.current.moveLog.length);
    saveGame({
      game: gameRef.current,
      mode: setupMode,
      aiColor: setupAiColor,
      level: setupLevel,
      autoFlip,
      timerEnabled,
      timerMinutes,
      clock: clockRef.current,
      ponderEnabled,
      fromShared,
      unverified,
      telemetry: meta,
    });
  });

  // Sends the move log and the `game_end` event of a finished game, once.
  // Deliberately wider than the scoring effect, which skips human-vs-human and
  // shared games: those are finished games too. `logged` rides in the save, so
  // a reload of a game already sent does not send it again.
  useEffect(() => {
    if (!loaded) return;
    // Same rule as the save effect: nothing about a shared position is recorded
    // until the recipient plays from it. A link to a position that is already
    // mate would otherwise log a nought-move game, and log it again on every
    // reload, since `logged` is only persisted once the game goes live.
    if (sharedPending) return;
    const game = gameRef.current;
    // A resignation or an agreed draw ends the game without the board showing
    // it (docs/live-match.md §Milestone 2c). Left out, it would go unreported
    // here and then be logged as abandoned on the way out of the tab.
    const liveOutcome = live.live?.outcome ?? null;
    if (!game.isGameOver() && !timeUp && !liveOutcome) return;
    const meta = gameMetaRef.current;
    if (meta.logged) return;
    meta.logged = true;
    // In a match the human is whoever holds the seat, not White.
    const humanColor: Color =
      live.live?.seat?.seat ?? (mode === "human-ai" ? (aiColor === "w" ? "b" : "w") : "w");
    const outcome = timeUp
      ? "timeout"
      : liveOutcome
      ? liveOutcome === "d"
        ? "draw"
        : liveOutcome === humanColor
        ? "win"
        : "loss"
      : !game.chess.isCheckmate()
      ? "draw"
      : game.turn === humanColor
      ? "loss"
      : "win";
    logFinishedGame({
      meta,
      mode,
      level,
      aiColor,
      fromShared,
      puzzleDate: puzzle.puzzleDate(),
      outcome,
      moves: game.moveLog,
      moveTokens: game.moveTokens,
    });
    track(
      "game_end",
      {
        outcome,
        plies: game.moveLog.length,
        duration_ms: reportedDurationMs(meta),
        mode,
        level: mode === "human-ai" ? level : null,
        ai_color: aiColor,
        from_shared: fromShared,
        // Tagged, not suppressed: a puzzle attempt is a real game down the
        // shared-position path, and only this tells the two apart.
        puzzle_date: puzzle.puzzleDate(),
        takebacks: meta.takebacks,
      },
      meta.uid
    );
    rerender(); // persists `logged` now rather than at the next move
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loaded,
    mode,
    aiColor,
    level,
    fromShared,
    sharedPending,
    timeUp,
    live.live?.outcome,
    gameRef.current,
    gameRef.current.moveLog.length,
  ]);

  // Best-effort game_abandon on tab close: `pagehide` fires on navigation,
  // close and backgrounding alike, and is the one unload event bfcache doesn't
  // skip. A game already caught by the `game_end` effect above is a no-op here
  // (`abandonGame` checks `meta.logged`).
  useEffect(() => {
    if (!loaded) return;
    function onPageHide(e: PageTransitionEvent) {
      // Frozen into bfcache rather than closed. The page can come back, and on
      // a phone this is what switching apps mid-game looks like.
      if (e.persisted) return;
      // Nothing has happened this session. `resumeMeta` nulls the anchor on
      // load and only a ply sets it, so this is "the player moved". Without it,
      // every visit that opens a saved game and leaves reports an abandon.
      if (gameMetaRef.current.lastPlyAt === null) return;
      abandonGame();
    }
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, mode, aiColor, level, fromShared, gameRef.current]);

  // Resumes an AI-to-move position on load (e.g. reloading mid-game with the
  // AI to move). Deliberately NOT re-run when mode/aiColor change: toggling
  // "AI plays: White" before the first move would otherwise let the AI jump in
  // immediately with no human action. Starting/resuming after a setup change
  // goes through the explicit "New Game" button instead.
  useEffect(() => {
    if (!loaded) return;
    maybeAiMove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  useEffect(() => {
    if (!modal || modal.kind !== "optional") return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") cancelModalMove();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  // Escape and focus for the confirmation dialog. Focus lands on Cancel, not on
  // the destructive action, so a stray Enter or Space does nothing.
  useEffect(() => {
    if (!confirmAction) return;
    confirmCancelBtnRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setConfirmAction(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmAction]);

  useEffect(() => {
    if (!inviteOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setInviteOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inviteOpen]);

  async function maybeAiMove(overrides?: { mode?: Mode; aiColor?: Color; level?: AiLevel }) {
    const effMode = overrides?.mode ?? mode;
    const effAiColor = overrides?.aiColor ?? aiColor;
    const effLevel = overrides?.level ?? level;
    const game = gameRef.current;
    if (game.isGameOver()) return;
    // An unverified shared position never reaches the search (spec §5.2).
    if (engineLockedRef.current) return;
    if (effMode !== "human-ai") return;
    if (game.turn !== effAiColor) return;
    setSelected(null);
    setAiThinking(true);
    // Let the UI paint the "thinking" state before blocking the main thread
    // with the search.
    await new Promise((r) => setTimeout(r, 30));
    const candidate = await searchInWorker(game, effLevel, Math.floor(Math.random() * 1_000_000));
    // gameRef.current is reassigned (not mutated) by takeback/new game, so an
    // identity check here catches a search that's now stale.
    if (candidate && gameRef.current === game && !game.isGameOver() && game.turn === effAiColor) {
      historyRef.current.push(game.copy());
      clockHistoryRef.current.push({ ...clockRef.current });
      game.applyMove(candidate.from, candidate.to, candidate.options);
    }
    setAiThinking(false);
    // The engine's own move can end the game too: mating the solver, or
    // stalemating them. Both are failures.
    puzzle.checkPuzzle(effAiColor);
    rerender();
    // The AI just moved and it's now the human's turn: start pondering the
    // position the human is looking at (ponder-spec.md §3, §5.3).
    maybeStartPonder(game, { mode: effMode, aiColor: effAiColor, level: effLevel });
    setTimeout(() => maybeAiMove(overrides), 0);
  }

  /** `remote` marks a move that arrived from the opponent, so it is not sent back. */
  function applyAndAdvance(from: Square, to: Square, options: ApplyMoveOptions, remote = false) {
    // Must land before the history push and well before the 30ms UI-paint delay
    // in maybeAiMove — the whole point is getting the worker off the CPU at the
    // earliest instant we know the human has committed to a move
    // (ponder-spec.md §5.3's overriding priority, §1).
    stopPonder();
    const game = gameRef.current;
    const snapshot = game.copy();
    try {
      game.applyMove(from, to, options);
    } catch (e) {
      if (e instanceof EvoChessError) {
        // eslint-disable-next-line no-alert
        alert("Illegal move: " + e.message);
      }
      rerender();
      // The move never applied, so it's still the human's turn on the same
      // position — resume the chain we stopped above rather than leaving the
      // rest of their thinking time unpondered.
      maybeStartPonder(game);
      return;
    }
    if (!remote) live.sendLocalMove(game, from, to, options);
    tutorial.dismissInvite();
    // The top of the funnel. Only this path, and only a move of this player's
    // own: the AI applies its own moves, and the opponent's arrive over the
    // wire already counted on their side.
    if (!remote)
      trackSessionOnce("first_move", "first_move", {
        ms_since_load: msSinceSessionStart(),
        resumed_game: resumedRef.current,
      });
    // A game begins when it is played, so the human's first move is the event.
    // Not the first ply: the AI opens for itself when it has White, and a
    // takeback to the opening would otherwise start the same game twice.
    if (!remote && !gameMetaRef.current.started) {
      gameMetaRef.current.started = true;
      track(
        "game_start",
        {
          mode,
          level: mode === "human-ai" ? level : null,
          ai_color: aiColor,
          from_shared: fromShared,
          puzzle_date: puzzle.puzzleDate(),
          unverified,
        },
        gameMetaRef.current.uid
      );
    }
    // The recipient has played from the shared position, so it becomes the live
    // game and normal autosaving resumes (spec §6.4). Their own game is parked
    // rather than lost, so they can still go back to it. Not on a remote move:
    // an observer never commits to the match, so their own game stays where it
    // is, and a seat holder commits when they play.
    if (sharedPending && !remote) shared.parkOwnGameAndGoLive();
    // Straight after the solver's move and before the reply, which is the only
    // moment at which a mate-in-N delivered on move N still counts.
    const outcome = puzzle.checkPuzzle(aiColor);
    historyRef.current.push(snapshot);
    clockHistoryRef.current.push({ ...clockRef.current });
    rerender();
    // A failed attempt ends the attempt, so the engine does not reply. The game
    // is usually still playable — running out of moves is not the game ending —
    // and playing on under a banner saying it is over is not a thing to leave a
    // player doing. The board stops taking moves too (see `attemptMove`).
    if (outcome === "failed") return;
    setTimeout(maybeAiMove, 0);
  }
  applyMoveRef.current = applyAndAdvance;

  function takeback() {
    // A live match owns its own move list, and the server will not take a ply
    // it already holds: rewinding here would diverge the two boards for good.
    // The button is hidden too. This guards the keyboard and confirm paths.
    if (liveRef.current) return;
    const hist = historyRef.current;
    const clockHist = clockHistoryRef.current;
    if (hist.length === 0) return;
    let restored: ReturnType<typeof hist.pop>;
    let restoredClock: Record<Color, number> | undefined;
    if (mode === "human-ai") {
      // Roll back to the most recent position where the human is to move,
      // undoing the AI's reply along with the human's own move.
      const humanColor: Color = aiColor === "w" ? "b" : "w";
      do {
        restored = hist.pop();
        restoredClock = clockHist.pop();
      } while (hist.length > 0 && restored!.turn !== humanColor);
    } else {
      restored = hist.pop();
      restoredClock = clockHist.pop();
    }
    if (!restored) return;
    // One per takeback, not per ply undone: a vs-AI takeback rolls back the
    // AI's reply too.
    gameMetaRef.current.takebacks += 1;
    gameRef.current = restored;
    resetPonder(); // takeback discards game state (ponder-spec.md §5.3, §6.2)
    clearPrompts();
    setShowFireworks(false);
    clockRef.current = restoredClock ?? { w: timerMinutes * 60, b: timerMinutes * 60 };
    rerender();
    // Only reachable when taking back to the opening in an AI-plays-White game:
    // let the AI make its first move again.
    if (mode === "human-ai" && !restored.isGameOver() && restored.turn === aiColor) {
      setTimeout(maybeAiMove, 0);
    } else {
      // The usual case: the rollback landed on the human's move, so start a
      // fresh chain on the restored position rather than leaving this turn
      // unpondered until the AI's next reply (ponder-spec.md §3, §5.3).
      maybeStartPonder(restored);
    }
  }

  // Truncates the line at the browsed ply and goes live there — the one way
  // browsing is allowed to change the game, and only via this explicit action
  // (spec: the board itself stays read-only while browsing).
  //
  // Always behind the confirmation dialog, never a bare tap: it throws away
  // every move after the cursor. The dialog is in-page rather than
  // `window.confirm`, which some mobile browsers suppress outright.
  function playFromHere(ply: number) {
    if (liveRef.current) return; // as takeback: a live match cannot rewind
    const hist = historyRef.current;
    const clockHist = clockHistoryRef.current;
    const snapshot = hist[ply];
    setConfirmAction(null);
    if (!snapshot) return;
    const restoredClock = clockHist[ply];
    gameRef.current = snapshot.copy();
    historyRef.current = hist.slice(0, ply);
    clockHistoryRef.current = clockHist.slice(0, ply);
    clockRef.current = restoredClock ? { ...restoredClock } : { w: timerMinutes * 60, b: timerMinutes * 60 };
    resetPonder(); // discards everything after the cursor (ponder-spec.md §5.3, §6.2)
    clearPrompts();
    setShowFireworks(false);
    browseLive();
    rerender();
    const restored = gameRef.current;
    if (mode === "human-ai" && !restored.isGameOver() && restored.turn === aiColor) {
      setTimeout(maybeAiMove, 0);
    } else {
      maybeStartPonder(restored);
    }
  }

  function onPieceDrop({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) {
    if (!targetSquare || browsePly !== null) return false;
    setSelected(null);
    return attemptMove(sourceSquare as Square, targetSquare as Square);
  }

  /** Whether the move is allowed to be tried at all, before its own rules. */
  function moveAllowed(from: Square, to: Square): boolean {
    const game = gameRef.current;
    if (browsePly !== null) return false;
    if (from === to) return false;
    if (mode === "human-ai" && game.turn === aiColor) return false;
    // No seat token means every move is refused. That is the observer case.
    if (!canMoveNow(liveRef.current, game.moveLog.length)) return false;
    if (game.isGameOver()) return false;
    // A resolved puzzle is over even when the position is still playable.
    if (puzzle.puzzleResult) return false;
    return true;
  }

  function attemptMove(from: Square, to: Square): boolean {
    if (!moveAllowed(from, to)) return false;
    const plan = planMove(gameRef.current, from, to);
    if (plan.kind === "reject") return false;
    if (plan.kind === "prompt") setModal(plan.modal);
    else applyAndAdvance(plan.from, plan.to, plan.options);
    return true;
  }

  function onSquareClick({ square }: { square: string }) {
    const game = gameRef.current;
    const sq = square as Square;
    if (!view.humanCanMove) {
      setSelected(null);
      return;
    }
    const piece = game.chess.get(sq);
    const ownPiece = piece && piece.color === game.turn;

    if (selected) {
      if (sq === selected) {
        setSelected(null);
        return;
      }
      const isLegalTarget = game.legalMoves().some((m) => m.from === selected && m.to === sq);
      if (isLegalTarget) {
        const from = selected;
        setSelected(null);
        attemptMove(from, sq);
        return;
      }
      setSelected(ownPiece ? sq : null);
      return;
    }

    if (ownPiece) setSelected(sq);
  }

  function finishModalMove(options: ApplyMoveOptions) {
    if (!modal) return;
    const { from, to } = modal;
    setModal(null);
    applyAndAdvance(from, to, options);
  }

  /**
   * Closing the optional-promotion dialog abandons the move, rather than
   * playing it without the promotion. "Skip" is the way to do that, and it
   * says so. Escape and the × mean "I did not mean this", so the piece goes
   * back where it was.
   */
  function cancelModalMove() {
    setModal(null);
    setSelected(null);
  }

  // Logs a started-but-unfinished game as abandoned, before its state is
  // discarded or the tab goes away. Mirrors the `game_end` block above but with
  // no outcome that fits `win`/`loss`/`draw`/`timeout` (`abandoned` is its own
  // outcome) and no scoring, since an abandoned game was never decided.
  //
  // Deliberately does not set `logged`: from the close path this is a guess,
  // and a game reported abandoned must stay loggable so that finishing it later
  // still sends the real outcome. The collector takes one row per report and
  // analysis reads the last one, so the guess costs a row, not the truth.
  function abandonGame() {
    const meta = gameMetaRef.current;
    if (!meta.started || meta.logged) return;
    const game = gameRef.current;
    const plies = game.moveLog.length;
    // Already reported at this exact position: `pagehide` fires again after a
    // bfcache restore, and a game reopened and left alone would otherwise be
    // reported once per visit.
    if (meta.abandonedAtPly === plies) return;
    meta.abandonedAtPly = plies;
    logFinishedGame({
      meta,
      mode,
      level,
      aiColor,
      fromShared,
      puzzleDate: puzzle.puzzleDate(),
      outcome: "abandoned",
      moves: game.moveLog,
      moveTokens: game.moveTokens,
    });
    track(
      "game_abandon",
      {
        plies,
        duration_ms: reportedDurationMs(meta),
        mode,
        level: mode === "human-ai" ? level : null,
        ai_color: aiColor,
        from_shared: fromShared,
        puzzle_date: puzzle.puzzleDate(),
        takebacks: meta.takebacks,
      },
      meta.uid
    );
    // `abandonedAtPly` reaches the save through the save effect, and on
    // `pagehide` there is no render left to run it. Patched straight into the
    // save instead.
    markSavedGameAbandoned(plies);
  }

  function startNewGame(newMode: Mode, newAiColor: Color, newLevel: AiLevel) {
    abandonGame();
    resetGame();
    clockHistoryRef.current = [];
    resetPonder(); // new game discards the old position (ponder-spec.md §5.3, §6.2)
    // A fresh game is a well-formed position, so the engine is allowed back.
    setLockout(false);
    setLinkNotice(null);
    // A new game starts from the opening, so it counts again.
    shared.setFromShared(false);
    // Starting a new game is an explicit choice to leave the shared position
    // and the game it displaced, so "back to my game" retires here too.
    if (sharedPending) shared.goLive();
    // A new game leaves the live match too.
    live.leaveLiveMatch();
    // …and out of the puzzle with it, so the new game is not tagged as one and
    // no stale banner outlives the position it described.
    puzzle.clearPuzzle();
    clearParkedGame();
    shared.setParked(false);
    setSetupMode(newMode);
    setSetupAiColor(newAiColor);
    setSetupLevel(newLevel);
    setInviteOpen(false);
    clearPrompts();
    setShowFireworks(false);
    resetClock(timerMinutes);
    clearSavedGame();
    rerender();
    setTimeout(() => maybeAiMove({ mode: newMode, aiColor: newAiColor, level: newLevel }), 0);
  }

  /**
   * New Game, which is also where the mode is chosen (docs/live-match.md
   * §Milestone 2). The board is reset first either way, so a match created here
   * starts at the opening and carries no `start_payload`.
   */
  function chooseNewGame(choice: NewGameChoice, seat: Color) {
    setConfirmAction(null);
    startNewGame(NEW_GAME_MODE[choice], setupAiColor, setupLevel);
    if (choice !== "live") return;
    // After the reset has flushed, so the match is created from the opening and
    // not from the board `startNewGame` has only just replaced.
    setTimeout(async () => {
      try {
        if (await live.createLiveMatch(seat)) setInviteOpen(true);
      } catch {
        setLinkNotice("Could not start a live match. Check your connection and try again.");
      }
    }, 0);
  }

  const view = deriveBoardView({
    game: gameRef.current,
    history: historyRef.current,
    browsePly,
    mode,
    aiColor,
    level,
    autoFlip,
    aiThinking,
    timeUp,
    live: live.live,
    liveConnectionLost: live.connectionLost,
    puzzle: puzzleOnBoard,
    puzzleResult: puzzle.puzzleResult,
    fromShared,
    hasScoreHistory:
      scores[level].wins + scores[level].losses + scores[level].draws > 0,
    promptOpen: !!modal,
  });

  if (!loaded) return null;
  // The tutorial plays Black through the same worker and the same Easy search
  // the game itself uses, so what it teaches against is a real opponent.
  if (tutorial.showTutorial) {
    return <Tutorial onExit={() => tutorial.setShowTutorial(false)} onSearch={searchInWorker} />;
  }

  const game = gameRef.current;
  const { totalPlies, browsing } = view;

  /**
   * The one route to a restart, for New Game and for the colour and level
   * switches, which both end the current game. A switch only asks when there is
   * something to lose: a game with moves in it that has not finished. Starting
   * over from the opening, or after a result, goes straight through.
   *
   * `apply` is what a switch does when no game is under way: set the value and
   * leave the board alone, rather than restarting it for nothing.
   */
  const restart = (what: RestartReason, next: { mode: Mode; aiColor: Color; level: AiLevel }, apply?: () => void) => {
    // New Game always asks, because the dialog is also where the mode is
    // picked. There is nothing to skip to.
    if (what === "new-game") {
      setConfirmAction({ kind: "restart", what, ...next });
    } else if (totalPlies === 0 && apply) {
      resetPonder(); // setting change (ponder-spec.md §5.3, §6.2)
      apply();
      // A live match is always worth asking about, even at ply 0. The seat is
      // what is lost, and no number of moves says that.
    } else if (!view.gameOver && (totalPlies > 0 || live.live)) {
      setConfirmAction({ kind: "restart", what, ...next });
    } else {
      startNewGame(next.mode, next.aiColor, next.level);
    }
  };

  // Kept short: the banner sits above the board, and every extra line of it is
  // a line the board loses on a phone. A puzzle replaces the shared-position
  // wording with the day it is for. The zone is spelled out because one global
  // boundary is what makes "today's puzzle" mean the same thing everywhere.
  const sharedStatusText = puzzleOnBoard
    ? `Puzzle of ${formatPuzzleDate(puzzleOnBoard.date)} (UTC)`
    : live.live
    ? // A match arrives down the shared-position path, but "Shared position" is
      // not what it is, least of all to the player who just created it.
      `Live match.${sharedPending && savedGameRef.current ? " Your own game is saved." : ""}`
    : [
        sharedPending && (savedGameRef.current ? "Shared position. Your own game is saved." : "Shared position."),
        unverified &&
          "This position could not have occurred in a game, so the computer opponent is unavailable for it.",
      ]
        .filter(Boolean)
        .join(" ");

  // Mounted twice, in the desktop panel and in the mobile sheet.
  const controls = {
    mode,
    aiColor,
    level,
    puzzleActive: puzzleOnBoard !== null,
    liveActive,
    autoFlip,
    timerEnabled,
    timerMinutes,
    hasHistory: totalPlies > 0,
    onRestart: restart,
    setAiColor: setSetupAiColor,
    setLevel: setSetupLevel,
    setAutoFlip,
    setTimerEnabled,
    setTimerMinutes,
    setTimeUp,
    resetClock,
  };
  const moveLogProps = {
    moveLog: game.moveLog,
    blackFirst: game.logStartsWithBlack,
    browsePly,
    browsable: totalPlies > 0,
  };

  // The board's props, in clusters (docs/refactor-board-props.md).
  const clockProps: ClockProps = { clock: clockRef.current, timerEnabled, turn: game.turn };
  const boardProps: BoardViewProps = {
    displayGame: view.displayGame,
    boardPosition: view.displayGame.chess.fen(),
    boardOrientation: view.boardOrientation,
    squareStyles: buildSquareStyles(game, selected),
    topColor: view.topColor,
    bottomColor: view.bottomColor,
    rightsFor: view.rightsFor,
  };
  const browseProps: BrowseProps = {
    browsing,
    browsePly,
    totalPlies,
    browsePrevHoldable: holdable(browseHome, browsePrev),
    browseNextHoldable: holdable(browseLive, browseNext),
    onBrowseLive: browseLive,
  };
  const puzzleProps: PuzzleProps = {
    // A match owns the board. New Game is the way out of one.
    onPuzzle: puzzle.puzzle && !liveActive ? openPuzzle : null,
    puzzleFresh: puzzle.puzzleFresh,
    onPuzzleRetry: openPuzzle,
    puzzleActive: puzzleOnBoard !== null,
    puzzleMateIn: puzzleOnBoard?.mateIn ?? 0,
    puzzleResult: puzzle.puzzleResult,
  };
  // Ours, and still waiting for the second seat: the only state the invite has
  // anything to say in.
  const waitingMatch = live.live?.seat && !live.live.joined ? live.live : null;
  // Ours, finished, and still a match: the rematch is the only thing left to
  // do with it. Out of sync is not a game to play again.
  const rematchMatch = rematchOffered(live.live, view.gameOver) ? live.live : null;
  // Whose draw offer is standing, ours or theirs. Nothing once the game is
  // over: an offer outliving the result would be an answer to nothing.
  const offer = view.gameOver ? null : drawOffered(live.live);
  // The menu replaces New Game for as long as the match can still be acted on.
  // A seat, both seats taken, and a game still being played: anything less and
  // there is no Draw and no Resign to hold.
  const liveMenu =
    live.live?.seat && live.live.joined && live.live.status === "live" && !live.live.outOfSync && !view.gameOver;
  const liveProps: LiveProps = {
    liveActive,
    joinSeat: live.live && !live.live.seat && live.live.status !== "over" ? live.live.freeSeat : null,
    joining: live.joining,
    onJoin: () => void live.joinLiveMatch(),
    onShowInvite: waitingMatch ? () => setInviteOpen(true) : null,
    rematch: rematchMatch
      ? { ...rematchAsks(rematchMatch), onAsk: () => void live.askRematch() }
      : null,
    onMenu: liveMenu ? () => setConfirmAction({ kind: "live-menu" }) : null,
    drawOffer:
      offer === "theirs"
        ? {
            onAccept: () => void live.endMatch("draw_accept"),
            onDecline: () => void live.endMatch("draw_decline"),
          }
        : null,
  };
  const nextLevel = justWonLevel === level ? NEXT_LEVEL[level] : undefined;
  const scoreProps: ScoreProps = {
    showScoreOverlay: view.showScoreOverlay,
    scoreOverlayReady,
    levelLabel: view.levelLabel,
    currentRecord: scores[level],
    onPlayAgain: () => startNewGame(setupMode, setupAiColor, setupLevel),
    nudge: nextLevel
      ? {
          label: nextLevel.charAt(0).toUpperCase() + nextLevel.slice(1),
          onAccept: () => {
            setSetupLevel(nextLevel);
            startNewGame(setupMode, setupAiColor, nextLevel);
          },
        }
      : null,
  };

  return (
    <div className="layout">
      {showFireworks && !browsing && (
        <Fireworks
          onDone={() => setShowFireworks(false)}
          launchX={
            boardWrapRef.current
              ? boardWrapRef.current.getBoundingClientRect().left +
                boardWrapRef.current.getBoundingClientRect().width / 2
              : undefined
          }
          launchY={boardWrapRef.current?.getBoundingClientRect().bottom}
        />
      )}
      <TopBanners
        linkNotice={linkNotice}
        sharedPending={sharedPending}
        unverified={unverified}
        sharedStatusText={sharedStatusText}
        hasSavedGame={shared.hasSavedGame}
        puzzleActive={puzzleOnBoard !== null}
        setLinkNotice={setLinkNotice}
        backToMyGame={() =>
          // A finished match has no seat worth warning about.
          live.live && !view.gameOver ? setConfirmAction({ kind: "leave-live" }) : backToMyGame()
        }
        parked={shared.parked}
        showInvite={tutorial.showInvite}
        openTutorial={tutorial.openTutorial}
        dismissInvite={tutorial.dismissInvite}
      />
      <BoardArea
        boardWrapRef={boardWrapRef}
        mode={mode}
        clock={clockProps}
        board={boardProps}
        browse={browseProps}
        puzzle={puzzleProps}
        live={liveProps}
        score={scoreProps}
        gameOver={view.gameOver}
        status={view.status}
        aiThinking={aiThinking}
        nnueReady={nnueReady}
        onBoardTouchStart={onBoardTouchStart}
        onBoardTouchEnd={onBoardTouchEnd}
        onPieceDrop={onPieceDrop}
        onSquareClick={onSquareClick}
        allowDragging={view.allowDragging}
        onRestart={() => restart("new-game", { mode: setupMode, aiColor: setupAiColor, level: setupLevel })}
        onTakeback={takeback}
        setConfirmAction={setConfirmAction}
        openTutorial={tutorial.openTutorial}
        openWidget={setWidget}
        onShare={share.handleShare}
      />
      <AppPanel
        showInvite={tutorial.showInvite}
        openTutorial={tutorial.openTutorial}
        hasPuzzle={puzzleProps.onPuzzle !== null}
        puzzleFresh={puzzle.puzzleFresh}
        openPuzzle={openPuzzle}
        onShare={share.handleShare}
        controls={controls}
        moveLog={moveLogProps}
        onSelectPly={enterBrowse}
        openPanel={openPanel}
        togglePanel={togglePanel}
      />

      {widget && (
        <MobileWidgetSheet widget={widget} onClose={() => setWidget(null)}>
          <MobileSheetContent
            widget={widget}
            controls={controls}
            moveLog={moveLogProps}
            onSelectPly={(ply) => {
              enterBrowse(ply);
              setWidget(null);
            }}
          />
        </MobileWidgetSheet>
      )}

      <Dialogs
        modal={modal}
        finishModalMove={finishModalMove}
        cancelModalMove={cancelModalMove}
        share={share}
        confirmAction={confirmAction}
        closeConfirm={() => setConfirmAction(null)}
        totalPlies={totalPlies}
        confirmCancelBtnRef={confirmCancelBtnRef}
        onPlayHere={playFromHere}
        onLeaveLive={backToMyGame}
        // Draw closes the menu and goes out: what it waits on is the opponent,
        // not another press here. Resign swaps the menu for the dialog that
        // asks (docs/live-match.md §Milestone 2c).
        onOfferDraw={() => {
          setConfirmAction(null);
          void live.endMatch("draw_offer");
        }}
        onAskResign={() => setConfirmAction({ kind: "resign" })}
        onResign={() => {
          setConfirmAction(null);
          void live.endMatch("resign");
        }}
        drawPending={offer === "mine"}
        liveActive={liveActive && !view.gameOver}
        onNewGame={chooseNewGame}
        invite={
          inviteOpen && live.live?.seat
            ? { url: inviteUrl(live.live.matchId), joined: live.live.joined }
            : null
        }
        closeInvite={() => setInviteOpen(false)}
        onStartNewGame={() => {
          setConfirmAction(null);
          if (confirmAction?.kind === "restart") {
            startNewGame(confirmAction.mode, confirmAction.aiColor, confirmAction.level);
          }
        }}
      />
    </div>
  );
}

export default App;
