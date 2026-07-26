import { describe, it, expect, beforeEach } from "vitest";
import { EvoChessGame } from "../game";
import { saveGame, loadGame, clearSavedGame } from "../persistence";
import type { Square } from "chess.js";

// This project's jsdom environment provides `window` but not `localStorage`,
// so persistence needs a stub to be exercised at all.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const save = (game: EvoChessGame) =>
  saveGame(game, "human-ai", "b", "zen", false, false, 5, { w: 0, b: 0 }, true);

describe("persistence of the evolved en passant", () => {
  beforeEach(() => {
    store.clear();
    clearSavedGame();
  });

  it("restores a pending capture, and it stays playable", () => {
    const game = new EvoChessGame();
    game.chess.load("7k/8/8/8/1p6/8/P3K3/8 w - - 0 1");
    game.minorRights.w = 1;
    game.applyMove("a2" as Square, "a4" as Square, { minorPromo: "n" });
    expect(game.epEvolved).not.toBeNull();

    save(game);
    const restored = loadGame()!.game;

    expect(restored.chess.get("a4" as Square)?.type).toBe("n");
    expect(restored.legalMoves().filter((m) => m.evolvedEp)).toHaveLength(1);

    restored.applyMove("b4" as Square, "a3" as Square);
    expect(restored.chess.get("a4" as Square)).toBeUndefined();
    expect(restored.chess.get("a3" as Square)?.color).toBe("b");
  });

  it("restores no pending capture when there is none", () => {
    const game = new EvoChessGame();
    save(game);
    const restored = loadGame()!.game;
    expect(restored.epEvolved).toBeNull();
    expect(restored.legalMoves().some((m) => m.evolvedEp)).toBe(false);
  });

  it("round-trips ponderEnabled", () => {
    const game = new EvoChessGame();
    saveGame(game, "human-ai", "b", "fun", false, false, 5, { w: 0, b: 0 }, false);
    expect(loadGame()!.ponderEnabled).toBe(false);
  });
});
