/**
 * A single persistent worker running `searchWorker.ts`'s search loop, with a
 * hard wall-clock timeout per call. See `searchWorker.ts` for why: a
 * measured minority of sampled positions send quiescence search's
 * (correctly, ply-bounded but not branching-bounded) tree into the tens of
 * seconds or worse, and nothing in a synchronous, single-threaded call can
 * interrupt that. Terminating and respawning the worker on timeout turns a
 * would-be-indefinite stall into "this position took too long, reject and
 * resample" — the same reject-and-resample posture `sampler.ts` already uses
 * for structurally illegal positions.
 *
 * Used by `augment.ts` (one search per sampled position, score only), by
 * `gen.ts`'s seeded self-play plies (`--seed-frac`, which need the move too,
 * to actually play the game out), and by `relabel.ts` in both its PST-leaf
 * and net-as-leaf modes.
 */
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { EvoChessGame } from "../src/evochess/game";
import { engineConfig, type RootSearch } from "../src/evochess/ai";
import type { SerializedWeights } from "../src/evochess/nnue";
import type { SearchRequest, SearchResponse, SearchWorkerData } from "./searchWorker";

async function bundleWorkerEntry(): Promise<string> {
  const entry = fileURLToPath(new URL("./searchWorker.ts", import.meta.url));
  const outfile = join(tmpdir(), `evochess-search-worker-${process.pid}-${Date.now()}.mjs`);
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
  });
  return outfile;
}

interface Pending {
  resolve: (result: RootSearch | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SearchWorkerPool {
  private bundlePath: string;
  private weights: SerializedWeights | null;
  private worker!: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 0;

  private constructor(bundlePath: string, weights: SerializedWeights | null) {
    this.bundlePath = bundlePath;
    this.weights = weights;
    this.spawn();
  }

  /**
   * `weightsPath` (net-as-leaf runs) points at the JSON `nnue.export` writes —
   * the same file `ladder.ts`/`match.ts` take. It is read **once, here**, not
   * per spawn: a bad path then throws on the main thread at startup instead of
   * inside a worker, where the pool's `error` handler would quietly turn every
   * search into a `null` (i.e. every position keeping its old score, a whole
   * relabel run silently doing nothing). Holding the parsed net also means a
   * respawn after a timeout can't pick up a different file mid-run.
   */
  static async create(weightsPath?: string | null): Promise<SearchWorkerPool> {
    const weights: SerializedWeights | null = weightsPath
      ? (JSON.parse(readFileSync(weightsPath, "utf8")) as SerializedWeights)
      : null;
    return new SearchWorkerPool(await bundleWorkerEntry(), weights);
  }

  private spawn(): void {
    // Every spawn re-sends the net: `setNnueWeights` is module state, and a
    // respawned worker is a fresh module instance that would otherwise come
    // back up evaluating with PST.
    const data: SearchWorkerData = { weights: this.weights };
    const worker = new Worker(this.bundlePath, { workerData: data });
    worker.on("message", (msg: SearchResponse) => {
      const p = this.pending.get(msg.id);
      if (!p) return; // already timed out and resolved
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve({ move: msg.move, score: msg.score });
    });
    worker.on("error", () => {
      // A crash mid-search: fail every outstanding request rather than hang
      // them, then let the next `search()` call respawn on demand.
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.resolve(null);
      }
      this.pending.clear();
    });
    this.worker = worker;
  }

  /**
   * The root search result (side-to-move-relative score, same convention as
   * `searchRoot()`), or `null` if the search doesn't return within
   * `timeoutMs` — the caller's signal to discard this position and try
   * another, exactly like any other rejected sample.
   */
  search(game: EvoChessGame, depth: number, seed: number, timeoutMs: number): Promise<RootSearch | null> {
    const id = this.nextId++;
    const req: SearchRequest = {
      id,
      fen: game.chess.fen(),
      minorRights: game.minorRights,
      rookRights: game.rookRights,
      pawnMoveProgress: game.pawnMoveProgress,
      minorMoveProgress: game.minorMoveProgress,
      rookCharges: [...game.rookCharges],
      rookLocked: [...game.rookLocked],
      epEvolved: game.epEvolved,
      depth,
      seed,
      // Forward the main-thread engine flag so the pooled path uses the same
      // backend as the in-process one (workers default to "chessjs" otherwise).
      backend: engineConfig.backend,
    };
    return new Promise<RootSearch | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The worker is presumably still deep in the pathological search;
        // kill it so it isn't still burning a core when the next call comes
        // in, and respawn so that call has a fresh worker to talk to.
        void this.worker.terminate();
        this.spawn();
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage(req);
    });
  }

  async close(): Promise<void> {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    await this.worker.terminate();
    await unlink(this.bundlePath).catch(() => {});
  }
}
