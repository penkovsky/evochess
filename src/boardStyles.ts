import type { CSSProperties } from "react";
import type { Square } from "chess.js";
import type { EvoChessGame } from "./evochess/game";
import { SQUARE_MARKER } from "./boardSkin";

const SELECTED = "rgba(255, 255, 0, 0.4)";
// A ring for a capture, a dot for a quiet move. The two read differently at a
// glance on a phone, which is the whole reason they differ.
const CAPTURE = `radial-gradient(circle, transparent 55%, ${SQUARE_MARKER} 55%)`;
const QUIET = `radial-gradient(circle, ${SQUARE_MARKER} 19%, transparent 20%)`;

/**
 * Click-to-move highlighting: the selected square, plus a marker on every
 * square it can legally reach. Empty when nothing is selected, which is also
 * what a drag-only interaction sees.
 */
export function buildSquareStyles(game: EvoChessGame, selected: Square | null): Record<string, CSSProperties> {
  const styles: Record<string, CSSProperties> = {};
  if (!selected) return styles;
  styles[selected] = { background: SELECTED };
  for (const m of game.legalMoves()) {
    if (m.from !== selected) continue;
    styles[m.to] = { background: m.isCapture ? CAPTURE : QUIET };
  }
  return styles;
}
