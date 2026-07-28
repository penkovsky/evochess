import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Chessboard } from "react-chessboard";
import type { Color, Square } from "chess.js";
import { EvoChessGame, ROOK_CHARGES, type ApplyMoveOptions, type ForcedPromo, type MinorPromo } from "./evochess/game";
import {
  LESSONS,
  RULES_SUMMARY,
  buildLessonGame,
  isStepSquarePair,
  isSuggestionAvailable,
  optionsMatch,
  type Lesson,
  type ScriptedMove,
  type StepMove,
} from "./evochess/tutorial";
import { loadProgress, markCompleted, markSeen } from "./evochess/tutorialProgress";
import { EvoStrip } from "./EvoStrip";
import { PIECE_GLYPH } from "./pieceGlyph";
import "./Tutorial.css";

/** Lets the learner's own move paint before the search takes the thread. */
const MOVE_SETTLE_MS = 220;

/** Black's opponent throughout the tutorial: the game's own gentlest level. */
const OPPONENT_LEVEL = "easy" as const;

export type SearchFn = (
  game: EvoChessGame,
  level: typeof OPPONENT_LEVEL,
  seed: number
) => Promise<{ from: Square; to: Square; options: ApplyMoveOptions } | null>;

/**
 * "await" — a step is suggesting a move.
 * "reply" — the opponent is choosing its answer.
 * "note"  — the suggested move was played; showing what it did.
 * "done"  — the lesson's last step is finished.
 * "free"  — the learner played something else, so the script stepped aside;
 *           the game carries on against the AI until they ask to rewind.
 */
type Phase = "await" | "reply" | "note" | "done" | "free";

interface ModalState {
  kind: "optional" | "downgrade" | "forced";
  from: Square;
  to: Square;
  color: Color;
  canMinor: boolean;
  canRook: boolean;
  /** Whether these squares are the step's own move, so the choice still decides. */
  onScript: boolean;
}

/** What the step suggests picking, derived from its own options. */
function choicePrompt(step: StepMove): string {
  if (step.anyDowngrade) return "Choose a Knight or a Bishop.";
  const { minorPromo, rookPromo } = step.options ?? {};
  if (minorPromo === "n") return "The lesson suggests the Knight.";
  if (minorPromo === "b") return "The lesson suggests the Bishop.";
  if (rookPromo) return "The lesson suggests the Rook.";
  return "The lesson suggests None — banking the right for later.";
}

export function Tutorial({ onExit, onSearch }: { onExit: () => void; onSearch?: SearchFn }) {
  const [lessonIndex, setLessonIndex] = useState<number | null>(null);
  const [progress, setProgress] = useState(loadProgress);

  useEffect(() => {
    // Opening the tutorial at all counts as seeing it, so the invitation on
    // the board isn't offered again on the next visit.
    setProgress(markSeen());
  }, []);

  if (lessonIndex === null) {
    return <LessonMenu completed={progress.completed} onPick={setLessonIndex} onExit={onExit} />;
  }

  return (
    <LessonPlayer
      key={LESSONS[lessonIndex].id}
      lesson={LESSONS[lessonIndex]}
      index={lessonIndex}
      onSearch={onSearch}
      onComplete={(id) => setProgress(markCompleted(id))}
      onNext={() => setLessonIndex(lessonIndex + 1 < LESSONS.length ? lessonIndex + 1 : null)}
      isLast={lessonIndex === LESSONS.length - 1}
      onMenu={() => setLessonIndex(null)}
      onExit={onExit}
    />
  );
}

