/**
 * Milestone 1 of docs/ponder-spec.md §4.2/§9: the in-search abort that makes
 * pondering safe to interrupt. `armPonderDeadline`/`disarmPonderDeadline` are
 * the test-facing (and, later, ponder-slice-facing) hooks around the
 * module-level deadline that `negamaxTT`/`quiesce` poll every 2048 nodes.
 *
 * Two properties matter, per the milestone-1 verification criterion:
 *   1. An armed deadline actually bounds wall-clock time, well under a budget
 *      that would otherwise run for seconds.
 *   2. An unarmed search is unaffected: identical move/score/node count to a
 *      search run before the abort machinery was ever exercised.
 */
import { describe, expect, it } from "vitest";
import { EvoChessGame } from "../game";
import { fromEvoGame } from "../evoBitboard";
import {
  searchEvoTT,
  searchEvoTTTimed,
  armPonderDeadline,
  disarmPonderDeadline,
} from "../evoSearch";

describe("evoSearch in-search abort (ponder-spec.md §4.2, milestone 1)", () => {
  it("an armed deadline stops a search that would otherwise run for seconds", () => {
    const pos = fromEvoGame(new EvoChessGame());

    armPonderDeadline(Date.now() + 50);
    const start = Date.now();
    const r = searchEvoTTTimed(pos, /* timeMs */ 5000, /* maxDepth */ 64);
    const elapsed = Date.now() - start;
    disarmPonderDeadline();

    // Generous bound over the ~60ms poll granularity to absorb CI jitter,
    // while still being an order of magnitude below the 5000ms budget it
    // would otherwise run for — proof the abort, not the budget, ended this.
    expect(elapsed).toBeLessThan(1000);
    expect(r.turn).not.toBeNull();
  });

  it("an aborted search reports only completed iterations, never a placeholder score", () => {
    // Regression: `rootSearch` originally had no ABORT guard, so an aborted
    // pass scored its unsearched root moves with the placeholder `negamaxTT`
    // returns on abort — 0, or -Infinity (arriving at the root as +Infinity)
    // when a child aborted before scoring its own first move. That escaped as
    // `score: Infinity`, which the caller's `>= MATE_THRESHOLD` check then
    // read as a found mate, and inflated the reported `depth` by a ply.
    for (const armMs of [5, 20, 40, 60, 100]) {
      const pos = fromEvoGame(new EvoChessGame());
      armPonderDeadline(Date.now() + armMs);
      const r = searchEvoTTTimed(pos, /* timeMs */ armMs, /* maxDepth */ 64);
      disarmPonderDeadline();

      expect(Number.isFinite(r.score), `armMs=${armMs} score=${r.score}`).toBe(true);
      // A completed iteration only; never the 64th, which is what the loop
      // used to run away to once ABORT short-circuited every node.
      expect(r.depth, `armMs=${armMs}`).toBeLessThan(64);
    }
  });

  it("an unarmed search is bit-identical to one run before the abort was ever armed", () => {
    const pos = fromEvoGame(new EvoChessGame());
    const before = searchEvoTT(fromEvoGame(new EvoChessGame()), 5);

    // Exercise the abort machinery in between, then disarm — must leave no trace.
    armPonderDeadline(Date.now() + 50);
    searchEvoTTTimed(pos, 5000, 64);
    disarmPonderDeadline();

    const after = searchEvoTT(fromEvoGame(new EvoChessGame()), 5);

    expect(after.nodes).toBe(before.nodes);
    expect(after.score).toBe(before.score);
    expect(after.turn).toEqual(before.turn);
  });
});
