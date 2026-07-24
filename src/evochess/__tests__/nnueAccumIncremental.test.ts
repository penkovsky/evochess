/**
 * Correctness validation for milestone 2 of the NNUE accumulator spec
 * (nnue-accumulator-spec.md §9.3) — the important one. Walks random EvoChess
 * games with the accumulator stack (`applyAccum`/`createAccStack`), and at
 * every node asserts `evalAcc(stack[p])` equals a from-scratch `refresh` of
 * the same position within epsilon, for **both** perspectives (not just
 * whichever one happens to be side to move — a bug confined to the "off-turn"
 * perspective would be invisible otherwise).
 *
 * Also does the recursive make→apply→descend→undo→(different move) walk the
 * spec calls out: after undoing a child and applying a *different* sibling
 * move, the parent's `stack[p]` must still read correctly. This is trivially
 * true given the stack design (children only ever write `stack[p+1]`, never
 * touch `stack[p]`) — the test exists to guard against a regression to
 * in-place mutation, not because the current design could plausibly fail it.
 */
import { describe, expect, it } from "vitest";
import { EvoChessGame } from "../game";
import { fromEvoGame, generateEvoTurns, applyEvoTurn, undoEvoTurn, type EvoPos } from "../evoBitboard";
import { applyAccum, createAcc, createAccStack, evalAcc, refresh, type Acc } from "../nnueAccum";
import { seededNet, DEFAULT_HIDDEN1, DEFAULT_HIDDEN2, type NnueWeights } from "../nnue";
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

function assertMatchesRefresh(node: Acc, s: EvoPos, weights: NnueWeights): void {
  const fresh = createAcc(weights);
  refresh(fresh, s, weights);
  for (const persp of [0, 1] as const) {
    expect(evalAcc(node, persp, weights)).toBeCloseTo(evalAcc(fresh, persp, weights), 4);
  }
}

describe("NNUE accumulator: incremental parity with refresh, spec §9.3", () => {
  const net = seededNet(90210, FEATURE_SIZE, DEFAULT_HIDDEN1, DEFAULT_HIDDEN2);

  it("incremental deltas via applyAccum match refresh at every node of a long random walk", () => {
    const rng = mulberry32(24601);
    const stack = createAccStack(net, 96);
    let s = fromEvoGame(new EvoChessGame());
    let p = 0;
    refresh(stack[0], s, net);
    assertMatchesRefresh(stack[0], s, net);

    for (let ply = 0; ply < 80; ply++) {
      const turns = generateEvoTurns(s);
      if (turns.length === 0 || p + 1 >= stack.length) {
        s = fromEvoGame(new EvoChessGame());
        p = 0;
        refresh(stack[0], s, net);
        assertMatchesRefresh(stack[0], s, net);
        continue;
      }
      const t = turns[Math.floor(rng() * turns.length)];
      const u = applyEvoTurn(s, t);
      applyAccum(stack, p, s, t, u, net);
      p++;
      assertMatchesRefresh(stack[p], s, net);
    }
  });

  it("incremental deltas via applyAccum match refresh at every node of a recursive walk, both colours", () => {
    const rng = mulberry32(577);
    const net2 = seededNet(1618, FEATURE_SIZE, DEFAULT_HIDDEN1, DEFAULT_HIDDEN2);
    const stack = createAccStack(net2, 16);
    let sawWhiteToMove = false, sawBlackToMove = false;

    function walk(s: EvoPos, p: number, depth: number): void {
      if (s.pos.us === 0) sawWhiteToMove = true; else sawBlackToMove = true;
      assertMatchesRefresh(stack[p], s, net2);
      if (depth === 0) return;

      const turns = generateEvoTurns(s);
      if (turns.length === 0) return;
      const sampleSize = Math.min(3, turns.length);
      const sample: typeof turns = [];
      const pool = turns.slice();
      for (let i = 0; i < sampleSize; i++) {
        const idx = Math.floor(rng() * pool.length);
        sample.push(pool.splice(idx, 1)[0]);
      }

      for (const t of sample) {
        const u = applyEvoTurn(s, t);
        applyAccum(stack, p, s, t, u, net2);
        walk(s, p + 1, depth - 1);
        undoEvoTurn(s, u);
        // Parent slot must still read correctly after a child wrote p+1 and
        // was undone — guards against any accidental parent mutation.
        assertMatchesRefresh(stack[p], s, net2);
      }
    }

    const root = fromEvoGame(new EvoChessGame());
    refresh(stack[0], root, net2);
    walk(root, 0, 4);

    // A depth-4 walk from the start position should reach both colours to
    // move; this is a sanity guard against a vacuous test.
    expect(sawWhiteToMove).toBe(true);
    expect(sawBlackToMove).toBe(true);
  });
});
