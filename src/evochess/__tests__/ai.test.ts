import { describe, it, expect } from "vitest";
import { material, chooseMove, searchLevel, EASY_MIX, EASY_EASING_FROM_PLY } from "../ai";
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

describe("EASY_MIX", () => {
  it("is a well-formed mix that leaves room for the full search", () => {
    for (const { p } of EASY_MIX) expect(p).toBeGreaterThan(0);
    // Strictly less than 1: the leftover probability is the full Zen search,
    // and Easy without any real moves in it just reads as broken.
    expect(EASY_MIX.reduce((a, { p }) => a + p, 0)).toBeLessThan(1);
    // Distinct depths, so the console log and the assertions below can name an
    // arm by its depth alone.
    expect(new Set(EASY_MIX.map((a) => a.depth)).size).toBe(EASY_MIX.length);
  });
});

// mulberry32, copied from ai.ts, so a test can pick a seed whose first draw —
// the one `searchLevel` rolls the mix from — lands where it wants it. Only the
// PRNG is mirrored: the cumulative walk that turns that roll into an arm is
// the real one, exercised through `searchLevel` below.
function easyRoll(seed: number): number {
  let a = seed >>> 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Smallest seed whose Easy roll lands in `[lo, hi)`. */
function seedRollingInto(lo: number, hi: number): number {
  for (let seed = 0; seed < 1_000_000; seed++) {
    const r = easyRoll(seed);
    if (r >= lo && r < hi) return seed;
  }
  throw new Error(`no seed rolls into [${lo}, ${hi})`);
}

/** A game sitting exactly on `EASY_EASING_FROM_PLY`, where the mix switches on. */
function gameAtEasingPly(): EvoChessGame {
  const game = new EvoChessGame();
  for (const [from, to] of [
    ["e2", "e4"],
    ["e7", "e5"],
    ["d2", "d4"],
    ["d7", "d5"],
  ] as [Square, Square][]) {
    game.applyMove(from, to);
  }
  return game;
}

describe("searchLevel easy mix", () => {
  const game = gameAtEasingPly();

  it("is set up on the ply the mix switches on", () => {
    expect(game.moveLog.length + 1).toBe(EASY_EASING_FROM_PLY);
  });

  // Each arm owns the roll interval [cum, cum + p). Probing just inside both
  // edges is what pins the cumulative walk: drop the running subtraction, or
  // reorder the arms, and a probe lands in the wrong one.
  let cum = 0;
  for (const { p, depth } of EASY_MIX) {
    const lo = cum;
    const hi = cum + p;
    cum = hi;
    const eps = Math.min(1e-3, p / 4);

    it(`plays depth ${depth} for rolls in [${lo}, ${hi})`, () => {
      for (const [a, b] of [
        [lo, lo + eps],
        [hi - eps, hi],
      ]) {
        const r = searchLevel(game, "easy", seedRollingInto(a, b));
        expect(r.shallow).toBe(true);
        expect(r.depth).toBe(depth);
        expect(r.move).not.toBeNull();
      }
    });
  }

  it("plays the full search on the leftover probability", () => {
    const r = searchLevel(game, "easy", seedRollingInto(cum, 1));
    expect(r.shallow).toBeFalsy();
    expect(r.move).not.toBeNull();
  });

  it("plays the opening straight, whatever the roll says", () => {
    // Same seed as the first arm above, but before EASY_EASING_FROM_PLY.
    const r = searchLevel(new EvoChessGame(), "easy", seedRollingInto(0, Math.min(1e-3, EASY_MIX[0].p)));
    expect(r.shallow).toBeFalsy();
  });
});
