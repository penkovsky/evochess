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

/**
 * An en passant opportunity that chess.js cannot represent: the pawn that
 * double-moved evolved into a minor piece at the end of that move, so the
 * capture's victim is no longer a pawn.
 *
 * chess.js's en-passant *undo* hardcodes restoring a PAWN on the victim
 * square, so leaving chess.js's own `_epSquare` pointing at an evolved piece
 * corrupts the board: every legality trial inside `fen()`/`moves()` makes and
 * unmakes the capture and stamps a pawn over the minor piece. We therefore let
 * chess.js forget the en passant entirely (its `put()` clears `_epSquare` as a
 * side effect of the evolution) and track the opportunity here instead, per
 * rules.txt: "the right to capture en passant is created by the Pawn move".
 */
/** A legal base move, as reported by `EvoChessGame.legalMoves()`. */
export interface EvoMove {
  from: Square;
  to: Square;
  piece: PieceSymbol;
  isCapture: boolean;
  /** Type of the piece captured, if any (for the evolved en passant, the evolved piece). */
  captured?: PieceSymbol;
  /** True for the en passant capture of an evolved pawn (see `EvolvedEnPassant`). */
  evolvedEp: boolean;
}

export interface EvolvedEnPassant {
  /** The skipped square the capturing pawn moves to (e.g. h6). */
  skipped: Square;
  /** Where the evolved piece stands and is captured from (e.g. h5). */
  victim: Square;
  /** Colour of the side that made the double move — i.e. the victim's owner. */
  color: Color;
  /** chess.js's internal 0x88 index for `skipped`, reused when applying. */
  index: number;
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
  // Set for exactly one ply, when a double pawn move's pawn evolved on the
  // same move. Null whenever chess.js's own en-passant handling suffices.
  epEvolved: EvolvedEnPassant | null;

  constructor() {
    this.chess = new Chess(START_FEN);
    this.minorRights = { w: 0, b: 0 };
    this.rookRights = { w: 0, b: 0 };
    this.pawnMoveProgress = { w: 0, b: 0 };
    this.minorMoveProgress = { w: 0, b: 0 };
    this.moveLog = [];
    this.rookCharges = new Map();
    this.rookLocked = new Set();
    this.epEvolved = null;
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
    g.epEvolved = this.epEvolved ? { ...this.epEvolved } : null;
    return g;
  }

  get turn(): Color {
    return this.chess.turn();
  }

  rightsFor(color: Color): Rights {
    return { minor: this.minorRights[color], rook: this.rookRights[color] };
  }

  isGameOver(): boolean {
    if (this.chess.isCheckmate() || this.chess.isStalemate()) return true;
    if (this.chess.isInsufficientMaterial()) return !this.hasPromotableMinor();
    return this.chess.isDrawByFiftyMoves() || this.chess.isThreefoldRepetition();
  }

  /**
   * Whether any minor piece on the board is still eligible to one day become
   * a Rook (i.e. not permanently barred by a prior rook->minor downgrade).
   * A lone minor piece isn't literal insufficient material yet, but it could
   * still accumulate moves and promote, so the game shouldn't be declared
   * drawn until every minor piece is locked out of that path.
   */
  private hasPromotableMinor(): boolean {
    for (const row of this.chess.board()) {
      for (const sq of row) {
        if (!sq) continue;
        if ((sq.type === "n" || sq.type === "b") && !this.rookLocked.has(sq.square)) {
          return true;
        }
      }
    }
    return false;
  }

