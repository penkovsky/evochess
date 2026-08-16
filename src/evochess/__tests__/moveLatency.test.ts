/**
 * A move must arrive inside its ceiling.
 *
 * `TIMED_TIME_MS` is checked between deepening iterations, so on its own it
 * bounds nothing — the iteration that blows the budget is the one already
 * running. Before `TIMED_HARD_MS` was enforced in-search, a nominally 800ms
 * Fun search was measured at 4552ms in the browser and up to 3.1s over the
 * corpus (bench/bench11_move_latency.ts). This is the guard for that.
 *
 * Only the timed path is bounded. Chill's and Easy's shallow mix arms are fixed
 * depth and arm no deadline, so they have no ceiling to check.
 */
import { describe, expect, it } from "vitest";
import { EvoChessGame } from "../game";
import { legalTurns, searchLevel, searchRootTimed, __timingForTest } from "../ai";

// A position several plies in, where the branching factor (and so the cost of
// one more iteration) is high enough for the ceiling to actually bind.
function midgame(): EvoChessGame {
  const g = new EvoChessGame();
  const moves: [string, string][] = [
    ["e2", "e4"], ["e7", "e5"], ["d2", "d4"], ["d7", "d5"],
    ["c2", "c4"], ["c7", "c5"], ["f2", "f4"], ["f7", "f5"],
  ];
  for (const [from, to] of moves) g.applyMove(from as never, to as never);
  return g;
}

describe("timed-level move latency", () => {
  it("returns inside the hard ceiling, with a move, at every timed level", () => {
    const { TIMED_HARD_MS, EASY_HARD_MS } = __timingForTest;
    let bounded = 0;
    for (const level of ["chill", "easy", "zen", "fun"] as const) {
      const ceiling = level === "chill" || level === "easy" ? EASY_HARD_MS : TIMED_HARD_MS;
      for (const game of [new EvoChessGame(), midgame()]) {
        const t0 = Date.now();
        const r = searchLevel(game, level, 1);
        const elapsed = Date.now() - t0;
        // A shallow mix arm is depth-bounded, not time-bounded: `searchLevel`
        // returns from the mix branch before it arms a deadline, so there is no
        // ceiling on that call to assert. Chill's midgame roll draws one; the
        // other seven cases here still go down the timed path.
        if (!r.shallow) {
          bounded++;
          // Generous over the ceiling to absorb CI jitter while still catching
          // the regression this exists for — the pre-fix path took 3-4.5s.
          expect(elapsed).toBeLessThan(ceiling + 500);
        }
        expect(r.move).not.toBeNull();
      }
    }
    // The skip above must not be able to hollow the test out. Six of the eight
    // cases take the timed path whatever the mixes hold: Zen and Fun never mix,
    // and the fresh board is ply 1, before `EASY_EASING_FROM_PLY`. Only the two
    // mixed levels at midgame can roll shallow.
    expect(bounded).toBeGreaterThanOrEqual(6);
  }, 30_000);

  it("still returns a legal move when the ceiling fires before any iteration completes", () => {
    // The pathological case the ceiling introduces: cut off so early that no
    // depth completed. Returning null there would stall the game, so the
    // search falls back to the first statically-ordered turn.
    const game = midgame();
    // `maxDepth: 0` leaves the deepening loop no iteration it may run, which
    // is the state an expired ceiling produces on a position where even depth
    // 1 costs more than the abort's 2048-node poll interval — reachable here
    // without depending on that timing. (An already-expired deadline usually
    // still completes depth 1, since it is cheaper than one poll interval;
    // this fallback is the defence for when it does not.)
    const r = searchRootTimed(game, 400, 1, 0, false, false);

    expect(r.depth).toBe(0); // honest: nothing was searched to completion
    expect(r.move).not.toBeNull();
    // ...and what it returns is a move that can actually be played.
    const legal = legalTurns(game);
    expect(legal.some((t) => t.from === r.move!.from && t.to === r.move!.to)).toBe(true);
    expect(() => game.copy().applyMove(r.move!.from, r.move!.to, r.move!.options)).not.toThrow();
  }, 20_000);
});
