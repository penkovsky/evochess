import { describe, it, expect } from "vitest";
import { EvoChessGame } from "../game";
import { searchRoot, searchRootTimed, engineConfig } from "../ai";

describe("searchRootTimed backend flag", () => {
  it("bitboard backend returns a legal move and deepens under the budget", () => {
    const game = new EvoChessGame();
    engineConfig.backend = "bitboard";
    const r = searchRootTimed(game, 200, 1);
    engineConfig.backend = "chessjs";

    expect(r.move).not.toBeNull();
    // move must be legal in the reference engine
    const legal = game.legalMoves().some((m) => m.from === r.move!.from && m.to === r.move!.to);
    expect(legal).toBe(true);
    // a 200ms budget from the opening should reach at least depth 2
    expect(r.depth).toBeGreaterThanOrEqual(2);
    // score is in pawn units (small in the opening)
    expect(Math.abs(r.score)).toBeLessThan(50);
  });

  it("chessjs backend is unaffected and still works", () => {
    const game = new EvoChessGame();
    const r = searchRootTimed(game, 100, 1);
    expect(r.move).not.toBeNull();
    expect(r.depth).toBeGreaterThanOrEqual(1);
  });

  it("chessjs backend aborts mid-iteration instead of overshooting the budget", () => {
    // A near-zero budget with a generous maxDepth: without a mid-search
    // deadline check, iterative deepening only looks at the clock *between*
    // full-depth passes, so it can start (and fully run) an iteration many
    // times slower than the whole budget before ever noticing. The abort in
    // `negamax`/`quiesce` should catch this well before that happens.
    const game = new EvoChessGame();
    const r = searchRootTimed(game, 1, 1, 64);
    expect(r.move).not.toBeNull();
    // Generous slack over the 1ms budget for scheduler jitter, but nowhere
    // near what an unchecked deep iteration would take.
    expect(r.timeMs).toBeLessThan(300);
  });

  it("bitboard backend varies equal-value moves across seeds (no strength change)", () => {
    engineConfig.backend = "bitboard";
    const moves = new Set<string>();
    const scores = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const r = searchRoot(new EvoChessGame(), 3, seed);
      moves.add(r.move ? r.move.from + r.move.to : "none");
      scores.add(Math.round(r.score * 1000));
    }
    engineConfig.backend = "chessjs";
    // Variety: more than one distinct opening move is chosen across seeds...
    expect(moves.size).toBeGreaterThan(1);
    // ...but all are equal-valued — the jitter only breaks ties, never picks a
    // worse move, so the root score is identical regardless of seed.
    expect(scores.size).toBe(1);
  });
});
