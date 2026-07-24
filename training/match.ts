/**
 * Equal-time strength match: a challenger NNUE net vs either the hand-crafted
 * material+PST evaluation or a second NNUE checkpoint (milestone 6 — the real
 * ship gate).
 *
 *   python -m nnue.export                       # writes net-weights.json
 *   npx esbuild training/match.ts --bundle --platform=node --format=esm \
 *       --outfile=training/match.bundle.mjs
 *   node training/match.bundle.mjs --games 40 --time 200
 *   node training/match.bundle.mjs --games 40 --time 200 \
 *       --opponent-weights training/checkpoints/net-weights.json
 *
 * The measurement that counts is equal *time*, not equal depth: the net costs
 * more per node, so at a fixed time budget it searches shallower and must earn
 * that back with a better evaluation. Both sides share one search; only the
 * leaf evaluation differs, toggled per move via the module-level weights in
 * nnue.ts (the search is synchronous, so a toggle before each root move governs
 * that whole subtree).
 *
 * Ship only if the challenger clearly wins. A ~40-game sample has wide error
 * bars — treat anything under ~+100 Elo as unproven and run more games.
 *
 * `--backend` (default `engineConfig`'s, now "bitboard") picks the search both
 * sides run on. It is part of the result, not a detail: a faster backend
 * reaches greater depth in the same budget, so Elo measured on one backend is
 * not comparable with Elo measured on the other. Every figure recorded in
 * docs/ before this default changed was measured on "chessjs"; re-baseline
 * rather than comparing across the two.
 */
import { readFileSync } from "node:fs";
import type { Color } from "chess.js";
import { EvoChessGame } from "../src/evochess/game";
import { engineConfig, legalTurns, material, searchRootTimed, type CandidateTurn, type EngineBackend } from "../src/evochess/ai";
import { loadWeights, setNnueWeights, type NnueWeights } from "../src/evochess/nnue";

type Player = "challenger" | "opponent";

interface Config {
  games: number;
  timeMs: number;
  cap: number;
  capMargin: number;
  openingPlies: number;
  seed: number;
  weightsPath: string;
  opponentWeightsPath: string | null;
  backend: EngineBackend;
}

const DEFAULTS: Config = {
  games: 40,
  timeMs: 200,
  cap: 200,
  capMargin: 1.5,
  openingPlies: 4,
  seed: 1,
  weightsPath: "training/checkpoints/net-weights.json",
  opponentWeightsPath: null,
  backend: engineConfig.backend,
};

