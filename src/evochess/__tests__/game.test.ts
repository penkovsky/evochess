import { describe, it, expect } from "vitest";
import { EvoChessGame, EvoChessError, START_FEN } from "../game";
import type { Square } from "chess.js";

function push(game: EvoChessGame, uci: string, options = {}) {
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  return game.applyMove(from, to, options);
}

function playWhitePawnMoves(game: EvoChessGame, whites: string[], blacks: (string | null)[]) {
  whites.forEach((w, i) => {
    push(game, w);
    const b = blacks[i];
    if (b !== null && b !== undefined) push(game, b);
  });
}

describe("minor promotion rights", () => {
  it("is granted every N=3 pawn moves", () => {
    const game = new EvoChessGame();
    playWhitePawnMoves(game, ["a2a3", "b2b3", "c2c3"], ["a7a6", "b7b6", null]);
    expect(game.minorRights.w).toBe(1);
  });

  it("is not granted before N moves", () => {
    const game = new EvoChessGame();
    push(game, "a2a3");
    push(game, "a7a6");
    push(game, "b2b3");
    expect(game.minorRights.w).toBe(0);
  });

  it("accumulates indefinitely", () => {
    const game = new EvoChessGame();
    playWhitePawnMoves(
      game,
      ["a2a3", "b2b3", "c2c3", "d2d3", "e2e3", "f2f3"],
      ["a7a6", "b7b6", "c7c6", "d7d6", "e7e6", null]
    );
    expect(game.minorRights.w).toBe(2);
  });

  it("applies only to the pawn that just moved", () => {
    const game = new EvoChessGame();
    playWhitePawnMoves(game, ["a2a3", "b2b3", "c2c3"], ["a7a6", "b7b6", null]);
    expect(() => push(game, "d2d3", { minorPromo: "n" })).toThrow(EvoChessError);
  });

  it("spends the right and promotes the moved pawn", () => {
    const game = new EvoChessGame();
    playWhitePawnMoves(game, ["a2a3", "b2b3", "c2c3"], ["a7a6", "b7b6", "d7d6"]);
    push(game, "c3c4", { minorPromo: "n" });
    expect(game.minorRights.w).toBe(0);
    const piece = game.chess.get("c4");
    expect(piece?.type).toBe("n");
    expect(piece?.color).toBe("w");
  });
});

describe("rook promotion rights", () => {
  it("is granted every M=3 minor-piece moves", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/N3K3 w - - 0 1");
    push(game, "a1b3"); // knight move #1
    push(game, "e8f8");
    push(game, "b3d4"); // knight move #2
    expect(game.rookRights.w).toBe(0);
    push(game, "f8e8");
    push(game, "d4c6"); // knight move #3 completes M_ROOK=3
    expect(game.rookRights.w).toBe(1);
  });

  it("counts bishop moves as well as knight moves", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/N1B1K3 w - - 0 1");
    push(game, "a1b3"); // knight move #1
    push(game, "e8f8");
    push(game, "c1d2"); // bishop move #2
    push(game, "f8e8");
    push(game, "b3d4"); // knight move #3 completes M_ROOK=3
    expect(game.rookRights.w).toBe(1);
  });

  it("does not count captures by pawns toward the rook counter", () => {
    const game = new EvoChessGame();
    // A pawn capturing a knight (a non-pawn capture) grants no rook progress
    // under the revised rule; only minor-piece moves do.
    game.chess.load("4k3/8/8/8/3n4/4P3/8/4K3 w - - 0 1");
    push(game, "e3d4"); // pawn captures knight
    expect(game.rookRights.w).toBe(0);
    expect(game.minorMoveProgress.w).toBe(0);
  });

  it("counts a minor-piece capture as a single minor move only", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/1n6/3N4/8/8/8/4K3 w - - 0 1");
    push(game, "d5b6"); // knight captures knight: 1 minor move, no capture bonus
    expect(game.minorMoveProgress.w).toBe(1);
    expect(game.rookRights.w).toBe(0);
  });

  it("treats an evolutionary pawn->minor promotion as a pawn move, not a minor move", () => {
    const game = new EvoChessGame();
    playWhitePawnMoves(game, ["a2a3", "b2b3", "c2c3"], ["a7a6", "b7b6", "d7d6"]);
    expect(game.minorRights.w).toBe(1);
    push(game, "c3c4", { minorPromo: "n" }); // pawn moves and evolves into a knight
    // The move counts toward the pawn counter (progresses toward the next
    // minor right), never toward the rook counter.
    expect(game.chess.get("c4")?.type).toBe("n");
    expect(game.pawnMoveProgress.w).toBe(1);
    expect(game.minorMoveProgress.w).toBe(0);
    expect(game.rookRights.w).toBe(0);
  });

  it("promotes only the minor piece that just moved, spending the right", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/1n6/3N4/8/8/8/4K3 w - - 0 1");
    game.rookRights.w = 1;
    push(game, "d5b6", { rookPromo: true }); // knight moves to b6 and evolves
    expect(game.rookRights.w).toBe(0);
    expect(game.chess.get("b6")?.type).toBe("r");
  });

  it("can be spent on the very move that earns the right", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/N3K3 w - - 0 1");
    push(game, "a1b3"); // minor move #1
    push(game, "e8f8");
    push(game, "b3d4"); // minor move #2
    push(game, "f8e8");
    // minor move #3 earns the rook right and immediately promotes the knight
    push(game, "d4c6", { rookPromo: true });
    expect(game.rookRights.w).toBe(0);
    expect(game.chess.get("c6")?.type).toBe("r");
  });

  it("rejects rook promotion when the piece that moved is not a minor piece", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    game.rookRights.w = 1;
    // moving the King cannot trigger a rook promotion; only a moved minor can
    expect(() => push(game, "e1d1", { rookPromo: true })).toThrow(EvoChessError);
    expect(game.chess.get("e1")?.type).toBe("k"); // move rolled back
    expect(game.chess.get("d1")).toBeUndefined();
    expect(game.rookRights.w).toBe(1); // right not consumed
  });
});

