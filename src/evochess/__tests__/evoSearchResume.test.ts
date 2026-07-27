/**
 * `searchEvoTTTimed`'s `startDepth`: resuming the iterative-deepening ladder
 * across the slices of a ponder chain instead of restarting it at 1
 * (ai.worker.ts `ponderSlice`).
 *
 * What is asserted here is the *contract*, not a strength claim — measured, the
 * depth it buys is between zero and one ply (bench/bench8_ponder_resume.ts).
 * The property that has to hold regardless is that resuming is confined to the
 * warm-TT chain: a search that does not opt into a warm table must behave
 * exactly as it did before this existed, since `startDepth`'s companion root
 * hint is search-order state that outlives a single call.
 */
import { describe, expect, it } from "vitest";
import { EvoChessGame } from "../game";
import { fromEvoGame } from "../evoBitboard";
import { searchEvoTTTimed, armSearchDeadline, disarmSearchDeadline } from "../evoSearch";

const SLICE_MS = 40;

// Runs a ponder-shaped chain: short sliced searches over one warm TT, each
// aborted at its own deadline. `resume` picks the ladder policy under test.
function chain(pos: ReturnType<typeof fromEvoGame>, slices: number, resume: boolean): number {
  let keepTT = false;
  let next = 1; // the iteration the following slice attempts first
  let deepest = 0;
  for (let i = 0; i < slices; i++) {
    armSearchDeadline(Date.now() + SLICE_MS);
    const r = searchEvoTTTimed(pos, SLICE_MS, 64, undefined, false, keepTT, resume ? next : 1);
    disarmSearchDeadline();
    keepTT = true;
    if (r.depth > 0) {
      deepest = Math.max(deepest, r.depth);
      next = r.depth + 1;
    }
  }
  return deepest;
}

describe("resumable ponder slices (startDepth)", () => {
  it("reaches at least the depth a restarting chain does, over the same slices", () => {
    const restart = chain(fromEvoGame(new EvoChessGame()), 50, false);
    const resumed = chain(fromEvoGame(new EvoChessGame()), 50, true);
    expect(restart).toBeGreaterThan(0);
    // Deliberately `>=`: skipping iterations a warm TT already answers cheaply
    // is not where a chain's time goes, so this buys ~0-1 ply. It must not
    // *cost* any, which is the regression this guards.
    expect(resumed).toBeGreaterThanOrEqual(restart);
  }, 20_000);

  it("leaves a search that does not keep the TT bit-identical to a cold one", () => {
    // The root hint `startDepth` relies on is module state that survives a
    // call. A fresh search (keepTT = false) must drop it along with the
    // generation it belongs to — otherwise a real, unpondered search would
    // silently inherit move ordering from a prior ponder, breaking the
    // ponder-spec.md §6.4 guarantee that the move-playing path is untouched.
    const pos = fromEvoGame(new EvoChessGame());
    const cold = searchEvoTTTimed(pos, 300, 4, 7, false, false);

    chain(fromEvoGame(new EvoChessGame()), 20, true); // warm chain over the same position

    const after = searchEvoTTTimed(pos, 300, 4, 7, false, false);
    expect(after.nodes).toBe(cold.nodes);
    expect(after.score).toBe(cold.score);
    expect(after.turn).toEqual(cold.turn);
  }, 20_000);

  it("reports depth 0, not a crash, when the ladder starts past maxDepth", () => {
    const pos = fromEvoGame(new EvoChessGame());
    const r = searchEvoTTTimed(pos, 200, 4, undefined, false, false, 9);
    expect(r.depth).toBe(0);
  });
});
