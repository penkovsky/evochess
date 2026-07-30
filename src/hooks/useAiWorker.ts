import { useEffect, useRef, useState, type RefObject } from "react";
import type { Color } from "chess.js";
import type { EvoChessGame } from "../evochess/game";
import { serializeGame } from "../evochess/serialize";
import type {
  AiCandidate,
  AiSearchRequest,
  AiSearchResponse,
  NnueStatusMessage,
  PonderPredictionMessage,
  PonderStatusMessage,
  WorkerRequest,
} from "../evochess/ai.worker";
import type { AiLevel } from "../evochess/ai";
import type { Mode } from "../appTypes";

/** Values a caller may hold before React state has caught up to them. */
export interface EngineOverrides {
  mode?: Mode;
  aiColor?: Color;
  level?: AiLevel;
  ponderEnabled?: boolean;
}

export interface UseAiWorker {
  /** Whether the worker has finished fetching the NNUE weights. */
  nnueReady: boolean;
  searchInWorker: (game: EvoChessGame, level: AiLevel, seed: number) => Promise<AiCandidate | null>;
  resetPonder: () => void;
  stopPonder: () => void;
  maybeStartPonder: (game: EvoChessGame, overrides?: EngineOverrides) => void;
}

export interface UseAiWorkerArgs {
  gameRef: RefObject<EvoChessGame>;
  /** An unverified shared position never reaches the search (share-links-spec.md §5.2). */
  engineLockedRef: RefObject<boolean>;
  mode: Mode;
  aiColor: Color;
  level: AiLevel;
  ponderEnabled: boolean;
}

/**
 * The search worker and its ponder protocol (docs/ponder-spec.md). Runs
 * chooseMove off the main thread so the board stays responsive while the AI is
 * thinking, and keeps the worker's transposition table warm between moves.
 */
export function useAiWorker({
  gameRef,
  engineLockedRef,
  mode,
  aiColor,
  level,
  ponderEnabled,
}: UseAiWorkerArgs): UseAiWorker {
  // Reflects the worker's NNUE weights fetch, purely for the status underline
  // color — the worker owns the weights and posts this once its own
  // `nnueReady` promise settles (see ai.worker.ts).
  const [nnueReady, setNnueReady] = useState(false);
  const aiWorkerRef = useRef<Worker | null>(null);
  // Tags each request so a stale response (e.g. after a takeback) can't be
  // mistaken for the latest one.
  const searchIdRef = useRef(0);

  useEffect(() => {
    const worker = new Worker(new URL("../evochess/ai.worker.ts", import.meta.url), { type: "module" });
    aiWorkerRef.current = worker;
    const handleStatus = (e: MessageEvent<NnueStatusMessage | PonderStatusMessage | unknown>) => {
      const data = e.data as { kind?: string; ready?: boolean };
      if (data?.kind === "nnue-status") setNnueReady(!!data.ready);
      if (data?.kind === "ponder-status") {
        // The depth a ponder chain reaches is otherwise invisible — it posts
        // no result, and its whole product is transposition-table entries.
        // `phase` names which of the two searches a chain runs got there:
        // "position" is the one the human is looking at, "predicted" the one
        // their most likely reply leads to (ponder-spec.md §8).
        const p = data as PonderStatusMessage;
        console.log(`[EvoChess ponder] phase=${p.phase} depth=${p.depth} elapsed=${p.elapsedMs}ms`);
      }
      if (data?.kind === "ponder-prediction") {
        // Whether the "predicted" phase above was pondering the position the
        // human actually went on to reach. `actual` is printed on a hit too,
        // so both outcomes read identically.
        const p = data as PonderPredictionMessage;
        console.log(
          `[EvoChess ponder] predicted? ${p.hit ? "True" : "False"} ` +
            `(guessed ${p.predicted} at depth ${p.depth}, played ${p.actual})`
        );
      }
    };
    worker.addEventListener("message", handleStatus);
    return () => {
      worker.removeEventListener("message", handleStatus);
      worker.terminate();
    };
  }, []);

  function searchInWorker(game: EvoChessGame, level: AiLevel, seed: number): Promise<AiCandidate | null> {
    return new Promise((resolve) => {
      const worker = aiWorkerRef.current;
      if (!worker) {
        resolve(null);
        return;
      }
      const id = ++searchIdRef.current;
      const handleMessage = (e: MessageEvent<AiSearchResponse>) => {
        if (e.data.id !== id) return;
        worker.removeEventListener("message", handleMessage);
        const r = e.data;
        const nps = r.timeMs > 0 ? Math.round((r.nodes / r.timeMs) * 1000) : r.nodes;
        console.log(
          `[EvoChess AI] level=${level} method=${r.method} depth=${r.depth} nodes=${r.nodes} ` +
            `time=${r.timeMs.toFixed(0)}ms speed=${nps.toLocaleString()} nodes/sec score=${r.score.toFixed(2)}`
        );
        resolve(r.candidate);
      };
      worker.addEventListener("message", handleMessage);
      const request: AiSearchRequest = { kind: "search", id, game: serializeGame(game), level, seed };
      worker.postMessage(request);
    });
  }

  // Every discontinuity in game state (new game, takeback, mode/color/level
  // change, loading a save) must invalidate the worker's ponder TT — stale
  // analysis from a position that no longer exists on this board must never
  // be reused (ponder-spec.md §5.3, §6.2).
  function resetPonder() {
    const req: WorkerRequest = { kind: "reset" };
    aiWorkerRef.current?.postMessage(req);
  }

  // Ends a running ponder chain but keeps its warm TT — the human has
  // committed to something, so the analysis is still valid and reusable.
  function stopPonder() {
    const req: WorkerRequest = { kind: "stop" };
    aiWorkerRef.current?.postMessage(req);
  }

  // Starts a ponder chain if this is a position worth pondering: the human is
  // on move against the AI at Fun level, with the setting on (§5.5). Called
  // both when the AI's move lands and when a move the human attempted turned
  // out to be illegal — in the latter case the position is unchanged, so the
  // chain we stopped on the way in should resume.
  // `overrides` exists for callers holding a value React state hasn't caught
  // up to yet — the same pattern (and reason) as `maybeAiMove`'s.
  function maybeStartPonder(game: EvoChessGame, overrides?: EngineOverrides) {
    const effMode = overrides?.mode ?? mode;
    const effAiColor = overrides?.aiColor ?? aiColor;
    const effLevel = overrides?.level ?? level;
    const effPonder = overrides?.ponderEnabled ?? ponderEnabled;
    if (engineLockedRef.current) return;
    if (
      effMode === "human-ai" &&
      effLevel === "fun" &&
      effPonder &&
      gameRef.current === game &&
      game.turn !== effAiColor &&
      !game.isGameOver()
    ) {
      const req: WorkerRequest = { kind: "ponder", game: serializeGame(game) };
      aiWorkerRef.current?.postMessage(req);
    }
  }

  return { nnueReady, searchInWorker, resetPonder, stopPonder, maybeStartPonder };
}
