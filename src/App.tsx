import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Color, Square } from "chess.js";
import { EvoChessGame, EvoChessError, ROOK_CHARGES, START_FEN, type ApplyMoveOptions } from "./evochess/game";
import type { AiLevel } from "./evochess/ai";
import { decodeShareLink, readShareParam } from "./evochess/shareLink";
import {
  saveGame,
  loadGame,
  clearSavedGame,
  parkSavedGame,
  loadParkedGame,
  hasParkedGame,
  clearParkedGame,
  markSavedGameAbandoned,
  type LoadedGame,
} from "./evochess/persistence";
import { loadProgress, markSeen } from "./evochess/tutorialProgress";
import {
  cachePuzzle,
  countAttempt,
  fetchDailyPuzzle,
  formatPuzzleDate,
  loadCachedPuzzle,
  resolvePuzzle,
  type DailyPuzzle,
  type PuzzleAttempts,
  type PuzzleState,
} from "./evochess/dailyPuzzle";
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
  type GameMeta,
} from "./telemetry";
import { Fireworks } from "./Fireworks";
import { Tutorial } from "./Tutorial";
import { PuzzleIcon, ShareIcon } from "./Icons";
import {
  type ConfirmState,
  type Mode,
  type PromoModalState,
  type RestartReason,
} from "./appTypes";
import { useShareModal } from "./hooks/useShareModal";
import { useGameClock } from "./hooks/useGameClock";
import { useMobileWidget } from "./hooks/useMobileWidget";
import { useHistoryBrowse } from "./hooks/useHistoryBrowse";
import { useGameOutcome } from "./hooks/useGameOutcome";
import { useAiWorker } from "./hooks/useAiWorker";
import { MoveLog } from "./components/MoveLog";
import { RulesSummary } from "./components/RulesSummary";
import { ControlsPanel } from "./components/ControlsPanel";
import { TopBanners } from "./components/TopBanners";
import { BoardArea } from "./components/BoardArea";
import { MobileWidgetSheet } from "./components/MobileWidgetSheet";
import { PromoModal } from "./components/PromoModal";
import { ShareModal } from "./components/ShareModal";
import { ConfirmModal } from "./components/ConfirmModal";
import "./App.css";

/**
 * Restores the meta of a game being resumed. The ply anchor is dropped, so the
 * time the game sat closed is not counted as play.
 */
function resumeMeta(saved: LoadedGame): GameMeta {
  return { ...saved.telemetry, lastPlyAt: null };
}

