import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Chessboard } from "react-chessboard";
import type { Color, Square } from "chess.js";
import { EvoChessGame, EvoChessError, N_MINOR, M_ROOK, ROOK_CHARGES, type ApplyMoveOptions, type ForcedPromo, type MinorPromo } from "./evochess/game";
import { serializeGame } from "./evochess/serialize";
import type { AiCandidate, AiSearchRequest, AiSearchResponse } from "./evochess/ai.worker";
import { saveGame, loadGame, clearSavedGame } from "./evochess/persistence";
import "./App.css";

type Mode = "human-ai" | "human-human";

interface PromoModalState {
  from: Square;
  to: Square;
  kind: "forced" | "optional" | "downgrade";
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
  const [depth, setDepth] = useState(3);
  const [modal, setModal] = useState<PromoModalState | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // In human-vs-human, flip the board after every move so the side to move
  // sees their pieces at the bottom. Can be disabled by the user.
  const [autoFlip, setAutoFlip] = useState(true);
  // Human-vs-human clock. Off by default; remaining time lives in a ref
  // (like gameRef) and is pushed to the screen via rerender(), not React
  // state, since it changes many times per second.
  const [timerEnabled, setTimerEnabled] = useState(false);
  const [timerMinutes, setTimerMinutes] = useState(10);
  const [timeUp, setTimeUp] = useState<Color | null>(null);
  const clockRef = useRef<Record<Color, number>>({ w: 600, b: 600 });
  const logRef = useRef<HTMLDivElement>(null);
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
    return () => worker.terminate();
  }, []);

  function searchInWorker(game: EvoChessGame, depth: number, seed: number): Promise<AiCandidate | null> {
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
        resolve(e.data.candidate);
      };
      worker.addEventListener("message", handleMessage);
      const request: AiSearchRequest = { id, game: serializeGame(game), depth, seed };
      worker.postMessage(request);
    });
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
      setMode(saved.mode);
      setAiColor(saved.aiColor);
      setDepth(saved.depth);
      setAutoFlip(saved.autoFlip ?? true);
      setTimerEnabled(saved.timerEnabled ?? false);
      setTimerMinutes(saved.timerMinutes ?? 10);
      clockRef.current = saved.clock ?? { w: (saved.timerMinutes ?? 10) * 60, b: (saved.timerMinutes ?? 10) * 60 };
    }
    setLoaded(true);
    rerender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loaded) return;
    saveGame(gameRef.current, mode, aiColor, depth, autoFlip, timerEnabled, timerMinutes, clockRef.current);
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

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  async function maybeAiMove() {
    const game = gameRef.current;
    if (game.isGameOver()) return;
    if (mode !== "human-ai") return;
    if (game.turn !== aiColor) return;
    setSelected(null);
    setAiThinking(true);
    // Let the UI paint the "thinking" state before blocking the main
    // thread with the search.
    await new Promise((r) => setTimeout(r, 30));
    const candidate = await searchInWorker(game, depth, Math.floor(Math.random() * 1_000_000));
    // gameRef.current is reassigned (not mutated) by takeback/new game, so an
    // identity check here catches a search that's now stale.
    if (candidate && gameRef.current === game && !game.isGameOver() && game.turn === aiColor) {
      historyRef.current.push(game.copy());
      clockHistoryRef.current.push({ ...clockRef.current });
      game.applyMove(candidate.from, candidate.to, candidate.options);
    }
    setAiThinking(false);
    rerender();
    setTimeout(maybeAiMove, 0);
  }

  function applyAndAdvance(from: Square, to: Square, options: ApplyMoveOptions) {
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
    setModal(null);
    setSelected(null);
    setTimeUp(null);
    clockRef.current = restoredClock ?? { w: timerMinutes * 60, b: timerMinutes * 60 };
    rerender();
    // Only reachable when taking back to the opening in an AI-plays-White
    // game: let the AI make its first move again.
    if (mode === "human-ai" && !restored.isGameOver() && restored.turn === aiColor) {
      setTimeout(maybeAiMove, 0);
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
      setModal({ from, to, kind: "forced", canMinor: false, canRook: false });
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
        setModal({ from, to, kind: "downgrade", canMinor: false, canRook: false });
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

    setModal({ from, to, kind: "optional", canMinor, canRook });
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

  function startNewGame(newMode: Mode, newAiColor: Color, newDepth: number) {
    gameRef.current = new EvoChessGame();
    historyRef.current = [];
    clockHistoryRef.current = [];
    setMode(newMode);
    setAiColor(newAiColor);
    setDepth(newDepth);
    setModal(null);
    setSelected(null);
    setTimeUp(null);
    resetClock(timerMinutes);
    clearSavedGame();
    rerender();
    setTimeout(maybeAiMove, 0);
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
  const gameOver = game.isGameOver() || !!timeUp;

  const rw = game.rightsFor("w");
  const rb = game.rightsFor("b");

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
      <div className="board-wrap">
        {mode === "human-human" && timerEnabled && (
          <ClockDisplay clock={clockRef.current} turn={game.turn} gameOver={gameOver} />
        )}
        <button className="toggle-panel-btn" onClick={() => setHidePanel((v) => !v)}>
          {hidePanel ? "Show widgets" : "Hide widgets"}
        </button>
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
      </div>
      {!hidePanel && (
      <div className="panel">
        <div className="status">{status}</div>
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
          <label>
            Mode:
            <select
              value={mode}
              onChange={(e) => {
                const newMode = e.target.value as Mode;
                if (historyRef.current.length > 0) {
                  // eslint-disable-next-line no-alert
                  if (!window.confirm("Switch mode and end the current game?")) return;
                  startNewGame(newMode, aiColor, depth);
                } else {
                  setMode(newMode);
                }
              }}
            >
              <option value="human-ai">Human vs AI</option>
              <option value="human-human">Human vs Human</option>
            </select>
          </label>
          {mode === "human-ai" && (
            <div className="controls-row">
              <label>
                AI plays:
                <select value={aiColor} onChange={(e) => setAiColor(e.target.value as Color)}>
                  <option value="b">Black</option>
                  <option value="w">White</option>
                </select>
              </label>
              <label>
                AI depth:
                <input
                  type="number"
                  min={1}
                  max={4}
                  value={depth}
                  onChange={(e) => setDepth(Number(e.target.value))}
                />
              </label>
            </div>
          )}
          {mode === "human-human" && (
            <div className="controls-row">
              <label>
                <input
                  type="checkbox"
                  checked={autoFlip}
                  onChange={(e) => setAutoFlip(e.target.checked)}
                />
                Flip board
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={timerEnabled}
                  disabled={historyRef.current.length > 0}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    setTimerEnabled(enabled);
                    if (enabled) {
                      setTimeUp(null);
                      resetClock(timerMinutes);
                    }
                  }}
                />
                Clock
              </label>
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
          <button onClick={takeback} disabled={historyRef.current.length === 0 || aiThinking}>
            Takeback
          </button>
          <button onClick={() => startNewGame(mode, aiColor, depth)}>New Game</button>
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
                {(["q", "r", "b", "n"] as ForcedPromo[]).map((p) => (
                  <button key={p} onClick={() => finishModalMove({ forcedPromo: p })}>
                    {p.toUpperCase()}
                  </button>
                ))}
              </>
            ) : (
              <>
                <p>Optional evolutionary promotion this turn:</p>
                <button onClick={() => finishModalMove({})}>No promotion</button>
                {modal.canMinor && (
                  <>
                    <button onClick={() => finishModalMove({ minorPromo: "n" as MinorPromo })}>
                      Promote moved pawn → Knight
                    </button>
                    <button onClick={() => finishModalMove({ minorPromo: "b" as MinorPromo })}>
                      Promote moved pawn → Bishop
                    </button>
                  </>
                )}
                {modal.canRook && (
                  <button onClick={() => finishModalMove({ rookPromo: true })}>
                    Promote moved minor piece → Rook
                  </button>
                )}
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
