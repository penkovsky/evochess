import type { Color } from "chess.js";
import { EvoChessGame } from "./game";
import type { AiLevel } from "./ai";
import { serializeGame, deserializeGame, type SerializedGame } from "./serialize";

const STORAGE_KEY = "evochess-save-v3";

export interface SavedState extends SerializedGame {
  mode: "human-ai" | "human-human";
  aiColor: Color;
  level: AiLevel;
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
  // Optional for backward compatibility with saves written before pondering
  // existed (ponder-spec.md §5.5). Defaults to on when absent.
  ponderEnabled?: boolean;
}

export function saveGame(
  game: EvoChessGame,
  mode: "human-ai" | "human-human",
  aiColor: Color,
  level: AiLevel,
  autoFlip: boolean,
  timerEnabled: boolean,
  timerMinutes: number,
  clock: Record<Color, number>,
  ponderEnabled: boolean
) {
  const saved: SavedState = {
    ...serializeGame(game),
    mode,
    aiColor,
    level,
    autoFlip,
    timerEnabled,
    timerMinutes,
    clock,
    ponderEnabled,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
}

export function loadGame(): {
  game: EvoChessGame;
  mode: "human-ai" | "human-human";
  aiColor: Color;
  level: AiLevel;
  autoFlip?: boolean;
  timerEnabled?: boolean;
  timerMinutes?: number;
  clock?: Record<Color, number>;
  ponderEnabled?: boolean;
} | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const saved: SavedState = JSON.parse(raw);
    return {
      game: deserializeGame(saved),
      mode: saved.mode,
      aiColor: saved.aiColor,
      // Default for saves written before difficulty was a named level.
      level: saved.level ?? "fun",
      autoFlip: saved.autoFlip,
      timerEnabled: saved.timerEnabled,
      timerMinutes: saved.timerMinutes,
      clock: saved.clock,
      ponderEnabled: saved.ponderEnabled,
    };
  } catch {
    return null;
  }
}

export function clearSavedGame() {
  localStorage.removeItem(STORAGE_KEY);
}
