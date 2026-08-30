/**
 * Per-ply static eval and search score from two nets, for a recorded game.
 *
 * Static wrong but search right is a horizon problem. Both wrong is the
 * evaluator.
 *
 * Values are White-positive, so the two nets are comparable on one row. The
 * engine's scores are side-to-move relative; the flip happens here, once.
 *
 *   npx esbuild training/annotate_game.ts --bundle --platform=node --format=esm \
 *     --outfile=training/annotate_game.bundle.mjs
 *   node training/annotate_game.bundle.mjs --log data/games/game2.txt \
 *     --white public/net-r3-weights.json \
 *     --black public/net-relab4-d5-weights.json \
 *     --out data/games/game2-annotated.tsv
 */
import { readFileSync, writeFileSync } from "node:fs";
import { EvoChessGame } from "../src/evochess/game";
import { legalTurns, searchRootTimed } from "../src/evochess/ai";
import { loadWeights, setNnueWeights, evaluateNNUE, type NnueWeights } from "../src/evochess/nnue";

// Pawn units: searchRootTimed divides MATE by 100, so a mate is 999.9x.
const MATE_THRESHOLD = 990;

interface Net {
  label: string;
  weights: NnueWeights;
}

function parseMoveLog(text: string): string[] {
  const moves: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim(); // "#" is mate inside a move, so only a whole line comments
    if (!line || line.startsWith("#")) continue;
    for (const word of line.split(/\s+/)) {
      if (/^\d+\.+$/.test(word)) continue;
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(word)) continue;
      const move = word.replace(/^\d+\.+/, "");
      if (move) moves.push(move);
    }
  }
  return moves;
}

/** Play `written` by matching it against every legal turn's own notation. */
function playWritten(game: EvoChessGame, written: string): string | null {
  const wanted = written.replace(/[!?]+$/, "");
  for (const turn of legalTurns(game)) {
    const probe = game.copy();
    let note: string;
    try {
      note = probe.applyMove(turn.from, turn.to, turn.options);
    } catch {
      continue;
    }
    if (note === wanted) {
      game.applyMove(turn.from, turn.to, turn.options);
      return note;
    }
  }
  return null;
}

const fmt = (score: number): string =>
  Math.abs(score) >= MATE_THRESHOLD ? (score > 0 ? "+M" : "-M") : score.toFixed(2);

function assess(game: EvoChessGame, net: Net, timeMs: number, ply: number) {
  setNnueWeights(net.weights);
  const sign = game.turn === "w" ? 1 : -1;
  const stat = sign * evaluateNNUE(game);
  const { score, depth } = searchRootTimed(game, timeMs, ply);
  return { stat, search: sign * score, depth };
}

function main(): void {
  const argv = process.argv.slice(2);
  let logPath = "";
  let whitePath = "";
  let blackPath = "";
  let out = "";
  let timeMs = 400;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--log") logPath = argv[++i];
    else if (argv[i] === "--white") whitePath = argv[++i];
    else if (argv[i] === "--black") blackPath = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--time") timeMs = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!logPath || !whitePath || !blackPath) {
    throw new Error("need --log, --white and --black");
  }

  const load = (p: string): Net => ({
    label: (p.split("/").pop() ?? p).replace(/(-weights)?\.json$/, ""),
    weights: loadWeights(JSON.parse(readFileSync(p, "utf8"))),
  });
  const white = load(whitePath);
  const black = load(blackPath);

  const moves = parseMoveLog(readFileSync(logPath, "utf8"));
  const game = new EvoChessGame();
  const rows: string[] = [];
  const header = [
    "ply",
    "move",
    "san",
    "onMove",
    `${white.label}.static`,
    `${white.label}.search`,
    `${white.label}.depth`,
    `${black.label}.static`,
    `${black.label}.search`,
    `${black.label}.depth`,
  ];
  rows.push(header.join("\t"));

  for (let ply = 0; ply <= moves.length; ply++) {
    const onMove = game.turn;
    const w = assess(game, white, timeMs, ply);
    const b = assess(game, black, timeMs, ply);
    const san = ply < moves.length ? moves[ply] : "";
    rows.push(
      [
        ply,
        Math.floor(ply / 2) + 1,
        san,
        onMove,
        fmt(w.stat),
        fmt(w.search),
        w.depth,
        fmt(b.stat),
        fmt(b.search),
        b.depth,
      ].join("\t")
    );
    if (ply === moves.length) break;
    if (playWritten(game, moves[ply]) === null) {
      throw new Error(`no legal turn matches "${moves[ply]}" at ply ${ply}`);
    }
  }

  const text = rows.join("\n") + "\n";
  if (out) {
    writeFileSync(out, text);
    console.log(`${moves.length} plies -> ${out}`);
  } else {
    console.log(text);
  }
}

main();
