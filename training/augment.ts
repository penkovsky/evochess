/**
 * Material augmentation (mechanism 2, `nnue-data-coverage-spec.md`). Synthesizes
 * isolated legal positions across the material spectrum via `sampler.ts` and
 * labels each with one root search — no game played out. This is the cheap,
 * high-yield attack on the measured failure: the net was blind on rooks and
 * queens because 40k short self-play games almost never reached them.
 *
 * Run under vite-node, e.g.:
 *
 *     npx vite-node training/augment.ts -- --positions 20000 --depth 3 \
 *         --out training/data/augment.jsonl.gz
 *
 * **Outcome handling is deliberately absent, not a bug.** Every emitted
 * record has a `score` and no `outcome`/`termination`. In `position.py`,
 * that makes `outcome_is_sound` false; `target.py`'s `build_target` then
 * collapses to effective lambda=1 (pure search-score signal) and
 * `sound_label_pairs`/`fit_k` skip the record entirely. So these positions
 * teach the net piece values without ever polluting the outcome signal or
 * the K fit — see the pinned tests in `training/tests/test_target.py`.
 */
import { EvoChessGame } from "../src/evochess/game";
import { engineConfig, material, searchRoot, type EngineBackend } from "../src/evochess/ai";
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
} from "./jsonl";

// -- tuning -----------------------------------------------------------------

interface Config {
  positions: number; // stop once this many unique positions are written
  maxAttempts: number; // hard ceiling, so a bad config can't loop forever
  depth: number;
  seed: number;
  out: string;
  // Per-position wall-clock budget for the worker-isolated search. A small
  // fraction of sampled positions (dense, randomly-placed material — see
  // sampler.ts) send quiescence search's tree into the tens of seconds or
  // worse; past this budget the position is discarded and resampled rather
  // than let one pathological board stall the whole run.
  timeoutMs: number;
  // Which search produces the labels. Defaults to `engineConfig`'s own
  // default; pass `--backend chessjs` to label with the reference search
  // instead. Do not mix backends within one dataset.
  backend: EngineBackend;
}

const DEFAULTS: Config = {
  positions: 5_000,
  maxAttempts: 1_000_000,
  depth: 3,
  seed: 1,
  out: "training/data/augment.jsonl.gz",
  timeoutMs: 4_000,
  backend: engineConfig.backend,
};

function parseArgs(argv: string[]): Config {
  const cfg: Config = { ...DEFAULTS };
  const args = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : argv;
  const numeric: Record<string, (v: number) => void> = {
    "--positions": (v) => (cfg.positions = v),
    "--attempts": (v) => (cfg.maxAttempts = v),
    "--depth": (v) => (cfg.depth = v),
    "--seed": (v) => (cfg.seed = v),
    "--timeout-ms": (v) => (cfg.timeoutMs = v),
  };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--out") cfg.out = args[++i];
    else if (key === "--backend") {
      const v = args[++i];
      if (v !== "chessjs" && v !== "bitboard") {
        throw new Error(`--backend must be chessjs|bitboard, got ${v}`);
      }
      cfg.backend = v;
    } else if (key in numeric) numeric[key](Number(args[++i]));
    else throw new Error(`unknown argument: ${key}`);
  }
  return cfg;
}

/**
 * One score-only record given an already-computed White-positive score.
 * Tagged `source: "synthetic"` purely for dataset inspection (see the module
 * docstring): not read by `position.py`, and not required for the
 * outcome-less handling to be correct.
 */
export function buildAugmentedRecord(game: EvoChessGame, whiteScore: number): PositionRecord {
  const record = toRecord(game, whiteScore);
  record.source = "synthetic";
  return record;
}

/**
 * Convenience wrapper that runs the search directly (synchronously, in this
 * process) rather than through the worker pool. Fine for tests and one-off
 * calls; the CLI driver below goes through `SearchWorkerPool` instead so a
 * pathological position can't stall the whole run — see `searchWorker.ts`.
 */
export function augmentRecord(game: EvoChessGame, depth: number, seed: number): PositionRecord {
  const { score } = searchRoot(game, depth, seed);
  const whiteScore = game.turn === "w" ? score : -score;
  return buildAugmentedRecord(game, whiteScore);
}

// -- coverage histogram -------------------------------------------------------

/**
 * Material-imbalance buckets (White material minus Black material, pawn
 * units), plus rook/queen presence counts. The direct check that generation
 * actually filled the gap the natural self-play distribution left empty —
 * per the spec, "if those are still near zero, the generation change did not
 * work: stop and fix it before spending GPU."
 */
export interface Coverage {
  buckets: Record<string, number>;
  anyWhiteRook: number;
  anyBlackRook: number;
  anyWhiteQueen: number;
  anyBlackQueen: number;
  n: number;
}

export function newCoverage(): Coverage {
  return { buckets: {}, anyWhiteRook: 0, anyBlackRook: 0, anyWhiteQueen: 0, anyBlackQueen: 0, n: 0 };
}

