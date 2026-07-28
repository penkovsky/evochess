/**
 * Relabel an existing dataset by re-scoring each position with a deeper
 * search, per `docs/nnue-pst-relabel-spec.md`. Only the `score` field is
 * rewritten; `outcome`/`termination` and every other field are copied through
 * unchanged.
 *
 * Run under plain `node` against an esbuild bundle (see `relabel_batch.sh`),
 * or directly under vite-node for a one-off:
 *
 *     npx vite-node training/relabel.ts -- --in training/data \
 *         --out training/data-relabel-pst5/relabel.jsonl.gz --depth 5
 *
 * **PST vs net-as-leaf.** Omitting `--weights` leaves no NNUE weights loaded
 * and gives a PST-only search (`docs/nnue-pst-relabel-spec.md`'s mode);
 * passing `--weights <the JSON `nnue.export` writes>` scores with the net at
 * the leaves (`nnue-iterative-relabel-spec.md`'s mode).
 *
 * **Backend.** Both modes default to the `"bitboard"` engine backend
 * (`evoSearch.ts`), measured at ~17-20× the `"chessjs"` backend's throughput
 * at equal depth (`other_docs/bitboard-search-memo.md`). It used to be
 * PST-only, which is why net-as-leaf once had to fall back to chessjs; since
 * the incremental accumulator landed it evaluates with the net too, and
 * `nnueEvoAdapter.test.ts` pins its NNUE search scores to the chessjs
 * backend's at equal depth. Bitboard computes in integer centipawns against
 * chessjs's float pawn units, so the two are not bit-identical internally,
 * but at the 2dp the records store they came out identical on every position
 * of a depth-3 sample. Pass `--backend chessjs` to opt back into the exact
 * `ai.ts` eval.
 *
 * Both modes search through the worker pool, which loads the net into the
 * worker itself, so both get the same per-position timeout.
 *
 * **Sharding.** `--shards`/`--shard-index` partition the *positions*, not
 * the input files, by a hash of each position's canonical `stateKey()` — so
 * shards stay balanced even though input shard files vary in size, and a
 * process only pays the (expensive) search cost for its own 1/N share, even
 * though it streams every input file to find them.
 *
 * **Timeout policy.** Per the spec: a position that blows the per-position
 * search budget keeps its existing score rather than being dropped (dropping
 * would shrink the set and bias it toward quiet positions).
 */
import type { Color } from "chess.js";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { engineConfig, type EngineBackend } from "../src/evochess/ai";
import { SearchWorkerPool } from "./searchWorkerPool";
import {
  flushSink,
  gameFromRecord,
  openSink,
  round,
  stateKeyOf,
  writeLine,
  yieldToIO,
  type PositionRecord,
} from "./jsonl";

// -- tuning -------------------------------------------------------------------

interface Config {
  in: string;
  out: string;
  depth: number;
  seed: number; // salt mixed into the per-position search seed
  weights: string | null;
  shards: number;
  shardIndex: number;
  timeoutMs: number;
  // "auto" (default) picks "bitboard" for PST-only runs (no --weights) and
  // "chessjs" once --weights is set (NNUE only runs on chessjs). An explicit
  // value overrides that, e.g. --backend chessjs to force the exact ai.ts
  // PST eval instead of the faster bitboard one.
  backend: EngineBackend | "auto";
}

const DEFAULTS: Config = {
  in: "training/data",
  out: "training/data-relabel-pst5/relabel.jsonl.gz",
  depth: 5,
  seed: 1,
  weights: null,
  shards: 1,
  shardIndex: 0,
  timeoutMs: 15_000,
  backend: "auto",
};

function parseArgs(argv: string[]): Config {
  const cfg: Config = { ...DEFAULTS };
  const args = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : argv;
  const numeric: Record<string, (v: number) => void> = {
    "--depth": (v) => (cfg.depth = v),
    "--seed": (v) => (cfg.seed = v),
    "--shards": (v) => (cfg.shards = v),
    "--shard-index": (v) => (cfg.shardIndex = v),
    "--timeout-ms": (v) => (cfg.timeoutMs = v),
  };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--in") cfg.in = args[++i];
    else if (key === "--out") cfg.out = args[++i];
    else if (key === "--weights") cfg.weights = args[++i];
    else if (key === "--backend") {
      const v = args[++i];
      if (v !== "auto" && v !== "chessjs" && v !== "bitboard") {
        throw new Error(`--backend must be auto|chessjs|bitboard, got ${v}`);
      }
      cfg.backend = v;
    } else if (key in numeric) numeric[key](Number(args[++i]));
    else throw new Error(`unknown argument: ${key}`);
  }
  return cfg;
}

