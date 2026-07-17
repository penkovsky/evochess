// Runs the minimax search off the main thread so the board stays responsive
// (highlights, scrolling, takeback) while the AI is thinking, instead of
// freezing the tab for the duration of the search.
import type { Square } from "chess.js";
import { type ApplyMoveOptions } from "./game";
import { chooseMove } from "./ai";
import { deserializeGame, type SerializedGame } from "./serialize";

export interface AiCandidate {
  from: Square;
  to: Square;
  options: ApplyMoveOptions;
}

export interface AiSearchRequest {
  id: number;
  game: SerializedGame;
  depth: number;
  seed: number;
}

export interface AiSearchResponse {
  id: number;
  candidate: AiCandidate | null;
}

self.onmessage = (e: MessageEvent<AiSearchRequest>) => {
  const { id, game, depth, seed } = e.data;
  const candidate = chooseMove(deserializeGame(game), depth, seed);
  const response: AiSearchResponse = { id, candidate };
  (self as unknown as { postMessage(data: AiSearchResponse): void }).postMessage(response);
};
