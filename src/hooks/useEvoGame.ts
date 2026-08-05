import { useRef, useState, type RefObject } from "react";
import { EvoChessGame, START_FEN } from "../evochess/game";
import { newGameMeta, type GameMeta } from "../telemetry";

export interface UseEvoGame {
  /**
   * The game being played. A ref, not state: it is mutated in place, so
   * anything that touches it has to ask for the repaint itself.
   */
  gameRef: RefObject<EvoChessGame>;
  /**
   * Snapshots taken just before each applied move, for takeback and browsing.
   * In-memory only (not persisted): `copy()` captures the full EvoChess state,
   * which chess.js's own undo cannot.
   */
  historyRef: RefObject<EvoChessGame[]>;
  /**
   * Identity of the game being played, for the finished-game log. A ref, so a
   * takeback (which swaps `gameRef.current` for an earlier copy) stays the same
   * game.
   */
  gameMetaRef: RefObject<GameMeta>;
  /**
   * Whether the board holds a game restored from a save rather than one begun
   * in this session. Read by `first_move`.
   */
  resumedRef: RefObject<boolean>;
  /** Repaints from the refs above. */
  rerender: () => void;
  /** Puts a fresh game from the opening on the board. */
  resetGame: () => void;
}

/**
 * The game itself: the position, the line that led to it, and the identity the
 * telemetry hangs off. Everything that mutates them stays with the caller,
 * which is what keeps the move path in one place.
 */
export function useEvoGame(): UseEvoGame {
  const [, forceRender] = useState(0);
  const rerender = () => forceRender((n) => n + 1);
  const gameRef = useRef<EvoChessGame>(new EvoChessGame());
  const historyRef = useRef<EvoChessGame[]>([]);
  const gameMetaRef = useRef<GameMeta>(newGameMeta(START_FEN));
  const resumedRef = useRef(false);

  function resetGame() {
    gameRef.current = new EvoChessGame();
    gameMetaRef.current = newGameMeta(START_FEN);
    historyRef.current = [];
    resumedRef.current = false;
  }

  return { gameRef, historyRef, gameMetaRef, resumedRef, rerender, resetGame };
}