// -- input enumeration + streaming -------------------------------------------

function listShardFiles(inPath: string): string[] {
  const stat = statSync(inPath);
  if (stat.isFile()) return [inPath];
  return readdirSync(inPath)
    .filter((f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.gz"))
    .sort()
    .map((f) => join(inPath, f));
}

async function* readRecords(paths: string[]): AsyncGenerator<PositionRecord> {
  for (const path of paths) {
    const raw = createReadStream(path);
    const stream = path.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      yield JSON.parse(line) as PositionRecord;
    }
  }
}

// -- scoring convention -------------------------------------------------------

/**
 * Convert a `searchRoot()` score (side-to-move-relative) into the
 * White-positive pawn units records store, per `jsonl.ts`'s `PositionRecord`.
 * Same flip `gen.ts` and `augment.ts` apply to their own labels — exported
 * (and pinned in `relabel.test.ts`) because getting it backwards is silent:
 * every score keeps a plausible magnitude and only the sign is wrong, which
 * no downstream stage checks and which trains the net to prefer losing.
 */
export function whiteScore(turn: Color, sideToMoveScore: number): number {
  return turn === "w" ? sideToMoveScore : -sideToMoveScore;
}

// -- deterministic hash (FNV-1a) ----------------------------------------------

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// -- driver -------------------------------------------------------------------

interface Stats {
  total: number;
  inShard: number;
  relabeled: number;
  timedOut: number;
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  if (cfg.shardIndex < 0 || cfg.shardIndex >= cfg.shards) {
    throw new Error(`--shard-index must be in [0, ${cfg.shards})`);
  }

  // "auto" is now bitboard for both modes: it carries the measured ~17-20×
  // throughput of the chessjs backend at equal depth, and since the
  // accumulator landed it evaluates with the net too (`evoSearch.ts`'s
  // `USE_NNUE`), so net-as-leaf no longer has to pay chessjs's cost. Pass
  // `--backend chessjs` to opt back into the exact `ai.ts` eval. Set before
  // the pool is created: `search()` forwards this flag to the worker, which
  // has no other way to learn it.
  engineConfig.backend = cfg.backend === "auto" ? "bitboard" : cfg.backend;

  const files = listShardFiles(cfg.in);
  if (files.length === 0) throw new Error(`no .jsonl(.gz) files found under ${cfg.in}`);

  // Both modes search through the pool, so both get the per-position timeout.
  // The pool loads the net into the worker itself; nothing needs to (or can)
  // set weights in this process's module instance.
  const pool = await SearchWorkerPool.create(cfg.weights);
  const { sink, done } = openSink(cfg.out);
  const stats: Stats = { total: 0, inShard: 0, relabeled: 0, timedOut: 0 };
  const start = Date.now();

  try {
    for await (const record of readRecords(files)) {
      stats.total += 1;
      const game = gameFromRecord(record);
      const key = stateKeyOf(game);
      if (hash32(key) % cfg.shards !== cfg.shardIndex) continue;
      stats.inShard += 1;

      const searchSeed = hash32(`${key}:${cfg.seed}`);
      const result = await pool.search(game, cfg.depth, searchSeed, cfg.timeoutMs);
      if (result === null) {
        stats.timedOut += 1;
      } else {
        record.score = round(whiteScore(game.turn, result.score));
        stats.relabeled += 1;
      }

      await writeLine(sink, JSON.stringify(record) + "\n");

      if (stats.inShard % 20 === 0) {
        await yieldToIO();
        flushSink(sink);
        const perSec = (stats.inShard / ((Date.now() - start) / 1000) || 0).toFixed(2);
        process.stderr.write(
          `\r${stats.inShard} in shard (${stats.relabeled} relabeled, ${stats.timedOut} kept-old) ` +
            `of ${stats.total} scanned (${perSec}/s) `
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
    `backend:    ${engineConfig.backend}\n` +
      `scanned:    ${stats.total}\n` +
      `this shard: ${stats.inShard}\n` +
      `relabeled:  ${stats.relabeled}\n` +
      `kept-old:   ${stats.timedOut} (timed out past ${cfg.timeoutMs}ms)\n` +
      `wrote ${cfg.out}\n`
  );
}

// Guarded exactly as `augment.ts` is, and for the same reason: the test suite
// imports `whiteScore` from here, and an unguarded `main()` would kick off a
// relabel run (against the default `--in`, which usually doesn't exist) as an
// import side effect and `process.exit(1)` out of the test process. See
// augment.ts's note for why this can't be an `import.meta.url` check.
if (!process.env.VITEST) {
  main().catch((err) => {
    process.stderr.write(`\n${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
