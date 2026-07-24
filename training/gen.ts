/**
 * NNUE data generator (milestone 1). Plays randomised self-play with the real
 * engine and writes one labelled position per move to JSONL, in the exact shape
 * `training/nnue/position.py` reads.
 *
 * Run under vite-node, e.g.:
 *
 *     npx vite-node training/gen.ts -- --positions 100000 --depth 3 \
 *         --out training/data/positions.jsonl.gz
 *
 * Why the engine and not a rewrite: the labels must come from the same code
 * that will consume the net, or the net learns to predict a different engine
 * than the one it ships beside.
 *
 * Three things the spec insists on, all handled below:
 *
 *  - **Diversity.** The engine is deterministic given a seed and its jitter
 *    only breaks ties between *equal* moves, so naive self-play would produce
 *    near-identical games. We force a uniformly random opening and a fixed
 *    fraction of random moves thereafter, and deduplicate on `stateKey()`.
 *  - **Termination.** Under weak/random play games do not end on their own —
 *    measured random playouts ran past 195 plies. A move cap plus material
 *    adjudication is mandatory, or the file fills with timeout draws and the
 *    outcome signal never bootstraps.
 *  - **Unsound draw labels.** chess.js judges repetition on the board alone,
 *    but two identical boards with different rights/progress are not the same
 *    EvoChess position, so a "repetition" draw may be spurious. We record the
 *    termination reason and let the Python side exclude it; we do not silently
 *    train on it.
 *
 * **Seeded self-play** (`--seed-frac`, mechanism 1 of
 * `nnue-data-coverage-spec.md`): with that probability, a game starts from a
 * sampled material-rich position (`sampler.ts`) instead of `START_FEN`, then
 * plays out exactly as any other game — search-labelled every ply, outcome
 * backfilled at the end. This is what teaches the net *sound game outcomes*
 * on rook/queen-rich positions, which the score-only augmentation in
 * `augment.ts` cannot provide. Seeded plies are searched through
 * `SearchWorkerPool` rather than directly: the sampler's positions are
 * measured to occasionally send quiescence into a tens-of-seconds-plus
 * search (see `searchWorker.ts`), and a whole game's worth of plies makes
 * that risk compound. A ply that times out is treated exactly like the
 * existing `move === null` case below: adjudicate on material and end the
 * game early rather than block the run.
 */
import { EvoChessGame } from "../src/evochess/game";
import { legalTurns, material, searchRoot, type CandidateTurn, type RootSearch } from "../src/evochess/ai";
import { sampleSeedPosition } from "./sampler";
import { SearchWorkerPool } from "./searchWorkerPool";
import {
  flushSink,
  mulberry32,
  openSink,
  recordKey,
  toRecord,
  writeLine,
  yieldToIO,
  type PositionRecord,
  type Termination,
} from "./jsonl";

// -- tuning -----------------------------------------------------------------

interface Config {
  positions: number; // stop once this many unique positions are written
  maxGames: number; // hard ceiling, so a bad config can't loop forever
  depth: number;
  seed: number;
  cap: number; // move cap in plies
  out: string;
  randomOpeningMin: number;
  randomOpeningMax: number;
  randomMoveProb: number;
  // Adjudicate a game as decided the instant one side is this far ahead
  // (pawn units, from the material eval). Ends lopsided games long before the
  // cap and gives a clean win/loss label instead of a drifted draw.
  earlyMargin: number;
  // At the move cap, a smaller edge than this scores as a draw.
  capMargin: number;
  // Fraction of games that start from a sampled material-rich position
  // (sampler.ts) instead of START_FEN. 0 disables seeded self-play entirely
  // (and skips spinning up the search worker pool).
  seedFrac: number;
  // Per-ply wall-clock budget for a seeded game's worker-isolated search.
  seedTimeoutMs: number;
}

const DEFAULTS: Config = {
  positions: 5_000,
  maxGames: 1_000_000,
  depth: 3,
  seed: 1,
  cap: 160,
  out: "training/data/positions.jsonl.gz",
  randomOpeningMin: 4,
  randomOpeningMax: 8,
  randomMoveProb: 0.1,
  earlyMargin: 10,
  capMargin: 2,
  seedFrac: 0,
  seedTimeoutMs: 5_000,
};

// -- adjudication -----------------------------------------------------------

/** White-positive outcome in {0, 0.5, 1} for a completed chess.js game. */
function naturalOutcome(game: EvoChessGame): { outcome: number; termination: Termination } {
  if (game.chess.isCheckmate()) {
    // The side to move is mated, so the *other* side won.
    return { outcome: game.chess.turn() === "w" ? 0 : 1, termination: "checkmate" };
  }
  if (game.chess.isStalemate()) return { outcome: 0.5, termination: "stalemate" };
  if (game.chess.isInsufficientMaterial()) return { outcome: 0.5, termination: "insufficient" };
  if (game.chess.isThreefoldRepetition()) return { outcome: 0.5, termination: "repetition" };
  return { outcome: 0.5, termination: "fifty_moves" };
}

