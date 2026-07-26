/**
 * Milestone 2 of docs/ponder-spec.md §4.1/§9: `keepTT` threaded through
 * `searchEvoTT`/`searchEvoTTTimed` (evoSearch.ts) and `searchRoot`/
 * `searchRootTimed`/`searchLevel` (ai.ts).
 *
 * The verification criterion is a node-count test: a search continuing with
 * `keepTT: true` from a TT already warmed by an identical prior search visits
 * strictly fewer nodes than one with `keepTT: false` (which bumps the TT's
 * generation and starts from an effectively empty cache) — while still
 * returning the same move and score, since retained entries only ever store
 * exact bounds (evoSearch.ts's `negamaxTT`).
 */
import { describe, expect, it } from "vitest";
import { EvoChessGame } from "../game";
import { fromEvoGame } from "../evoBitboard";
import { searchEvoTT } from "../evoSearch";
import { searchRoot, searchLevel } from "../ai";

describe("keepTT (ponder-spec.md §4.1, milestone 2)", () => {
  it("evoSearch.searchEvoTT: keepTT:true reuses a prior search's TT, visiting strictly fewer nodes", () => {
    const seed = 7;
    const depth = 5;

    searchEvoTT(fromEvoGame(new EvoChessGame()), depth, seed); // warm the TT
    const withoutKeep = searchEvoTT(fromEvoGame(new EvoChessGame()), depth, seed, false, false);

    searchEvoTT(fromEvoGame(new EvoChessGame()), depth, seed); // re-warm (previous call invalidated it)
    const withKeep = searchEvoTT(fromEvoGame(new EvoChessGame()), depth, seed, false, true);

    expect(withKeep.nodes).toBeLessThan(withoutKeep.nodes);
    expect(withKeep.turn).toEqual(withoutKeep.turn);
    expect(withKeep.score).toBe(withoutKeep.score);
  });

  it("ai.searchRoot: keepTT threads down to the bitboard TT", () => {
    const seed = 3;
    const depth = 5;

    searchRoot(new EvoChessGame(), depth, seed, false);
    const withoutKeep = searchRoot(new EvoChessGame(), depth, seed, false, false);

    searchRoot(new EvoChessGame(), depth, seed, false);
    const withKeep = searchRoot(new EvoChessGame(), depth, seed, false, true);

    expect(withKeep.nodes).toBeLessThan(withoutKeep.nodes);
    expect(withKeep.move).toEqual(withoutKeep.move);
    expect(withKeep.score).toBe(withoutKeep.score);
  });

  it("ai.searchLevel: opts.keepTT threads all the way down, defaulting to false", () => {
    const seed = 11;

    searchLevel(new EvoChessGame(), "easy", seed);
    const withoutKeep = searchLevel(new EvoChessGame(), "easy", seed, { keepTT: false });

    searchLevel(new EvoChessGame(), "easy", seed);
    const withKeep = searchLevel(new EvoChessGame(), "easy", seed, { keepTT: true });

    expect(withKeep.nodes).toBeLessThan(withoutKeep.nodes);
    expect(withKeep.move).toEqual(withoutKeep.move);

    // Omitting opts entirely must match the explicit keepTT:false default —
    // no existing caller may change behaviour from this signature change.
    searchLevel(new EvoChessGame(), "easy", seed);
    const omitted = searchLevel(new EvoChessGame(), "easy", seed);
    searchLevel(new EvoChessGame(), "easy", seed);
    const explicitFalse = searchLevel(new EvoChessGame(), "easy", seed, { keepTT: false });
    expect(omitted.nodes).toBe(explicitFalse.nodes);
  });
});
