import type { Color } from "chess.js";

/** Unicode piece glyphs for the promotion prompts, by color. */
export const PIECE_GLYPH: Record<Color, Record<"q" | "r" | "b" | "n", string>> = {
  w: { q: "♕", r: "♖", b: "♗", n: "♘" },
  b: { q: "♛", r: "♜", b: "♝", n: "♞" },
};
