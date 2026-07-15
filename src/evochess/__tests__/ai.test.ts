import { describe, it, expect } from "vitest";
import { material, chooseMove } from "../ai";
import { EvoChessGame, ROOK_CHARGES } from "../game";
import type { Square } from "chess.js";

// A bare position with one white rook on d4, so material() reduces to that
// rook's value alone.
function loneRook(charges?: number): EvoChessGame {
  const game = new EvoChessGame();
  game.chess.load("4k3/8/8/8/3R4/8/8/4K3 w - - 0 1");
  game.rookCharges = new Map();
  if (charges !== undefined) game.rookCharges.set("d4" as Square, charges);
  return game;
}

describe("rook valuation by charges", () => {
  it("values a full-charge rook as a full rook", () => {
    expect(material(loneRook(ROOK_CHARGES))).toBe(5);
  });

  it("treats a rook with no charge entry as full", () => {
    expect(material(loneRook())).toBe(material(loneRook(ROOK_CHARGES)));
  });

  it("decays toward a minor as charges drain", () => {
    const values = [5, 4, 3, 2, 1].map((c) => material(loneRook(c)));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThan(values[i - 1]);
    }
  });

  it("keeps even a 1-charge rook worth more than a minor", () => {
    expect(material(loneRook(1))).toBeGreaterThan(3);
    expect(material(loneRook(1))).toBeLessThan(5);
  });

  it("negates the scaled value for black", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/3r4/8/8/4K3 w - - 0 1");
    game.rookCharges = new Map([["d4" as Square, 1]]);
    expect(material(game)).toBe(-material(loneRook(1)));
  });
});

describe("chooseMove with a rookLocked minor piece", () => {
  it("never proposes promoting a rook-locked minor back to a rook", () => {
    // White knight on d4 was previously downgraded from a rook, so it is
    // permanently barred from becoming one again even though a rook
    // promotion right is available. Search must skip that candidate
    // entirely rather than let applyMove throw when it's tried. An extra
    // pawn keeps the position from being an instant insufficient-material
    // draw, which would otherwise short-circuit the search before any move
    // is ever applied.
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/3N4/8/4P3/4K3 w - - 0 1");
    game.rookRights.w = 1;
    game.rookLocked.add("d4" as Square);

    for (let seed = 0; seed < 10; seed++) {
      expect(() => chooseMove(game, 2, seed)).not.toThrow();
    }
  });
});
