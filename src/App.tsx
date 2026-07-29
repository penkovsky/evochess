import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Chessboard } from "react-chessboard";
import type { Color, Square } from "chess.js";
import { EvoChessGame, EvoChessError, ROOK_CHARGES, type ApplyMoveOptions, type ForcedPromo, type MinorPromo } from "./evochess/game";
import { serializeGame } from "./evochess/serialize";
import type {
  AiCandidate,
  AiSearchRequest,
  AiSearchResponse,
  NnueStatusMessage,
  PonderPredictionMessage,
  PonderStatusMessage,
  WorkerRequest,
} from "./evochess/ai.worker";
import type { AiLevel } from "./evochess/ai";
import { saveGame, loadGame, clearSavedGame } from "./evochess/persistence";
import { loadScores, recordResult, type Scores } from "./evochess/scores";
import { RULES_SUMMARY } from "./evochess/tutorial";
import { loadProgress, markSeen } from "./evochess/tutorialProgress";
import { Fireworks } from "./Fireworks";
import { EvoStrip } from "./EvoStrip";
import { Tutorial } from "./Tutorial";
import { PIECE_GLYPH } from "./pieceGlyph";
import { CapIcon, ScrollIcon, BookIcon, GearIcon } from "./Icons";
import "./App.css";

type Mode = "human-ai" | "human-human";

/** Which widget the mobile bar is showing in the sheet, if any. */
type MobileWidget = "rules" | "log" | "settings";

/**
 * The move log, owning its own scroll-to-bottom. A component rather than a
 * render helper because the panel copy and the mobile copy are both mounted
 * (one is hidden by CSS), and a single shared ref cannot serve two elements.
 */
function MoveLog({ moveLog }: { moveLog: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  });
  return (
    <div className="log" ref={ref}>
      {/* Without this the sheet's height:auto log collapses to nothing on an
          unplayed game, leaving a drawer with a title and no body. Not a
          <div>: the e2e specs count `.log > div` to mean "moves played". */}
      {moveLog.length === 0 && <p className="log-empty">No moves yet.</p>}
      {moveLog
        .filter((_, i) => i % 2 === 0)
        .map((white, n) => {
          const black = moveLog[n * 2 + 1];
          return (
            <div key={n}>
              {n + 1}. {white}{black ? ` ${black}` : ""}
            </div>
          );
        })}
    </div>
  );
}

interface PromoModalState {
  from: Square;
  to: Square;
  kind: "forced" | "optional" | "downgrade";
  color: Color;
  canMinor: boolean;
  canRook: boolean;
}

