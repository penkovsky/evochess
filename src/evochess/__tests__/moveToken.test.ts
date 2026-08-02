import { describe, it, expect } from "vitest";
import { EvoChessGame, moveToken, parseMoveToken, replayLine, START_FEN, type ApplyMoveOptions } from "../game";
import { deserializeGame, serializeGame, type SerializedGame } from "../serialize";
import { legalTurns } from "../ai";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seenTags = { f: false, m: false, r: false, d: false, banked: false };

function tagOf(options: ApplyMoveOptions): keyof typeof seenTags | null {
  if (options.forcedPromo) return "f";
  if (options.minorPromo) return "m";
  if (options.rookPromo) return "r";
  if (options.downgradeTo) return "d";
  return null;
}

function playRandomGame(seed: number, maxPlies: number): EvoChessGame {
  const rng = mulberry32(seed);
  const game = new EvoChessGame();
  for (let ply = 0; ply < maxPlies; ply++) {
    if (game.isGameOver()) break;
    const moves = legalTurns(game);
    if (moves.length === 0) break;
    const mv = moves[Math.floor(rng() * moves.length)];
    const tag = tagOf(mv.options);
    if (tag) seenTags[tag] = true;
    else if (moves.some((m) => m.from === mv.from && m.to === mv.to && tagOf(m.options))) {
      seenTags.banked = true;
    }
    game.applyMove(mv.from, mv.to, mv.options);
  }
  return game;
}