/** White-positive outcome from a material margin, for cap/early adjudication. */
function adjudicate(whiteMaterial: number, margin: number): number {
  if (whiteMaterial >= margin) return 1;
  if (whiteMaterial <= -margin) return 0;
  return 0.5;
}

// -- one self-play game ------------------------------------------------------

interface GameResult {
  records: PositionRecord[];
  plies: number;
  termination: Termination;
  seeded: boolean;
  timedOut: boolean;
}

async function playGame(
  cfg: Config,
  rng: () => number,
  searchSeed: () => number,
  pool: SearchWorkerPool | null
): Promise<GameResult> {
  const seeded = pool !== null && rng() < cfg.seedFrac;
  const game = seeded ? sampleSeedPosition(rng) : new EvoChessGame();
  const records: PositionRecord[] = [];
  const openingPlies =
    cfg.randomOpeningMin +
    Math.floor(rng() * (cfg.randomOpeningMax - cfg.randomOpeningMin + 1));

  let ply = 0;
  let outcome: number;
  let termination: Termination;
  let timedOut = false;

  for (;;) {
    if (game.isGameOver()) {
      ({ outcome, termination } = naturalOutcome(game));
      break;
    }
    if (ply >= cfg.cap) {
      outcome = adjudicate(material(game), cfg.capMargin);
      termination = "cap";
      break;
    }

    // One search per ply, whatever move we then play: it is both the position's
    // label and — outside the random plies — the move the engine would pick.
    // Seeded plies go through the worker pool so a pathological position
    // (see searchWorker.ts) can be killed on a timeout instead of stalling
    // the run; natural self-play never needs it, so it keeps the direct,
    // synchronous call.
    const result: RootSearch | null = seeded
      ? await pool!.search(game, cfg.depth, searchSeed(), cfg.seedTimeoutMs)
      : searchRoot(game, cfg.depth, searchSeed());
    if (result === null) {
      // The worker didn't return within budget: treat like a dead position
      // rather than block the run on it.
      timedOut = true;
      outcome = adjudicate(material(game), cfg.capMargin);
      termination = "cap";
      break;
    }
    const { move, score } = result;
    if (move === null) {
      // No legal turn although isGameOver() was false: treat as a dead
      // position and adjudicate rather than trust a single flag.
      outcome = adjudicate(material(game), cfg.capMargin);
      termination = "cap";
      break;
    }

    const whiteScore = game.turn === "w" ? score : -score;
    records.push(toRecord(game, whiteScore));

    // Early adjudication keeps lopsided games from drifting to the cap.
    const mat = material(game);
    if (Math.abs(mat) >= cfg.earlyMargin) {
      outcome = adjudicate(mat, cfg.capMargin);
      termination = "cap";
      break;
    }

    const play = pickMove(game, move, ply < openingPlies, cfg.randomMoveProb, rng);
    game.applyMove(play.from, play.to, play.options);
    ply += 1;
  }

  for (const record of records) {
    record.outcome = outcome;
    record.termination = termination;
  }
  return { records, plies: ply, termination, seeded, timedOut };
}

function pickMove(
  game: EvoChessGame,
  best: CandidateTurn,
  forceRandom: boolean,
  randomProb: number,
  rng: () => number
): CandidateTurn {
  if (!forceRandom && rng() >= randomProb) return best;
  const turns = legalTurns(game);
  return turns.length ? turns[Math.floor(rng() * turns.length)] : best;
}

// -- driver ------------------------------------------------------------------

function parseArgs(argv: string[]): Config {
  const cfg: Config = { ...DEFAULTS };
  // Everything after a lone `--` (vite-node passes the rest through) or from
  // the start: accept `--key value` for each known field.
  const args = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : argv;
  const numeric: Record<string, (v: number) => void> = {
    "--positions": (v) => (cfg.positions = v),
    "--games": (v) => (cfg.maxGames = v),
    "--depth": (v) => (cfg.depth = v),
    "--seed": (v) => (cfg.seed = v),
    "--cap": (v) => (cfg.cap = v),
    "--random-prob": (v) => (cfg.randomMoveProb = v),
    "--early-margin": (v) => (cfg.earlyMargin = v),
    "--cap-margin": (v) => (cfg.capMargin = v),
    "--seed-frac": (v) => (cfg.seedFrac = v),
    "--seed-timeout-ms": (v) => (cfg.seedTimeoutMs = v),
  };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--out") cfg.out = args[++i];
    else if (key in numeric) numeric[key](Number(args[++i]));
    else throw new Error(`unknown argument: ${key}`);
  }
  return cfg;
}

