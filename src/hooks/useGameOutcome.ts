import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Color } from "chess.js";
import { EvoChessGame } from "../evochess/game";
import type { AiLevel } from "../evochess/ai";
import { loadScores, recordResult, type Scores } from "../evochess/scores";
import type { Mode } from "../appTypes";

export interface UseGameOutcome {
  /** Win/loss/draw record vs the AI, per level, persisted to localStorage. */
  scores: Scores;
  /** True once the score text under the end-of-game dim is revealed. */
  scoreOverlayReady: boolean;
  showFireworks: boolean;
  setShowFireworks: Dispatch<SetStateAction<boolean>>;
  /** Which finished game has already been recorded. Set when loading a save
   *  that is already over, so a reload doesn't score it a second time. */
  scoredGameRef: RefObject<EvoChessGame | null>;
}

export interface UseGameOutcomeArgs {
  gameRef: RefObject<EvoChessGame>;
  loaded: boolean;
  mode: Mode;
  aiColor: Color;
  level: AiLevel;
  /** A game played from a shared link is not recorded against the level. */
  fromShared: boolean;
  /** A clock flag ends the game without EvoChessGame knowing about it. */
  timeUp: Color | null;
  /** Our colour in a live match, null when we are not seated in one. A live
   *  game is human-vs-human, so it is not scored, but the winner still gets
   *  the fireworks. */
  liveSeat: Color | null;
}

/**
 * What happens when a game ends: recording the result against the level's
 * score, the fireworks for beating the AI, and the delayed reveal of the
 * score overlay.
 */
export function useGameOutcome({
  gameRef,
  loaded,
  mode,
  aiColor,
  level,
  fromShared,
  timeUp,
  liveSeat,
}: UseGameOutcomeArgs): UseGameOutcome {
  const [scores, setScores] = useState<Scores>(loadScores);
  const [showFireworks, setShowFireworks] = useState(false);
  // The score overlay covers the board, so its dim fades in over 2.5s and the
  // score itself is only revealed at the end — long enough to see the final
  // position / mating move.
  const [scoreOverlayReady, setScoreOverlayReady] = useState(false);
  // Tracks which finished game instance has already been recorded, so the
  // scores effect below records each game-over exactly once (new game /
  // takeback reassign gameRef.current, giving a fresh instance to compare).
  const scoredGameRef = useRef<EvoChessGame | null>(null);

  // The game instance the fireworks effect below has already seen. A game that
  // is already over the first time it appears ended somewhere else: a shared
  // line that ends in mate, or a save of a game won before the reload. The
  // fireworks belong to the move that delivers mate, not to arriving at it.
  const seenGameRef = useRef<EvoChessGame | null>(null);

  // Fires the fireworks once when the human checkmates the AI, or when we
  // deliver mate in a live match. Keyed on the EvoChessGame instance so a new
  // game / takeback (which reassigns gameRef.current) resets the trigger even
  // if the win condition repeats.
  useEffect(() => {
    const game = gameRef.current;
    const firstSight = seenGameRef.current !== game;
    seenGameRef.current = game;
    if (!loaded) return;
    if (firstSight && game.isGameOver()) return;
    if (!game.isGameOver() || !game.chess.isCheckmate()) return;
    // The mated side is the one to move. Ours only if it is our own seat.
    const loser = game.turn;
    const won = liveSeat ? loser !== liveSeat : mode === "human-ai" && loser === aiColor;
    if (won) setShowFireworks(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, mode, aiColor, liveSeat, gameRef.current, gameRef.current.moveLog.length]);

  // Records the outcome of a finished vs-AI game against the current level's
  // score, once per game instance.
  useEffect(() => {
    if (!loaded) return;
    if (mode !== "human-ai") return;
    // A game played from a shared position started from whatever advantage the
    // sharer chose, so beating or losing to the AI there says nothing about the
    // level and is not recorded.
    if (fromShared) return;
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
  }, [loaded, mode, aiColor, level, fromShared, gameRef.current, gameRef.current.moveLog.length]);

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

  return { scores, scoreOverlayReady, showFireworks, setShowFireworks, scoredGameRef };
}
