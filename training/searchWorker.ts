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
 */
import { parentPort } from "node:worker_threads";
import type { Color, Square } from "chess.js";
import { EvoChessGame, type ApplyMoveOptions, type EvolvedEnPassant } from "../src/evochess/game";
import { searchRoot, engineConfig, type EngineBackend } from "../src/evochess/ai";

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
   * its own (each worker has its own module instance), so it rides the request. */
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

if (!parentPort) {
  throw new Error("searchWorker.ts must be run as a worker_threads.Worker");
}

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

  engineConfig.backend = req.backend ?? "chessjs";
  const { move, score } = searchRoot(game, req.depth, req.seed);
  const response: SearchResponse = { id: req.id, move, score };
  parentPort!.postMessage(response);
});