/** Strips directory and `.json` so a path becomes a short match-log label. */
function labelFor(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.endsWith(".json") ? base.slice(0, -".json".length) : base;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** White-positive result in {0, 0.5, 1} for a finished or capped game. */
function outcome(game: EvoChessGame, cap: number, capMargin: number, ply: number): number | null {
  if (game.chess.isCheckmate()) return game.chess.turn() === "w" ? 0 : 1;
  if (
    game.chess.isStalemate() ||
    game.chess.isInsufficientMaterial() ||
    game.chess.isThreefoldRepetition() ||
    game.chess.isDrawByFiftyMoves()
  ) {
    return 0.5;
  }
  if (ply >= cap) {
    const m = material(game);
    return m >= capMargin ? 1 : m <= -capMargin ? 0 : 0.5;
  }
  return null;
}

interface GameResult {
  /** White-positive outcome. */
  outcome: number;
  plies: number;
  /** Average search depth reached, per player. */
  depth: Record<Player, number>;
}

function playGame(
  whitePlayer: Player,
  challengerWeights: NnueWeights,
  opponentWeights: NnueWeights | null,
  cfg: Config,
  rng: () => number,
  seedBase: number
): GameResult {
  const game = new EvoChessGame();
  const depthSum: Record<Player, number> = { challenger: 0, opponent: 0 };
  const depthCount: Record<Player, number> = { challenger: 0, opponent: 0 };
  let ply = 0;

  // A short uniformly-random opening, identical in kind for both sides, so the
  // games diverge instead of replaying one deterministic line.
  for (let i = 0; i < cfg.openingPlies && !game.isGameOver(); i++) {
    const turns = legalTurns(game);
    if (!turns.length) break;
    const t = turns[Math.floor(rng() * turns.length)];
    game.applyMove(t.from, t.to, t.options);
    ply++;
  }

  for (;;) {
    const result = outcome(game, cfg.cap, cfg.capMargin, ply);
    if (result !== null) {
      return {
        outcome: result,
        plies: ply,
        depth: {
          challenger: depthCount.challenger ? depthSum.challenger / depthCount.challenger : 0,
          opponent: depthCount.opponent ? depthSum.opponent / depthCount.opponent : 0,
        },
      };
    }

    const player: Player = game.chess.turn() === "w" ? whitePlayer : other(whitePlayer);
    // Toggle the leaf evaluation for this whole search subtree.
    const evalFor: Record<Player, NnueWeights | null> = {
      challenger: challengerWeights,
      opponent: opponentWeights,
    };
    setNnueWeights(evalFor[player]);
    const { move, depth } = searchRootTimed(game, cfg.timeMs, seedBase + ply);
    depthSum[player] += depth;
    depthCount[player] += 1;

    if (!move) {
      // No legal move though not flagged game-over: adjudicate by material.
      const m = material(game);
      return {
        outcome: m >= cfg.capMargin ? 1 : m <= -cfg.capMargin ? 0 : 0.5,
        plies: ply,
        depth: {
          challenger: depthCount.challenger ? depthSum.challenger / depthCount.challenger : 0,
          opponent: depthCount.opponent ? depthSum.opponent / depthCount.opponent : 0,
        },
      };
    }
    game.applyMove(move.from, move.to, move.options);
    ply++;
  }
}

function other(p: Player): Player {
  return p === "challenger" ? "opponent" : "challenger";
}

function elo(score: number, n: number): string {
  if (score <= 0) return "-inf";
  if (score >= 1) return "+inf";
  const e = -400 * Math.log10(1 / score - 1);
  // Rough 95% band from the standard error of a Bernoulli-ish match score.
  const se = Math.sqrt((score * (1 - score)) / n);
  const band = (400 / Math.LN10) * (se / (score * (1 - score)));
  return `${e >= 0 ? "+" : ""}${e.toFixed(0)} ± ${band.toFixed(0)}`;
}

function parseArgs(argv: string[]): Config {
  const cfg = { ...DEFAULTS };
  const args = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : argv;
  for (let i = 0; i < args.length; i++) {
    const v = args[i + 1];
    switch (args[i]) {
      case "--games": cfg.games = Number(v); i++; break;
      case "--time": cfg.timeMs = Number(v); i++; break;
      case "--cap": cfg.cap = Number(v); i++; break;
      case "--seed": cfg.seed = Number(v); i++; break;
      case "--opening": cfg.openingPlies = Number(v); i++; break;
      case "--weights": cfg.weightsPath = v; i++; break;
      case "--opponent-weights": cfg.opponentWeightsPath = v; i++; break;
      case "--backend":
        if (v !== "chessjs" && v !== "bitboard") {
          throw new Error(`--backend must be chessjs|bitboard, got ${v}`);
        }
        cfg.backend = v; i++; break;
      default: throw new Error(`unknown argument: ${args[i]}`);
    }
  }
  return cfg;
}

function main(): void {
  const cfg = parseArgs(process.argv.slice(2));
  // Both sides share one search, so this applies to challenger and opponent
  // alike — the comparison stays symmetric whichever backend is chosen.
  engineConfig.backend = cfg.backend;
  const challengerWeights = loadWeights(JSON.parse(readFileSync(cfg.weightsPath, "utf8")));
  const opponentWeights = cfg.opponentWeightsPath
    ? loadWeights(JSON.parse(readFileSync(cfg.opponentWeightsPath, "utf8")))
    : null;
  const challengerLabel = labelFor(cfg.weightsPath);
  const opponentLabel = cfg.opponentWeightsPath ? labelFor(cfg.opponentWeightsPath) : "material+PST";
  const rng = mulberry32(cfg.seed);

  let wins = 0;
  let losses = 0;
  let draws = 0;
  const depthTotals: Record<Player, number> = { challenger: 0, opponent: 0 };
  let plySum = 0;

  for (let g = 0; g < cfg.games; g++) {
    // Alternate colours so a first-move edge cancels across the match.
    const whitePlayer: Player = g % 2 === 0 ? "challenger" : "opponent";
    const result = playGame(whitePlayer, challengerWeights, opponentWeights, cfg, rng, cfg.seed + g * 100003);

    // Convert the White-positive outcome to the challenger's point of view.
    const challengerScore = whitePlayer === "challenger" ? result.outcome : 1 - result.outcome;
    if (challengerScore === 1) wins++;
    else if (challengerScore === 0) losses++;
    else draws++;
    depthTotals.challenger += result.depth.challenger;
    depthTotals.opponent += result.depth.opponent;
    plySum += result.plies;

    process.stderr.write(
      `\rgame ${g + 1}/${cfg.games}  ${challengerLabel} ${wins}-${losses}-${draws} ` +
        `(${challengerLabel} was ${whitePlayer === "challenger" ? "White" : "Black"}, ${result.plies} plies) `
    );
  }
  process.stderr.write("\n");

  const n = cfg.games;
  const score = (wins + 0.5 * draws) / n;
  // The backend is part of the result: it sets how deep an equal-time search
  // reaches, so Elo from different backends is not comparable.
  console.log(
    `\n${challengerLabel} vs ${opponentLabel} — ${n} games at ${cfg.timeMs}ms/move, ${cfg.backend} backend`
  );
  console.log(`result (challenger):   +${wins} -${losses} =${draws}   score ${(100 * score).toFixed(1)}%`);
  console.log(`elo (challenger):      ${elo(score, n)}`);
  console.log(
    `avg depth:      challenger ${(depthTotals.challenger / n).toFixed(2)}  ` +
      `opponent ${(depthTotals.opponent / n).toFixed(2)}  (equal time)`
  );
  console.log(`avg game:       ${(plySum / n).toFixed(0)} plies`);
}

main();
