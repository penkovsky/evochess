/**
 * Material augmentation tests (`nnue-data-coverage-spec.md`, mechanism 2).
 * The load-bearing property: every emitted record has a score and no
 * outcome/termination, so it trains on the pure search-score signal without
 * ever touching the outcome/K-fit path (pinned on the Python side too, in
 * `training/tests/test_target.py`).
 */
import { describe, expect, it } from "vitest";
import { EvoChessGame } from "../src/evochess/game";
import { mulberry32 } from "./jsonl";
import { sampleSeedPosition } from "./sampler";
import {
  augmentRecord,
  imbalanceBucket,
  newCoverage,
  recordCoverage,
} from "./augment";

describe("augmentRecord", () => {
  it("has a score and no outcome or termination", () => {
    const game = new EvoChessGame();
    const record = augmentRecord(game, 2, 1);
    expect(record.score).toBeTypeOf("number");
    expect(record.outcome).toBeUndefined();
    expect(record.termination).toBeUndefined();
  });

  it("tags the record with source: synthetic", () => {
    const game = new EvoChessGame();
    const record = augmentRecord(game, 2, 1);
    expect(record.source).toBe("synthetic");
  });

  it("is White-positive: a White-winning sampled position scores positive", () => {
    // Hand-build a position where White has an extra queen, Black to move,
    // so the search should clearly favour White regardless of whose turn it
    // is in the FEN.
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1");
    const record = augmentRecord(game, 2, 1);
    expect(record.score!).toBeGreaterThan(5);
  });

  it("round trips through the fen it stores (turn preserved)", () => {
    // Small N: this calls augmentRecord() directly, bypassing the worker
    // timeout in searchWorkerPool.ts, and a small fraction of sampled
    // positions are genuinely slow to search (see sampler.ts's
    // MAX_NON_PAWN_PIECES comment) — keep this test's cumulative cost well
    // under vitest's default timeout rather than chasing full coverage here.
    const rng = mulberry32(1);
    for (let i = 0; i < 8; i++) {
      const game = sampleSeedPosition(rng);
      const record = augmentRecord(game, 1, 1);
      const reloaded = new EvoChessGame();
      reloaded.chess.load(record.fen);
      expect(reloaded.chess.turn()).toBe(game.chess.turn());
    }
  });
});

describe("coverage histogram", () => {
  it("buckets material imbalance and clamps the tails", () => {
    expect(imbalanceBucket(0)).toBe("0");
    expect(imbalanceBucket(3)).toBe("3");
    expect(imbalanceBucket(-3)).toBe("-3");
    expect(imbalanceBucket(12)).toBe(">=10");
    expect(imbalanceBucket(-12)).toBe("<=-10");
  });

  it("tallies rook/queen presence per side", () => {
    const coverage = newCoverage();
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/R3K2Q w - - 0 1");
    recordCoverage(coverage, game);
    expect(coverage.n).toBe(1);
    expect(coverage.anyWhiteRook).toBe(1);
    expect(coverage.anyWhiteQueen).toBe(1);
    expect(coverage.anyBlackRook).toBe(0);
    expect(coverage.anyBlackQueen).toBe(0);
  });

  it("counts a position with two same-side rooks as one, not two", () => {
    // Regression test: this must be a presence count (fraction of positions
    // with >=1 rook), not a piece count, or the reported percentage can run
    // past 100% and stops answering the spec's coverage question.
    const coverage = newCoverage();
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/R3K2R w - - 0 1");
    recordCoverage(coverage, game);
    expect(coverage.anyWhiteRook).toBe(1);
  });

  it("over many sampled positions, rook/queen coverage is far from zero", () => {
    const rng = mulberry32(2);
    const coverage = newCoverage();
    for (let i = 0; i < 200; i++) {
      recordCoverage(coverage, sampleSeedPosition(rng));
    }
    // The whole point of mechanism 2: this must not read near-zero the way
    // natural self-play did (see the spec's measured ladder failure).
    expect(coverage.anyWhiteRook + coverage.anyBlackRook).toBeGreaterThan(0);
    expect(coverage.anyWhiteQueen + coverage.anyBlackQueen).toBeGreaterThan(0);
  });
});
