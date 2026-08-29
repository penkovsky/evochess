/**
 * A surgical integration test for milestone 3 of the NNUE accumulator spec
 * (wiring `applyAccum`/`refresh`/`evalAcc` into `evoSearch.ts`'s real
 * `searchEvoTT`/`quiesce`/`negamaxTT` recursion) — narrower and more
 * sensitive than the cross-backend parity test in `nnueEvoAdapter.test.ts`.
 *
 * That cross-backend test (spec §12's "integration sign/scale test") turned
 * out to have a real blind spot when checked by deliberately breaking the
 * wiring (skipping the root `refresh` call): with `seededNet`'s small random
 * weights (scale 0.1), both the correct and the broken score land close to
 * zero, so `toBeCloseTo(..., 1)` doesn't reliably distinguish them. This test
 * avoids that by (a) using a larger weight scale to amplify any discrepancy,
 * and (b) picking a position (a lone king vs king+queen) where no move is
 * ever "noisy" — no captures are possible at all, since the only capturable
 * piece would be a king, which chess never allows — so `quiesce` provably
 * returns the stand-pat with zero further recursion. That collapses
 * `searchEvoTT(pos, 1, seed, true)`'s root score to a value independently
 * computable without needing to replicate quiescence's move filtering: the
 * best of `-evalPos(child)` over each legal root move, computed here via the
 * from-scratch Option-B path (`activeIndicesFromEvoPos` + `evaluateActive`)
 * rather than the accumulator — so a bug in `applyAccum`'s wiring (wrong ply,
 * missed root refresh, stale accumulator) has nowhere to hide.
 */
import { describe, expect, it } from "vitest";
import { fromFen } from "../bitboard";
import { generateEvoTurns, applyEvoTurn, undoEvoTurn, type EvoPos, type EvoState } from "../evoBitboard";
import { searchEvoTT, setCheckExtension } from "../evoSearch";
import { activeIndicesFromEvoPos } from "../nnueAccum";
import { seededNet, setNnueWeights, evaluateActive, DEFAULT_HIDDEN1, DEFAULT_HIDDEN2 } from "../nnue";
import { FEATURE_SIZE } from "../nnueFeatures";

function emptyEvoState(): EvoState {
  return {
    minorRights: [0, 0],
    rookRights: [0, 0],
    pawnProgress: [0, 0],
    minorProgress: [0, 0],
    charges: new Map(),
    locked: new Set(),
    epEvolved: null,
    half: 0,
  };
}

describe("NNUE accumulator: search-wiring integration, spec §8/§12", () => {
  it("searchEvoTT's depth-1 NNUE root score matches an independent from-scratch computation (no move is ever noisy here)", () => {
    // A lone king vs king+queen: with only two piece types on the board and
    // one side down to a bare king, no move can ever be a capture (chess
    // never lets a move "capture" a king) and there's no pawn to promote —
    // isNoisy is false for every legal move at every depth, so quiesce's
    // noisy-move loop never executes and it always returns the stand-pat
    // untouched.
    const net = seededNet(4040, FEATURE_SIZE, DEFAULT_HIDDEN1, DEFAULT_HIDDEN2, /* scale */ 1.0);
    setNnueWeights(net);
    // Off: many queen moves here give check, and the extension would search
    // those children a ply deeper than the depth-1 score computed below.
    const wasExt = setCheckExtension(false);
    try {
      // Black's king sits in the centre, not a corner: with only a queen and
      // king to attack with, neither checkmate nor stalemate is reachable in
      // a single move against a centrally placed king (both patterns need
      // the king boxed against the board edge) — verified below rather than
      // just assumed. The queen starts off any rank/file/diagonal shared
      // with the black king (c2 vs e5), so no queen move can land on/capture
      // it either — an earlier attempt with the queen on the same diagonal
      // (b2, sharing the b2–e5 diagonal) produced an illegal starting
      // position (black already in check on white's move) that the move
      // generator happily "resolved" by capturing the king, an artifact of
      // hand-authoring a FEN rather than a real bug in the engine.
      const pos = fromFen("8/8/8/4k3/8/8/2Q5/K7 w - - 0 1");
      const root: EvoPos = { pos, evo: emptyEvoState() };

      const turns = generateEvoTurns(root);
      expect(turns.length).toBeGreaterThan(0);

      let bestChildEval = -Infinity;
      for (const t of turns) {
        const u = applyEvoTurn(root, t);
        expect(generateEvoTurns(root).length).toBeGreaterThan(0); // not mate/stalemate
        const childEval = evaluateActive(activeIndicesFromEvoPos(root)); // side-to-move (child) relative, pawns
        undoEvoTurn(root, u);
        if (-childEval > bestChildEval) bestChildEval = -childEval;
      }
      const expectedScoreCp = Math.round(100 * bestChildEval);

      const result = searchEvoTT(root, 1, 1, true);
      expect(result.score).toBe(expectedScoreCp);
    } finally {
      setNnueWeights(null);
      setCheckExtension(wasExt);
    }
  });
});
