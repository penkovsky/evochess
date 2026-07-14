/**
 * EvoChess: a chess variant where the game starts with only Pawns and Kings,
 * and pieces evolve onto the board over time via accumulated promotion
 * rights. See rules.txt for the full rule text. This is a TypeScript port
 * of the reference Python implementation (evochess/game.py), built on top
 * of chess.js instead of python-chess.
 *
 * Rules implemented:
 *   0. Standard chess movement/check/mate/stalemate/en-passant, no castling.
 *   1. Starting position: 8 Pawns + King per side, standard squares only.
 *   2. "To Minor Piece Promotion": every N=3 pawn moves (by a color) grants
 *      that color the right to promote the pawn that just moved into a
 *      Knight or Bishop. Rights accumulate indefinitely.
 *   3. "To Rook Promotion": every M=3 moves made by a color's own minor
 *      pieces (Knights and Bishops) grants that color the right to promote
 *      the minor piece that just moved into a Rook (mirroring the pawn rule,
 *      which promotes the pawn that just moved). Captures play no part.
 *      Rights accumulate.
 *   4. Clarifications:
 *      - Pawn moves (including pawn captures) count towards "To Minor Piece
 *        Promotion" only, never towards "To Rook Promotion".
 *      - Only one piece may be promoted per move, even if multiple rights
 *        are held / earned that same move.
 *      - Reaching the 8th rank forces standard chess promotion (Q/R/B/N)
 *        and precludes any other promotion that move.
 */
import { Chess, type Color, type Square, type PieceSymbol } from "chess.js";

export const N_MINOR = 3;
export const M_ROOK = 3;

export const START_FEN = "4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1";

export type MinorPromo = "n" | "b";
export type ForcedPromo = "q" | "r" | "b" | "n";

export class EvoChessError extends Error {}

export interface ApplyMoveOptions {
  forcedPromo?: ForcedPromo;
  minorPromo?: MinorPromo;
  /**
   * Evolve the minor piece that just moved into a Rook. Like `minorPromo`
   * (which promotes the pawn that just moved), this can only be applied on a
   * turn on which a minor piece moves, and requires an unused rook right.
   */
  rookPromo?: boolean;
}

export interface Rights {
  minor: number;
  rook: number;
}

export class EvoChessGame {
  chess: Chess;
  minorRights: Record<Color, number>;
  rookRights: Record<Color, number>;
  // Not private: persisted to localStorage so progress toward the next
  // right survives a page reload.
  pawnMoveProgress: Record<Color, number>;
  minorMoveProgress: Record<Color, number>;
  moveLog: string[];

  constructor() {
    this.chess = new Chess(START_FEN);
    this.minorRights = { w: 0, b: 0 };
    this.rookRights = { w: 0, b: 0 };
    this.pawnMoveProgress = { w: 0, b: 0 };
    this.minorMoveProgress = { w: 0, b: 0 };
    this.moveLog = [];
  }

  copy(): EvoChessGame {
    const g = Object.create(EvoChessGame.prototype) as EvoChessGame;
    g.chess = new Chess(this.chess.fen());
    g.minorRights = { ...this.minorRights };
    g.rookRights = { ...this.rookRights };
    g.pawnMoveProgress = { ...this.pawnMoveProgress };
    g.minorMoveProgress = { ...this.minorMoveProgress };
    g.moveLog = [...this.moveLog];
    return g;
  }

  get turn(): Color {
    return this.chess.turn();
  }

  rightsFor(color: Color): Rights {
    return { minor: this.minorRights[color], rook: this.rookRights[color] };
  }

  isGameOver(): boolean {
    return this.chess.isGameOver();
  }

  resultString(): string {
    if (this.chess.isCheckmate()) {
      const winner = this.chess.turn() === "w" ? "Black" : "White";
      return `Checkmate - ${winner} wins`;
    }
    if (this.chess.isStalemate()) return "Stalemate - draw";
    if (this.chess.isInsufficientMaterial()) return "Draw - insufficient material";
    if (this.chess.isDrawByFiftyMoves()) return "Draw - fifty-move rule";
    if (this.chess.isThreefoldRepetition()) return "Draw - repetition";
    return "Game in progress";
  }

