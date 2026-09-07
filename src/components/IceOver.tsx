import type { CSSProperties } from "react";
import type { Freeze } from "../evochess/freeze";

/**
 * Ice closing over the square a rook downgraded on. Board percentages
 * throughout, so a resize needs no measurement. Crystals are seeded from the
 * square and revealed outside in, so the frost grows.
 */

/** mulberry32, seeded from the square: same frost every time. */
function rng(square: string): () => number {
  let a = (square.charCodeAt(0) * 131 + square.charCodeAt(1) * 17 + 0x9e37) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Board percentages of a square's top-left corner. */
function corner(square: string, flipped: boolean) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const x = flipped ? 7 - file : file;
  const y = flipped ? rank : 7 - rank;
  return { x: x * 12.5, y: y * 12.5 };
}

export default function IceOver({
  freeze,
  orientation,
  onDone,
}: {
  freeze: Freeze;
  orientation: "white" | "black";
  onDone: () => void;
}) {
  const { x, y } = corner(freeze.square, orientation === "black");
  const rand = rng(freeze.square);
  const vars = {
    "--ice-x": `${x}%`,
    "--ice-y": `${y}%`,
  } as CSSProperties;

  // Offsets in fractions of a square, so it scales with the board.
  const crystals = Array.from({ length: 5 }, () => {
    const px = (rand() - 0.5) * 0.86;
    const py = (rand() - 0.5) * 0.86;
    const d = 3.2 + rand() * 4.6;
    // Furthest from the middle freezes first.
    const delay = (1 - Math.min(1, Math.hypot(px, py) / 0.6)) * 400;
    return { px, py, d, delay };
  });
  const cracks = Array.from({ length: 4 }, () => ({
    angle: rand() * 360,
    reach: 3.4 + rand() * 2.6,
  }));
  const vapour = Array.from({ length: 3 }, () => ({
    px: (rand() - 0.5) * 1.1,
    d: 2.6 + rand() * 3,
    delay: 120 + rand() * 380,
  }));

  return (
    // Keyed: a second freeze remounts instead of joining the first's melt.
    <div key={freeze.id} className="ice" style={vars} aria-hidden="true">
      {/* Longest animation, so it ends the effect. */}
      <div className="ice-slab" onAnimationEnd={onDone} />
      {crystals.map((c, i) => (
        <div
          key={`c${i}`}
          className="ice-crystal"
          style={{
            // Centre on the offset; the rule above places the corner.
            marginLeft: `${6.25 + c.px * 12.5 - c.d / 2}%`,
            marginTop: `${6.25 + c.py * 12.5 - c.d / 2}%`,
            width: `${c.d}%`,
            height: `${c.d}%`,
            animationDelay: `${c.delay}ms`,
          }}
        />
      ))}
      {cracks.map((c, i) => (
        <div
          key={`k${i}`}
          className="ice-crack"
          style={{ width: `${c.reach}%`, transform: `rotate(${c.angle}deg)` }}
        />
      ))}
      {vapour.map((v, i) => (
        <div
          key={`v${i}`}
          className="ice-vapour"
          style={{
            marginLeft: `${6.25 + v.px * 12.5 - v.d / 2}%`,
            width: `${v.d}%`,
            height: `${v.d}%`,
            animationDelay: `${v.delay}ms`,
          }}
        />
      ))}
    </div>
  );
}
