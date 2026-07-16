import { describe, it, expect } from "vitest";
import { EvoChessGame, EvoChessError, START_FEN, ROOK_CHARGES } from "../game";
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

describe("rook charges", () => {
  it("grants ROOK_CHARGES charges on evolutionary promotion", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/1n6/3N4/8/8/8/4K3 w - - 0 1");
    game.rookRights.w = 1;
    push(game, "d5b6", { rookPromo: true });
    expect(game.rookCharges.get("b6" as Square)).toBe(ROOK_CHARGES);
  });

  it("grants ROOK_CHARGES charges on a forced 8th-rank promotion to rook", () => {
    const game = new EvoChessGame();
    game.chess.load("7k/4P3/8/8/8/8/8/K7 w - - 0 1");
    push(game, "e7e8", { forcedPromo: "r" });
    expect(game.rookCharges.get("e8" as Square)).toBe(ROOK_CHARGES);
  });

  it("spends one charge per rook move and the key follows the piece", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/R3K3 w - - 0 1");
    game.rookCharges.set("a1" as Square, ROOK_CHARGES);
    push(game, "a1a4");
    expect(game.rookCharges.get("a4" as Square)).toBe(ROOK_CHARGES - 1);
    expect(game.rookCharges.has("a1" as Square)).toBe(false);
  });

  it("treats a rook with no tracked charge entry as freshly-promoted", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/R3K3 w - - 0 1");
    push(game, "a1a4");
    expect(game.rookCharges.get("a4" as Square)).toBe(ROOK_CHARGES - 1);
  });

  it("requires a downgrade choice when a rook move would exhaust its last charge", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/R3K3 w - - 0 1");
    game.rookCharges.set("a1" as Square, 1);
    expect(() => push(game, "a1a4")).toThrow(EvoChessError);
    expect(game.chess.get("a1")?.type).toBe("r"); // move rolled back
    expect(game.rookCharges.get("a1" as Square)).toBe(1); // charge not consumed
  });

  it("rejects a downgrade choice when the rook still has charges left", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/R3K3 w - - 0 1");
    game.rookCharges.set("a1" as Square, ROOK_CHARGES);
    expect(() => push(game, "a1a4", { downgradeTo: "n" })).toThrow(EvoChessError);
  });

  it("rejects a downgrade choice for a move that isn't a rook move", () => {
    const game = new EvoChessGame();
    expect(() => push(game, "a2a3", { downgradeTo: "n" })).toThrow(EvoChessError);
  });

  it("downgrades to the chosen minor piece and logs an Rd4→Bd4-style note", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/R3K3 w - - 0 1");
    game.rookCharges.set("a1" as Square, 1);
    // Knight, not Bishop: a4 sits on the a4-e8 diagonal, which would put the
    // black king in check and add an unwanted "+" to the expected note.
    const note = push(game, "a1a4", { downgradeTo: "n" });
    expect(game.chess.get("a4" as Square)?.type).toBe("n");
    expect(game.rookCharges.has("a4" as Square)).toBe(false);
    expect(game.rookLocked.has("a4" as Square)).toBe(true);
    expect(note).toBe("Ra4→Na4");
  });

  it("permanently locks the downgraded piece out of ever becoming a rook again", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/R3K3 w - - 0 1");
    game.rookCharges.set("a1" as Square, 1);
    push(game, "a1a4", { downgradeTo: "n" }); // rook downgrades to knight on a4
    push(game, "e8f8");
    game.rookRights.w = 1;
    expect(game.canRookPromote("w", "a4" as Square)).toBe(false);
    expect(() => push(game, "a4b6", { rookPromo: true })).toThrow(EvoChessError);
  });

  it("discards a captured rook's charges without downgrading it", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/3r4/8/8/8/3RK3 w - - 0 1");
    game.rookCharges.set("d1" as Square, ROOK_CHARGES);
    game.rookCharges.set("d5" as Square, 1);
    push(game, "d1d5"); // white rook captures black rook
    expect(game.chess.get("d5" as Square)?.type).toBe("r");
    expect(game.chess.get("d5" as Square)?.color).toBe("w");
    expect(game.rookCharges.get("d5" as Square)).toBe(ROOK_CHARGES - 1);
  });

  it("re-evaluates checkmate after a downgrade, since the new piece attacks differently", () => {
    const game = new EvoChessGame();
    game.chess.load("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1");
    game.rookCharges.set("a1" as Square, 1);
    push(game, "a1a8", { downgradeTo: "n" });
    expect(game.chess.get("a8" as Square)?.type).toBe("n");
    expect(game.chess.isCheck()).toBe(false);
    expect(game.isGameOver()).toBe(false);
  });

  it("copy() clones rookCharges and rookLocked independently", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/R3K3 w - - 0 1");
    game.rookCharges.set("a1" as Square, 3);
    game.rookLocked.add("h1" as Square);
    const copy = game.copy();
    copy.rookCharges.set("a1" as Square, 1);
    copy.rookLocked.add("g1" as Square);
    expect(game.rookCharges.get("a1" as Square)).toBe(3);
    expect(game.rookLocked.has("g1" as Square)).toBe(false);
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

  it("does not declare insufficient material a draw while a minor piece could still become a rook", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/B3K3 w - - 0 1");
    expect(game.chess.isInsufficientMaterial()).toBe(true);
    expect(game.isGameOver()).toBe(false);
    expect(game.resultString()).toBe("Game in progress");
  });

  it("declares insufficient material a draw once the lone minor piece is rook-locked", () => {
    const game = new EvoChessGame();
    game.chess.load("4k3/8/8/8/8/8/8/B3K3 w - - 0 1");
    game.rookLocked.add("a1" as Square);
    expect(game.chess.isInsufficientMaterial()).toBe(true);
    expect(game.isGameOver()).toBe(true);
    expect(game.resultString()).toBe("Draw - insufficient material");
  });
});

