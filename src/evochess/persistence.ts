import type { Color } from "chess.js";
import { EvoChessGame } from "./game";

const STORAGE_KEY = "evochess-save-v2";

export interface SavedState {
  fen: string;
  minorRights: Record<Color, number>;
  rookRights: Record<Color, number>;
  pawnMoveProgress: Record<Color, number>;
  minorMoveProgress: Record<Color, number>;
  moveLog: string[];
  mode: "human-ai" | "human-human";
  aiColor: Color;
  depth: number;
  // Optional for backward compatibility with saves written before the
  // board-flip preference existed.
  autoFlip?: boolean;
  // Optional for backward compatibility with saves written before the
  // human-vs-human clock existed. Only the settings are persisted, not the
  // remaining time — like moveLog, the in-progress clock isn't reconstructed.
  timerEnabled?: boolean;
  timerMinutes?: number;
  // Optional for backward compatibility with saves written before the clock's
  // remaining time was persisted (it used to reset to timerMinutes on reload).
  clock?: Record<Color, number>;
}

export function saveGame(
  game: EvoChessGame,
  mode: "human-ai" | "human-human",
  aiColor: Color,
  depth: number,
  autoFlip: boolean,
  timerEnabled: boolean,
  timerMinutes: number,
  clock: Record<Color, number>
) {
  const saved: SavedState = {
    fen: game.chess.fen(),
    minorRights: game.minorRights,
    rookRights: game.rookRights,
    pawnMoveProgress: game.pawnMoveProgress,
    minorMoveProgress: game.minorMoveProgress,
    moveLog: game.moveLog,
    mode,
    aiColor,
    depth,
    autoFlip,
    timerEnabled,
    timerMinutes,
    clock,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
}

export function loadGame(): {
  game: EvoChessGame;
  mode: "human-ai" | "human-human";
  aiColor: Color;
  depth: number;
  autoFlip?: boolean;
  timerEnabled?: boolean;
  timerMinutes?: number;
  clock?: Record<Color, number>;
} | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const saved: SavedState = JSON.parse(raw);
    const game = new EvoChessGame();
    game.chess.load(saved.fen);
    game.minorRights = saved.minorRights;
    game.rookRights = saved.rookRights;
    game.pawnMoveProgress = saved.pawnMoveProgress;
    game.minorMoveProgress = saved.minorMoveProgress;
    game.moveLog = saved.moveLog;
    return {
      game,
      mode: saved.mode,
      aiColor: saved.aiColor,
      depth: saved.depth,
      autoFlip: saved.autoFlip,
      timerEnabled: saved.timerEnabled,
      timerMinutes: saved.timerMinutes,
      clock: saved.clock,
    };
  } catch {
    return null;
  }
}

export function clearSavedGame() {
  localStorage.removeItem(STORAGE_KEY);
}
