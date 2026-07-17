import type { Color } from "chess.js";
import { EvoChessGame } from "./game";
import { serializeGame, deserializeGame, type SerializedGame } from "./serialize";

const STORAGE_KEY = "evochess-save-v3";

export interface SavedState extends SerializedGame {
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
    ...serializeGame(game),
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
    return {
      game: deserializeGame(saved),
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