describe("en passant interaction with evolutionary promotion", () => {
  it("remains available when the pawn evolves on the same move as its double push", () => {
    const game = new EvoChessGame();
    game.chess.load("7k/8/8/8/1p6/8/P3K3/8 w - - 0 1");
    game.minorRights.w = 1;
    push(game, "a2a4", { minorPromo: "n" });
    expect(game.chess.get("a4" as Square)?.type).toBe("n"); // the pawn evolved
    // chess.js cannot represent this capture (its en passant assumes a pawn
    // victim), so the engine tracks it itself and legalMoves() is the only
    // source of truth. Asserting against chess.chess.moves() here would be
    // asserting the corrupting `_epSquare` hack that used to back it.
    const ep = game.legalMoves().filter((m) => m.evolvedEp);
    expect(ep).toHaveLength(1);
    expect(ep[0]).toMatchObject({ from: "b4", to: "a3", captured: "n" });
  });

  it("does not let a read-only fen() revert the evolution", () => {
    // Regression: chess.js's en-passant undo hardcodes restoring a PAWN, so
    // pointing its `_epSquare` at an evolved piece let any legality trial
    // inside fen()/moves() silently rewrite the knight back into a pawn.
    const game = new EvoChessGame();
    game.chess.load("7k/8/8/8/1p6/8/P3K3/8 w - - 0 1");
    game.minorRights.w = 1;
    push(game, "a2a4", { minorPromo: "n" });
    expect(game.chess.get("a4" as Square)?.type).toBe("n");
    game.chess.fen();
    game.chess.moves({ verbose: true });
    expect(game.chess.get("a4" as Square)?.type).toBe("n");
    // and the board must survive the fen() round-trip that copy() performs
    expect(game.copy().chess.get("a4" as Square)?.type).toBe("n");
  });

  it("captures en passant and removes the evolved piece, not just a pawn", () => {
    const game = new EvoChessGame();
    game.chess.load("7k/8/8/8/1p6/8/P3K3/8 w - - 0 1");
    game.minorRights.w = 1;
    push(game, "a2a4", { minorPromo: "n" }); // white pawn evolves into a knight on a4
    push(game, "b4a3"); // black captures en passant
    expect(game.chess.get("a4" as Square)).toBeUndefined(); // the knight is gone, not just a pawn
    expect(game.chess.get("a3" as Square)?.type).toBe("p");
    expect(game.chess.get("a3" as Square)?.color).toBe("b");
  });

  it("still expires after one ply even when the pawn evolved", () => {
    const game = new EvoChessGame();
    game.chess.load("7k/8/8/8/1p6/8/P3K3/8 w - - 0 1");
    game.minorRights.w = 1;
    push(game, "a2a4", { minorPromo: "n" });
    push(game, "h8g8"); // black declines the capture and plays something else
    expect(game.epEvolved).toBeNull();
    expect(game.legalMoves().some((m) => m.evolvedEp)).toBe(false);
  });

  it("does not affect a plain double push with no evolution", () => {
    const game = new EvoChessGame();
    game.chess.load("7k/8/8/8/1p6/8/P3K3/8 w - - 0 1");
    push(game, "a2a4");
    const moves = game.chess.moves({ square: "b4" as Square, verbose: true });
    expect(moves.some((m) => m.flags.includes("e"))).toBe(true);
  });
});
