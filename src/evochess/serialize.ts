import type { Color, Square } from "chess.js";
import { EvoChessGame, type EvolvedEnPassant } from "./game";

// JSON-safe snapshot of an EvoChessGame: everything applyMove/legalMoves
// need that isn't recoverable from the FEN alone. Shared by localStorage
// persistence and the AI worker (postMessage can't carry class instances or
// Map/Set — structured clone would silently strip their prototypes).
export interface SerializedGame {
  fen: string;
  minorRights: Record<Color, number>;
  rookRights: Record<Color, number>;
  pawnMoveProgress: Record<Color, number>;
  minorMoveProgress: Record<Color, number>;
  moveLog: string[];
  moveTokens?: string[];
  rookCharges: Record<string, number>;
  rookLocked: string[];
  epEvolved?: EvolvedEnPassant | null;
  /** Where the game started. Absent for a save written before this field
   *  existed. See `EvoChessGame.base`. */
  base?: SerializedGame;
}

export function serializeGame(game: EvoChessGame): SerializedGame {
  return {
    fen: game.chess.fen(),
    minorRights: game.minorRights,
    rookRights: game.rookRights,
    pawnMoveProgress: game.pawnMoveProgress,
    minorMoveProgress: game.minorMoveProgress,
    moveLog: game.moveLog,
    moveTokens: game.moveTokens,
    rookCharges: Object.fromEntries(game.rookCharges),
    rookLocked: [...game.rookLocked],
    epEvolved: game.epEvolved,
    base: game.base,
  };
}

export function deserializeGame(saved: SerializedGame): EvoChessGame {
  const game = new EvoChessGame();
  game.chess.load(saved.fen);
  game.minorRights = saved.minorRights;
  game.rookRights = saved.rookRights;
  game.pawnMoveProgress = saved.pawnMoveProgress;
  game.minorMoveProgress = saved.minorMoveProgress;
  game.moveLog = saved.moveLog;
  game.moveTokens = saved.moveTokens ?? [];
  game.rookCharges = new Map(Object.entries(saved.rookCharges ?? {})) as Map<Square, number>;
  game.rookLocked = new Set((saved.rookLocked ?? []) as Square[]);
  game.epEvolved = saved.epEvolved ?? null;
  game.base = saved.base;
  return game;
}