export function imbalanceBucket(mat: number): string {
  const rounded = Math.round(mat);
  if (rounded <= -10) return "<=-10";
  if (rounded >= 10) return ">=10";
  return String(rounded);
}

export function recordCoverage(coverage: Coverage, game: EvoChessGame): void {
  coverage.n += 1;
  const bucket = imbalanceBucket(material(game));
  coverage.buckets[bucket] = (coverage.buckets[bucket] ?? 0) + 1;
  // Presence per position (≥1 piece), not a piece count: a position with two
  // rooks must still only count once, or the "percentage" below can run past
  // 100% and no longer answers the spec's question ("fraction of positions
  // with ≥1 rook").
  let hasWhiteRook = false;
  let hasBlackRook = false;
  let hasWhiteQueen = false;
  let hasBlackQueen = false;
  for (const row of game.chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      if (cell.type === "r") {
        if (cell.color === "w") hasWhiteRook = true;
        else hasBlackRook = true;
      }
      if (cell.type === "q") {
        if (cell.color === "w") hasWhiteQueen = true;
        else hasBlackQueen = true;
      }
    }
  }
  if (hasWhiteRook) coverage.anyWhiteRook += 1;
  if (hasBlackRook) coverage.anyBlackRook += 1;
  if (hasWhiteQueen) coverage.anyWhiteQueen += 1;
  if (hasBlackQueen) coverage.anyBlackQueen += 1;
}

function summariseCoverage(coverage: Coverage, elapsedMs: number): string {
  const n = coverage.n || 1;
  const pct = (x: number) => `${((x / n) * 100).toFixed(1)}%`;
  const buckets = Object.entries(coverage.buckets)
    .sort(([a], [b]) => Number(a.replace(/[<=>]/g, "")) - Number(b.replace(/[<=>]/g, "")))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const perSec = (coverage.n / (elapsedMs / 1000)).toFixed(1);
  return [
    `positions:    ${coverage.n} written`,
    `rate:         ${perSec} positions/sec`,
    `coverage:     white rook ${pct(coverage.anyWhiteRook)}, black rook ${pct(coverage.anyBlackRook)}, ` +
      `white queen ${pct(coverage.anyWhiteQueen)}, black queen ${pct(coverage.anyBlackQueen)}`,
    `imbalance:    ${buckets}`,
  ].join("\n");
}

// -- driver ------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const rng = mulberry32(cfg.seed);
  let seedState = cfg.seed ^ 0x9e3779b9;
  const searchSeed = () => (seedState = (seedState + 0x6d2b79f5) | 0);

  // Set before the pool is created: `search()` forwards this to the worker,
  // which has no other way to learn it.
  engineConfig.backend = cfg.backend;
  const { sink, done } = openSink(cfg.out);
  const pool = await SearchWorkerPool.create();
  const seen = new Set<string>();
  const coverage = newCoverage();
  let duplicates = 0;
  let timeouts = 0;
  let attempts = 0;
  const start = Date.now();

  try {
    while (coverage.n < cfg.positions && attempts < cfg.maxAttempts) {
      attempts += 1;
      const game = sampleSeedPosition(rng);
      const result = await pool.search(game, cfg.depth, searchSeed(), cfg.timeoutMs);
      if (result === null) {
        timeouts += 1;
        continue;
      }
      const whiteScore = game.turn === "w" ? result.score : -result.score;
      const record = buildAugmentedRecord(game, whiteScore);

      const key = recordKey(record);
      if (seen.has(key)) {
        duplicates += 1;
      } else {
        seen.add(key);
        await writeLine(sink, JSON.stringify(record) + "\n");
        recordCoverage(coverage, game);
      }

      // Same rationale as gen.ts: yield periodically so the stream actually
      // flushes to disk during a long run instead of buffering to the end.
      if (attempts % 25 === 0) {
        await yieldToIO();
        flushSink(sink);
        process.stderr.write(
          `\r${coverage.n}/${cfg.positions} positions, ${duplicates} duplicates, ${timeouts} timeouts ` +
            `(${((coverage.n / ((Date.now() - start) / 1000)) || 0).toFixed(1)}/s) `
        );
      }
    }
  } finally {
    await pool.close();
  }

  sink.end();
  await done;
  process.stderr.write("\n");
  process.stdout.write(
    summariseCoverage(coverage, Date.now() - start) +
      `\nduplicates:   ${duplicates}\ntimeouts:     ${timeouts}\nwrote ${cfg.out}\n`
  );
}

// Guarded so the test suite can import `augmentRecord` and friends without
// kicking off a full generation run as an import side effect. Can't use an
// `import.meta.url`/`process.argv[1]` check here: `vite-node` (this file's
// own documented entry point) consumes the script path into its own CLI
// parsing and never puts it back in `process.argv`, so that comparison can
// never match under the very runner this file is meant to run under.
// Vitest's own process-level env var is the reliable signal instead.
if (!process.env.VITEST) {
  main().catch((err) => {
    process.stderr.write(`\n${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