function LessonMenu({
  completed,
  onPick,
  onExit,
}: {
  completed: string[];
  onPick: (index: number) => void;
  onExit: () => void;
}) {
  const allDone = LESSONS.every((l) => completed.includes(l.id));
  // Resume where they left off rather than always restarting at lesson one.
  const nextIndex = Math.max(0, LESSONS.findIndex((l) => !completed.includes(l.id)));

  return (
    <div className="tutorial tutorial-menu">
      <h2 className="tutorial-title">Learn EvoChess</h2>
      <p className="tutorial-lede">
        It's chess, except you start with only Pawns and a King — every other piece has to be
        earned during the game. Three short lessons, about a minute each. Nothing is forced: play
        along, or wander off and poke at the rules whenever you like.
      </p>
      <ol className="lesson-list">
        {LESSONS.map((lesson, i) => {
          const done = completed.includes(lesson.id);
          return (
            <li key={lesson.id}>
              <button className={`lesson-card ${done ? "done" : ""}`} onClick={() => onPick(i)}>
                <span className="lesson-num" aria-hidden="true">
                  {done ? "✓" : i + 1}
                </span>
                <span className="lesson-card-text">
                  <span className="lesson-card-title">{lesson.title}</span>
                  <span className="lesson-card-blurb">{lesson.blurb}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="tutorial-menu-actions">
        {!allDone && (
          <button className="tutorial-btn primary" onClick={() => onPick(nextIndex)}>
            {completed.length > 0 ? "Continue" : "Start lesson 1"}
          </button>
        )}
        <button className="tutorial-btn" onClick={onExit}>
          {allDone ? "Play a game" : "Back to the board"}
        </button>
      </div>

      {/* The lessons teach three rules by playing them; this is the rest, for
          anyone who would rather just read the whole thing. */}
      <section className="tutorial-rules">
        <h3>The rules, in brief</h3>
        <ul>
          {RULES_SUMMARY.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function LessonPlayer({
  lesson,
  index,
  isLast,
  onSearch,
  onComplete,
  onNext,
  onMenu,
  onExit,
}: {
  lesson: Lesson;
  index: number;
  isLast: boolean;
  onSearch?: SearchFn;
  onComplete: (id: string) => void;
  onNext: () => void;
  onMenu: () => void;
  onExit: () => void;
}) {
  const [, forceRender] = useState(0);
  const rerender = () => forceRender((n) => n + 1);
  const gameRef = useRef<EvoChessGame>(buildLessonGame(lesson));
  // The position each step was actually played from. Snapshots rather than a
  // replay of the script, because the opponent is a real AI: what happened is
  // not what the scripted line says would have happened.
  const stepStartsRef = useRef<EvoChessGame[]>([gameRef.current.copy()]);
  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("await");
  const [modal, setModal] = useState<ModalState | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  // Set while an opponent search is in flight so a reply arriving after a
  // rewind can be recognised as stale and dropped.
  const mountedRef = useRef(true);

  const step = lesson.steps[stepIndex];
  const game = gameRef.current;
  const boardLive = (phase === "await" || phase === "free") && !game.isGameOver();
  // A real opponent can overtake the lesson: the piece a step wants to move
  // may be gone, or a check may rule the move out.
  const diverged = phase === "await" && !isSuggestionAvailable(game, step);
  const suggestionLive = phase === "await" && !diverged;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Puts the learner back on a position, discarding anything played since. */
  function restore(target: number, position: EvoChessGame) {
    gameRef.current = position;
    setStepIndex(target);
    setPhase("await");
    setModal(null);
    setSelected(null);
    rerender();
  }

  /** Back to the position this step was played from — earlier steps survive. */
  function rewindToStep() {
    restore(stepIndex, stepStartsRef.current[stepIndex].copy());
  }

  function restartLesson() {
    const fresh = buildLessonGame(lesson);
    stepStartsRef.current = [fresh.copy()];
    restore(0, fresh);
  }

  /**
   * Black's move. The tutorial plays a real game against the Easy AI rather
   * than a canned line, so the learner is practising against the same
   * opponent the app itself offers. `step.reply` is the fallback for when no
   * search is available at all.
   */
  async function playOpponentReply(from: EvoChessGame, onScript: boolean, fallback?: ScriptedMove) {
    setPhase("reply");
    // Let the learner's own move land visibly before the search starts.
    await new Promise((r) => setTimeout(r, MOVE_SETTLE_MS));
    let move: ScriptedMove | null = null;
    if (onSearch && gameRef.current === from && !from.isGameOver()) {
      const candidate = await onSearch(from, OPPONENT_LEVEL, Math.floor(Math.random() * 1_000_000));
      if (candidate) move = { from: candidate.from, to: candidate.to, options: candidate.options };
    }
    // A rewind (or an unmount) while the search ran makes this reply stale:
    // gameRef is reassigned rather than mutated, so identity catches it.
    if (!mountedRef.current || gameRef.current !== from) return;
    if (!move && fallback) move = fallback;
    if (move && !from.isGameOver()) {
      try {
        from.applyMove(move.from, move.to, move.options ?? {});
      } catch {
        // A fallback line that no longer fits the position: skip it rather
        // than corrupt the game. The learner simply gets another turn.
      }
    }
    setPhase(onScript ? "note" : "free");
    rerender();
  }

  function commit(from: Square, to: Square, options: ApplyMoveOptions, onScript: boolean) {
    setModal(null);
    setSelected(null);
    try {
      game.applyMove(from, to, options);
    } catch {
      // The rules engine refused it; leave the position alone.
      rerender();
      return;
    }
    rerender();
    if (game.isGameOver()) {
      setPhase(onScript ? "note" : "free");
      return;
    }
    void playOpponentReply(game, onScript, onScript ? step.reply : undefined);
  }

  function advance() {
    if (stepIndex + 1 < lesson.steps.length) {
      stepStartsRef.current[stepIndex + 1] = game.copy();
      setStepIndex(stepIndex + 1);
      setPhase("await");
      return;
    }
    onComplete(lesson.id);
    setPhase("done");
  }

  /**
   * Any legal move is accepted, whether or not it's the one being taught —
   * the step's move continues the lesson, anything else hands the board over.
   * Illegal moves are simply declined by the rules engine, with no telling-off.
   */
  function attemptMove(from: Square, to: Square): boolean {
    if (!boardLive || modal) return false;
    const piece = game.chess.get(from);
    if (!piece || piece.color !== game.turn) return false;
    const onScript = suggestionLive && isStepSquarePair(step.play, from, to);
    const color = game.turn;

    // Which prompt (if any) a move needs is decided by the rules engine, so the
    // learner meets exactly the prompts a real game would show them.
    const isPawn = piece.type === "p";
    const reachesLastRank = isPawn && (to[1] === "8" || to[1] === "1");
    const scratch = game.copy();

    if (reachesLastRank) {
      try {
        scratch.applyMove(from, to, { forcedPromo: "q" });
      } catch {
        return false;
      }
      setModal({ kind: "forced", from, to, color, canMinor: false, canRook: false, onScript });
      return true;
    }

    if (piece.type === "r") {
      const remaining = (game.rookCharges.get(from) ?? ROOK_CHARGES) - 1;
      try {
        scratch.applyMove(from, to, remaining <= 0 ? { downgradeTo: "n" } : {});
      } catch {
        return false;
      }
      if (remaining <= 0) {
        setModal({ kind: "downgrade", from, to, color, canMinor: false, canRook: false, onScript });
        return true;
      }
      commit(from, to, {}, onScript);
      return true;
    }

    try {
      scratch.applyMove(from, to);
    } catch {
      return false;
    }
    const canMinor = isPawn && scratch.minorRights[color] > 0;
    const canRook = (piece.type === "n" || piece.type === "b") && scratch.canRookPromote(color, to);
    if (!canMinor && !canRook) {
      commit(from, to, {}, onScript);
      return true;
    }
    setModal({ kind: "optional", from, to, color, canMinor, canRook, onScript });
    return true;
  }

  /** A choice from the prompt. Taking a different one is allowed — it goes free. */
  function choose(options: ApplyMoveOptions) {
    if (!modal) return;
    commit(modal.from, modal.to, options, modal.onScript && optionsMatch(step.play, options));
  }

  function onSquareClick({ square }: { square: string }) {
    if (!boardLive || modal) return;
    const sq = square as Square;
    const piece = game.chess.get(sq);
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
      setSelected(piece && piece.color === game.turn ? sq : null);
      return;
    }
    if (piece && piece.color === game.turn) setSelected(sq);
  }

  const squareStyles: Record<string, CSSProperties> = {};
  if (suggestionLive && !modal) {
    squareStyles[step.play.from] = { boxShadow: "inset 0 0 0 4px rgba(34, 170, 119, 0.85)" };
    // A filled dot would sit behind the piece on an occupied square, so a
    // capture is marked with a ring around it instead — the same convention
    // the game itself uses for legal-move hints.
    squareStyles[step.play.to] = game.chess.get(step.play.to)
      ? { background: "radial-gradient(circle, transparent 55%, rgba(34, 170, 119, 0.55) 55%)" }
      : { background: "radial-gradient(circle, rgba(34, 170, 119, 0.55) 22%, transparent 23%)" };
  }
  if (selected) {
    squareStyles[selected] = { background: "rgba(255, 255, 0, 0.4)" };
    for (const m of game.legalMoves()) {
      if (m.from !== selected || squareStyles[m.to]) continue;
      squareStyles[m.to] = {
        background: m.isCapture
          ? "radial-gradient(circle, transparent 55%, rgba(0, 0, 0, 0.35) 55%)"
          : "radial-gradient(circle, rgba(0, 0, 0, 0.35) 19%, transparent 20%)",
      };
    }
  }

  const rights = { w: game.rightsFor("w"), b: game.rightsFor("b") };
  const turnLabel = game.turn === "w" ? "White" : "Black";

  return (
    <div className="tutorial tutorial-lesson">
      <div className="board-wrap">
        <div className="tutorial-lesson-head">
          <span className="tutorial-crumb">
            Lesson {index + 1} of {LESSONS.length}
          </span>
          <span className="tutorial-lesson-title">{lesson.title}</span>
        </div>
        <EvoStrip color="b" game={game} rights={rights.b} active={game.turn === "b"} />
        <div className="board-container">
          <Chessboard
            options={{
              position: game.chess.fen(),
              onPieceDrop: ({ sourceSquare, targetSquare }) =>
                targetSquare ? attemptMove(sourceSquare as Square, targetSquare as Square) : false,
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
              boardOrientation: "white",
              allowDragging: boardLive && !modal,
            }}
          />
        </div>
        <EvoStrip color="w" game={game} rights={rights.w} active={game.turn === "w"} />
      </div>

      <div className="tutorial-panel">
        <div className="step-pips" aria-label={`Step ${stepIndex + 1} of ${lesson.steps.length}`}>
          {lesson.steps.map((_, i) => (
            <span
              key={i}
              className={`step-pip ${
                i < stepIndex || phase === "done"
                  ? "done"
                  : i === stepIndex && phase !== "free" && !diverged
                  ? "current"
                  : ""
              }`}
            />
          ))}
        </div>

        {phase === "done" ? (
          <div className="tutorial-card outro">
            <h3>Lesson complete</h3>
            <p>{lesson.outro}</p>
            <div className="tutorial-actions">
              {isLast ? (
                <button className="tutorial-btn primary" onClick={onExit}>
                  Play a real game
                </button>
              ) : (
                <button className="tutorial-btn primary" onClick={onNext}>
                  Next lesson
                </button>
              )}
              <button className="tutorial-btn" onClick={onMenu}>
                All lessons
              </button>
            </div>
            {isLast && (
              <p className="tutorial-footnote">
                Two leftovers, both borrowed straight from chess: a Pawn reaching the last rank still
                promotes normally (Queen included), and there is no castling.
              </p>
            )}
          </div>
        ) : phase === "free" ? (
          <div className="tutorial-card free">
            <h3>Off script — that's fine</h3>
            <p>
              Carry on: you're playing White against the Easy opponent, and every rule, counter and
              prompt works exactly as it does in a real game.
            </p>
            <p className="tutorial-free-status">
              {game.isGameOver() ? game.resultString() : `${turnLabel} to move.`}
            </p>
            <p>I'll be right here whenever you want the lesson back.</p>
            <div className="tutorial-actions">
              <button className="tutorial-btn primary" onClick={rewindToStep}>
                Replay this step
              </button>
              <button className="tutorial-btn" onClick={restartLesson}>
                Replay lesson
              </button>
            </div>
          </div>
        ) : phase === "reply" ? (
          <div className="tutorial-card thinking">
            <p>Easy is thinking…</p>
          </div>
        ) : diverged ? (
          <div className="tutorial-card free">
            <h3>The game has moved on</h3>
            <p>
              The lesson wanted to play {step.play.from}–{step.play.to}, but the position has run
              ahead of it and that move isn't available any more. That's chess — nothing has gone
              wrong.
            </p>
            <p>Keep playing, or rewind and take the step again.</p>
            <div className="tutorial-actions">
              <button className="tutorial-btn primary" onClick={rewindToStep}>
                Replay this step
              </button>
              <button className="tutorial-btn" onClick={restartLesson}>
                Replay lesson
              </button>
            </div>
          </div>
        ) : phase === "note" ? (
          <div className="tutorial-card note">
            <p>{step.note}</p>
            <div className="tutorial-actions">
              <button className="tutorial-btn primary" onClick={advance}>
                {stepIndex + 1 < lesson.steps.length ? "Continue" : "Finish lesson"}
              </button>
            </div>
          </div>
        ) : (
          <div className="tutorial-card instruction">
            <p>{step.text}</p>
            <p className="tutorial-suggestion">{step.hint}</p>
            <p className="tutorial-aside">Or play anything else — I'll step aside and wait.</p>
          </div>
        )}

        <div className="tutorial-footer">
          <button className="tutorial-btn subtle" onClick={restartLesson}>
            Restart lesson
          </button>
          <button className="tutorial-btn subtle" onClick={onMenu}>
            All lessons
          </button>
          <button className="tutorial-btn subtle" onClick={onExit}>
            Exit
          </button>
        </div>
      </div>

      {modal && (
        <div className="modal-backdrop">
          <div className="modal tutorial-modal">
            {modal.kind === "downgrade" ? (
              <>
                <p>Rook charges exhausted — it must downgrade:</p>
                <button onClick={() => choose({ downgradeTo: "n" as MinorPromo })}>Downgrade to Knight</button>
                <button onClick={() => choose({ downgradeTo: "b" as MinorPromo })}>Downgrade to Bishop</button>
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
                      onClick={() => choose({ forcedPromo: p })}
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
                </div>
                <div className="promo-icons">
                  {modal.canMinor && (
                    <button
                      className="promo-icon"
                      title="Promote moved pawn → Knight"
                      onClick={() => choose({ minorPromo: "n" as MinorPromo })}
                    >
                      {PIECE_GLYPH[modal.color].n}
                    </button>
                  )}
                  {modal.canMinor && (
                    <button
                      className="promo-icon"
                      title="Promote moved pawn → Bishop"
                      onClick={() => choose({ minorPromo: "b" as MinorPromo })}
                    >
                      {PIECE_GLYPH[modal.color].b}
                    </button>
                  )}
                  {modal.canRook && (
                    <button
                      className="promo-icon"
                      title="Promote moved minor piece → Rook"
                      onClick={() => choose({ rookPromo: true })}
                    >
                      {PIECE_GLYPH[modal.color].r}
                    </button>
                  )}
                  <button className="promo-icon promo-none" title="No promotion" onClick={() => choose({})}>
                    None
                  </button>
                </div>
              </>
            )}
            {/* The instruction card is behind the backdrop, so the step's own
                suggestion has to be repeated here to be readable. Any other
                choice is still accepted — it just ends the scripted line. */}
            {modal.onScript && <p className="tutorial-choice-prompt">{choicePrompt(step.play)}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
