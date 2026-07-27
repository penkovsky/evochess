/**
 * Milestone 5 of docs/ponder-spec.md §9: tuning `SLICE_MS`, `MAX_PONDER_DEPTH`,
 * `PONDER_BUDGET_MS`. The verification criterion is measured stop-latency, not
 * Elo — this file is that measurement, turned into a regression guard.
 *
 * The mechanism that actually bounds stop-latency is the in-search abort
 * (§4.2, milestone 1): a live ponder chain blocks the event loop for the
 * duration of whatever slice is executing when the human moves, so the
 * worst-case added latency is one slice's wall-clock length — `SLICE_MS` plus
 * whatever the abort's 2048-node poll granularity overshoots by. What this
 * test pins down is that the overshoot stays small *across a long chain*,
 * i.e. tuning `SLICE_MS` down did not trade away the bound as the TT deepens.
 */
import { describe, expect, it } from "vitest";
import { EvoChessGame } from "../game";
import { fromEvoGame } from "../evoBitboard";
import { searchEvoTTTimed, armSearchDeadline, disarmSearchDeadline } from "../evoSearch";
import { __ponderTuningForTest } from "../ai.worker";

describe("ponder tuning (ponder-spec.md §9, milestone 5)", () => {
  it("MAX_PONDER_DEPTH is a harmless upper bound; PONDER_BUDGET_MS is the real cap", () => {
    // Recorded upstream (bench script, not part of CI): depth plateaus around
    // 5-7 in both a fresh opening and a 6-ply-in position, never approaching
    // 12 even after ~30s of chained slices. The cap stays well above any
    // depth this suite (or ordinary play) will actually reach.
    expect(__ponderTuningForTest.MAX_PONDER_DEPTH).toBeGreaterThan(7);
    expect(__ponderTuningForTest.PONDER_BUDGET_MS).toBeLessThan(10_000);
  });

  it("stop-latency (one slice's wall-clock length) stays bounded across a long chained ponder", () => {
    const { SLICE_MS } = __ponderTuningForTest;
    const pos = fromEvoGame(new EvoChessGame());
    let keepTT = false;
    let maxElapsed = 0;

    // Chain enough slices to run well past the depth plateau, so this
    // exercises the abort against a deep, fully-warm TT — not just a cold
    // first slice, which milestone 1's test already covers.
    const slices = Math.ceil(4000 / SLICE_MS);
    for (let i = 0; i < slices; i++) {
      armSearchDeadline(Date.now() + SLICE_MS);
      const start = Date.now();
      searchEvoTTTimed(pos, SLICE_MS, 64, undefined, false, keepTT);
      const elapsed = Date.now() - start;
      disarmSearchDeadline();
      keepTT = true;
      maxElapsed = Math.max(maxElapsed, elapsed);
    }

    // Generous bound over SLICE_MS + the abort's poll-granularity overshoot,
    // to absorb CI jitter while still catching a real regression (e.g. the
    // abort silently stopping firing once the tree is deep).
    expect(maxElapsed).toBeLessThan(SLICE_MS + 500);
  }, 20_000);
});
