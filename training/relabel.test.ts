// @vitest-environment node
//
// Node, not the config's default jsdom: this file's import chain reaches
// searchWorkerPool.ts -> esbuild, and esbuild refuses to load under jsdom
// (its TextEncoder doesn't produce a real Uint8Array).
/**
 * Relabel scoring-convention tests (`docs/nnue-pst-relabel-spec.md`).
 *
 * The load-bearing property: `searchRoot()` returns a side-to-move-relative
 * score, but records store White-positive pawn units, so relabel has to flip
 * on Black's turn. Getting that backwards is the worst kind of bug in this
 * pipeline — every score keeps a plausible magnitude, nothing downstream
 * validates the sign, and the net simply learns to prefer losing. So these
 * tests don't assert the flip in isolation (`turn === "w" ? s : -s` is
 * tautological); they compose it with a real search on positions whose
 * correct sign is unarguable, which is what actually pins the direction.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EvoChessGame } from "../src/evochess/game";
import { engineConfig, searchRoot, type EngineBackend } from "../src/evochess/ai";
import { gameFromRecord, round, type PositionRecord } from "./jsonl";
import { whiteScore } from "./relabel";

/** White up a queen from the opening position — mirrored to each side to move. */
const WHITE_UP_QUEEN_W = "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const WHITE_UP_QUEEN_B = "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1";
/** Black up a rook, same treatment. */
const BLACK_UP_ROOK_W = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NBQKBNR w Kkq - 0 1";
const BLACK_UP_ROOK_B = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NBQKBNR b Kkq - 0 1";

const original = engineConfig.backend;
afterEach(() => {
  engineConfig.backend = original;
});

/** What relabel.ts's main loop does to one record, minus the worker pool. */
function relabel(fen: string, depth = 2): number {
  const game = new EvoChessGame();
  game.chess.load(fen);
  const { score } = searchRoot(game, depth, 1);
  return round(whiteScore(game.turn, score));
}

describe("whiteScore", () => {
  it("passes White's own score through and negates Black's", () => {
    expect(whiteScore("w", 3.5)).toBe(3.5);
    expect(whiteScore("b", 3.5)).toBe(-3.5);
    expect(whiteScore("b", -3.5)).toBe(3.5);
  });
});

// Both backends: relabel_batch.sh defaults to bitboard (integer centipawns,
// converted in searchRoot) while --backend chessjs keeps the float ai.ts
// eval, and the convention must not depend on which one produced the number.
describe.each<EngineBackend>(["bitboard", "chessjs"])("relabel sign (%s backend)", (backend) => {
  it("scores a White-winning position positive with White to move", () => {
    engineConfig.backend = backend;
    expect(relabel(WHITE_UP_QUEEN_W)).toBeGreaterThan(5);
  });

  it("scores the same White-winning position positive with Black to move", () => {
    // The case the flip exists for: search returns a large *negative* number
    // here (Black is losing, and Black is to move), and the stored label must
    // still be positive.
    engineConfig.backend = backend;
    expect(relabel(WHITE_UP_QUEEN_B)).toBeGreaterThan(5);
  });

  it("scores a Black-winning position negative regardless of side to move", () => {
    engineConfig.backend = backend;
    expect(relabel(BLACK_UP_ROOK_W)).toBeLessThan(-2);
    expect(relabel(BLACK_UP_ROOK_B)).toBeLessThan(-2);
  });

  it("agrees with the raw search on the side-to-move view", () => {
    // Ties the stored label back to searchRoot's own convention, so a change
    // to *either* side of the flip breaks a test rather than cancelling out.
    engineConfig.backend = backend;
    const game = new EvoChessGame();
    game.chess.load(WHITE_UP_QUEEN_B);
    const { score } = searchRoot(game, 2, 1);
    expect(score).toBeLessThan(0); // Black to move, Black is losing
    expect(relabel(WHITE_UP_QUEEN_B)).toBe(round(-score));
  });
});

describe("relabel record round trip", () => {
  it("reads the turn from the record's own fen, not the caller's assumption", () => {
    // relabel.ts derives `turn` from gameFromRecord(record), so a record that
    // says "b" must flip even though nothing else in the record mentions it.
    const record: PositionRecord = { fen: WHITE_UP_QUEEN_B, score: -99, outcome: 0.5 };
    const game = gameFromRecord(record);
    expect(game.turn).toBe("b");
    const { score } = searchRoot(game, 2, 1);
    expect(round(whiteScore(game.turn, score))).toBeGreaterThan(5);
  });
});
