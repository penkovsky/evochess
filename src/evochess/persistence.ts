import type { Color } from "chess.js";
import { EvoChessGame } from "./game";
import type { AiLevel } from "./ai";
import { serializeGame, deserializeGame, type SerializedGame } from "./serialize";

const STORAGE_KEY = "evochess-save-v3";
// A second slot, holding the game that was in STORAGE_KEY when a shared
// position took the board over. It exists so "back to my game" keeps working
// after the first move on the shared board, which is the point at which the
// shared game claims the autosave. Reload-proof by design: the offer is no use
// if closing the tab loses the game it points at.
const PARKED_KEY = "evochess-parked-v1";

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
  // True when this game began from a shared `?p=` position rather than from the
  // opening. Persisted because the flag has to survive a reload: the result of
  // a game played from someone else's position is not recorded against the
  // local score, and the score is not shown when it ends.
  fromShared?: boolean;
  // True when the position this game was played from could not have occurred
  // (share-links-spec.md §5.2). Persisted for the same reason as `fromShared`,
  // but the stake is higher: the engine lockout is what makes rendering an
  // impossible position safe, and the search assumes a well-formed board. Three
  // of the legality failures produce FENs chess.js accepts, so without this the
  // position comes back after a reload with the engine re-enabled.
  unverified?: boolean;
}

/**
 * Everything a save is made of. An object rather than a positional list because
 * the tail of it is `ponderEnabled, fromShared, unverified`: three adjacent
 * booleans that a positional call can transpose silently, and one of them
 * decides whether the engine is allowed near the position at all. Every field is
 * required, so adding the next one is a compile error at each call site rather
 * than a `false` that nobody notices.
 */
export interface SaveOptions {
  game: EvoChessGame;
  mode: "human-ai" | "human-human";
  aiColor: Color;
  level: AiLevel;
  autoFlip: boolean;
  timerEnabled: boolean;
  timerMinutes: number;
  clock: Record<Color, number>;
  ponderEnabled: boolean;
  fromShared: boolean;
  unverified: boolean;
}

export function saveGame({ game, ...settings }: SaveOptions) {
  const saved: SavedState = { ...serializeGame(game), ...settings };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
}

export interface LoadedGame {
  game: EvoChessGame;
  mode: "human-ai" | "human-human";
  aiColor: Color;
  level: AiLevel;
  autoFlip?: boolean;
  timerEnabled?: boolean;
  timerMinutes?: number;
  clock?: Record<Color, number>;
  ponderEnabled?: boolean;
  fromShared?: boolean;
  unverified?: boolean;
}

function parseSave(raw: string | null): LoadedGame | null {
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
      fromShared: saved.fromShared,
      unverified: saved.unverified,
    };
  } catch {
    return null;
  }
}

export function loadGame(): LoadedGame | null {
  return parseSave(localStorage.getItem(STORAGE_KEY));
}

export function clearSavedGame() {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Moves the current save aside so a shared game can take its place, and reports
 * whether there was one. The raw text is copied across rather than
 * re-serialized, so nothing about the parked game can be lost in a round trip.
 */
export function parkSavedGame(): boolean {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  localStorage.setItem(PARKED_KEY, raw);
  return true;
}

export function loadParkedGame(): LoadedGame | null {
  return parseSave(localStorage.getItem(PARKED_KEY));
}

export function hasParkedGame(): boolean {
  return localStorage.getItem(PARKED_KEY) !== null;
}

export function clearParkedGame() {
  localStorage.removeItem(PARKED_KEY);
}
