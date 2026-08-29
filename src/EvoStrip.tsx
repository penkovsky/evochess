import type { Color } from "chess.js";
import { EvoChessGame, N_MINOR, M_ROOK } from "./evochess/game";

// One compact line of evolution progress, sitting directly above or below the
// board on that color's side. Which side a strip is on identifies its color, so
// it carries no title — only dots and the banked-rights badges.
// Shared by the game (App.tsx) and the tutorial, which teaches these dots.
export function EvoStrip({
  color,
  game,
  rights,
  active,
}: {
  color: Color;
  game: EvoChessGame;
  rights: { minor: number; rook: number };
  active: boolean;
}) {
  const side = color === "w" ? "White" : "Black";
  return (
    <div className={`evo-strip ${active ? "active" : ""}`}>
      <EvoDots
        kind="minor"
        value={game.pawnMoveProgress[color]}
        max={N_MINOR}
        banked={rights.minor}
        bankedGlyph={color === "w" ? "♘/♗" : "♞/♝"}
        label={`${side} pawn moves toward a minor promotion`}
      />
      <EvoDots
        kind="rook"
        value={game.minorMoveProgress[color]}
        max={M_ROOK}
        banked={rights.rook}
        bankedGlyph={color === "w" ? "♖" : "♜"}
        label={`${side} minor moves toward a rook promotion`}
        // Rook rights keep accruing even when every minor of this color came
        // from a spent rook, and those can never be promoted again. Without
        // this the strip advertises a right nothing on the board can use.
        unusable={!game.hasPromotableMinor(color)}
      />
    </div>
  );
}

function EvoDots({
  kind,
  value,
  max,
  banked,
  bankedGlyph,
  label,
  unusable = false,
}: {
  kind: "minor" | "rook";
  value: number;
  max: number;
  banked: number;
  bankedGlyph: string;
  label: string;
  /** Whether a banked right has no piece on the board that could spend it. */
  unusable?: boolean;
}) {
  // The game resets progress to 0 on the very move that banks a right, so drawn
  // straight the dots empty on the move that earned something and the last dot
  // is never seen filled. Show the pair one step behind: (banked, 0) borrows the
  // right back as a full group of dots, so with N_MINOR=3 counter 3 reads three
  // dots and no badge, 4 reads ×1 and one dot, 6 reads ×1 and three dots. A
  // shift of the (banked, value) pair rather than a running total, so it
  // survives a right being spent. Display only.
  const lag = value === 0 && banked > 0;
  const dots = lag ? max : value;
  const badge = lag ? banked - 1 : banked;
  return (
    <span className="evo-group">
      <span className="evo-dots" role="progressbar" aria-label={label} aria-valuenow={dots} aria-valuemax={max}>
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={`evo-dot ${kind} ${i < dots ? "filled" : ""}`} />
        ))}
      </span>
      {/* Always rendered, blank at zero: the slot reserves its width so the
          dots don't shift sideways the moment a right is banked. */}
      <span
        className={`evo-banked${badge > 0 && unusable ? " unusable" : ""}`}
        title={
          badge > 0
            ? unusable
              ? "Banked, but no minor piece on the board can use it"
              : "Banked unused promotion rights"
            : undefined
        }
      >
        {badge > 0 ? `×${badge} ${bankedGlyph}` : ""}
      </span>
    </span>
  );
}