function App() {
  const [, forceRender] = useState(0);
  const gameRef = useRef<EvoChessGame>(new EvoChessGame());
  // Snapshots taken just before each applied move, for takeback. In-memory
  // only (not persisted): copy() captures the full EvoChess state — position,
  // evolution rights/counters, and move log — which chess.js's own undo can't.
  const historyRef = useRef<EvoChessGame[]>([]);
  // Clock reading captured alongside each historyRef snapshot (same index),
  // so takeback can restore each side's remaining time instead of resetting it.
  const clockHistoryRef = useRef<Record<Color, number>[]>([]);
  const [mode, setMode] = useState<Mode>("human-ai");
  const [aiColor, setAiColor] = useState<Color>("b");
  const [level, setLevel] = useState<AiLevel>("fun");
  const [modal, setModal] = useState<PromoModalState | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [showFireworks, setShowFireworks] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  // The rules are the whole point of the variant and take longer to read than
  // a first-time visitor will give us — so a first visit offers the tutorial
  // beside a live board rather than in front of it. The offer never blocks
  // play: making a move dismisses it (see dismissInvite).
  const [showInvite, setShowInvite] = useState(false);
  // Win/loss/draw record vs the AI, kept separately per level and persisted
  // to localStorage (see evochess/scores.ts).
  const [scores, setScores] = useState<Scores>(loadScores);
  // Tracks which finished game instance has already been recorded, so the
  // scores effect below records each game-over exactly once (new game /
  // takeback reassign gameRef.current, giving a fresh instance to compare).
  const scoredGameRef = useRef<EvoChessGame | null>(null);
  // The score overlay covers the board, so its dim fades in over 2.5s and the
  // score itself is only revealed at the end — long enough to see the final
  // position / mating move.
  const [scoreOverlayReady, setScoreOverlayReady] = useState(false);
  // Reflects the AI worker's NNUE weights fetch, purely for the status
  // underline color — the worker owns the weights and posts this once its
  // own `nnueReady` promise settles (see ai.worker.ts).
  const [nnueReady, setNnueReady] = useState(false);
  // In human-vs-human, flip the board after every move so the side to move
  // sees their pieces at the bottom. Can be disabled by the user.
  const [autoFlip, setAutoFlip] = useState(true);
  // Human-vs-human clock. Off by default; remaining time lives in a ref
  // (like gameRef) and is pushed to the screen via rerender(), not React
  // state, since it changes many times per second.
  const [timerEnabled, setTimerEnabled] = useState(false);
  const [timerMinutes, setTimerMinutes] = useState(10);
  // Let the AI keep searching the current position in the background while
  // it's the human's turn, warming the TT for its next real search
  // (docs/ponder-spec.md). Only takes effect at Fun level; persisted like the
  // other settings, default on.
  const [ponderEnabled, setPonderEnabled] = useState(true);
  const [timeUp, setTimeUp] = useState<Color | null>(null);
  const clockRef = useRef<Record<Color, number>>({ w: 600, b: 600 });
  const boardWrapRef = useRef<HTMLDivElement>(null);
  // Rules summary and move log share panel space, so only one is expanded
  // at a time — opening one collapses the other.
  const [openPanel, setOpenPanel] = useState<"rules" | "log" | null>("log");
  // On a phone the side panel is hidden entirely (CSS) and its widgets are
  // reached through the icon bar under the board, which opens one of them in
  // a bottom sheet over the page. null = no sheet open.
  const [widget, setWidget] = useState<MobileWidget | null>(null);
  // Click-to-move: square selected by tapping a piece, awaiting a target
  // square tap. Cleared on every move attempt (successful or not).
  const [selected, setSelected] = useState<Square | null>(null);
  // Runs chooseMove off the main thread so the board stays responsive while
  // the AI is thinking. searchIdRef tags each request so a stale response
  // (e.g. after a takeback) can't be mistaken for the latest one.
  const aiWorkerRef = useRef<Worker | null>(null);
  const searchIdRef = useRef(0);

  useEffect(() => {
    const worker = new Worker(new URL("./evochess/ai.worker.ts", import.meta.url), { type: "module" });
    aiWorkerRef.current = worker;
    const handleStatus = (e: MessageEvent<NnueStatusMessage | PonderStatusMessage | unknown>) => {
      const data = e.data as { kind?: string; ready?: boolean };
      if (data?.kind === "nnue-status") setNnueReady(!!data.ready);
      if (data?.kind === "ponder-status") {
        // The depth a ponder chain reaches is otherwise invisible — it posts
        // no result, and its whole product is transposition-table entries.
        // `phase` names which of the two searches a chain runs got there:
        // "position" is the one the human is looking at, "predicted" the one
        // their most likely reply leads to (ponder-spec.md §8).
        const p = data as PonderStatusMessage;
        console.log(
          `[EvoChess ponder] phase=${p.phase} depth=${p.depth} elapsed=${p.elapsedMs}ms`
        );
      }
      if (data?.kind === "ponder-prediction") {
        // Whether the "predicted" phase above was pondering the position the
        // human actually went on to reach. `actual` is printed on a hit too,
        // so both outcomes read identically.
        const p = data as PonderPredictionMessage;
        console.log(
          `[EvoChess ponder] predicted? ${p.hit ? "True" : "False"} ` +
            `(guessed ${p.predicted} at depth ${p.depth}, played ${p.actual})`
        );
      }
    };
    worker.addEventListener("message", handleStatus);
    return () => {
      worker.removeEventListener("message", handleStatus);
      worker.terminate();
    };
  }, []);

  function searchInWorker(game: EvoChessGame, level: AiLevel, seed: number): Promise<AiCandidate | null> {
    return new Promise((resolve) => {
      const worker = aiWorkerRef.current;
      if (!worker) {
        resolve(null);
        return;
      }
      const id = ++searchIdRef.current;
      const handleMessage = (e: MessageEvent<AiSearchResponse>) => {
        if (e.data.id !== id) return;
        worker.removeEventListener("message", handleMessage);
        const r = e.data;
        const nps = r.timeMs > 0 ? Math.round((r.nodes / r.timeMs) * 1000) : r.nodes;
        console.log(
          `[EvoChess AI] level=${level} method=${r.method} depth=${r.depth} nodes=${r.nodes} ` +
            `time=${r.timeMs.toFixed(0)}ms speed=${nps.toLocaleString()} nodes/sec score=${r.score.toFixed(2)}`
        );
        resolve(r.candidate);
      };
      worker.addEventListener("message", handleMessage);
      const request: AiSearchRequest = { kind: "search", id, game: serializeGame(game), level, seed };
      worker.postMessage(request);
    });
  }

  // Every discontinuity in game state (new game, takeback, mode/color/level
  // change, loading a save) must invalidate the worker's ponder TT — stale
  // analysis from a position that no longer exists on this board must never
  // be reused (ponder-spec.md §5.3, §6.2).
  function resetPonder() {
    const req: WorkerRequest = { kind: "reset" };
    aiWorkerRef.current?.postMessage(req);
  }

  // Ends a running ponder chain but keeps its warm TT — the human has
  // committed to something, so the analysis is still valid and reusable.
  function stopPonder() {
    const req: WorkerRequest = { kind: "stop" };
    aiWorkerRef.current?.postMessage(req);
  }

  // Starts a ponder chain if this is a position worth pondering: the human is
  // on move against the AI at Fun level, with the setting on (§5.5). Called
  // both when the AI's move lands and when a move the human attempted turned
  // out to be illegal — in the latter case the position is unchanged, so the
  // chain we stopped on the way in should resume.
  // `overrides` exists for callers holding a value React state hasn't caught
  // up to yet — the same pattern (and reason) as `maybeAiMove`'s.
  function maybeStartPonder(
    game: EvoChessGame,
    overrides?: { mode?: Mode; aiColor?: Color; level?: AiLevel; ponderEnabled?: boolean }
  ) {
    const effMode = overrides?.mode ?? mode;
    const effAiColor = overrides?.aiColor ?? aiColor;
    const effLevel = overrides?.level ?? level;
    const effPonder = overrides?.ponderEnabled ?? ponderEnabled;
    if (
      effMode === "human-ai" &&
      effLevel === "fun" &&
      effPonder &&
      gameRef.current === game &&
      game.turn !== effAiColor &&
      !game.isGameOver()
    ) {
      const req: WorkerRequest = { kind: "ponder", game: serializeGame(game) };
      aiWorkerRef.current?.postMessage(req);
    }
  }

  function togglePanel(key: "rules" | "log", isOpen: boolean) {
    setOpenPanel((prev) => (isOpen ? key : prev === key ? null : prev));
  }

  const rerender = () => forceRender((n) => n + 1);

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

  function resetClock(minutes: number) {
    clockRef.current = { w: minutes * 60, b: minutes * 60 };
  }

  useEffect(() => {
    const saved = loadGame();
    if (saved) {
      gameRef.current = saved.game;
      // A finished game was already scored live before the page was saved/
      // reloaded (the scores effect runs the moment isGameOver() first goes
      // true). Mark it pre-scored so that effect doesn't record it again on
      // every subsequent reload of the same finished game.
      if (saved.game.isGameOver()) scoredGameRef.current = saved.game;
      setMode(saved.mode);
      setAiColor(saved.aiColor);
      setLevel(saved.level);
      setAutoFlip(saved.autoFlip ?? true);
      setTimerEnabled(saved.timerEnabled ?? false);
      setTimerMinutes(saved.timerMinutes ?? 10);
      clockRef.current = saved.clock ?? { w: (saved.timerMinutes ?? 10) * 60, b: (saved.timerMinutes ?? 10) * 60 };
      setPonderEnabled(saved.ponderEnabled ?? true);
      resetPonder(); // loading a save (ponder-spec.md §5.3, §6.2)
    } else if (!loadProgress().seen) {
      setShowInvite(true);
    }
    setLoaded(true);
    rerender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loaded) return;
    saveGame(gameRef.current, mode, aiColor, level, autoFlip, timerEnabled, timerMinutes, clockRef.current, ponderEnabled);
  });

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

  // Ticks the clock for whichever side is to move. Restarts (with a fresh
  // reference timestamp) whenever the turn changes, the modal opens/closes,
  // or the timer is toggled, so no stale elapsed time leaks across a pause.
  useEffect(() => {
    if (!loaded || !timerEnabled || mode !== "human-human" || timeUp) return;
    const game = gameRef.current;
    if (game.isGameOver() || modal) return;
    if (game.moveLog.length === 0) return;
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - last) / 1000;
      last = now;
      const turn = game.turn;
      const remaining = Math.max(0, clockRef.current[turn] - elapsed);
      clockRef.current[turn] = remaining;
      if (remaining <= 0) {
        setTimeUp(turn);
        clearInterval(id);
      }
      rerender();
    }, 200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, timerEnabled, mode, modal, timeUp, gameRef.current.turn, gameRef.current.moveLog.length]);

  // Fires the fireworks once when the human checkmates the AI. Keyed on the
  // EvoChessGame instance so a new game / takeback (which reassigns
  // gameRef.current) resets the trigger even if the win condition repeats.
  useEffect(() => {
    if (!loaded) return;
    const game = gameRef.current;
    if (mode === "human-ai" && game.isGameOver() && game.chess.isCheckmate() && game.turn === aiColor) {
      setShowFireworks(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, mode, aiColor, gameRef.current, gameRef.current.moveLog.length]);

  // Records the outcome of a finished vs-AI game against the current level's
  // score, once per game instance.
  useEffect(() => {
    if (!loaded) return;
    if (mode !== "human-ai") return;
    const game = gameRef.current;
    if (!game.isGameOver()) return;
    if (scoredGameRef.current === game) return;
    scoredGameRef.current = game;
    const humanColor: Color = aiColor === "w" ? "b" : "w";
    const outcome: "win" | "loss" | "draw" = !game.chess.isCheckmate()
      ? "draw"
      : game.turn === humanColor
      ? "loss"
      : "win";
    setScores(recordResult(level, outcome));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, mode, aiColor, level, gameRef.current, gameRef.current.moveLog.length]);

  // Reveals the score 2.5s after the game ends (matching the CSS dim-in), and
  // hides it again as soon as play resumes (new game / takeback).
  const gameIsOver = gameRef.current.isGameOver() || !!timeUp;
  useEffect(() => {
    if (!gameIsOver) {
      setScoreOverlayReady(false);
      return;
    }
    const id = setTimeout(() => setScoreOverlayReady(true), 2500);
    return () => clearTimeout(id);
  }, [gameIsOver]);

  useEffect(() => {
    if (!modal || modal.kind !== "optional") return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") finishModalMove({});
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  // Escape closes the widget sheet — but not while the promotion prompt is up,
  // which binds Escape for itself and takes priority.
  useEffect(() => {
    if (!widget || modal) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setWidget(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [widget, modal]);

  // The sheet is position:fixed, so nothing stops the page scrolling behind
  // it; and a rotate/resize past the breakpoint would leave it stranded over
  // the desktop layout, where the bar that opened it no longer exists.
  //
  // iOS Safari ignores `overflow: hidden` on the body for touch scrolling, so
  // the lock has to pin the body itself — which drops the scroll position, and
  // so has to carry it in `top` and restore it on the way out.
  useEffect(() => {
    if (!widget) return;
    const { style } = document.body;
    const previous = { overflow: style.overflow, position: style.position, top: style.top, width: style.width };
    const scrollY = window.scrollY;
    style.overflow = "hidden";
    style.position = "fixed";
    style.top = `-${scrollY}px`;
    style.width = "100%";
    const mq = window.matchMedia("(max-width: 600px)");
    const onChange = () => {
      if (!mq.matches) setWidget(null);
    };
    mq.addEventListener("change", onChange);
    return () => {
      Object.assign(style, previous);
      window.scrollTo(0, scrollY);
      mq.removeEventListener("change", onChange);
    };
  }, [widget]);

  async function maybeAiMove(overrides?: { mode?: Mode; aiColor?: Color; level?: AiLevel }) {
    const effMode = overrides?.mode ?? mode;
    const effAiColor = overrides?.aiColor ?? aiColor;
    const effLevel = overrides?.level ?? level;
    const game = gameRef.current;
    if (game.isGameOver()) return;
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
    historyRef.current.push(snapshot);
    clockHistoryRef.current.push({ ...clockRef.current });
    rerender();
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

  function onPieceDrop({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) {
    if (!targetSquare) return false;
    setSelected(null);
    return attemptMove(sourceSquare as Square, targetSquare as Square);
  }

  function attemptMove(from: Square, to: Square): boolean {
    const game = gameRef.current;
    if (from === to) return false;
    if (mode === "human-ai" && game.turn === aiColor) return false;
    if (game.isGameOver()) return false;

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
    const humanCanMove = !(mode === "human-ai" && game.turn === aiColor) && !game.isGameOver() && !modal;
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

  function startNewGame(newMode: Mode, newAiColor: Color, newLevel: AiLevel) {
    gameRef.current = new EvoChessGame();
    historyRef.current = [];
    clockHistoryRef.current = [];
    resetPonder(); // new game discards the old position (ponder-spec.md §5.3, §6.2)
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
  const turnLabel = game.turn === "w" ? "White" : "Black";
  let status = `${turnLabel} to move.`;
  if (game.chess.isCheck()) status += " Check!";
  if (game.isGameOver()) status = game.resultString();
  else if (timeUp) {
    const winner = timeUp === "w" ? "Black" : "White";
    status = `${timeUp === "w" ? "White" : "Black"} ran out of time. ${winner} wins!`;
  } else if (aiThinking) status += " (AI thinking...)";
  const gameOver = gameIsOver;

  const currentRecord = scores[level];
  const hasScoreHistory = currentRecord.wins + currentRecord.losses + currentRecord.draws > 0;
  // The overlay mounts as soon as the game ends and dims in over 2.5s (CSS);
  // `scoreOverlayReady` then reveals the score text and the button.
  const showScoreOverlay = mode === "human-ai" && gameOver && hasScoreHistory;
  const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);

  const rw = game.rightsFor("w");
  const rb = game.rightsFor("b");

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

  const renderActionPicker = (extraClass: string) => (
    <div className={`action-picker ${extraClass}`}>
      <button
        className="takeback-btn"
        onClick={takeback}
        disabled={historyRef.current.length === 0 || aiThinking}
      >
        Takeback
      </button>
      <button className="new-game-btn" onClick={() => startNewGame(mode, aiColor, level)}>
        New Game
      </button>
    </div>
  );

  // Shared by the desktop panel and the mobile widget bar, which mount the
  // same content in two different containers.
  const renderRules = () => (
    <ul>
      {RULES_SUMMARY.map((rule) => (
        <li key={rule}>{rule}</li>
      ))}
    </ul>
  );

  const renderControls = () => (
    <div className="controls">
      <div className="mode-picker" role="group" aria-label="Mode">
        {(
          [
            { label: "vs AI", value: "human-ai" },
            { label: "vs Human", value: "human-human" },
          ] as const
        ).map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={mode === opt.value ? "active" : ""}
            onClick={() => {
              const newMode = opt.value;
              if (newMode === mode) return;
              if (historyRef.current.length > 0) {
                // eslint-disable-next-line no-alert
                if (!window.confirm("Switch mode and end the current game?")) return;
                startNewGame(newMode, aiColor, level);
              } else {
                resetPonder(); // mode change (ponder-spec.md §5.3, §6.2)
                setMode(newMode);
              }
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {mode === "human-ai" && (
        <>
          <div className="color-picker" role="group" aria-label="Your color">
            {(
              [
                { label: "White", value: "b" },
                { label: "Black", value: "w" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={aiColor === opt.value ? "active" : ""}
                onClick={() => {
                  const newAiColor = opt.value;
                  if (newAiColor === aiColor) return;
                  if (historyRef.current.length > 0) {
                    // eslint-disable-next-line no-alert
                    if (!window.confirm("Switch colors and start a new game?")) return;
                    startNewGame(mode, newAiColor, level);
                  } else {
                    resetPonder(); // side change (ponder-spec.md §5.3, §6.2)
                    setAiColor(newAiColor);
                  }
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="level-picker" role="group" aria-label="AI level">
            {(
              [
                { label: "Easy", value: "easy" },
                { label: "Zen", value: "zen" },
                { label: "Fun", value: "fun" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={level === opt.value ? "active" : ""}
                onClick={() => {
                  const newLevel = opt.value;
                  if (newLevel === level) return;
                  if (historyRef.current.length > 0) {
                    // eslint-disable-next-line no-alert
                    if (!window.confirm("Switch level and end the current game?")) return;
                    startNewGame(mode, aiColor, newLevel);
                  } else {
                    resetPonder(); // level change (ponder-spec.md §5.3, §6.2)
                    setLevel(newLevel);
                  }
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
      {mode === "human-human" && (
        <div className="controls-row">
          <button
            type="button"
            className={`toggle-btn ${autoFlip ? "pressed" : ""}`}
            aria-pressed={autoFlip}
            onClick={() => setAutoFlip((v) => !v)}
          >
            Flip board
          </button>
          <button
            type="button"
            className={`toggle-btn ${timerEnabled ? "pressed" : ""}`}
            aria-pressed={timerEnabled}
            disabled={historyRef.current.length > 0}
            onClick={() => {
              const enabled = !timerEnabled;
              setTimerEnabled(enabled);
              if (enabled) {
                setTimeUp(null);
                resetClock(timerMinutes);
              }
            }}
          >
            Clock
          </button>
        </div>
      )}
      {mode === "human-human" && timerEnabled && (
        <label>
          Minutes per side:
          <input
            type="number"
            min={1}
            max={180}
            value={timerMinutes}
            disabled={historyRef.current.length > 0}
            onChange={(e) => {
              const minutes = Number(e.target.value);
              setTimerMinutes(minutes);
              resetClock(minutes);
            }}
          />
        </label>
      )}
    </div>
  );

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
      {showFireworks && (
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
      {/* Sits above the board rather than inside the panel: on a phone the
          panel is below the board, which would put the offer under the fold
          for exactly the visitors who most need it. */}
      {showInvite && (
        <div className="tutorial-invite">
          <div className="tutorial-invite-text">
            <h2>New to EvoChess?</h2>
            <p>
              It's chess, but you start with only Pawns and a King — everything else has to be
              earned mid-game. Three one-minute lessons, or just start playing and pick it up.
            </p>
          </div>
          <div className="tutorial-invite-actions">
            <button className="learn-btn" onClick={openTutorial}>
              Show me how
            </button>
            <button className="invite-skip-btn" onClick={dismissInvite}>
              No thanks
            </button>
          </div>
        </div>
      )}
      <div className="board-wrap" ref={boardWrapRef}>
        {mode === "human-human" && timerEnabled && (
          <ClockDisplay clock={clockRef.current} turn={game.turn} gameOver={gameOver} />
        )}
        <div className="board-status">{status}</div>
        <div
          className={`board-status-underline${
            aiThinking ? " thinking" : level === "easy" ? " easy" : nnueReady ? " nnue-ready" : ""
          }`}
        />
        <EvoStrip color={topColor} game={game} rights={rightsFor[topColor]} active={game.turn === topColor} />
        <div className="board-container">
          <Chessboard
            options={{
              position: game.chess.fen(),
              onPieceDrop,
              onSquareClick,
              squareRenderer: ({ square, children }) => {
                const charges = game.rookCharges.get(square as Square);
                return (
                  <div style={{ width: "100%", height: "100%", position: "relative", ...squareStyles[square] }}>
                    {children}
                    {charges !== undefined && (
                      <span className={`rook-charge-badge ${charges === 1 ? "low" : ""}`}>{charges}</span>
                    )}
                  </div>
                );
              },
              boardOrientation,
              allowDragging: !(mode === "human-ai" && game.turn === aiColor) && !gameOver,
            }}
          />
          {showScoreOverlay && (
            <div className={`score-overlay${scoreOverlayReady ? " revealed" : ""}`}>
              <div className="score-overlay-text">
                {levelLabel} <span className="score-win">{currentRecord.wins}</span>-{currentRecord.draws}-
                <span className="score-loss">{currentRecord.losses}</span>
              </div>
              <button className="play-again-btn" onClick={() => startNewGame(mode, aiColor, level)}>
                Play again?
              </button>
            </div>
          )}
        </div>
        <EvoStrip
          color={bottomColor}
          game={game}
          rights={rightsFor[bottomColor]}
          active={game.turn === bottomColor}
        />
        {renderActionPicker("action-picker-below-board")}
        {/* Phone-only: the panel below is hidden at this width, so its widgets
            are reached here instead. Tapping an icon slides that widget up
            from the bottom edge as a sheet. While a sheet is open its backdrop
            covers this bar, so the next tap anywhere — including on an icon —
            dismisses it rather than switching widgets. */}
        <div className="mobile-bar" role="group" aria-label="Widgets">
          <button
            type="button"
            className="widget-btn primary"
            aria-label="Learn Evo Basics"
            title="Learn Evo Basics"
            onClick={openTutorial}
          >
            <CapIcon />
          </button>
          {(
            [
              { id: "settings", label: "Settings", Icon: GearIcon },
              { id: "log", label: "Move log", Icon: BookIcon },
              { id: "rules", label: "Rules summary", Icon: ScrollIcon },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className="widget-btn"
              aria-label={label}
              title={label}
              aria-haspopup="dialog"
              onClick={() => setWidget(id)}
            >
              <Icon />
            </button>
          ))}
        </div>
      </div>
      <div className="panel">
        {/* The banner is already asking; this is the permanent way back in. */}
        {!showInvite && (
          <button className="learn-btn" onClick={openTutorial}>
            Learn Evo Basics
          </button>
        )}
        {renderControls()}
        <details
          className="collapsible"
          open={openPanel === "log"}
          onToggle={(e) => togglePanel("log", e.currentTarget.open)}
        >
          <summary>Move log</summary>
          <MoveLog moveLog={game.moveLog} />
        </details>
        <details
          className="collapsible rules-summary"
          open={openPanel === "rules"}
          onToggle={(e) => togglePanel("rules", e.currentTarget.open)}
        >
          <summary>Rules summary</summary>
          {renderRules()}
        </details>
      </div>

      {/* The mobile widget drawer: same idea as a hamburger side menu, but
          anchored to the bottom edge, where the thumb and the bar that opened
          it already are. It scrolls inside itself so the page never does. */}
      {widget && (
        <div className="sheet-backdrop" onClick={() => setWidget(null)}>
          <div
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={
              widget === "rules" ? "Rules summary" : widget === "log" ? "Move log" : "Settings"
            }
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-header">
              <h2>
                {widget === "rules" ? "Rules summary" : widget === "log" ? "Move log" : "Settings"}
              </h2>
              <button
                type="button"
                className="sheet-close"
                aria-label="Close"
                onClick={() => setWidget(null)}
              >
                ×
              </button>
            </div>
            <div className="sheet-body">
              {widget === "rules" && <div className="rules-summary">{renderRules()}</div>}
              {widget === "log" && <MoveLog moveLog={game.moveLog} />}
              {widget === "settings" && renderControls()}
            </div>
          </div>
        </div>
      )}

      {modal && (
        <div className="modal-backdrop">
          <div className="modal">
            {modal.kind === "downgrade" ? (
              <>
                <p>Rook charges exhausted — it must downgrade:</p>
                <button onClick={() => finishModalMove({ downgradeTo: "n" as MinorPromo })}>
                  Downgrade to Knight
                </button>
                <button onClick={() => finishModalMove({ downgradeTo: "b" as MinorPromo })}>
                  Downgrade to Bishop
                </button>
              </>
            ) : modal.kind === "forced" ? (
              <>
                <p>Pawn reaches the last rank — choose promotion:</p>
                <div className="promo-icons">
                  {(["q", "r", "b", "n"] as ForcedPromo[]).map((p) => (
                    <button
                      key={p}
                      className="promo-icon"
                      title={p.toUpperCase()}
                      onClick={() => finishModalMove({ forcedPromo: p })}
                    >
                      {PIECE_GLYPH[modal.color][p]}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="modal-header">
                  <p>Promote (optional)</p>
                  <button
                    className="modal-close"
                    aria-label="Close (no promotion)"
                    onClick={() => finishModalMove({})}
                  >
                    ×
                  </button>
                </div>
                <div className="promo-icons">
                  {modal.canMinor && (
                    <button
                      className="promo-icon"
                      title="Promote moved pawn → Knight"
                      onClick={() => finishModalMove({ minorPromo: "n" as MinorPromo })}
                    >
                      {PIECE_GLYPH[modal.color].n}
                    </button>
                  )}
                  {modal.canMinor && (
                    <button
                      className="promo-icon"
                      title="Promote moved pawn → Bishop"
                      onClick={() => finishModalMove({ minorPromo: "b" as MinorPromo })}
                    >
                      {PIECE_GLYPH[modal.color].b}
                    </button>
                  )}
                  {modal.canRook && (
                    <button
                      className="promo-icon"
                      title="Promote moved minor piece → Rook"
                      onClick={() => finishModalMove({ rookPromo: true })}
                    >
                      {PIECE_GLYPH[modal.color].r}
                    </button>
                  )}
                  <button className="promo-icon promo-none" title="No promotion" onClick={() => finishModalMove({})}>
                    None
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ClockDisplay({
  clock,
  turn,
  gameOver,
}: {
  clock: Record<Color, number>;
  turn: Color;
  gameOver: boolean;
}) {
  return (
    <div className="clocks">
      {(["w", "b"] as Color[]).map((color) => (
        <div
          key={color}
          className={`clock ${!gameOver && turn === color ? "active" : ""} ${clock[color] <= 10 ? "low" : ""}`}
        >
          <span className="clock-label">{color === "w" ? "White" : "Black"}</span>
          <span className="clock-time">{formatClock(clock[color])}</span>
        </div>
      ))}
    </div>
  );
}

export default App;
