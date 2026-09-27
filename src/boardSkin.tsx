import type { CSSProperties, SVGProps } from "react";
import type { Color } from "chess.js";
import { defaultPieces } from "react-chessboard";
import type { PieceRenderObject } from "react-chessboard";
import type { EvoChessGame, Rights } from "./evochess/game";

/**
 * The board skin. `BOARD_SKIN` is the only switch: set it to "classic" to get
 * the stock react-chessboard look back, pieces, squares and move markers all
 * at once.
 *
 * "evo" keeps the stock set, gives pawns and minors the battery (below), and
 * swaps two black pieces for traced outlines of the Unicode chess glyphs,
 * normalised into the same 45x45 box the stock pieces use and scaled to 90%:
 *
 *   N from Droid Sans Fallback, Apache 2.0
 *   Q from Symbola, released free of restrictions
 *
 * Both are filled flat black with no outline, the same deal the stock black
 * pieces have. Overlapping contours are merged before tracing, so each is one
 * silhouette with its counters cut out.
 *
 * The tutorial board does not use this.
 */
export type SkinName = "evo" | "classic";

export const BOARD_SKIN: SkinName = "evo";

const PIECE_FILL = "#000000";

const LIGHT_SQUARE = "#ebe7d2";
const DARK_SQUARE = "#7e9472";

/** Tuned for the moss squares: the stock black marker disappears on them. */
export const SQUARE_MARKER =
  BOARD_SKIN === "evo" ? "rgba(30, 40, 25, 0.45)" : "rgba(0, 0, 0, 0.35)";