  /**
   * Apply one full EvoChess turn: a base chess move, plus at most one
   * optional evolutionary promotion (minor or rook), or a forced standard
   * promotion if the pawn reaches the last rank.
   *
   * Throws EvoChessError on any illegal request.
   */
  applyMove(from: Square, to: Square, options: ApplyMoveOptions = {}): string {
    const { forcedPromo, minorPromo, rookPromo } = options;
    const color = this.chess.turn();
    const piece = this.chess.get(from);
    if (!piece || piece.color !== color) {
      throw new EvoChessError("No piece of the side to move on the origin square.");
    }

    const isPawnMove = piece.type === "p";
    const isMinorMove = piece.type === "n" || piece.type === "b";
    const destRank = to[1];
    const reachesLastRank = isPawnMove && (destRank === "8" || destRank === "1");

    if (reachesLastRank) {
      if (!forcedPromo) {
        throw new EvoChessError(
          "Pawn reaches the last rank: a promotion piece (Q/R/B/N) must be specified."
        );
      }
      if (minorPromo !== undefined || rookPromo) {
        throw new EvoChessError("No other promotion is possible when a pawn reaches the last rank.");
      }
    } else {
      if (forcedPromo) {
        throw new EvoChessError("Forced promotion given, but the pawn does not reach the last rank.");
      }
      if (minorPromo !== undefined && rookPromo) {
        throw new EvoChessError("Only one piece may be promoted per move.");
      }
    }

    let moveResult;
    try {
      moveResult = this.chess.move(
        reachesLastRank ? { from, to, promotion: forcedPromo } : { from, to }
      );
    } catch {
      throw new EvoChessError(`Illegal move: ${from}${to}`);
    }

    let note = moveResult.san;

    // -- update evolutionary counters (rank-8 promotion still counts) --
    // Pawn moves feed "To Minor Piece Promotion"; minor-piece (Knight/Bishop)
    // moves feed "To Rook Promotion". Captures play no part in either counter.
    if (isPawnMove) {
      this.pawnMoveProgress[color] += 1;
      if (this.pawnMoveProgress[color] >= N_MINOR) {
        this.pawnMoveProgress[color] -= N_MINOR;
        this.minorRights[color] += 1;
      }
    }
    if (isMinorMove) {
      this.minorMoveProgress[color] += 1;
      if (this.minorMoveProgress[color] >= M_ROOK) {
        this.minorMoveProgress[color] -= M_ROOK;
        this.rookRights[color] += 1;
      }
    }

    // -- optional evolutionary promotion (only if not a forced promo) --
    if (!reachesLastRank) {
      if (minorPromo !== undefined) {
        if (this.minorRights[color] <= 0) {
          this.chess.undo();
          throw new EvoChessError("No unused minor-piece promotion right available.");
        }
        const movedPiece = this.chess.get(to);
        if (!movedPiece || movedPiece.type !== "p" || movedPiece.color !== color) {
          this.chess.undo();
          throw new EvoChessError("Minor promotion may only be applied to the pawn that just moved.");
        }
        this.chess.remove(to);
        this.chess.put({ type: minorPromo as PieceSymbol, color }, to);
        this.minorRights[color] -= 1;
        note += ` (minor-promo->${minorPromo.toUpperCase()}@${to})`;
      } else if (rookPromo) {
        if (this.rookRights[color] <= 0) {
          this.chess.undo();
          throw new EvoChessError("No unused rook promotion right available.");
        }
        const movedPiece = this.chess.get(to);
        if (!movedPiece || movedPiece.color !== color || (movedPiece.type !== "n" && movedPiece.type !== "b")) {
          this.chess.undo();
          throw new EvoChessError("Rook promotion may only be applied to the minor piece that just moved.");
        }
        this.chess.remove(to);
        this.chess.put({ type: "r", color }, to);
        this.rookRights[color] -= 1;
        note += ` (rook-promo->R@${to})`;
      }

      // an evolutionary promotion can change whether the opponent is now in
      // check/checkmate, so refresh the SAN's +/# suffix
      if (minorPromo !== undefined || rookPromo) {
        const parenIdx = note.indexOf(" (");
        let base = parenIdx >= 0 ? note.slice(0, parenIdx) : note;
        const suffix = parenIdx >= 0 ? note.slice(parenIdx) : "";
        base = base.replace(/[+#]$/, "");
        if (this.chess.isCheckmate()) base += "#";
        else if (this.chess.isCheck()) base += "+";
        note = base + suffix;
      }
    }

    this.moveLog.push(note);
    return note;
  }

  // -- helpers for candidate generation (used by the AI / UI) ----------

  minorPromoCandidates(color: Color): boolean {
    return this.minorRights[color] > 0;
  }

  /**
   * Whether a Knight/Bishop currently standing on `square` (assumed to be the
   * piece that just moved) may be evolved into a Rook: the side must hold an
   * unused rook right and the piece must be its own minor piece.
   */
  canRookPromote(color: Color, square: Square): boolean {
    if (this.rookRights[color] <= 0) return false;
    const piece = this.chess.get(square);
    return !!piece && piece.color === color && (piece.type === "n" || piece.type === "b");
  }
}
