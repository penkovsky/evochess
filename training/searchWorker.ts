/**
 * Worker-thread entry point for search calls that need a hard wall-clock
 * timeout: `augment.ts`'s score-only positions and `gen.ts`'s seeded
 * self-play plies (`--seed-frac`). Not imported directly — callers bundle
 * this file with esbuild via `searchWorkerPool.ts` and run it in a
 * `worker_threads.Worker` so a pathological search can be killed with
 * `worker.terminate()` without taking the generator process down with it.
 *
 * Why this exists: the sampler in `sampler.ts` deliberately builds
 * material-dense, randomly-placed positions no real game ever reaches, and a
 * measured minority of them make quiescence search (bounded at a 32-ply cap,
 * but not a small branching factor) take anywhere from a few seconds to over
 * a minute — an unbounded tail in a single-threaded, synchronous search call
 * that nothing in the main loop could otherwise interrupt. Per the coverage
 * spec's non-goals, the search itself is not touched; this only adds an
 * external, generation-side timeout around it.
 *
 * The worker owns its own NNUE weights, exactly as the app's `ai.worker.ts`
 * does and for the same reason: `setNnueWeights` writes module state, and a
 * worker is a separate module instance the main thread's copy never reaches.
 * `relabel.ts`'s net-as-leaf mode passes the serialized net through
 * `workerData` (see `searchWorkerPool.ts`), which is what lets that mode get
 * the same hard per-position timeout the PST mode has always had.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { Color, Square } from "chess.js";
import { EvoChessGame, type ApplyMoveOptions, type EvolvedEnPassant } from "../src/evochess/game";
import { searchRoot, engineConfig, type EngineBackend } from "../src/evochess/ai";
import { loadWeights, setNnueWeights, type SerializedWeights } from "../src/evochess/nnue";

export interface SearchRequest {
  id: number;
  fen: string;
  minorRights: Record<Color, number>;
  rookRights: Record<Color, number>;
  pawnMoveProgress: Record<Color, number>;
  minorMoveProgress: Record<Color, number>;
  rookCharges: [Square, number][];
  rookLocked: Square[];
  epEvolved: EvolvedEnPassant | null;
  depth: number;
  seed: number;
  /** Which search backend to use; the main-thread flag doesn't reach here on
   * its own (each worker has its own module instance), so it rides the
   * request. Omitted leaves the worker on `engineConfig`'s own default. */
  backend?: EngineBackend;
}

export interface SearchResponse {
  id: number;
  // Raw searchRoot() output: side-to-move-relative score, and the move (if
  // any legal one exists). Callers that need a White-positive score flip it
  // themselves — they already have `game.turn` on hand.
  move: { from: Square; to: Square; options: ApplyMoveOptions } | null;
  score: number;
}

/** Set by `SearchWorkerPool`; `weights: null` is the PST-leaf default. */
export interface SearchWorkerData {
  weights: SerializedWeights | null;
}

if (!parentPort) {
  throw new Error("searchWorker.ts must be run as a worker_threads.Worker");
}

// Load before the first message is handled: `searchRoot` reads the net through
// `evaluate()`'s `hasNnueWeights()` check, so a position searched before this
// ran would silently get a PST label in a net-as-leaf run. Worker construction
// and this module's evaluation both precede any `message` event, so it can't.
const { weights } = (workerData ?? { weights: null }) as SearchWorkerData;
if (weights) setNnueWeights(loadWeights(weights));

parentPort.on("message", (req: SearchRequest) => {
  const game = new EvoChessGame();
  game.chess.load(req.fen);
  game.minorRights = req.minorRights;
  game.rookRights = req.rookRights;
  game.pawnMoveProgress = req.pawnMoveProgress;
  game.minorMoveProgress = req.minorMoveProgress;
  game.rookCharges = new Map(req.rookCharges);
  game.rookLocked = new Set(req.rookLocked);
  game.epEvolved = req.epEvolved;

  // Only override when the request names a backend; otherwise leave this
  // worker's own module default in place, so the two can't drift apart.
  if (req.backend) engineConfig.backend = req.backend;
  const { move, score } = searchRoot(game, req.depth, req.seed);
  const response: SearchResponse = { id: req.id, move, score };
  parentPort!.postMessage(response);
});
