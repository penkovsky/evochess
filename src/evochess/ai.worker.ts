// Runs the minimax search off the main thread so the board stays responsive
// (highlights, scrolling, takeback) while the AI is thinking, instead of
// freezing the tab for the duration of the search — which matters most for the
// Fun level, whose search runs for a time budget.
//
// The worker owns the NNUE weights: it fetches them once on startup so the Fun
// level can evaluate with the net. Weights live in the module instance that runs
// the search, and this worker is that instance — the main thread's copy would
// not reach here. Until the fetch resolves (or if it fails), `searchLevel` sees
// no net and Fun transparently falls back to a time-budgeted PST search.
import type { Square } from "chess.js";
import { type ApplyMoveOptions } from "./game";
import { searchLevel, type AiLevel } from "./ai";
import { loadWeights, setNnueWeights, type SerializedWeights } from "./nnue";
import { deserializeGame, type SerializedGame } from "./serialize";

export interface AiCandidate {
  from: Square;
  to: Square;
  options: ApplyMoveOptions;
}

export interface AiSearchRequest {
  id: number;
  game: SerializedGame;
  level: AiLevel;
  seed: number;
}

export interface AiSearchResponse {
  id: number;
  candidate: AiCandidate | null;
  // Search diagnostics, for the main thread's speed log.
  score: number;
  nodes: number;
  timeMs: number;
  method: "nnue" | "pst";
  depth: number;
}

// Fetch the net once, best-effort. A failure (missing file, offline) simply
// leaves Fun on the PST fallback — the game stays fully playable either way.
fetch(`${import.meta.env.BASE_URL}net-weights.json`)
  .then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
  .then((serialized: SerializedWeights) => setNnueWeights(loadWeights(serialized)))
  .catch(() => setNnueWeights(null));

self.onmessage = (e: MessageEvent<AiSearchRequest>) => {
  const { id, game, level, seed } = e.data;
  const r = searchLevel(deserializeGame(game), level, seed);
  const response: AiSearchResponse = {
    id,
    candidate: r.move,
    score: r.score,
    nodes: r.nodes,
    timeMs: r.timeMs,
    method: r.method,
    depth: r.depth,
  };
  (self as unknown as { postMessage(data: AiSearchResponse): void }).postMessage(response);
};