const GLYPHS = {
  N: "M21.46 20.27Q20.98 23.62 17.79 24.73Q17.47 27.61 16.20 29.84H29.28Q28.16 27.77 28.16 26.01Q28.16 24.57 29.20 21.46Q30.24 18.35 30.24 16.76Q30.24 12.77 27.37 10.85Q26.09 12.13 24.18 12.45L24.02 11.65Q25.61 11.33 26.49 10.37Q27.37 9.42 27.37 8.46Q27.21 8.30 26.41 8.30Q25.77 8.30 25.13 8.46Q24.49 8.62 23.94 8.78Q23.38 8.94 21.70 9.10Q20.03 9.26 18.99 9.50Q17.95 9.74 17.00 10.14Q16.04 10.53 15.32 11.09Q14.60 11.65 13.96 12.29L13.01 13.57Q9.34 18.19 7.82 19.55Q6.31 20.90 6.31 21.86Q6.31 22.66 6.94 23.46L8.22 25.05Q8.86 25.85 9.50 26.25Q10.14 26.65 11.41 26.65Q12.53 26.65 12.85 26.17Q13.80 25.21 15.56 23.78Q20.03 23.78 20.67 20.27ZM14.76 30.96 14.60 31.59Q14.12 34.63 11.25 35.10V39.89H34.39V35.10Q31.20 34.63 30.88 31.59V30.96ZM30.56 29.68 33.43 28.56Q34.39 28.08 34.39 27.45Q34.39 27.13 33.51 25.77Q32.63 24.41 32.63 23.62Q32.63 22.98 33.11 22.02Q34.07 19.79 34.63 17.79Q35.18 15.80 35.18 14.20Q35.18 10.21 32.71 7.66Q30.24 5.11 26.41 5.11Q21.94 5.11 18.91 8.46Q20.19 8.14 23.22 8.14Q24.81 7.34 26.89 7.34Q28.00 7.34 28.32 7.50Q28.48 7.82 28.48 8.14Q28.48 9.26 27.84 10.21Q31.35 11.97 31.35 16.76Q31.35 18.35 30.32 21.38Q29.28 24.41 29.28 26.01Q29.28 27.61 30.56 29.68ZM18.43 13.88V14.52Q17.00 14.52 17.00 15.16V15.64Q17.00 16.60 16.04 16.60Q15.24 16.60 14.92 14.84Q16.52 13.88 18.43 13.88Z",
  Q: "M38.01 16.86Q38.01 15.78 37.24 15.01Q36.47 14.24 35.39 14.24Q34.31 14.24 33.54 15.01Q32.77 15.78 32.77 16.86Q32.77 17.60 33.16 18.23Q31.36 21.18 30.25 21.18Q29.85 21.18 29.54 20.88Q29.24 20.58 29.24 20.19Q29.24 18.39 30.61 13.64Q31.51 13.45 32.11 12.72Q32.71 11.99 32.71 11.07Q32.71 9.99 31.94 9.22Q31.17 8.45 30.09 8.45Q29.01 8.45 28.24 9.22Q27.47 9.99 27.47 11.07Q27.47 12.22 28.33 13.01Q26.58 19.23 25.35 19.23Q24.57 19.23 24.18 18.27Q23.72 17.15 23.72 13.01V11.99Q23.73 11.22 23.73 10.98Q25.12 10.23 25.12 8.67Q25.12 7.59 24.35 6.82Q23.58 6.05 22.50 6.05Q21.42 6.05 20.65 6.82Q19.88 7.59 19.88 8.67Q19.88 10.23 21.27 10.98Q21.27 11.22 21.28 11.99V13.01Q21.28 17.15 20.82 18.27Q20.43 19.23 19.65 19.23Q18.42 19.23 16.67 13.01Q17.53 12.22 17.53 11.07Q17.53 9.99 16.76 9.22Q15.99 8.45 14.91 8.45Q13.83 8.45 13.06 9.22Q12.29 9.99 12.29 11.07Q12.29 11.99 12.89 12.72Q13.49 13.45 14.39 13.64Q15.76 18.39 15.76 20.19Q15.76 20.58 15.46 20.88Q15.15 21.18 14.75 21.18Q13.64 21.18 11.84 18.23Q12.23 17.60 12.23 16.86Q12.23 15.78 11.46 15.01Q10.69 14.24 9.61 14.24Q8.53 14.24 7.76 15.01Q6.99 15.78 6.99 16.86Q6.99 17.94 7.76 18.71Q8.53 19.48 9.61 19.48Q9.63 19.48 9.83 19.47Q12.17 23.15 12.17 24.39Q12.17 24.88 11.46 25.83Q10.76 26.78 10.76 27.30Q10.76 28.16 11.67 29.20V29.97Q10.67 30.54 10.67 32.29Q10.67 34.81 12.59 34.81Q14.65 38.95 22.50 38.95Q30.35 38.95 32.41 34.81Q34.33 34.81 34.33 32.29Q34.33 30.54 33.33 29.97V29.20Q34.24 28.16 34.24 27.30Q34.24 26.78 33.54 25.83Q32.83 24.88 32.83 24.39Q32.83 23.15 35.17 19.47Q35.37 19.48 35.39 19.48Q36.47 19.48 37.24 18.71Q38.01 17.94 38.01 16.86ZM25.93 28.65 22.50 32.10 19.07 28.65 22.50 24.88ZM30.44 35.58Q29.82 36.21 29.04 36.66Q29.41 36.40 29.41 36.02Q29.41 35.06 26.46 34.55Q24.40 34.19 22.50 34.19Q20.60 34.19 18.54 34.55Q15.59 35.06 15.59 36.02Q15.59 36.40 15.96 36.66Q15.18 36.21 14.56 35.58Q14.99 34.14 18.01 33.50Q19.98 33.09 22.50 33.09Q25.02 33.09 26.99 33.50Q30.02 34.14 30.44 35.58ZM22.29 23.48 21.23 24.64Q16.96 25.12 12.77 28.91Q12.42 28.52 12.18 27.97Q17.17 23.56 22.29 23.48ZM32.82 27.97Q32.56 28.52 32.23 28.91Q28.10 25.14 23.77 24.64L22.71 23.48Q27.85 23.56 32.82 27.97ZM24.42 28.62 22.50 26.51 20.58 28.62 22.50 30.54ZM18.54 29.68Q16.45 30.49 14.32 31.89Q14.27 31.27 14.05 30.78Q15.90 29.58 17.68 28.84ZM30.95 30.78Q30.73 31.27 30.68 31.89Q28.55 30.49 26.46 29.68L27.32 28.84Q29.10 29.58 30.95 30.78ZM13.25 32.29Q13.25 33.71 12.51 33.71Q11.77 33.71 11.77 32.29Q11.77 30.86 12.51 30.86Q13.25 30.86 13.25 32.29ZM33.23 32.29Q33.23 33.71 32.49 33.71Q31.75 33.71 31.75 32.29Q31.75 30.86 32.49 30.86Q33.23 30.86 33.23 32.29ZM10.59 16.86Q10.59 17.84 9.61 17.84Q8.63 17.84 8.63 16.86Q8.63 15.88 9.61 15.88Q10.59 15.88 10.59 16.86ZM36.37 16.86Q36.37 17.84 35.39 17.84Q34.41 17.84 34.41 16.86Q34.41 15.88 35.39 15.88Q36.37 15.88 36.37 16.86ZM15.88 11.07Q15.88 12.05 14.91 12.05Q13.93 12.05 13.93 11.07Q13.93 10.09 14.91 10.09Q15.88 10.09 15.88 11.07ZM31.07 11.07Q31.07 12.05 30.09 12.05Q29.12 12.05 29.12 11.07Q29.12 10.09 30.09 10.09Q31.07 10.09 31.07 11.07ZM23.48 8.67Q23.48 9.65 22.50 9.65Q21.52 9.65 21.52 8.67Q21.52 7.69 22.50 7.69Q23.48 7.69 23.48 8.67Z",
};

