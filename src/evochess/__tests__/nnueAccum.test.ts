/**
 * Correctness validation for milestone 1 of the NNUE-on-bitboard port
 * (nnue-bitboard-port-spec.md §5.1): the bitboard-native indexer
 * (`nnueAccum.ts`, Option B) must produce the exact same multiset of active
 * feature indices as Option A / the golden extractor, for every position —
 * both colours to move, since the `sq ^ 56` mirror and the us/them swap both
 * flip with side to move and a bug there is invisible from White-to-move
 * fixtures alone.
 *
 * Uses the same fixture-loading helpers as `nnueEvoAdapter.test.ts` (the
 * 28-position cross-language corpus) plus a seeded random walk for volume
 * and black-to-move coverage, per spec §5 corpus note 2.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Color, Square } from "chess.js";
import { EvoChessGame, type EvolvedEnPassant } from "../game";
import { legalTurns } from "../ai";
import { fromEvoGame, type EvoPos } from "../evoBitboard";
import { activeIndicesFromEvoPos } from "../nnueAccum";
import { activeFeatures, denseActiveIndices, FEATURE_SIZE, type NnuePosition } from "../nnueFeatures";
import { nnuePositionFromEvoPos } from "../nnueEvoAdapter";
import { seededNet, evaluatePosition, forwardActive } from "../nnue";

const here = dirname(fileURLToPath(import.meta.url));
const parityDir = resolve(here, "../../../training/parity");

interface FixtureJson {
  fen: string;
  minorRights?: [number, number];
  rookRights?: [number, number];
  pawnMoveProgress?: [number, number];
  minorMoveProgress?: [number, number];
  rookCharges?: Record<string, number>;
  rookLocked?: string[];
  epEvolved?: [Square, Square, Color];
}

function pair(value: [number, number] | undefined): Record<Color, number> {
  const [w, b] = value ?? [0, 0];
  return { w, b };
}

function index0x88(square: string): number {
  const file = square.charCodeAt(0) - 97;
  const rank = square.charCodeAt(1) - 49;
  return rank * 16 + file;
}

function evoGameFromFixture(json: FixtureJson): EvoChessGame {
  const game = new EvoChessGame();
  game.chess.load(json.fen);
  game.minorRights = pair(json.minorRights);
  game.rookRights = pair(json.rookRights);
  game.pawnMoveProgress = pair(json.pawnMoveProgress);
  game.minorMoveProgress = pair(json.minorMoveProgress);
  game.rookCharges = new Map(Object.entries(json.rookCharges ?? {}) as [Square, number][]);
  game.rookLocked = new Set((json.rookLocked ?? []) as Square[]);
  game.epEvolved = json.epEvolved
    ? ({
        skipped: json.epEvolved[0],
        victim: json.epEvolved[1],
        color: json.epEvolved[2],
        index: index0x88(json.epEvolved[0]),
      } satisfies EvolvedEnPassant)
    : null;
  return game;
}

const fixtures: { name: string; position: FixtureJson }[] = JSON.parse(
  readFileSync(resolve(parityDir, "fixtures.json"), "utf8")
);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seeded corpus of EvoPos reached by random legal turns, both colours. A
 * *random* ply count per sample (not a fixed one) is what actually gives
 * colour balance — a fixed even count would always land back on White to
 * move.
 */
function randomEvoPositions(count: number, maxPlyPerSample: number, seed: number): EvoPos[] {
  const rng = mulberry32(seed);
  const positions: EvoPos[] = [];
  let game = new EvoChessGame();
  while (positions.length < count) {
    const plies = 1 + Math.floor(rng() * maxPlyPerSample);
    for (let ply = 0; ply < plies; ply++) {
      if (game.isGameOver()) break;
      const moves = legalTurns(game);
      if (moves.length === 0) break;
      const mv = moves[Math.floor(rng() * moves.length)];
      game.applyMove(mv.from, mv.to, mv.options);
    }
    positions.push(fromEvoGame(game));
    if (game.isGameOver()) game = new EvoChessGame();
  }
  return positions;
}

function goldenIndices(position: NnuePosition): number[] {
  return activeFeatures(position).concat(denseActiveIndices(position)).sort((a, b) => a - b);
}

describe("NNUE bitboard-native indexer (Option B): index parity, spec §5.1", () => {
  it.each(fixtures)("$name: matches the golden extractor's active indices", ({ position }) => {
    const evoPos = fromEvoGame(evoGameFromFixture(position));
    const viaBitboard = activeIndicesFromEvoPos(evoPos).slice().sort((a, b) => a - b);
    const viaGolden = goldenIndices(nnuePositionFromEvoPos(evoPos));
    expect(viaBitboard).toEqual(viaGolden);
  });

  it("matches the golden extractor over a random walk, both colours to move", () => {
    const positions = randomEvoPositions(60, 4, 999);
    expect(positions.some((p) => p.pos.us === 0)).toBe(true);
    expect(positions.some((p) => p.pos.us === 1)).toBe(true);

    for (const evoPos of positions) {
      const viaBitboard = activeIndicesFromEvoPos(evoPos).slice().sort((a, b) => a - b);
      const viaGolden = goldenIndices(nnuePositionFromEvoPos(evoPos));
      expect(viaBitboard).toEqual(viaGolden);
    }
  });
});

describe("NNUE bitboard-native indexer (Option B): eval parity, spec §5.2", () => {
  it("forwardActive on Option B indices matches evaluatePosition via Option A / the golden extractor", () => {
    const net = seededNet(13, FEATURE_SIZE);
    const positions = randomEvoPositions(30, 4, 4242);
    for (const evoPos of positions) {
      const viaBitboard = forwardActive(net, activeIndicesFromEvoPos(evoPos));
      const viaGolden = evaluatePosition(net, nnuePositionFromEvoPos(evoPos));
      // Nonzero epsilon only because Option B may sum indices in a different
      // order than the golden extractor (spec §5.2).
      expect(viaBitboard).toBeCloseTo(viaGolden, 4);
    }
  });
});
