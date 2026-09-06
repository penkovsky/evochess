import type { CSSProperties } from "react";
import type { Burn } from "../evochess/burn";

/**
 * A blaze riding the piece to its square, and the streak behind it. Board
 * percentages throughout, so a resize needs no measurement.
 */

/** Board percentages of a square's centre. */
function centre(square: string, flipped: boolean) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const x = flipped ? 7 - file : file;
  const y = flipped ? rank : 7 - rank;
  return { x: (x + 0.5) * 12.5, y: (y + 0.5) * 12.5 };
}

export default function BurnTrail({
  burn,
  orientation,
  onDone,
}: {
  burn: Burn;
  orientation: "white" | "black";
  onDone: () => void;
}) {
  const flipped = orientation === "black";
  const a = centre(burn.from, flipped);
  const b = centre(burn.to, flipped);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const vars = {
    "--burn-ax": `${a.x}%`,
    "--burn-ay": `${a.y}%`,
    "--burn-bx": `${b.x}%`,
    "--burn-by": `${b.y}%`,
    // The board is square, so one axis serves both.
    "--burn-len": `${Math.hypot(dx, dy)}%`,
    "--burn-angle": `${(Math.atan2(dy, dx) * 180) / Math.PI}deg`,
  } as CSSProperties;

  return (
    // Keyed, so a second burn remounts rather than finishing the first's flight.
    <div key={burn.id} className="burn" style={vars} aria-hidden="true">
      {/* Outlasts the flames, so it ends the effect. */}
      <div className="burn-streak" onAnimationEnd={onDone} />
      <div className="burn-glow" />
      <div className="burn-flame" />
    </div>
  );
}
