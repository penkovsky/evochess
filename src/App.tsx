import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Chessboard } from "react-chessboard";
import type { Color, Square } from "chess.js";
import { EvoChessGame, EvoChessError, N_MINOR, M_ROOK, ROOK_CHARGES, type ApplyMoveOptions, type ForcedPromo, type MinorPromo } from "./evochess/game";
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
import { Fireworks } from "./Fireworks";
import "./App.css";

type Mode = "human-ai" | "human-human";

interface PromoModalState {
  from: Square;
  to: Square;
  kind: "forced" | "optional" | "downgrade";
  color: Color;
  canMinor: boolean;
  canRook: boolean;
}

const PIECE_GLYPH: Record<Color, Record<"q" | "r" | "b" | "n", string>> = {
  w: { q: "♕", r: "♖", b: "♗", n: "♘" },
  b: { q: "♛", r: "♜", b: "♝", n: "♞" },
};

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
  const logRef = useRef<HTMLDivElement>(null);
  const boardWrapRef = useRef<HTMLDivElement>(null);
  // Rules summary and move log share panel space, so only one is expanded
  // at a time — opening one collapses the other.
  const [openPanel, setOpenPanel] = useState<"rules" | "log" | null>("log");
  // Lets small screens hide the side panel to give the board more room; the
  // toggle button itself is only shown below a width breakpoint (see CSS).
  const [hidePanel, setHidePanel] = useState(false);
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
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    if (!modal || modal.kind !== "optional") return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") finishModalMove({});
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

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
              boardOrientation:
                mode === "human-human"
                  ? autoFlip && game.turn === "b"
                    ? "black"
                    : "white"
                  : aiColor === "w"
                  ? "black"
                  : "white",
              allowDragging: !(mode === "human-ai" && game.turn === aiColor) && !gameOver,
            }}
          />
          {showScoreOverlay && (
            <div className={`score-overlay${scoreOverlayReady ? " revealed" : ""}`}>
              <div className="score-overlay-text">
                {levelLabel} {currentRecord.wins}-{currentRecord.losses}-{currentRecord.draws}
              </div>
              <button className="play-again-btn" onClick={() => startNewGame(mode, aiColor, level)}>
                Play again?
              </button>
            </div>
          )}
        </div>
        {renderActionPicker("action-picker-below-board")}
        <button className="toggle-panel-btn" onClick={() => setHidePanel((v) => !v)}>
          {hidePanel ? "Show widgets" : "Hide widgets"}
        </button>
      </div>
      {!hidePanel && (
      <div className="panel">
        <details
          className="collapsible rules-summary"
          open={openPanel === "rules"}
          onToggle={(e) => togglePanel("rules", e.currentTarget.open)}
        >
          <summary>Rules summary</summary>
          <ul>
            <li>Starts with only Pawns and Kings; other pieces are earned through play.</li>
            <li>Every 3 Pawn moves earns a right to promote the last Pawn that moved to a Knight or Bishop.</li>
            <li>Every 3 minor-piece (Knight/Bishop) moves earns a right to promote the last minor piece that moved to a Rook.</li>
            <li>Rights accumulate and carry over until used; only one promotion may be spent per turn.</li>
            <li>A Rook has 5 charges, spent only when it moves; at 0 it downgrades to a Knight or Bishop (owner's choice) and can never become a Rook again. Capturing a Rook is a normal capture — it never triggers a downgrade.</li>
            <li>Reaching the 8th rank still forces a standard Pawn promotion, as in chess.</li>
            <li>Castling is not defined.</li>
          </ul>
        </details>
        <EvolutionPanel label="White" color="w" game={game} rights={rw} />
        <EvolutionPanel label="Black" color="b" game={game} rights={rb} />
        <details
          className="collapsible"
          open={openPanel === "log"}
          onToggle={(e) => togglePanel("log", e.currentTarget.open)}
        >
          <summary>Move log</summary>
          <div className="log" ref={logRef}>
            {game.moveLog
              .filter((_, i) => i % 2 === 0)
              .map((white, n) => {
                const black = game.moveLog[n * 2 + 1];
                return (
                  <div key={n}>
                    {n + 1}. {white}{black ? ` ${black}` : ""}
                  </div>
                );
              })}
          </div>
        </details>
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

function EvolutionPanel({
  label,
  color,
  game,
  rights,
}: {
  label: string;
  color: Color;
  game: EvoChessGame;
  rights: { minor: number; rook: number };
}) {
  const active = game.turn === color;
  return (
    <div className={`rights ${active ? "active" : ""}`}>
      <div className="rights-title">{label}</div>
      <EvoTrack
        label="Pawns → Minor"
        value={game.pawnMoveProgress[color]}
        max={N_MINOR}
        banked={rights.minor}
        bankedGlyph={color === "w" ? "♘/♗" : "♞/♝"}
      />
      <EvoTrack
        label="Minors → Rook"
        value={game.minorMoveProgress[color]}
        max={M_ROOK}
        banked={rights.rook}
        bankedGlyph={color === "w" ? "♖" : "♜"}
      />
    </div>
  );
}

function EvoTrack({
  label,
  value,
  max,
  banked,
  bankedGlyph,
}: {
  label: string;
  value: number;
  max: number;
  banked: number;
  bankedGlyph: string;
}) {
  return (
    <div className="evo-track">
      <span className="evo-label">{label}</span>
      <span className="evo-bar" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={`evo-cell ${i < value ? "filled" : ""}`} />
        ))}
      </span>
      <span className="evo-count">
        {value}/{max}
      </span>
      {banked > 0 && (
        <span className="evo-banked" title="Banked unused promotion rights">
          {bankedGlyph} ×{banked}
        </span>
      )}
    </div>
  );
}

export default App;
