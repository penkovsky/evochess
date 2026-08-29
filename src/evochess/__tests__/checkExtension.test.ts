/**
 * The check extension, against the position that motivated it.
 *
 * `data/games/game2.txt` is a net-vs-net game whose loser walked into a mate in
 * 5 that neither side saw coming, and both sides were positive about themselves
 * for four moves before it landed. The reason is structural rather than a bad
 * evaluation: quiescence extends *captures*, and the mating line is all checks,
 * so the mate sits past the horizon at depth 4.
 *
 * The position below is after 19. ... f6 (ply 38), White to move and mating in
 * five plies: 20. Rg8+ Kf7 21. Bd8=R f5=B 22. Rdf8#.
 */
import { describe, expect, it } from "vitest";
import { EvoChessGame } from "../game";
import { fromEvoGame } from "../evoBitboard";
import { searchEvoTT, setCheckExtension } from "../evoSearch";
import type { Square } from "chess.js";

const MATE_THRESHOLD = 100_000 - 1000;

/** game2 after 19. ... f6: White to move, mate in 5 plies. */
function game2Ply38(): EvoChessGame {
  const game = new EvoChessGame();
  game.chess.load("4k3/4p3/1Bp1pp2/1p2P2b/3P4/P5R1/8/2K5 w - - 0 20");
  game.minorRights = { w: 0, b: 1 };
  game.rookRights = { w: 1, b: 0 };
  game.pawnMoveProgress = { w: 1, b: 1 };
  game.minorMoveProgress = { w: 0, b: 1 };
  game.rookCharges = new Map([["g3" as Square, 5]]);
  game.rookLocked = new Set(["h5" as Square]);
  return game;
}

/** Search at a fixed depth with the extension forced on or off. */
function searchWithExtension(depth: number, on: boolean) {
  const was = setCheckExtension(on);
  try {
    // PST evaluation (useNnue defaults false), so the result does not depend on
    // which net happens to be loaded.
    return searchEvoTT(fromEvoGame(game2Ply38()), depth, undefined);
  } finally {
    setCheckExtension(was);
  }
}

describe("check extension", () => {
  it("finds game2's mate in 5 at depth 4, which the plain search misses", () => {
    expect(searchWithExtension(4, false).score).toBeLessThan(MATE_THRESHOLD);
    expect(searchWithExtension(4, true).score).toBeGreaterThanOrEqual(MATE_THRESHOLD);
  });

  it("still sees the mate at the depth the plain search needs for it", () => {
    // Depth 5 reaches it either way; the extension must not lose what the
    // deeper plain search already had.
    expect(searchWithExtension(5, false).score).toBeGreaterThanOrEqual(MATE_THRESHOLD);
    expect(searchWithExtension(5, true).score).toBeGreaterThanOrEqual(MATE_THRESHOLD);
  });

  it("restores what it replaced, whatever the default is", () => {
    // Every caller that flips it (training/match.ts, the probe runs) relies on
    // the returned previous value to put it back.
    const original = setCheckExtension(true);
    expect(setCheckExtension(false)).toBe(true);
    expect(setCheckExtension(true)).toBe(false);
    setCheckExtension(original);
  });
});
