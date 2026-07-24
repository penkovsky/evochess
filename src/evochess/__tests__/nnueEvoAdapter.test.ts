/**
 * Correctness validation for the NNUE-on-bitboard port, milestone 0
 * (nnue-bitboard-port-spec.md §5): Option A (`nnuePositionFromEvoPos`) plus
 * its wiring into `evoSearch.ts`.
 *
 * Two tests, per the spec:
 *   1. Eval parity (§5.2) — the bitboard-adapter eval must agree with the
 *      golden extractor exactly, on the same 28-fixture corpus the
 *      cross-language parity gate uses (`nnueFeatures.test.ts`). No search,
 *      no net weights beyond a seeded deterministic net.
 *   2. Cross-backend parity (§5.3) — with NNUE turned on, the bitboard
 *      search's root score must agree with the chessjs+NNUE `searchRoot` at
 *      equal depth, on a corpus of random EvoChess positions reached by
 *      applying legal turns to a live `EvoChessGame` (so both backends start
 *      from the exact same position by construction).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import type { Color, Square } from "chess.js";
import { EvoChessGame, type EvolvedEnPassant } from "../game";
import { engineConfig, legalTurns, searchRoot } from "../ai";
import { fromEvoGame, type EvoPos } from "../evoBitboard";
import { searchEvoTT } from "../evoSearch";
import { nnuePositionFromEvoPos } from "../nnueEvoAdapter";
import { evaluatePosition, seededNet, setNnueWeights } from "../nnue";
import { FEATURE_SIZE, type NnuePosition } from "../nnueFeatures";

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

/** Mirror of `positionFromFixture` in nnueFeatures.test.ts. */
function nnuePositionFromFixture(json: FixtureJson): NnuePosition {
  return {
    fen: json.fen,
    minorRights: pair(json.minorRights),
    rookRights: pair(json.rookRights),
    pawnMoveProgress: pair(json.pawnMoveProgress),
    minorMoveProgress: pair(json.minorMoveProgress),
    rookCharges: new Map(Object.entries(json.rookCharges ?? {})),
    rookLocked: new Set(json.rookLocked ?? []),
    epEvolved: json.epEvolved
      ? { skipped: json.epEvolved[0], victim: json.epEvolved[1], color: json.epEvolved[2] }
      : null,
  };
}

// chess.js's internal 0x88 index for a square (rank*16 + file); only
// `EvolvedEnPassant.index` needs it, and only `applyEvolvedEnPassant` (not
// exercised by these tests, which only read the fen/board and evo fields via
// `fromEvoGame`) ever consumes that field.
function index0x88(square: string): number {
  const file = square.charCodeAt(0) - 97;
  const rank = square.charCodeAt(1) - 49;
  return rank * 16 + file;
}

/** Same fixture, as a live `EvoChessGame` — the board plus the evo state. */
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

// mulberry32, matching ai.ts / evoSearch.ts's PRNG, for a deterministic walk.
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
 * A seeded corpus of positions reached by playing random legal turns from the
 * start position, restarting on game over. Supplements the fixtures with
 * volume and black-to-move coverage (spec §5, corpus note 2).
 */
function randomPositions(count: number, plyPerSample: number, seed: number): EvoChessGame[] {
  const rng = mulberry32(seed);
  const positions: EvoChessGame[] = [];
  let game = new EvoChessGame();
  while (positions.length < count) {
    for (let ply = 0; ply < plyPerSample; ply++) {
      if (game.isGameOver()) break;
      const moves = legalTurns(game);
      if (moves.length === 0) break;
      const mv = moves[Math.floor(rng() * moves.length)];
      game.applyMove(mv.from, mv.to, mv.options);
    }
    positions.push(game.copy());
    if (game.isGameOver()) game = new EvoChessGame();
  }
  return positions;
}

describe("NNUE-on-bitboard port: eval parity (Option A, spec §5.2)", () => {
  const net = seededNet(42, FEATURE_SIZE);

  it.each(fixtures)("$name: bitboard adapter eval matches the golden extractor", ({ position }) => {
    const evoPos: EvoPos = fromEvoGame(evoGameFromFixture(position));
    const viaAdapter = evaluatePosition(net, nnuePositionFromEvoPos(evoPos));
    const viaGolden = evaluatePosition(net, nnuePositionFromFixture(position));
    expect(viaAdapter).toBeCloseTo(viaGolden, 4);
  });
});

describe("NNUE-on-bitboard port: cross-backend search parity (spec §5.3)", () => {
  afterEach(() => {
    setNnueWeights(null);
    engineConfig.backend = "chessjs";
  });

  it("bitboard NNUE search score matches chessjs+NNUE search at equal depth", () => {
    const net = seededNet(7, FEATURE_SIZE);
    setNnueWeights(net);
    const depth = 2;
    const games = randomPositions(20, 5, 1234);

    // Mate-range scores are excluded: the two backends' searchRoot report
    // mate on different absolute scales (bitboard's MATE/100 vs chessjs's
    // material-scale MATE), a pre-existing convention mismatch orthogonal to
    // this port. Comparing quiet scores is the honest test of sign/scale/
    // side-to-move convention the spec calls for.
    const MATE_GUARD = 100; // pawns
    let compared = 0;

    for (const game of games) {
      engineConfig.backend = "chessjs";
      const chessjsResult = searchRoot(game, depth, 1);
      if (Math.abs(chessjsResult.score) >= MATE_GUARD) continue;

      const evoPos = fromEvoGame(game);
      const bitResult = searchEvoTT(evoPos, depth, 1, true);
      const bitScorePawns = bitResult.score / 100;
      if (Math.abs(bitScorePawns) >= MATE_GUARD) continue;

      expect(bitScorePawns).toBeCloseTo(chessjsResult.score, 1);
      compared++;
    }

    // A guard against the guard: if the mate-range skip ever started
    // swallowing every position (e.g. a wiring bug that makes the bitboard
    // score wildly wrong, not just off), the loop above would report a
    // trivial, vacuous pass. Most of a 20-position random-walk corpus at
    // depth 2 should be quiet positions.
    expect(compared).toBeGreaterThan(10);
  });
});