  resultString(): string {
    if (this.chess.isCheckmate()) {
      const winner = this.chess.turn() === "w" ? "Black" : "White";
      return `Checkmate - ${winner} wins`;
    }
    if (this.chess.isStalemate()) return "Stalemate - draw";
    if (this.chess.isInsufficientMaterial() && !this.hasPromotableMinor()) {
      return "Draw - insufficient material";
    }
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

    // `_epSquare`/`_hash`/`_epKey()` are underscore-prefixed by convention but
    // not truly private, and have no public equivalent. See `EvolvedEnPassant`
    // for why we touch them at all, and `applyEvolvedEnPassant` for the one
    // place we write `_epSquare` — both are exercised by the en passant tests
    // in game.test.ts, which would catch a chess.js upgrade breaking this.
    const chessInternal = this.chess as unknown as {
      _epSquare: number;
      _hash: bigint;
      _epKey(): bigint;
    };

    // An en passant opportunity created by an *evolved* pawn lives in
    // `epEvolved` rather than in chess.js, so chess.js will refuse the capture
    // as illegal. Recognise it here and apply it ourselves.
    const evolvedEp = this.matchEvolvedEnPassant(from, to, piece.type, piece.color);

    let moveResult;
    try {
      moveResult = evolvedEp
        ? this.applyEvolvedEnPassant(evolvedEp, from, to, chessInternal)
        : this.chess.move(reachesLastRank ? { from, to, promotion: forcedPromo } : { from, to });
    } catch (e) {
      if (e instanceof EvoChessError) throw e;
      throw new EvoChessError(`Illegal move: ${from}${to}`);
    }

    let note = moveResult.san;

    // A pawn's first (double) move creates a one-ply en passant opportunity,
    // which chess.js tracks via `_epSquare`. If this same move also evolves
    // the pawn (minorPromo), the chess.remove()/chess.put() calls that apply
    // the evolution make chess.js think the pawn simply vanished, and it
    // clears `_epSquare` as a side effect. Per the rules an evolution resolves
    // at the end of the move and must not retroactively erase an en passant
    // right the move itself created, so snapshot the index now and re-express
    // the opportunity as `epEvolved` below — restoring `_epSquare` instead
    // would corrupt the board (see `EvolvedEnPassant`).
    const epSquareAfterBaseMove = moveResult.flags.includes("b") ? chessInternal._epSquare : null;

    // -- rook-charge bookkeeping: key follows the piece, drop on capture --
    // Mutated on working copies and only committed to `this` once the whole
    // turn validates, so a rejected move (chess.undo()) leaves rookCharges/
    // rookLocked untouched, matching the reverted position.
    const rookCharges = new Map(this.rookCharges);
    const rookLocked = new Set(this.rookLocked);
    // The evolutionary counters/rights are staged the same way and for the
    // same reason: the validation gates below can still reject this turn after
    // the counters would have advanced, and chess.undo() only reverts the
    // board. Committing them early let a rejected move bank counter progress.
    const pawnMoveProgress = { ...this.pawnMoveProgress };
    const minorMoveProgress = { ...this.minorMoveProgress };
    const minorRights = { ...this.minorRights };
    const rookRights = { ...this.rookRights };
    // An en passant right lasts exactly one ply, so it defaults to cleared and
    // is only re-armed below if *this* move is an evolving double pawn move.
    let epEvolvedNext: EvolvedEnPassant | null = null;
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
    // A right earned by this very move may be spent on this same move (see the
    // `a4=B` example in rules.txt), so the counters advance before the
    // promotion gates below read them.
    if (isPawnMove) {
      pawnMoveProgress[color] += 1;
      if (pawnMoveProgress[color] >= N_MINOR) {
        pawnMoveProgress[color] -= N_MINOR;
        minorRights[color] += 1;
      }
    }
    if (isMinorMove) {
      minorMoveProgress[color] += 1;
      if (minorMoveProgress[color] >= M_ROOK) {
        minorMoveProgress[color] -= M_ROOK;
        rookRights[color] += 1;
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
        if (minorRights[color] <= 0) {
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
        if (epSquareAfterBaseMove !== null) {
          // put() has just cleared chess.js's `_epSquare`; leave it cleared
          // (a lying `_epSquare` corrupts the board) and record the
          // opportunity ourselves. The skipped square is the one behind the
          // pawn's destination, from the mover's point of view.
          const skippedRank = color === "w" ? Number(to[1]) - 1 : Number(to[1]) + 1;
          epEvolvedNext = {
            skipped: `${to[0]}${skippedRank}` as Square,
            victim: to,
            color,
            index: epSquareAfterBaseMove,
          };
        }
        minorRights[color] -= 1;
        note = note.replace(/[+#]$/, "") + `=${minorPromo.toUpperCase()}`;
      } else if (rookPromo) {
        if (rookRights[color] <= 0) {
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
        rookRights[color] -= 1;
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

    // every validation passed: commit the staged bookkeeping.
    this.rookCharges = rookCharges;
    this.rookLocked = rookLocked;
    this.pawnMoveProgress = pawnMoveProgress;
    this.minorMoveProgress = minorMoveProgress;
    this.minorRights = minorRights;
    this.rookRights = rookRights;
    this.epEvolved = epEvolvedNext;

    this.moveLog.push(note);
    return note;
  }

  /**
   * Whether `from`->`to` is the en passant capture of an evolved pawn (which
   * chess.js cannot represent, so it must be applied by hand). Returns the
   * opportunity being taken, or null.
   */
  private matchEvolvedEnPassant(
    from: Square,
    to: Square,
    pieceType: PieceSymbol,
    pieceColor: Color
  ): EvolvedEnPassant | null {
    const ep = this.epEvolved;
    if (!ep) return null;
    // Only an enemy pawn, moving onto the skipped square, from a square
    // directly beside the victim, can take it.
    if (pieceType !== "p" || pieceColor === ep.color) return null;
    if (to !== ep.skipped) return null;
    if (from[1] !== ep.victim[1]) return null;
    if (Math.abs(from.charCodeAt(0) - ep.victim.charCodeAt(0)) !== 1) return null;
    return ep;
  }

  /**
   * Apply the en passant capture of an evolved pawn.
   *
   * chess.js would reject this outright: it cleared its own `_epSquare` when
   * the evolution ran, and its en-passant code assumes the victim is a pawn.
   * So we momentarily put a pawn back on the victim square and hand chess.js
   * the en passant it understands. That is safe precisely because the victim
   * is removed by this very move — the board chess.js sees is truthful for the
   * instant it exists, so a legality trial that makes and unmakes the capture
   * restores the same pawn it just removed. Contrast the old approach of
   * leaving `_epSquare` set across plies while a *minor piece* stood on the
   * victim square, where those same trials silently rewrote the minor into a
   * pawn (see `EvolvedEnPassant`).
   *
   * Using chess.js's own `move()` keeps its history, turn and clocks intact,
   * which hand-rolling the capture via load()/put() would not.
   */
  private applyEvolvedEnPassant(
    ep: EvolvedEnPassant,
    from: Square,
    to: Square,
    chessInternal: { _epSquare: number; _hash: bigint; _epKey(): bigint }
  ): ReturnType<Chess["move"]> {
    const victimPiece = this.chess.get(ep.victim);
    if (!victimPiece) throw new EvoChessError("En passant victim has vanished.");

    this.chess.remove(ep.victim);
    this.chess.put({ type: "p", color: ep.color }, ep.victim);
    chessInternal._epSquare = ep.index;
    chessInternal._hash ^= chessInternal._epKey();

    try {
      return this.chess.move({ from, to });
    } catch {
      // Restore the evolved piece so a rejected move leaves no trace.
      this.chess.remove(ep.victim);
      this.chess.put(victimPiece, ep.victim);
      throw new EvoChessError(`Illegal move: ${from}${to}`);
    }
  }

  /**
   * Every legal EvoChess base move: chess.js's own moves, plus any en passant
   * capture of an evolved pawn that chess.js cannot see. Callers that
   * enumerate moves must use this rather than `chess.moves()`, or they will
   * miss the evolved en passant.
   */
  legalMoves(): EvoMove[] {
    const moves: EvoMove[] = this.chess.moves({ verbose: true }).map((m) => ({
      from: m.from as Square,
      to: m.to as Square,
      piece: m.piece,
      isCapture: m.flags.includes("c") || m.flags.includes("e"),
      captured: m.captured,
      evolvedEp: false,
    }));

    const ep = this.epEvolved;
    if (ep) {
      const victimPiece = this.chess.get(ep.victim);
      const capturer: Color = ep.color === "w" ? "b" : "w";
      if (victimPiece && this.chess.turn() === capturer) {
        const victimFile = ep.victim.charCodeAt(0);
        for (const file of [victimFile - 1, victimFile + 1]) {
          if (file < 97 || file > 104) continue;
          const from = `${String.fromCharCode(file)}${ep.victim[1]}` as Square;
          const cand = this.chess.get(from);
          if (!cand || cand.type !== "p" || cand.color !== capturer) continue;
          // Legality (does it leave our own king in check?) is decided by
          // actually playing it on a copy, so chess.js stays the authority.
          const probe = this.copy();
          try {
            probe.applyMove(from, ep.skipped);
          } catch {
            continue;
          }
          moves.push({
            from,
            to: ep.skipped,
            piece: "p",
            isCapture: true,
            captured: victimPiece.type,
            evolvedEp: true,
          });
        }
      }
    }
    return moves;
  }

  // -- helpers for candidate generation (used by the AI / UI) ----------

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