function glyph(d: string) {
  return () => (
    <svg viewBox="0 0 45 45" width="100%" height="100%">
      <path d={d} fill={PIECE_FILL} />
    </svg>
  );
}

/**
 * The battery: pawns and minors drawn twice, drained over charged, the solid copy
 * clipped to the side's progress toward its next promotion. Only body parts
 * take the drained colour, so ink stays crisp. Levels come from `--evo-p-*`/`--evo-m-*`
 * on `.board-container`.
 */
type Part = { d: string; ink?: string; a?: SVGProps<SVGPathElement> };

const EMPTY_W = "#f2c14e";
const EMPTY_OPACITY_W = 0.75;
const EMPTY_B = "#3b5f8a";

/** Dead battery: the marker on a minor that can never be a rook again. */
const DEAD_BOLT = "M9.5 0.8 L3 8.8 H7.2 L6.3 15.2 L13 7.2 H8.6 Z";

const BODY_STROKE = {
  stroke: "#000000",
  strokeWidth: 1.5,
  strokeLinejoin: "round",
  strokeLinecap: "round",
} as const;

const PAWN: Part[] = [
  { d: "m 22.5,9 c -2.21,0 -4,1.79 -4,4 0,0.89 0.29,1.71 0.78,2.38 C 17.33,16.5 16,18.59 16,21 c 0,2.03 0.94,3.84 2.41,5.03 C 15.41,27.09 11,31.58 11,39.5 H 34 C 34,31.58 29.59,27.09 26.59,26.03 28.06,24.84 29,23.03 29,21 29,18.59 27.67,16.5 25.72,15.38 26.21,14.71 26.5,13.89 26.5,13 c 0,-2.21 -1.79,-4 -4,-4 z" },
];

const KNIGHT_W: Part[] = [
  { d: "M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18" },
  { d: "M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10" },
  { d: "M 9.5 25.5 A 0.5 0.5 0 1 1 8.5,25.5 A 0.5 0.5 0 1 1 9.5 25.5 z", ink: "#000000" },
  { d: "M 15 15.5 A 0.5 1.5 0 1 1  14,15.5 A 0.5 1.5 0 1 1  15 15.5 z", ink: "#000000",
    a: { transform: "matrix(0.866,0.5,-0.5,0.866,9.693,-5.173)" } },
];

const BISHOP_BODY: Part[] = [
  { d: "M 9,36 C 12.39,35.03 19.11,36.43 22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.65,38.99 6.68,38.97 6,38 C 7.35,36.54 9,36 9,36 z" },
  { d: "M 15,32 C 17.5,34.5 27.5,34.5 30,32 C 30.5,30.5 30,30 30,30 C 30,27.5 27.5,26 27.5,26 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 12,24.5 17.5,26 C 17.5,26 15,27.5 15,30 C 15,30 14.5,30.5 15,32 z" },
  { d: "M 25 8 A 2.5 2.5 0 1 1  20,8 A 2.5 2.5 0 1 1  25 8 z" },
];
const bishop = (ink: string): Part[] => [
  ...BISHOP_BODY,
  { d: "M 17.5,26 L 27.5,26 M 15,30 L 30,30 M 22.5,15.5 L 22.5,20.5 M 20,18 L 25,18",
    ink, a: { fill: "none", strokeLinejoin: "miter" } },
];