function App() {
  const [, forceRender] = useState(0);
  // Game state lives in refs, not React state, so anything that mutates it in
  // place has to ask for the repaint itself.
  const rerender = () => forceRender((n) => n + 1);
  const gameRef = useRef<EvoChessGame>(new EvoChessGame());
  // Snapshots taken just before each applied move, for takeback. In-memory
  // only (not persisted): copy() captures the full EvoChess state — position,
  // evolution rights/counters, and move log — which chess.js's own undo can't.
  const historyRef = useRef<EvoChessGame[]>([]);
  // Identity of the game being played, for the finished-game log. A ref, so a
  // takeback (which swaps gameRef.current for an earlier copy) stays the same
  // game.
  const gameMetaRef = useRef<GameMeta>(newGameMeta(START_FEN));
  // Whether the board holds a game restored from a save rather than one begun
  // in this session. Read by `first_move`.
  const resumedRef = useRef(false);
  const [mode, setMode] = useState<Mode>("human-ai");
  const [aiColor, setAiColor] = useState<Color>("b");
  const [level, setLevel] = useState<AiLevel>("zen");
  const [modal, setModal] = useState<PromoModalState | null>(null);
  const {
    shareModal,
    handleShare,
    copyShareUrl,
    copyMoveLog,
    shareViaSheet,
    closeShareModal,
    shareCopyBtnRef,
    shareCloseBtnRef,
  } = useShareModal(gameRef);
  // The action waiting on confirmation, or null. Both of these throw away
  // moves, and neither can be undone. `play-here` carries its ply rather than
  // reading `browsePly` at the end, so the dialog commits to the position the
  // player was looking at when they asked, even if the AI moves meanwhile.
  const [confirmAction, setConfirmAction] = useState<ConfirmState | null>(null);
  const confirmCancelBtnRef = useRef<HTMLButtonElement>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  // The rules are the whole point of the variant and take longer to read than
  // a first-time visitor will give us — so a first visit offers the tutorial
  // beside a live board rather than in front of it. The offer never blocks
  // play: making a move dismisses it (see dismissInvite).
  const [showInvite, setShowInvite] = useState(false);
  // In human-vs-human, flip the board after every move so the side to move
  // sees their pieces at the bottom. Can be disabled by the user.
  const [autoFlip, setAutoFlip] = useState(true);
  // Let the AI keep searching the current position in the background while
  // it's the human's turn, warming the TT for its next real search
  // (docs/ponder-spec.md). Only takes effect at Fun level; persisted like the
  // other settings, default on.
  const [ponderEnabled, setPonderEnabled] = useState(true);
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
  const boardWrapRef = useRef<HTMLDivElement>(null);
  // Rules summary and move log share panel space, so only one is expanded
  // at a time — opening one collapses the other.
  const [openPanel, setOpenPanel] = useState<"rules" | "log" | null>("log");
  // On a phone the side panel is hidden entirely (CSS) and its widgets are
  // reached through the icon bar under the board, which opens one of them in
  // a bottom sheet over the page. null = no sheet open.
  const { widget, setWidget } = useMobileWidget(!!modal || !!confirmAction);
  // Click-to-move: square selected by tapping a piece, awaiting a target
  // square tap. Cleared on every move attempt (successful or not).
  const [selected, setSelected] = useState<Square | null>(null);
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
    blocked: !!modal || !!shareModal || !!widget || !!confirmAction,
  });
  // -- shared positions (?p=…), docs/share-links-spec.md ---------------
  // A shared position is held in memory only until the recipient makes a move:
  // their own autosave stays intact and restorable until then, so
  // opening a link never costs them a game in progress.
  const [sharedPending, setSharedPending] = useState(false);
  // The autosave a shared link arrived on top of, kept for "back to my game".
  const savedGameRef = useRef<ReturnType<typeof loadGame>>(null);
  // A link that decoded cleanly but describes a position that could not occur
  // (spec §5.2). The board is still shown; the engine is not allowed near it.
  const [unverified, setUnverified] = useState(false);
  // Read by maybeAiMove/maybeStartPonder, which run from setTimeout callbacks
  // holding a closure over state React may not have flushed yet. The engine
  // lockout must not depend on that timing: the search and NNUE assume a
  // well-formed board, and an impossible one risks an out-of-bounds read in
  // the bitboard layer.
  const engineLockedRef = useRef(false);
  // Why a `?p=` was refused outright (spec §5.1). Purely informational: the app
  // has already fallen back to the normal startup path by the time it shows.
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  // Stays true after `sharedPending` clears, for as long as the game on the
  // board is the one that arrived on a link. A game played from someone else's
  // position is not a game against the AI from the opening, so its result is
  // not recorded against the level's score and no score is shown when it ends.
  // Persisted with the save, so a reload does not turn it back into a scored
  // game (persistence.ts `fromShared`).
  const [fromShared, setFromShared] = useState(false);
  // The daily puzzle on the board, if the game was opened with `?daily`.
  // `resolved` is the once-per-load guard on the solved/failed event: a
  // takeback can walk the ply count backwards, and the
  // guard is what stops that becoming a second event. The row itself is kept
  // after that, since `game_end` and the `games` row are still to be tagged.
  // Nothing persists — a reload resumes the puzzle as an ordinary shared game
  // and it stops counting as a puzzle.
  const puzzleRef = useRef<PuzzleState | null>(null);
  // The puzzle the entry point offers, from the cache on the first paint and
  // from the response once it lands. Null hides the entry point entirely: a
  // player who has never loaded a puzzle and is offline sees the app exactly as
  // it was before this existed.
  const [puzzle, setPuzzle] = useState<DailyPuzzle | null>(null);
  // The outcome of the attempt on the board, which the banner over it reads.
  // Set by `checkPuzzle` alongside the event, so there is only ever one
  // implementation of the ply arithmetic.
  const [puzzleResult, setPuzzleResult] = useState<null | "solved" | "failed">(null);
  // Loads of one date within this session, counting from 1. Nothing persists,
  // consistent with the attempt itself not surviving a reload.
  const attemptsRef = useRef<PuzzleAttempts | null>(null);
  // Whether a game of the recipient's own is sitting in the parked slot, which
  // is what "back to my game" offers once the shared game has gone live.
  const [parked, setParked] = useState(false);
  // What happens when a game ends: the score record, the fireworks, and the
  // delayed reveal of the score overlay.
  const { scores, scoreOverlayReady, showFireworks, setShowFireworks, scoredGameRef } = useGameOutcome({
    gameRef,
    loaded,
    mode,
    aiColor,
    level,
    fromShared,
    timeUp,
  });
  // The search worker and its ponder protocol (docs/ponder-spec.md).
  const { nnueReady, searchInWorker, resetPonder, stopPonder, maybeStartPonder } = useAiWorker({
    gameRef,
    engineLockedRef,
    mode,
    aiColor,
    level,
    ponderEnabled,
  });

  function togglePanel(key: "rules" | "log", isOpen: boolean) {
    setOpenPanel((prev) => (isOpen ? key : prev === key ? null : prev));
  }

  // Someone who has started playing has answered the question the invitation
  // was asking, so it gets out of the way and doesn't come back.
  function dismissInvite() {
    if (!showInvite) return;
    setShowInvite(false);
    markSeen();
  }

  function openTutorial() {
    // The tutorial is about to use the worker for its own opponent, so hand it
    // over: a ponder chain on this game's position is now both stale and in
    // the way (ponder-spec.md §5.3, §6.2).
    resetPonder();
    setShowInvite(false);
    setShowTutorial(true);
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
    // copies the autosave, and `savedGameRef` is null in exactly the cases where
    // the autosave is no longer theirs: a retried puzzle, or a second link
    // opened on top of a first. Parking then would put the position they have
    // just left over their real game, and "back to my game" would hand back the
    // failed attempt.
    if (savedGameRef.current) setParked(parkSavedGame());
    goLive();
  }

  /**
   * Puts the recipient's own game back, discarding the shared one. Reads the
   * parked slot once the shared game has gone live, and the in-memory copy
   * before that, when nothing has been parked because nothing was at risk.
   */
  function backToMyGame() {
    const saved = savedGameRef.current ?? loadParkedGame();
    if (!saved) return;
    clearParkedGame();
    setParked(false);
    // The game coming back is the player's own, not the puzzle, so the tag must
    // not follow it onto the `games` row — nor the banner the position it
    // described has just left.
    puzzleRef.current = null;
    setPuzzleResult(null);
    gameRef.current = saved.game;
    gameMetaRef.current = resumeMeta(saved);
    resumedRef.current = true;
    if (saved.game.isGameOver()) scoredGameRef.current = saved.game;
    historyRef.current = [];
    clockHistoryRef.current = [];
    // Usually false, since the game being restored is the recipient's own. Not
    // always: open a second link after playing on a first, and the game parked
    // for this button is itself from an unverified position. The lockout follows
    // the position, not the sequence of events.
    const lockedOut = saved.unverified;
    engineLockedRef.current = lockedOut;
    setUnverified(lockedOut);
    setLinkNotice(null);
    setFromShared(saved.fromShared);
    setMode(lockedOut ? "human-human" : saved.mode);
    setAiColor(saved.aiColor);
    setLevel(saved.level);
    clockRef.current = saved.clock;
    setModal(null);
    setSelected(null);
    setTimeUp(null);
    resetPonder(); // a different position entirely (ponder-spec.md §5.3, §6.2)
    // Same two steps as goLive, for the opposite reason: the shared position is
    // gone, so a reload must not bring it back over the game just restored.
    goLive();
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
   * Puts today's puzzle on the board, down the same path a `?p=` link takes
   * (share-links-spec.md §6). Reusing it verbatim is what makes `fromShared`
   * keep the result off the local score — so failing a puzzle is not a loss —
   * and what parks the player's own game on their first move, so "back to my
   * game" still works.
   *
   * Runs from a promise, well after mount, so `saved` is passed in rather than
   * re-read: it is the same autosave the startup effect decided about.
   *
   * A row that fails to decode, or decodes but fails the legality check, is
   * treated as no puzzle at all. An unverified position locks the engine out
   * (share-links-spec.md §5.2), which would leave an unplayable board.
   */
  function loadDailyPuzzle(puzzle: DailyPuzzle, saved: LoadedGame | null) {
    const shared = decodeShareLink(puzzle.param);
    if (!shared.ok) {
      console.warn(`evochess: daily puzzle ${puzzle.date} failed to decode [${shared.code}]`);
      return;
    }
    if (!shared.legal) {
      console.warn(`evochess: daily puzzle ${puzzle.date} failed the legality check [${shared.reasons.join(", ")}]`);
      return;
    }
    savedGameRef.current = saved;
    gameRef.current = shared.game;
    gameMetaRef.current = newGameMeta(shared.game.chess.fen(), puzzle.param);
    historyRef.current = [];
    clockHistoryRef.current = [];
    resumedRef.current = false;
    setSharedPending(true);
    setFromShared(true);
    // As for a link: the solver always moves first, which is also what keeps
    // loading the puzzle from triggering an engine search.
    setAiColor(shared.game.turn === "w" ? "b" : "w");
    // A link leaves mode and level as the recipient's own, since the sharer
    // said nothing about them. A puzzle is not like that: it is a mate to find
    // against the engine. Zen and Fun are the same search, and Zen is the one
    // whose name promises nothing about the reply. Nothing is stashed to undo
    // this — `savedGameRef` holds the player's own game, and "back to my game"
    // already restores its mode and level from there.
    setMode("human-ai");
    setLevel("zen");
    // The lockout belongs to the position, not to the session, and this one has
    // just passed the same legality check a link gets. Left set, it would both
    // silence the engine and write `unverified` into the save for a position
    // that is fine.
    engineLockedRef.current = false;
    setUnverified(false);
    resetClock(saved?.timerMinutes ?? 10);
    resetPonder(); // a position from outside this session (ponder-spec.md §5.3)
    puzzleRef.current = {
      date: puzzle.date,
      mateIn: puzzle.mateIn,
      startPly: shared.game.moveLog.length,
      resolved: false,
    };
    // A fresh attempt, so the next outcome fires again and the banner from the
    // last one goes.
    attemptsRef.current = countAttempt(attemptsRef.current, puzzle.date);
    setPuzzleResult(null);
    setModal(null);
    setSelected(null);
    setTimeUp(null);
    track("puzzle_open", {
      date: puzzle.date,
      mate_in: puzzle.mateIn,
      attempts: attemptsRef.current.count,
    });
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
    if (!puzzle) return;
    loadDailyPuzzle(puzzle, puzzleRef.current ? savedGameRef.current : loadGame());
  }

  /**
   * Fires `puzzle_solved` or `puzzle_failed`, once, and raises the banner over
   * the board. Called straight after a move and before the reply: a ply later
   * would call a mate-in-2 failed on the move that delivers mate.
   *
   * Returns the outcome so the caller can hold the engine back: a failure can
   * land with the game still playable, since running out of moves is not the
   * game ending.
   */
  function checkPuzzle(overrides?: { aiColor?: Color }): "solved" | "failed" | null {
    const puzzle = puzzleRef.current;
    if (!puzzle) return null;
    const game = gameRef.current;
    const effAiColor = overrides?.aiColor ?? aiColor;
    const outcome = resolvePuzzle(puzzle, {
      gameOver: game.isGameOver(),
      isCheckmate: game.chess.isCheckmate(),
      turn: game.turn,
      humanColor: effAiColor === "w" ? "b" : "w",
      plies: game.moveLog.length,
    });
    if (!outcome) return null;
    setPuzzleResult(outcome);
    track(outcome === "solved" ? "puzzle_solved" : "puzzle_failed", {
      date: puzzle.date,
      mate_in: puzzle.mateIn,
      // The same number the open carried. Redundant, and it means a solve or a
      // failure can be read on its own without joining back to the open.
      attempts: attemptsRef.current?.count ?? 1,
    });
    return outcome;
  }

  useEffect(() => {
    initTelemetry();
    const saved = loadGame();
    // A game parked by an earlier visit on a link, if the recipient never went
    // back to it. The offer outlives the reload that made it necessary.
    setParked(hasParkedGame());
    // `?p=` is read before the autosave is used, and decoded before anything
    // else can claim the board (share-links-spec.md §6).
    const param = readShareParam(window.location.search);
    const shared = param ? decodeShareLink(param) : null;
    // `?p=` wins if both are present, being the more specific of the two. This
    // reads the flag before it is stripped below.
    const daily = !param && new URLSearchParams(window.location.search).has("daily");
    if (shared && !shared.ok) {
      console.warn(`evochess: shared link refused [${shared.code}]`);
      setLinkNotice(shared.message);
    }
    // After the decode, since `from_share` and `share_refused` depend on it.
    // The device class is the pointer and the viewport: no user agent string,
    // which is a fingerprint and answers nothing these do not.
    const tutorial = loadProgress();
    // A valid link takes the board, and the autosave is left where it is.
    resumedRef.current = !!saved && !shared?.ok;
    trackOnce("page_load", "page_load", {
      from_share: !!param,
      share_refused: !!shared && !shared.ok,
      resumed_game: resumedRef.current,
      viewport_w: window.innerWidth,
      viewport_h: window.innerHeight,
      dpr: Math.round(window.devicePixelRatio * 100) / 100,
      coarse_pointer: window.matchMedia("(pointer: coarse)").matches,
      tutorial_seen: tutorial.seen,
      lessons_done: tutorial.completed.length,
    });
    if (saved) {
      // Applied whichever game wins the board below: a position-only link
      // carries no extras block (share-links-spec.md §4.5), so orientation, mode
      // and level are the recipient's own.
      setMode(saved.mode);
      setAiColor(saved.aiColor);
      setLevel(saved.level);
      setAutoFlip(saved.autoFlip);
      setTimerEnabled(saved.timerEnabled);
      setTimerMinutes(saved.timerMinutes);
      clockRef.current = saved.clock;
      setPonderEnabled(saved.ponderEnabled);
    }
    if (shared?.ok) {
      savedGameRef.current = saved;
      gameRef.current = shared.game;
      gameMetaRef.current = newGameMeta(shared.game.chess.fen(), param);
      setSharedPending(true);
      setFromShared(true);
      // Nothing in the payload says who moves next, and there is no extras
      // block to lean on, so the rule is positional: the recipient always moves
      // first. This is also what keeps loading a link from triggering an engine
      // search.
      setAiColor(shared.game.turn === "w" ? "b" : "w");
      // Whatever time was left on the recipient's own clock has nothing to do
      // with this position.
      resetClock(saved?.timerMinutes ?? 10);
      if (!shared.legal) {
        // Logged verbatim so "the link is weird" is diagnosable from a
        // screenshot of the console (spec §5.2).
        console.warn(`evochess: shared link failed legality check [${shared.reasons.join(", ")}]`);
        engineLockedRef.current = true;
        setUnverified(true);
        setMode("human-human");
      }
      resetPonder(); // a position from outside this session (ponder-spec.md §5.3)
    } else if (saved) {
      gameRef.current = saved.game;
      gameMetaRef.current = resumeMeta(saved);
      setFromShared(saved.fromShared);
      // The lockout has to come back with the position. `engineLockedRef` is
      // memory-only, and three of the legality failures (over nine pieces per
      // side, side-not-to-move-in-check, en passant incoherence) produce FENs
      // chess.js loads happily, so a reload would otherwise hand the search a
      // board it must never see. `setMode` overrides the one set above: a saved
      // `human-ai` here can only come from a save edited by hand.
      if (saved.unverified) {
        console.warn("evochess: resuming a game played from an unverified shared position");
        engineLockedRef.current = true;
        setUnverified(true);
        setMode("human-human");
      }
      // A finished game was already scored live before the page was saved/
      // reloaded (the scores effect runs the moment isGameOver() first goes
      // true). Mark it pre-scored so that effect doesn't record it again on
      // every subsequent reload of the same finished game.
      if (saved.game.isGameOver()) scoredGameRef.current = saved.game;
      resetPonder(); // loading a save (ponder-spec.md §5.3, §6.2)
    } else if (!daily && !loadProgress().seen) {
      // Deliberately not offered on top of a shared board (spec §11), nor over
      // a puzzle that is about to arrive on one: someone arriving on a link
      // came to look at a position, and the invite would cover it. A later
      // visit without a link still gets the offer.
      setShowInvite(true);
    }
    if (daily) {
      // Stripped now, exactly as `?p=` is stripped once it goes live: a reload
      // must not re-enter the puzzle over a game in progress.
      const url = new URL(window.location.href);
      url.searchParams.delete("daily");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    // gameRef is whichever game took the board above, so this is the ply count
    // the request is racing.
    const plyAtLoad = gameRef.current.moveLog.length;
    // The entry point is hidden when there is no puzzle, so the client has to
    // know about one on an ordinary load and not only under `?daily`. The cache
    // puts the button on screen from the first paint; `?daily` takes its puzzle
    // from there too, rather than waiting for a response it already has an
    // answer for.
    const cached = loadCachedPuzzle();
    if (cached) {
      setPuzzle(cached);
      // Deferred rather than applied here, so it lands at the same point in the
      // life of the page the response's own load does. Everything above is
      // still deciding what the board holds, and swapping the position in
      // before `loaded` would leave the mount-time `maybeAiMove` running
      // against the colours of the game the puzzle displaced — which is the
      // engine taking the solver's first move.
      if (daily) setTimeout(() => loadDailyPuzzle(cached, saved), 0);
    }
    // Fired on every load, not awaited, and it does not gate `setLoaded`. The
    // cache is a fallback for offline and for the moment before this lands, not
    // a reason to skip it: the client cannot tell whether its own idea of today
    // is right, and one request per load is cheap.
    void fetchDailyPuzzle().then((row) => {
      // Null: keep whatever the cache held.
      if (!row) return;
      cachePuzzle(row);
      // A response that lands while a puzzle is already on the board stops
      // here: it must not swap the position out from under a player who is
      // mid-solve. The exception is the puzzle it has just found to be a day
      // stale, sitting untouched on the board because the cache is what `?daily`
      // and the button had to go on — that one is replaced with today's, which
      // is the puzzle the player asked for.
      const onBoard = puzzleRef.current;
      const staleOnBoard =
        onBoard !== null &&
        onBoard.date < row.date &&
        gameRef.current.moveLog.length === onBoard.startPly;
      if (onBoard && !staleOnBoard) return;
      setPuzzle(row);
      // A game in progress wins, and only under `?daily`: the player never
      // asked for the puzzle at that moment, and taking the board would lose
      // the moves they just made, since `savedGameRef` would hold the snapshot
      // from page load and "back to my game" would rewind past them. A dropped
      // puzzle is a load without one, and the next `?daily` gets it. The button
      // is the player asking, so it has no such rule.
      //
      // The ply count, not `gameMetaRef.current.started`, which `resumeMeta`
      // carries over from the save and which is therefore already true for any
      // resumed game in progress.
      // The replacement takes the game already being held for the puzzle on the
      // board, not the page-load autosave: the player may have reached the
      // stale one through the button after twenty moves, and `saved` would
      // rewind past them.
      if (staleOnBoard) loadDailyPuzzle(row, savedGameRef.current);
      else if (daily && gameRef.current.moveLog.length === plyAtLoad) loadDailyPuzzle(row, saved);
    });
    setLoaded(true);
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
      mode,
      aiColor,
      level,
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
  // Deliberately wider than the
  // scoring effect, which skips human-vs-human and shared games: those are
  // finished games too. `logged` rides in the save, so a reload of a game
  // already sent does not send it again.
  useEffect(() => {
    if (!loaded) return;
    // Same rule as the save effect: nothing about a shared position is recorded
    // until the recipient plays from it. A link to a position that is already
    // mate would otherwise log a nought-move game, and log it again on every
    // reload, since `logged` is only persisted once the game goes live.
    if (sharedPending) return;
    const game = gameRef.current;
    if (!game.isGameOver() && !timeUp) return;
    const meta = gameMetaRef.current;
    if (meta.logged) return;
    meta.logged = true;
    const humanColor: Color = mode === "human-ai" ? (aiColor === "w" ? "b" : "w") : "w";
    const outcome = timeUp
      ? "timeout"
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
      puzzleDate: puzzleRef.current?.date ?? null,
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
        puzzle_date: puzzleRef.current?.date ?? null,
        takebacks: meta.takebacks,
      },
      meta.uid
    );
    rerender(); // persists `logged` now rather than at the next move
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, mode, aiColor, level, fromShared, sharedPending, timeUp, gameRef.current, gameRef.current.moveLog.length]);

  // Best-effort game_abandon on tab close: `pagehide` fires on navigation,
  // close and backgrounding alike, and is the one unload event bfcache
  // doesn't skip. A game already caught by the `game_end` effect above is a
  // no-op here (`abandonGame` checks `meta.logged`).
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
  // "AI plays: White" before the first move would otherwise let the AI jump
  // in immediately with no human action. Starting/resuming after a setup
  // change goes through the explicit "New Game" button instead.
  useEffect(() => {
    if (!loaded) return;
    maybeAiMove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  useEffect(() => {
    if (!modal || modal.kind !== "optional") return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") finishModalMove({});
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  // Escape and focus for the confirmation dialog. Focus lands on Cancel, not
  // on the destructive action, so a stray Enter or Space does nothing.
  useEffect(() => {
    if (!confirmAction) return;
    confirmCancelBtnRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setConfirmAction(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmAction]);

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
    // Let the UI paint the "thinking" state before blocking the main
    // thread with the search.
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
    checkPuzzle({ aiColor: effAiColor });
    rerender();
    // The AI just moved and it's now the human's turn: start pondering the
    // position the human is looking at (ponder-spec.md §3, §5.3).
    maybeStartPonder(game, { mode: effMode, aiColor: effAiColor, level: effLevel });
    setTimeout(() => maybeAiMove(overrides), 0);
  }

  function applyAndAdvance(from: Square, to: Square, options: ApplyMoveOptions) {
    // Must land before the historyRef push and well before the 30ms UI-paint
    // delay in maybeAiMove — the whole point is getting the worker off the
    // CPU at the earliest instant we know the human has committed to a move
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
    // Only record the snapshot once the move actually applied.
    dismissInvite();
    // The top of the funnel. Only this path: the AI applies its own moves.
    trackSessionOnce("first_move", "first_move", {
      ms_since_load: msSinceSessionStart(),
      resumed_game: resumedRef.current,
    });
    // A game begins when it is played, so the human's first move is the event.
    // Not the first ply: the AI opens for itself when it has White, and a
    // takeback to the opening would otherwise start the same game twice.
    if (!gameMetaRef.current.started) {
      gameMetaRef.current.started = true;
      track(
        "game_start",
        {
          mode,
          level: mode === "human-ai" ? level : null,
          ai_color: aiColor,
          from_shared: fromShared,
          puzzle_date: puzzleRef.current?.date ?? null,
          unverified,
        },
        gameMetaRef.current.uid
      );
    }
    // The recipient has played from the shared position, so it becomes the
    // live game and normal autosaving resumes (spec §6.4). Their own game is
    // parked rather than lost, so they can still go back to it.
    if (sharedPending) parkOwnGameAndGoLive();
    // Straight after the solver's move and before the reply, which is the only
    // moment at which a mate-in-N delivered on move N still counts.
    const outcome = checkPuzzle();
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

  function takeback() {
    const hist = historyRef.current;
    const clockHist = clockHistoryRef.current;
    if (hist.length === 0) return;
    let restored: EvoChessGame | undefined;
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
    setModal(null);
    setSelected(null);
    setTimeUp(null);
    setShowFireworks(false);
    clockRef.current = restoredClock ?? { w: timerMinutes * 60, b: timerMinutes * 60 };
    rerender();
    // Only reachable when taking back to the opening in an AI-plays-White
    // game: let the AI make its first move again.
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
  // Always behind the confirmation dialog, never a bare tap: it
  // throws away every move after the cursor. The dialog is in-page rather than
  // `window.confirm`, which some mobile browsers suppress outright.
  function playFromHere(ply: number) {
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
    setModal(null);
    setSelected(null);
    setTimeUp(null);
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

  function attemptMove(from: Square, to: Square): boolean {
    const game = gameRef.current;
    if (browsePly !== null) return false;
    if (from === to) return false;
    if (mode === "human-ai" && game.turn === aiColor) return false;
    if (game.isGameOver()) return false;
    // A resolved puzzle is over even when the position is still playable.
    if (puzzleResult) return false;

    const piece = game.chess.get(from);
    if (!piece) return false;

    const isPawn = piece.type === "p";
    const isRook = piece.type === "r";
    const reachesLastRank = isPawn && (to[1] === "8" || to[1] === "1");

    if (reachesLastRank) {
      setModal({ from, to, kind: "forced", color: game.turn, canMinor: false, canRook: false });
      return true;
    }

    if (isRook) {
      const remaining = (game.rookCharges.get(from) ?? ROOK_CHARGES) - 1;
      // Validate legality on a scratch copy first (a dummy downgrade choice
      // is only needed to get past the mandatory-downgrade check; it isn't
      // applied to the real game).
      const scratch = game.copy();
      try {
        scratch.applyMove(from, to, remaining <= 0 ? { downgradeTo: "n" } : {});
      } catch {
        return false;
      }
      if (remaining <= 0) {
        setModal({ from, to, kind: "downgrade", color: game.turn, canMinor: false, canRook: false });
      } else {
        applyAndAdvance(from, to, {});
      }
      return true;
    }

    // Preview the move on a scratch copy to see what it would earn/unlock
    // this same turn (including a right granted by the move itself), so
    // the promotion prompt doesn't lag a move behind.
    const scratch = game.copy();
    let scratchNote: string;
    try {
      scratchNote = scratch.applyMove(from, to);
    } catch {
      return false;
    }
    void scratchNote;

    const color = game.turn;
    const isMinor = piece.type === "n" || piece.type === "b";
    const canMinor = isPawn && scratch.minorRights[color] > 0;
    // The rook right may be spent only on the minor piece that just moved,
    // which now sits on `to`.
    const canRook = isMinor && scratch.canRookPromote(color, to);

    if (!canMinor && !canRook) {
      applyAndAdvance(from, to, {});
      return true;
    }

    setModal({ from, to, kind: "optional", color, canMinor, canRook });
    return true;
  }

  function onSquareClick({ square }: { square: string }) {
    const game = gameRef.current;
    const sq = square as Square;
    const humanCanMove =
      browsePly === null &&
      !(mode === "human-ai" && game.turn === aiColor) &&
      !game.isGameOver() &&
      !puzzleResult &&
      !modal;
    if (!humanCanMove) {
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
      const isLegalTarget = game
        .legalMoves()
        .some((m) => m.from === selected && m.to === sq);
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
      puzzleDate: puzzleRef.current?.date ?? null,
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
        puzzle_date: puzzleRef.current?.date ?? null,
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
    gameRef.current = new EvoChessGame();
    gameMetaRef.current = newGameMeta(START_FEN);
    resumedRef.current = false;
    historyRef.current = [];
    clockHistoryRef.current = [];
    resetPonder(); // new game discards the old position (ponder-spec.md §5.3, §6.2)
    // A fresh game is a well-formed position, so the engine is allowed back.
    engineLockedRef.current = false;
    setUnverified(false);
    setLinkNotice(null);
    // A new game starts from the opening, so it counts again.
    setFromShared(false);
    // Starting a new game is an explicit choice to leave the shared position
    // and the game it displaced, so "back to my game" retires here too.
    if (sharedPending) goLive();
    // …and out of the puzzle with it, so the new game is not tagged as one and
    // no stale banner outlives the position it described.
    puzzleRef.current = null;
    setPuzzleResult(null);
    clearParkedGame();
    setParked(false);
    setMode(newMode);
    setAiColor(newAiColor);
    setLevel(newLevel);
    setModal(null);
    setSelected(null);
    setTimeUp(null);
    setShowFireworks(false);
    resetClock(timerMinutes);
    clearSavedGame();
    rerender();
    setTimeout(() => maybeAiMove({ mode: newMode, aiColor: newAiColor, level: newLevel }), 0);
  }

  if (!loaded) return null;
  // The tutorial plays Black through the same worker and the same Easy search
  // the game itself uses, so what it teaches against is a real opponent.
  if (showTutorial) return <Tutorial onExit={() => setShowTutorial(false)} onSearch={searchInWorker} />;

  const game = gameRef.current;
  const totalPlies = historyRef.current.length;
  const browsing = browsePly !== null;
  // Everything rendered below tracks this, not `game`, so the board, the evo
  // strips and the status line all show the browsed ply rather than the live
  // position. historyRef only holds positions strictly before the live one
  // (see browsePly's declaration), so an out-of-range index falls back to it.
  const displayGame = browsing && browsePly! < totalPlies ? historyRef.current[browsePly!] : game;
  const turnLabel = displayGame.turn === "w" ? "White" : "Black";
  // With no bar under the board, this line is the only readout of where in
  // the game you are, so ply 0 says what it is rather than "Move 0 of N".
  const browsingStatus = browsePly === 0 ? "Start position" : `Move ${browsePly} of ${totalPlies}`;
  // A puzzle owns the board until it resolves, at which point the banner over
  // the board carries the news and this line goes back to saying what it says
  // for any other game.
  const activePuzzle = puzzleResult ? null : puzzleRef.current;
  let status = browsing ? browsingStatus : `${turnLabel} to move.`;
  if (!browsing && activePuzzle) {
    // The solver's colour, not whoever is to move: this line is the label of the
    // puzzle and it has to hold still. Taken from the live turn it would flip to
    // "Black to play, mate in 2" for the length of every engine reply.
    status = `${aiColor === "w" ? "Black" : "White"} to play, mate in ${activePuzzle.mateIn}`;
  } else if (!browsing) {
    if (game.chess.isCheck()) status += " Check!";
    if (game.isGameOver()) status = game.resultString();
    else if (timeUp) {
      const winner = timeUp === "w" ? "Black" : "White";
      status = `${timeUp === "w" ? "White" : "Black"} ran out of time. ${winner} wins!`;
    } else if (aiThinking) status += " (AI thinking...)";
  }
  const gameOver = gameRef.current.isGameOver() || !!timeUp;

  const currentRecord = scores[level];
  const hasScoreHistory = currentRecord.wins + currentRecord.losses + currentRecord.draws > 0;
  // The overlay mounts as soon as the game ends and dims in over 2.5s (CSS);
  // `scoreOverlayReady` then reveals the score text and the button.
  // Suppressed for a game played from a shared position: that result was never
  // recorded, so the score would be the running total of unrelated games, and
  // "play again" would start from the opening rather than from the position.
  // Also suppressed while browsing: the overlay and the fireworks belong to
  // the end of the live game, not to whichever ply is on screen.
  const showScoreOverlay = mode === "human-ai" && gameOver && hasScoreHistory && !fromShared && !browsing;

  const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);

  const rw = displayGame.rightsFor("w");
  const rb = displayGame.rightsFor("b");

  // Both the board and the evolution strips flanking it depend on which way the
  // board faces, so it's computed once here rather than inline in the board.
  const boardOrientation: "white" | "black" =
    mode === "human-human"
      ? autoFlip && game.turn === "b"
        ? "black"
        : "white"
      : aiColor === "w"
      ? "black"
      : "white";
  const bottomColor: Color = boardOrientation === "white" ? "w" : "b";
  const topColor: Color = bottomColor === "w" ? "b" : "w";
  const rightsFor = { w: rw, b: rb };

  /**
   * The one route to a restart, for New Game and for the three settings
   * switches, which all end the current game. It only asks when there is
   * something to lose: a game with moves in it that has not finished. Starting
   * over from the opening, or after a result, goes straight through.
   *
   * `apply` is what a switch does when no game is under way — set the value
   * and leave the board alone, rather than restarting it for nothing.
   */
  const restart = (
    what: RestartReason,
    next: { mode: Mode; aiColor: Color; level: AiLevel },
    apply?: () => void
  ) => {
    if (totalPlies === 0 && apply) {
      resetPonder(); // setting change (ponder-spec.md §5.3, §6.2)
      apply();
    } else if (totalPlies > 0 && !gameOver) {
      setConfirmAction({ kind: "restart", what, ...next });
    } else {
      startNewGame(next.mode, next.aiColor, next.level);
    }
  };

  // Kept short: the banner sits above the board, and every extra line of it is
  // a line the board loses on a phone.
  // A puzzle replaces the shared-position wording with the day it is for. The
  // zone is spelled out because one global boundary is what makes "today's
  // puzzle" mean the same thing everywhere.
  const sharedStatusText = puzzleRef.current
    ? `Puzzle of ${formatPuzzleDate(puzzleRef.current.date)} (UTC)`
    : [
        sharedPending &&
          (savedGameRef.current ? "Shared position. Your own game is saved." : "Shared position."),
        unverified &&
          "This position could not have occurred in a game, so the computer opponent is unavailable for it.",
      ]
        .filter(Boolean)
        .join(" ");

  // Whether there is a game of the player's own to go back to. The parked slot
  // counts: retrying a puzzle sets `sharedPending` again, and by then their own
  // game has already moved there, so without the second half the way back would
  // vanish for the rest of the session.
  const hasSavedGame = savedGameRef.current !== null || parked;

  const squareStyles: Record<string, CSSProperties> = {};
  if (selected) {
    squareStyles[selected] = { background: "rgba(255, 255, 0, 0.4)" };
    for (const m of game.legalMoves()) {
      if (m.from !== selected) continue;
      squareStyles[m.to] = {
        background: m.isCapture
          ? "radial-gradient(circle, transparent 55%, rgba(0, 0, 0, 0.35) 55%)"
          : "radial-gradient(circle, rgba(0, 0, 0, 0.35) 19%, transparent 20%)",
      };
    }
  }

  return (
    <div className="layout">
      {showFireworks && !browsing && (
        <Fireworks
          onDone={() => setShowFireworks(false)}
          launchX={
            boardWrapRef.current
              ? boardWrapRef.current.getBoundingClientRect().left + boardWrapRef.current.getBoundingClientRect().width / 2
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
        hasSavedGame={hasSavedGame}
        puzzleActive={puzzleRef.current !== null}
        setLinkNotice={setLinkNotice}
        backToMyGame={backToMyGame}
        parked={parked}
        showInvite={showInvite}
        openTutorial={openTutorial}
        dismissInvite={dismissInvite}
      />
      <BoardArea
        boardWrapRef={boardWrapRef}
        mode={mode}
        timerEnabled={timerEnabled}
        clock={clockRef.current}
        turn={game.turn}
        gameOver={gameOver}
        status={status}
        aiThinking={aiThinking}
        level={level}
        nnueReady={nnueReady}
        topColor={topColor}
        bottomColor={bottomColor}
        displayGame={displayGame}
        rightsFor={rightsFor}
        onBoardTouchStart={onBoardTouchStart}
        onBoardTouchEnd={onBoardTouchEnd}
        boardPosition={displayGame.chess.fen()}
        onPieceDrop={onPieceDrop}
        onSquareClick={onSquareClick}
        squareStyles={squareStyles}
        boardOrientation={boardOrientation}
        allowDragging={
          !browsing && !(mode === "human-ai" && game.turn === aiColor) && !gameOver && !puzzleResult
        }
        showScoreOverlay={showScoreOverlay}
        scoreOverlayReady={scoreOverlayReady}
        levelLabel={levelLabel}
        currentRecord={currentRecord}
        onPlayAgain={() => startNewGame(mode, aiColor, level)}
        browsing={browsing}
        browsePly={browsePly}
        totalPlies={totalPlies}
        onRestart={() => restart("new-game", { mode, aiColor, level })}
        onTakeback={takeback}
        onBrowseLive={browseLive}
        browsePrevHoldable={holdable(browseHome, browsePrev)}
        browseNextHoldable={holdable(browseLive, browseNext)}
        setConfirmAction={setConfirmAction}
        openTutorial={openTutorial}
        openWidget={setWidget}
        onPuzzle={puzzle ? openPuzzle : null}
        onPuzzleRetry={openPuzzle}
        puzzleActive={puzzleRef.current !== null}
        puzzleMateIn={puzzleRef.current?.mateIn ?? 0}
        puzzleResult={puzzleResult}
        onShare={handleShare}
      />
      <div className="panel">
        {/* The banner is already asking; this is the permanent way back in. */}
        {!showInvite && (
          <button className="learn-btn" onClick={openTutorial}>
            Learn Evo Basics
          </button>
        )}
        {/* Hidden entirely when there is no puzzle: no disabled state, no
            spinner, no placeholder. Someone who has never loaded one and is
            offline sees the panel exactly as it was. */}
        {puzzle && (
          <button
            type="button"
            className="learn-btn share-btn"
            aria-label="Puzzle of the day"
            title="Puzzle of the day"
            onClick={openPuzzle}
          >
            <PuzzleIcon /> Puzzle of the day
          </button>
        )}
        {/* The panel is desktop-only, so this one always opens the dialog: the
            URL field is the point of it. */}
        <button
          type="button"
          className="learn-btn share-btn"
          aria-label="Share position"
          title="Share position"
          onClick={(e) => handleShare(e, false)}
        >
          <ShareIcon /> Share
        </button>
        <ControlsPanel
          mode={mode}
          aiColor={aiColor}
          level={level}
          unverified={unverified}
          autoFlip={autoFlip}
          timerEnabled={timerEnabled}
          timerMinutes={timerMinutes}
          hasHistory={historyRef.current.length > 0}
          onRestart={restart}
          setMode={setMode}
          setAiColor={setAiColor}
          setLevel={setLevel}
          setAutoFlip={setAutoFlip}
          setTimerEnabled={setTimerEnabled}
          setTimerMinutes={setTimerMinutes}
          setTimeUp={setTimeUp}
          resetClock={resetClock}
        />
        <details
          className="collapsible"
          open={openPanel === "log"}
          onToggle={(e) => togglePanel("log", e.currentTarget.open)}
        >
          <summary>Move log</summary>
          <MoveLog
            moveLog={game.moveLog}
            blackFirst={game.logStartsWithBlack}
            browsePly={browsePly}
            browsable={totalPlies > 0}
            onSelectPly={enterBrowse}
          />
        </details>
        <details
          className="collapsible rules-summary"
          open={openPanel === "rules"}
          onToggle={(e) => togglePanel("rules", e.currentTarget.open)}
        >
          <summary>Rules summary</summary>
          <RulesSummary />
        </details>
      </div>

      {widget && (
        <MobileWidgetSheet widget={widget} onClose={() => setWidget(null)}>
          {widget === "log" && (
            <MoveLog
              moveLog={game.moveLog}
              blackFirst={game.logStartsWithBlack}
              browsePly={browsePly}
              browsable={totalPlies > 0}
              onSelectPly={(ply) => {
                enterBrowse(ply);
                setWidget(null);
              }}
            />
          )}
          {widget === "settings" && (
            <>
              <ControlsPanel
                mode={mode}
                aiColor={aiColor}
                level={level}
                unverified={unverified}
                autoFlip={autoFlip}
                timerEnabled={timerEnabled}
                timerMinutes={timerMinutes}
                hasHistory={historyRef.current.length > 0}
                onRestart={restart}
                setMode={setMode}
                setAiColor={setAiColor}
                setLevel={setLevel}
                setAutoFlip={setAutoFlip}
                setTimerEnabled={setTimerEnabled}
                setTimerMinutes={setTimerMinutes}
                setTimeUp={setTimeUp}
                resetClock={resetClock}
              />
              {/* The puzzle button took the rules' slot in the bar, so this is
                  the phone route to them. The sheet already scrolls inside
                  itself, and the wrapper is what keeps their styling. */}
              <div className="rules-summary sheet-rules">
                <h3>Rules summary</h3>
                <RulesSummary />
              </div>
            </>
          )}
        </MobileWidgetSheet>
      )}

      {modal && <PromoModal modal={modal} finishModalMove={finishModalMove} />}

      {shareModal && (
        <ShareModal
          shareModal={shareModal}
          closeShareModal={closeShareModal}
          copyShareUrl={copyShareUrl}
          copyMoveLog={copyMoveLog}
          shareViaSheet={shareViaSheet}
          shareCopyBtnRef={shareCopyBtnRef}
          shareCloseBtnRef={shareCloseBtnRef}
        />
      )}
      {confirmAction && (
        <ConfirmModal
          confirmAction={confirmAction}
          totalPlies={totalPlies}
          close={() => setConfirmAction(null)}
          confirmCancelBtnRef={confirmCancelBtnRef}
          onPlayHere={playFromHere}
          onStartNewGame={() => {
            setConfirmAction(null);
            if (confirmAction.kind === "restart") {
              startNewGame(confirmAction.mode, confirmAction.aiColor, confirmAction.level);
            }
          }}
        />
      )}
    </div>
  );
}

export default App;
