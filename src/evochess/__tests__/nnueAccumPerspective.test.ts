/**
 * Correctness validation for milestone 0 of the NNUE accumulator spec
 * (nnue-accumulator-spec.md §9.1, §4): `activeIndicesForPerspective` must
 * match the golden extractor for an **explicit** perspective (0 = White,
 * 1 = Black), not just the side-to-move case `nnueAccum.test.ts` already
 * covers.
 *
 * The oracle: `nnueFeatures.ts`'s `activeFeatures`/`denseActiveIndices`
 * derive everything (square mirroring, the us/them split) purely from the
 * `turn` field of the FEN they're given — never from some separate "real"
 * side to move. So "the golden extractor's output for perspective P" is
 * exactly "the golden extractor's output on the same position with the FEN's
 * turn field forced to P" (nnue-accumulator-spec.md §2's claim that `accW`/
 * `accB` are valid perspective accumulators rests on this equivalence). That
 * makes the oracle a one-line tweak to the existing NnuePosition, no new
 * fixture machinery needed.
 *
 * Must exercise both perspectives on the same position (not just whichever
 * one happens to be the side to move) — the `sq ^ 56` mirror and the us/them
 * swap both flip per-perspective, and a bug there is invisible if only the
 * "natural" STM perspective is ever checked.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Color, Square } from "chess.js";
import { EvoChessGame, type EvolvedEnPassant } from "../game";
import { legalTurns } from "../ai";
import { fromEvoGame, type EvoPos } from "../evoBitboard";
import { activeIndicesForPerspective, type Perspective } from "../nnueAccum";
import { activeFeatures, denseActiveIndices, type NnuePosition } from "../nnueFeatures";
import { nnuePositionFromEvoPos } from "../nnueEvoAdapter";

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

/** The same NnuePosition with its FEN's turn field forced to `persp`. */
function withTurn(position: NnuePosition, persp: Perspective): NnuePosition {
  const [placement] = position.fen.trim().split(/\s+/);
  return { ...position, fen: `${placement} ${persp === 0 ? "w" : "b"}` };
}

function goldenIndices(position: NnuePosition): number[] {
  return activeFeatures(position).concat(denseActiveIndices(position)).sort((a, b) => a - b);
}

describe("NNUE accumulator: per-perspective index parity, spec §9.1", () => {
  const perspectives: Perspective[] = [0, 1];

  it.each(fixtures)("$name: both perspectives match the golden extractor", ({ position }) => {
    const evoPos = fromEvoGame(evoGameFromFixture(position));
    const nnuePos = nnuePositionFromEvoPos(evoPos);
    for (const persp of perspectives) {
      const viaBitboard = activeIndicesForPerspective(evoPos.pos, evoPos.evo, persp).slice().sort((a, b) => a - b);
      const viaGolden = goldenIndices(withTurn(nnuePos, persp));
      expect(viaBitboard).toEqual(viaGolden);
    }
  });

  it("both perspectives match the golden extractor over a random walk, both colours to move", () => {
    const positions = randomEvoPositions(40, 4, 31415);
    expect(positions.some((p) => p.pos.us === 0)).toBe(true);
    expect(positions.some((p) => p.pos.us === 1)).toBe(true);

    for (const evoPos of positions) {
      const nnuePos = nnuePositionFromEvoPos(evoPos);
      for (const persp of perspectives) {
        const viaBitboard = activeIndicesForPerspective(evoPos.pos, evoPos.evo, persp).slice().sort((a, b) => a - b);
        const viaGolden = goldenIndices(withTurn(nnuePos, persp));
        expect(viaBitboard).toEqual(viaGolden);
      }
    }
  });

  it("the off-turn perspective is not simply equal to the STM perspective (mirroring actually differs)", () => {
    // A sanity guard against a vacuous test above: pick a position with an
    // asymmetric board (start position is symmetric under the mirror) and
    // confirm the two perspectives' index sets actually differ.
    const game = new EvoChessGame();
    game.applyMove("e2", "e4");
    const evoPos = fromEvoGame(game);
    const w = activeIndicesForPerspective(evoPos.pos, evoPos.evo, 0).slice().sort((a, b) => a - b);
    const b = activeIndicesForPerspective(evoPos.pos, evoPos.evo, 1).slice().sort((a, b) => a - b);
    expect(w).not.toEqual(b);
  });
});
