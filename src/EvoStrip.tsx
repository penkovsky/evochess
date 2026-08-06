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
  return (
    <span className="evo-group">
      <span className="evo-dots" role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemax={max}>
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={`evo-dot ${kind} ${i < value ? "filled" : ""}`} />
        ))}
      </span>
      {/* Always rendered, blank at zero: the slot reserves its width so the
          dots don't shift sideways the moment a right is banked. */}
      <span
        className={`evo-banked${banked > 0 && unusable ? " unusable" : ""}`}
        title={
          banked > 0
            ? unusable
              ? "Banked, but no minor piece on the board can use it"
              : "Banked unused promotion rights"
            : undefined
        }
      >
        {banked > 0 ? `×${banked} ${bankedGlyph}` : ""}
      </span>
    </span>
  );
}