interface Stats {
  games: number;
  seededGames: number;
  timedOutGames: number;
  written: number;
  duplicates: number;
  plies: number[];
  terminations: Record<string, number>;
  outcomes: Record<string, number>;
  scoreSum: number;
  scoreSumSq: number;
}

function summarise(stats: Stats, elapsedMs: number): string {
  const plies = [...stats.plies].sort((a, b) => a - b);
  const median = plies.length ? plies[plies.length >> 1] : 0;
  const meanPly = plies.reduce((a, b) => a + b, 0) / (plies.length || 1);
  const n = stats.written || 1;
  const meanScore = stats.scoreSum / n;
  const variance = stats.scoreSumSq / n - meanScore * meanScore;
  const perSec = (stats.written / (elapsedMs / 1000)).toFixed(1);
  const lines = [
    `games:        ${stats.games} (${stats.seededGames} seeded, ${stats.timedOutGames} seeded-timeouts)`,
    `positions:    ${stats.written} written, ${stats.duplicates} dropped as duplicates`,
    `rate:         ${perSec} positions/sec`,
    `game length:  ${meanPly.toFixed(1)} plies mean, ${median} median, ${plies.at(-1) ?? 0} max`,
    `terminations: ${format(stats.terminations)}`,
    `outcomes:     ${format(stats.outcomes)} (White-positive)`,
    `score:        mean ${meanScore.toFixed(2)}, sd ${Math.sqrt(Math.max(variance, 0)).toFixed(2)} pawns`,
  ];
  return lines.join("\n");
}

function format(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const rng = mulberry32(cfg.seed);
  // A separate, disjoint stream for search seeds keeps the search reproducible
  // without coupling it to the diversity draws.
  let seedState = cfg.seed ^ 0x9e3779b9;
  const searchSeed = () => (seedState = (seedState + 0x6d2b79f5) | 0);

  const { sink, done } = openSink(cfg.out);
  // Only spun up when actually needed: the vast majority of runs use
  // --seed-frac 0 and shouldn't pay for an esbuild bundle + worker thread
  // they'll never use.
  const pool = cfg.seedFrac > 0 ? await SearchWorkerPool.create() : null;
  const seen = new Set<string>();
  const stats: Stats = {
    games: 0,
    seededGames: 0,
    timedOutGames: 0,
    written: 0,
    duplicates: 0,
    plies: [],
    terminations: {},
    outcomes: {},
    scoreSum: 0,
    scoreSumSq: 0,
  };
  const start = Date.now();

  try {
    while (stats.written < cfg.positions && stats.games < cfg.maxGames) {
      const { records, plies, termination, seeded, timedOut } = await playGame(cfg, rng, searchSeed, pool);
      stats.games += 1;
      if (seeded) stats.seededGames += 1;
      if (timedOut) stats.timedOutGames += 1;
      stats.plies.push(plies);
      stats.terminations[termination] = (stats.terminations[termination] ?? 0) + 1;

      // Deduplicate against the whole run, keeping the first sighting. This is
      // where the forced randomisation pays off — without it, near-identical
      // games would collapse to almost nothing here.
      for (const record of records) {
        const key = recordKey(record);
        if (seen.has(key)) {
          stats.duplicates += 1;
          continue;
        }
        seen.add(key);
        await writeLine(sink, JSON.stringify(record) + "\n");
        stats.written += 1;
        stats.outcomes[String(record.outcome)] = (stats.outcomes[String(record.outcome)] ?? 0) + 1;
        stats.scoreSum += record.score ?? 0;
        stats.scoreSumSq += (record.score ?? 0) ** 2;
        if (stats.written >= cfg.positions) break;
      }

      // Let the event loop turn between games so the stream flushes to disk
      // incrementally — otherwise the synchronous search keeps it buffered until
      // the very end, losing the whole shard if the process dies mid-run.
      await yieldToIO();
      // gzip holds compressed output until it has a full block, so on a long run
      // force it to disk periodically: durability for a multi-hour job is worth
      // a little compression ratio.
      if (stats.games % 3 === 0) flushSink(sink);

      if (stats.games % 5 === 0) {
        process.stderr.write(
          `\r${stats.written}/${cfg.positions} positions, ${stats.games} games ` +
            `(${((stats.written / ((Date.now() - start) / 1000)) || 0).toFixed(1)}/s) `
        );
      }
    }
  } finally {
    if (pool) await pool.close();
  }

  sink.end();
  await done;
  process.stderr.write("\n");
  process.stdout.write(summarise(stats, Date.now() - start) + `\nwrote ${cfg.out}\n`);
}

main().catch((err) => {
  process.stderr.write(`\n${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