function layer(parts: Part[], fill: string, cls: string, flat: boolean, opacity?: number) {
  return (
    <svg className={cls} viewBox="0 0 45 45" width="100%" height="100%">
      {parts.map((p, i) =>
        p.ink ? (
          <path key={i} d={p.d} fill={p.ink} stroke={p.ink} strokeWidth={1.5} strokeLinecap="round" {...p.a} />
        ) : (
          <path key={i} d={p.d} fill={fill} fillOpacity={opacity} {...(flat ? {} : BODY_STROKE)} {...p.a} />
        ),
      )}
    </svg>
  );
}

/** Locked squares. On the piece, not the square: the drag clone renders
 *  outside the grid. */
let lockedSquares: ReadonlySet<string> = new Set();

/** Battery level per progress count. */
const FILL = [1 / 3, 2 / 3, 1];

/** What `.board-container` needs for the batteries. Banked reads full; the count
 *  is the strip's job. */
export function batteryProps(game: EvoChessGame, rights: Record<Color, Rights>) {
  lockedSquares = game.rookLocked;
  const level = (progress: number, banked: number) => (banked > 0 ? 1 : FILL[progress]);
  return {
    style: {
      "--evo-p-w": level(game.pawnMoveProgress.w, rights.w.minor),
      "--evo-p-b": level(game.pawnMoveProgress.b, rights.b.minor),
      "--evo-m-w": level(game.minorMoveProgress.w, rights.w.rook),
      "--evo-m-b": level(game.minorMoveProgress.b, rights.b.rook),
    } as CSSProperties,
    aura:
      (rights.w.minor > 0 ? " evo-aura-p-w" : "") +
      (rights.b.minor > 0 ? " evo-aura-p-b" : "") +
      (rights.w.rook > 0 ? " evo-aura-m-w" : "") +
      (rights.b.rook > 0 ? " evo-aura-m-b" : ""),
  };
}

function battery(parts: Part[], kind: "pawn" | "knight" | "bishop", color: "w" | "b") {
  // The evo black knight is a silhouette: no stroke.
  const flat = color === "b" && kind === "knight";
  const solid = color === "w" ? "#ffffff" : PIECE_FILL;
  const empty = color === "w" ? EMPTY_W : EMPTY_B;
  const opacity = color === "w" ? EMPTY_OPACITY_W : undefined;
  const cls = `evo-battery evo-${kind} ${color === "w" ? "evo-white" : "evo-black"}`;
  return (props?: { square?: string }) => {
    const locked = !!props?.square && lockedSquares.has(props.square);
    return (
      <div className={locked ? `${cls} evo-locked-piece` : cls}>
        {layer(parts, empty, "evo-empty", flat, opacity)}
        {layer(parts, solid, "evo-full", flat)}
        {locked && (
          <svg className="evo-dead" viewBox="0 0 16 16">
            <path d={DEAD_BOLT} />
          </svg>
        )}
      </div>
    );
  };
}

const evoPieces: PieceRenderObject = {
  ...defaultPieces,
  bQ: glyph(GLYPHS.Q),
  wP: battery(PAWN, "pawn", "w"),
  bP: battery(PAWN, "pawn", "b"),
  wN: battery(KNIGHT_W, "knight", "w"),
  bN: battery([{ d: GLYPHS.N }], "knight", "b"),
  wB: battery(bishop("#000000"), "bishop", "w"),
  bB: battery(bishop("#ffffff"), "bishop", "b"),
};

const evoSkin = {
  pieces: evoPieces,
  lightSquareStyle: { backgroundColor: LIGHT_SQUARE },
  darkSquareStyle: { backgroundColor: DARK_SQUARE },
  lightSquareNotationStyle: { color: "#9a9578" },
  darkSquareNotationStyle: { color: "#3f5136" },
};

/** Spread into the Chessboard `options`. Empty object means stock. */
export const boardSkin = BOARD_SKIN === "evo" ? evoSkin : {};
