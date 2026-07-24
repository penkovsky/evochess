/**
 * Correctness validation for milestone 1 of the NNUE accumulator spec
 * (nnue-accumulator-spec.md §9.2): `evalAcc(refresh(s))` must agree with
 * `forwardActive` (the from-scratch path, same net) within a tight epsilon,
 * for both colours to move — refresh only pins the accumulator's own
 * perspective at the root each time, so a bug that only shows up when Black
 * is to move (`accB` selected, `sq ^ 56` mirror active) needs a Black-to-move
 * case to catch.
 *
 * No incremental deltas / make-unmake here yet (§6, §9.3) — `refresh` is
 * always a full rebuild, so this only exercises §5 + §7.
 */
import { describe, expect, it } from "vitest";
import { EvoChessGame } from "../game";
import { legalTurns } from "../ai";
import { fromEvoGame, type EvoPos } from "../evoBitboard";
import { activeIndicesFromEvoPos, createAcc, evalAcc, refresh } from "../nnueAccum";
import { forwardActive, seededNet, DEFAULT_HIDDEN1, DEFAULT_HIDDEN2 } from "../nnue";
import { FEATURE_SIZE } from "../nnueFeatures";

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

describe("NNUE accumulator: refresh + evalAcc parity with forwardActive, spec §9.2", () => {
  const net = seededNet(2718, FEATURE_SIZE, DEFAULT_HIDDEN1, DEFAULT_HIDDEN2);

  it("matches forwardActive over a random walk, both colours to move", () => {
    const positions = randomEvoPositions(50, 4, 161803);
    expect(positions.some((p) => p.pos.us === 0)).toBe(true);
    expect(positions.some((p) => p.pos.us === 1)).toBe(true);

    for (const evoPos of positions) {
      const acc = createAcc(net);
      refresh(acc, evoPos, net);
      const viaAcc = evalAcc(acc, evoPos.pos.us, net);
      const viaFromScratch = forwardActive(net, activeIndicesFromEvoPos(evoPos));
      // Float32 accumulator storage vs the from-scratch Float64Array sum:
      // nonzero epsilon is expected (spec §10), not a bug.
      expect(viaAcc).toBeCloseTo(viaFromScratch, 4);
    }
  });

  it("the start position's two perspectives read identically (symmetric board)", () => {
    const evoPos = fromEvoGame(new EvoChessGame());
    const acc = createAcc(net);
    refresh(acc, evoPos, net);
    expect(evalAcc(acc, 0, net)).toBeCloseTo(evalAcc(acc, 1, net), 6);
  });
});
