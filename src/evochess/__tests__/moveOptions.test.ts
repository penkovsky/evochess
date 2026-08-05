/**
 * The rules that decide what a tap from one square to another does: apply it,
 * refuse it, or ask the player something first. Pure, so this needs no board.
 */
import { describe, expect, it } from "vitest";
import type { Square } from "chess.js";
import { EvoChessGame, ROOK_CHARGES } from "../game";
import { planMove } from "../moveOptions";

function push(game: EvoChessGame, uci: string, options = {}) {
  game.applyMove(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, options);
}

const sq = (s: string) => s as Square;

describe("planMove", () => {
  it("refuses a move from an empty square", () => {
    expect(planMove(new EvoChessGame(), sq("e4"), sq("e5"))).toEqual({ kind: "reject" });
  });

  it("refuses a move the engine will not take", () => {
    // A pawn cannot move sideways, and nothing about evolution changes that.
    expect(planMove(new EvoChessGame(), sq("e2"), sq("d3")).kind).toBe("reject");
  });

  it("applies an ordinary pawn move with no options", () => {
    expect(planMove(new EvoChessGame(), sq("e2"), sq("e4"))).toEqual({
      kind: "apply",
      from: "e2",
      to: "e4",
      options: {},
    });
  });

  it("prompts when the move earns the minor right it could spend", () => {
    const game = new EvoChessGame();
    // Three pawn moves a side earns White the first minor right, and the third
    // of them is the move that earns it. The prompt must not lag behind it.
    push(game, "e2e4");
    push(game, "e7e5");
    push(game, "d2d4");
    push(game, "d7d5");
    const plan = planMove(game, sq("a2"), sq("a3"));
    expect(plan.kind).toBe("prompt");
    if (plan.kind !== "prompt") return;
    expect(plan.modal).toMatchObject({ from: "a2", to: "a3", kind: "optional", color: "w" });
    expect(plan.modal.canMinor).toBe(true);
  });

  it("forces the choice when a pawn reaches the last rank", () => {
    const game = new EvoChessGame();
    // A pawn walked up the a-file and taken across to b7, one square from
    // promoting. The far side of the board, so Black's king is not in check
    // and its own h-pawn is free to keep the turns alternating.
    push(game, "a2a4");
    push(game, "h7h6");
    push(game, "a4a5");
    push(game, "h6h5");
    push(game, "a5a6");
    push(game, "h5h4");
    push(game, "a6b7");
    push(game, "h4h3");
    const plan = planMove(game, sq("b7"), sq("b8"));
    expect(plan.kind).toBe("prompt");
    if (plan.kind !== "prompt") return;
    expect(plan.modal.kind).toBe("forced");
    expect(plan.modal.canMinor).toBe(false);
    expect(plan.modal.canRook).toBe(false);
  });

  it("applies a rook move that still has charges left, and prompts on the last one", () => {
    const game = new EvoChessGame();
    // A rook with charges to spare moves like any other piece.
    game.chess.load("4k3/8/8/8/8/8/8/R3K3 w - - 0 1");
    game.rookCharges.set("a1", ROOK_CHARGES);
    expect(planMove(game, sq("a1"), sq("a4"))).toEqual({ kind: "apply", from: "a1", to: "a4", options: {} });

    // Its last charge is spent by moving, so the move carries a mandatory
    // downgrade and the player has to pick what it becomes.
    game.rookCharges.set("a1", 1);
    const plan = planMove(game, sq("a1"), sq("a4"));
    expect(plan.kind).toBe("prompt");
    if (plan.kind !== "prompt") return;
    expect(plan.modal.kind).toBe("downgrade");
  });
});
