import { describe, it, expect, beforeEach } from "vitest";
import { EvoChessGame, START_FEN } from "../game";
import { saveGame, loadGame, clearSavedGame, type SaveOptions } from "../persistence";
import type { Square } from "chess.js";

// This project's jsdom environment provides `window` but not `localStorage`,
// so persistence needs a stub to be exercised at all.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const baseOptions: Omit<SaveOptions, "game"> = {
  mode: "human-ai",
  aiColor: "b",
  level: "zen",
  autoFlip: false,
  timerEnabled: false,
  timerMinutes: 5,
  clock: { w: 0, b: 0 },
  ponderEnabled: true,
  fromShared: false,
  unverified: false,
  telemetry: { uid: "test-uid", startFen: START_FEN, startParam: null, activeMs: 0, lastPlyAt: null, lastPlies: 0, takebacks: 0, started: true, logged: false, abandonedAtPly: null },
};

/** Saves with the defaults above, so each test states only what it varies. */
const save = (game: EvoChessGame, overrides: Partial<SaveOptions> = {}) =>
  saveGame({ game, ...baseOptions, ...overrides });

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
    save(game, { ponderEnabled: false });
    expect(loadGame()!.ponderEnabled).toBe(false);
  });

  // A game that began on a shared link must still be marked as such after a
  // reload, or its result would start counting against the local score.
  it("round-trips fromShared", () => {
    const game = new EvoChessGame();
    save(game, { fromShared: true });
    expect(loadGame()!.fromShared).toBe(true);
    save(game, { fromShared: false });
    expect(loadGame()!.fromShared).toBe(false);
  });

  // The engine lockout for an impossible position (share-links-spec.md §5.2) is
  // memory-only in App.tsx, so it has to be persisted or a reload re-enables the
  // search on a board the bitboard layer must never see.
  it("round-trips unverified", () => {
    const game = new EvoChessGame();
    save(game, { unverified: true });
    expect(loadGame()!.unverified).toBe(true);
    save(game, { unverified: false });
    expect(loadGame()!.unverified).toBe(false);
  });

  // Every field of a save is required. One written to an older shape is dropped
  // rather than restored with holes in it, which would mean a half-set of
  // preferences and a game the funnel cannot account for.
  it("drops a save with no telemetry field", () => {
    const game = new EvoChessGame();
    save(game);
    const raw = JSON.parse(store.get("evochess-save-v3")!);
    delete raw.telemetry;
    store.set("evochess-save-v3", JSON.stringify(raw));
    expect(loadGame()).toBeNull();
  });

  it("round-trips telemetry, so a resumed game is neither re-counted nor re-logged", () => {
    const game = new EvoChessGame();
    save(game, { telemetry: { ...baseOptions.telemetry, started: true, logged: true, takebacks: 3 } });
    const meta = loadGame()!.telemetry;
    expect(meta.started).toBe(true);
    expect(meta.logged).toBe(true);
    expect(meta.takebacks).toBe(3);
    expect(meta.uid).toBe("test-uid");
  });

  // `base` is what makes a resumed game shareable with its history, and what
  // the startup replay rebuilds the browsing snapshots from.
  it("round-trips the base position", () => {
    const game = new EvoChessGame();
    game.applyMove("e2" as Square, "e4" as Square);
    save(game);
    const restored = loadGame()!.game;
    expect(restored.base).toEqual(game.base);
    expect(restored.base!.fen).toBe(START_FEN);
  });

  it("leaves the base undefined for a save written without one", () => {
    const game = new EvoChessGame();
    save(game);
    const raw = JSON.parse(store.get("evochess-save-v3")!);
    delete raw.base;
    store.set("evochess-save-v3", JSON.stringify(raw));
    // Not the standard start: an unknown start must stay unknown, or a share
    // link would claim a history the game never had.
    expect(loadGame()!.game.base).toBeUndefined();
  });
});