describe("move constraints", () => {
  it("allows only one promotion per move", () => {
    const game = new EvoChessGame();
    playWhitePawnMoves(game, ["a2a3", "b2b3", "c2c3"], ["a7a6", "b7b6", null]);
    game.rookRights.w = 1;
    expect(() => push(game, "c3c4", { minorPromo: "n", rookPromo: true })).toThrow(EvoChessError);
  });

  it("forces standard promotion at the 8th rank", () => {
    const game = new EvoChessGame();
    game.chess.load("7k/4P3/8/8/8/8/8/K7 w - - 0 1");
    expect(() => push(game, "e7e8")).toThrow(EvoChessError);
    push(game, "e7e8", { forcedPromo: "q" });
    expect(game.chess.get("e8")?.type).toBe("q");
  });

  it("precludes other promotion on the same move as forced promotion", () => {
    const game = new EvoChessGame();
    game.chess.load("7k/4P3/8/8/8/8/8/K7 w - - 0 1");
    game.rookRights.w = 1;
    expect(() => push(game, "e7e8", { forcedPromo: "q", rookPromo: true })).toThrow(EvoChessError);
  });

  it("rejects an illegal move outright", () => {
    const game = new EvoChessGame();
    // pawn can't jump two squares from an already-advanced position
    push(game, "a2a4");
    push(game, "a7a5");
    expect(() => game.applyMove("a4" as Square, "a6" as Square)).toThrow(EvoChessError);
    expect(() => game.applyMove("h2" as Square, "h5" as Square)).toThrow(EvoChessError);
  });

  it("rejects spending a minor-promo right that isn't held", () => {
    const game = new EvoChessGame();
    expect(() => push(game, "a2a3", { minorPromo: "n" })).toThrow(EvoChessError);
    // the failed attempt must not have consumed the move
    expect(game.chess.get("a2")?.type).toBe("p");
  });

  it("rejects spending a rook-promo right that isn't held", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/3N4/8/8/8/4K3 w - - 0 1");
    // a minor piece moves, but no rook right is held
    expect(() => push(game, "d5c7", { rookPromo: true })).toThrow(EvoChessError);
    expect(game.chess.get("d5")?.type).toBe("n"); // move rolled back
  });
});

describe("starting position", () => {
  it("matches rule 1: 8 pawns + king per side, nothing else", () => {
    const game = new EvoChessGame();
    expect(game.chess.fen()).toBe(START_FEN);
    const board = game.chess.board();
    const counts: Record<string, number> = {};
    for (const row of board) {
      for (const cell of row) {
        if (!cell) continue;
        const key = cell.color + cell.type;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    expect(counts).toEqual({ wp: 8, bp: 8, wk: 1, bk: 1 });
  });

  it("has no rights or progress at game start", () => {
    const game = new EvoChessGame();
    expect(game.minorRights).toEqual({ w: 0, b: 0 });
    expect(game.rookRights).toEqual({ w: 0, b: 0 });
    expect(game.turn).toBe("w");
  });
});

describe("standard chess rules still apply", () => {
  it("supports en passant", () => {
    const game = new EvoChessGame();
    push(game, "e2e4");
    push(game, "a7a6");
    push(game, "e4e5");
    push(game, "d7d5"); // black pawn jumps 2, adjacent to white pawn on e5
    push(game, "e5d6"); // en passant capture
    expect(game.chess.get("d5")).toBeUndefined();
    expect(game.chess.get("d6")?.type).toBe("p");
    expect(game.chess.get("d6")?.color).toBe("w");
  });

  it("has no castling available (no rooks at start, none defined)", () => {
    const game = new EvoChessGame();
    const moves = game.chess.moves({ verbose: true });
    expect(moves.some((m) => m.flags.includes("k") || m.flags.includes("q"))).toBe(false);
  });

  it("detects checkmate and ends the game", () => {
    const game = new EvoChessGame();
    game.chess.load("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1");
    push(game, "a1a8"); // back-rank mate
    expect(game.isGameOver()).toBe(true);
    expect(game.resultString()).toBe("Checkmate - White wins");
  });

  it("detects stalemate as a draw", () => {
    const game = new EvoChessGame();
    game.chess.load("7k/5K2/8/8/8/8/6Q1/8 w - - 0 1");
    push(game, "g2g6");
    expect(game.isGameOver()).toBe(true);
    expect(game.resultString()).toBe("Stalemate - draw");
  });
});