describe("moveToken", () => {
  it("round-trips: replaying moveTokens from START_FEN reproduces the full game state", () => {
    for (let seed = 0; seed < 30; seed++) {
      const game = playRandomGame(seed, 120);

      const replay = new EvoChessGame();
      for (const token of game.moveTokens) {
        const from = token.slice(0, 2) as import("chess.js").Square;
        const to = token.slice(2, 4) as import("chess.js").Square;
        const options: ApplyMoveOptions = {};
        const rest = token.slice(4);
        if (rest) {
          const kind = rest[0];
          const piece = rest.slice(1);
          if (kind === "f") options.forcedPromo = piece as ApplyMoveOptions["forcedPromo"];
          else if (kind === "m") options.minorPromo = piece as ApplyMoveOptions["minorPromo"];
          else if (kind === "r") options.rookPromo = true;
          else if (kind === "d") options.downgradeTo = piece as ApplyMoveOptions["downgradeTo"];
        }
        replay.applyMove(from, to, options);
      }

      expect(replay.chess.fen()).toBe(game.chess.fen());
      expect(replay.minorRights).toEqual(game.minorRights);
      expect(replay.rookRights).toEqual(game.rookRights);
      expect(replay.pawnMoveProgress).toEqual(game.pawnMoveProgress);
      expect(replay.minorMoveProgress).toEqual(game.minorMoveProgress);
      expect([...replay.rookCharges.entries()].sort()).toEqual([...game.rookCharges.entries()].sort());
      expect([...replay.rookLocked].sort()).toEqual([...game.rookLocked].sort());
    }

    expect(seenTags).toEqual({ f: true, m: true, r: true, d: true, banked: true });
  });

  it("keeps moveTokens and moveLog the same length through moves, a rejected move, and copy()", () => {
    const game = new EvoChessGame();
    game.applyMove("e2", "e4");
    game.applyMove("e7", "e5");
    expect(game.moveTokens.length).toBe(game.moveLog.length);

    expect(() => game.applyMove("e1", "e8")).toThrow();
    expect(game.moveTokens.length).toBe(2);
    expect(game.moveLog.length).toBe(2);

    const copy = game.copy();
    copy.applyMove("d2", "d4");
    expect(copy.moveTokens.length).toBe(copy.moveLog.length);
    expect(game.moveTokens.length).toBe(2);
    expect(copy.moveTokens).toEqual([...game.moveTokens, "d2d4"]);
  });

  it("moveToken produces the documented spellings", () => {
    expect(moveToken("e2", "e4", {})).toBe("e2e4");
    expect(moveToken("d2", "d4", { minorPromo: "n" })).toBe("d2d4mn");
    expect(moveToken("c3", "d5", { rookPromo: true })).toBe("c3d5r");
    expect(moveToken("e7", "e8", { forcedPromo: "q" })).toBe("e7e8fq");
    expect(moveToken("a1", "a8", { downgradeTo: "n" })).toBe("a1a8dn");
  });

  it("defaults moveTokens to [] when deserializing a save written before it existed", () => {
    const game = new EvoChessGame();
    game.applyMove("e2", "e4");
    const saved = serializeGame(game) as SerializedGame & { moveTokens?: string[] };
    delete saved.moveTokens;

    const restored = deserializeGame(saved);
    expect(restored.moveTokens).toEqual([]);
    expect(restored.moveLog).toEqual(["e4"]);
  });

  it("parseMoveToken(moveToken(...)) round-trips for all five option shapes", () => {
    const cases: ApplyMoveOptions[] = [
      {},
      { minorPromo: "n" },
      { minorPromo: "b" },
      { rookPromo: true },
      { downgradeTo: "n" },
      { downgradeTo: "b" },
      { forcedPromo: "q" },
      { forcedPromo: "r" },
      { forcedPromo: "b" },
      { forcedPromo: "n" },
    ];
    for (const options of cases) {
      const token = moveToken("e2", "e4", options);
      expect(parseMoveToken(token)).toEqual({ from: "e2", to: "e4", options });
    }
  });

  it("parseMoveToken returns null for a malformed token", () => {
    expect(parseMoveToken("")).toBeNull();
    expect(parseMoveToken("e2e")).toBeNull();
    expect(parseMoveToken("e2e4x")).toBeNull();
  });

  describe("replayLine", () => {
    it("reproduces the game field for field at every ply, from the standard start", () => {
      for (let seed = 0; seed < 10; seed++) {
        const game = playRandomGame(seed, 60);
        const base: SerializedGame = {
          fen: START_FEN,
          minorRights: { w: 0, b: 0 },
          rookRights: { w: 0, b: 0 },
          pawnMoveProgress: { w: 0, b: 0 },
          minorMoveProgress: { w: 0, b: 0 },
          moveLog: [],
          moveTokens: [],
          rookCharges: {},
          rookLocked: [],
          epEvolved: null,
        };
        const line = replayLine(base, game.moveTokens);
        expect(line).toHaveLength(game.moveTokens.length + 1);
        const last = line[line.length - 1];
        expect(last.chess.fen()).toBe(game.chess.fen());
        expect(last.minorRights).toEqual(game.minorRights);
        expect(last.rookRights).toEqual(game.rookRights);
        expect([...last.rookCharges.entries()].sort()).toEqual([...game.rookCharges.entries()].sort());
        expect([...last.rookLocked].sort()).toEqual([...game.rookLocked].sort());
      }
    });

    it("reproduces state at every ply from a non-standard base, not just the standard start", () => {
      const full = playRandomGame(3, 40);
      const splitAt = Math.floor(full.moveTokens.length / 2);

      // Replay the first half to get a mid-game base, then replay the rest
      // on top of it. This is what a resume-play link's decoder does.
      const firstHalf = new EvoChessGame();
      for (const token of full.moveTokens.slice(0, splitAt)) {
        const from = token.slice(0, 2) as import("chess.js").Square;
        const to = token.slice(2, 4) as import("chess.js").Square;
        firstHalf.applyMove(from, to, parseMoveToken(token)!.options);
      }
      const base = serializeGame(firstHalf);
      const rest = full.moveTokens.slice(splitAt);

      const line = replayLine(base, rest);
      expect(line).toHaveLength(rest.length + 1);
      expect(line[0].chess.fen()).toBe(firstHalf.chess.fen());
      const last = line[line.length - 1];
      expect(last.chess.fen()).toBe(full.chess.fen());
      expect(last.minorRights).toEqual(full.minorRights);
      expect(last.rookRights).toEqual(full.rookRights);
      expect(last.epEvolved).toEqual(full.epEvolved);
    });

    it("throws EvoChessError on a token that will not apply", () => {
      const base: SerializedGame = serializeGame(new EvoChessGame());
      expect(() => replayLine(base, ["e2e5"])).toThrow();
    });
  });

  describe("EvoChessGame.base", () => {
    it("defaults to the standard start, and copy() carries it over", () => {
      const game = new EvoChessGame();
      expect(game.base?.fen).toBe(START_FEN);
      game.applyMove("e2", "e4");
      const copy = game.copy();
      expect(copy.base).toBe(game.base);
    });

    it("round-trips through serializeGame/deserializeGame", () => {
      const game = new EvoChessGame();
      game.applyMove("e2", "e4");
      const restored = deserializeGame(serializeGame(game));
      expect(restored.base).toEqual(game.base);
    });

    it("deserializes to undefined, not the standard start, when the save predates the field", () => {
      const game = new EvoChessGame();
      game.applyMove("e2", "e4");
      const saved = serializeGame(game) as SerializedGame & { base?: SerializedGame };
      delete saved.base;

      const restored = deserializeGame(saved);
      expect(restored.base).toBeUndefined();
    });
  });
});
