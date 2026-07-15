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
export const ROOK_CHARGES = 5;

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
  /**
   * Mandatory downgrade choice when a rook move exhausts its last charge:
   * the rook becomes a Knight or Bishop, on the same square, this turn.
   */
  downgradeTo?: MinorPromo;
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
  // Charges remaining on each rook currently on the board, keyed by square.
  // The key follows the piece across moves; a rook with no entry is treated
  // as freshly-promoted (full charges) — this covers rooks placed directly
  // via chess.load() rather than through applyMove.
  rookCharges: Map<Square, number>;
  // Squares of minor pieces that were downgraded from a rook: permanently
  // barred from ever being promoted back to a rook. Also follows the piece
  // across moves.
  rookLocked: Set<Square>;

  constructor() {
    this.chess = new Chess(START_FEN);
    this.minorRights = { w: 0, b: 0 };
    this.rookRights = { w: 0, b: 0 };
    this.pawnMoveProgress = { w: 0, b: 0 };
    this.minorMoveProgress = { w: 0, b: 0 };
    this.moveLog = [];
    this.rookCharges = new Map();
    this.rookLocked = new Set();
  }

  copy(): EvoChessGame {
    const g = Object.create(EvoChessGame.prototype) as EvoChessGame;
    g.chess = new Chess(this.chess.fen());
    g.minorRights = { ...this.minorRights };
    g.rookRights = { ...this.rookRights };
    g.pawnMoveProgress = { ...this.pawnMoveProgress };
    g.minorMoveProgress = { ...this.minorMoveProgress };
    g.moveLog = [...this.moveLog];
    g.rookCharges = new Map(this.rookCharges);
    g.rookLocked = new Set(this.rookLocked);
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
    const { forcedPromo, minorPromo, rookPromo, downgradeTo } = options;
    const color = this.chess.turn();
    const piece = this.chess.get(from);
    if (!piece || piece.color !== color) {
      throw new EvoChessError("No piece of the side to move on the origin square.");
    }

    const isPawnMove = piece.type === "p";
    const isMinorMove = piece.type === "n" || piece.type === "b";
    const isRookMove = piece.type === "r";
    const destRank = to[1];
    const reachesLastRank = isPawnMove && (destRank === "8" || destRank === "1");

    if (reachesLastRank) {
      if (!forcedPromo) {
        throw new EvoChessError(
          "Pawn reaches the last rank: a promotion piece (Q/R/B/N) must be specified."
        );
      }
      if (minorPromo !== undefined || rookPromo || downgradeTo !== undefined) {
        throw new EvoChessError("No other promotion is possible when a pawn reaches the last rank.");
      }
    } else {
      if (forcedPromo) {
        throw new EvoChessError("Forced promotion given, but the pawn does not reach the last rank.");
      }
      if (minorPromo !== undefined && rookPromo) {
        throw new EvoChessError("Only one piece may be promoted per move.");
      }
      if (downgradeTo !== undefined && !isRookMove) {
        throw new EvoChessError("Downgrade choice given, but the piece that moved is not a rook.");
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

    // -- rook-charge bookkeeping: key follows the piece, drop on capture --
    // Mutated on working copies and only committed to `this` once the whole
    // turn validates, so a rejected move (chess.undo()) leaves rookCharges/
    // rookLocked untouched, matching the reverted position.
    const rookCharges = new Map(this.rookCharges);
    const rookLocked = new Set(this.rookLocked);
    rookCharges.delete(to);
    rookLocked.delete(to);
    if (rookCharges.has(from)) {
      const charges = rookCharges.get(from)!;
      rookCharges.delete(from);
      rookCharges.set(to, charges);
    }
    if (rookLocked.has(from)) {
      rookLocked.delete(from);
      rookLocked.add(to);
    }

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

    // -- rook charge spend + mandatory downgrade --
    let downgraded = false;
    if (isRookMove) {
      const remaining = (rookCharges.get(to) ?? ROOK_CHARGES) - 1;
      if (remaining > 0) {
        if (downgradeTo !== undefined) {
          this.chess.undo();
          throw new EvoChessError("Rook still has charges remaining; no downgrade to specify.");
        }
        rookCharges.set(to, remaining);
      } else {
        if (downgradeTo === undefined) {
          this.chess.undo();
          throw new EvoChessError(
            "Rook charges exhausted: a downgrade piece (Knight/Bishop) must be specified."
          );
        }
        this.chess.remove(to);
        this.chess.put({ type: downgradeTo as PieceSymbol, color }, to);
        rookCharges.delete(to);
        rookLocked.add(to);
        downgraded = true;
        note = `R${to}→${downgradeTo.toUpperCase()}${to}`;
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
        note = note.replace(/[+#]$/, "") + `=${minorPromo.toUpperCase()}`;
      } else if (rookPromo) {
        if (this.rookRights[color] <= 0) {
          this.chess.undo();
          throw new EvoChessError("No unused rook promotion right available.");
        }
        if (rookLocked.has(to)) {
          this.chess.undo();
          throw new EvoChessError("This piece was downgraded from a rook and can never become one again.");
        }
        const movedPiece = this.chess.get(to);
        if (!movedPiece || movedPiece.color !== color || (movedPiece.type !== "n" && movedPiece.type !== "b")) {
          this.chess.undo();
          throw new EvoChessError("Rook promotion may only be applied to the minor piece that just moved.");
        }
        this.chess.remove(to);
        this.chess.put({ type: "r", color }, to);
        this.rookRights[color] -= 1;
        rookCharges.set(to, ROOK_CHARGES);
        note = note.replace(/[+#]$/, "") + "=R";
      }

      // an evolutionary promotion can change whether the opponent is now in
      // check/checkmate, so refresh the SAN's +/# suffix
      if (minorPromo !== undefined || rookPromo) {
        note = note.replace(/[+#]$/, "");
        if (this.chess.isCheckmate()) note += "#";
        else if (this.chess.isCheck()) note += "+";
      }
    }

    // -- forced (8th-rank) promotion to a rook also grants full charges --
    if (reachesLastRank && forcedPromo === "r") {
      rookCharges.set(to, ROOK_CHARGES);
    }

    // a rook downgrade can change whether the opponent is now in
    // check/checkmate; game-end must be judged post-downgrade.
    if (downgraded) {
      if (this.chess.isCheckmate()) note += "#";
      else if (this.chess.isCheck()) note += "+";
    }

    // every validation passed: commit the rook-charge bookkeeping.
    this.rookCharges = rookCharges;
    this.rookLocked = rookLocked;

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
    if (this.rookLocked.has(square)) return false;
    const piece = this.chess.get(square);
    return !!piece && piece.color === color && (piece.type === "n" || piece.type === "b");
  }
}
