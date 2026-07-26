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
//
// The worker also owns pondering (docs/ponder-spec.md): while it's the human's
// turn, it re-searches the current position in short slices, deepening the
// shared bitboard transposition table so the next real search starts warm.
import type { Square } from "chess.js";
import { type ApplyMoveOptions, type EvoChessGame } from "./game";
import { searchLevel, type AiLevel } from "./ai";
import { hasNnueWeights, loadWeights, setNnueWeights, type SerializedWeights } from "./nnue";
import { deserializeGame, type SerializedGame } from "./serialize";

export interface AiCandidate {
  from: Square;
  to: Square;
  options: ApplyMoveOptions;
}

// The worker's tagged message protocol (ponder-spec.md §5.1).
export interface AiSearchRequest {
  kind: "search";
  id: number;
  game: SerializedGame;
  level: AiLevel;
  seed: number;
}
export interface PonderRequest {
  kind: "ponder";
  game: SerializedGame;
}
export interface StopRequest {
  kind: "stop"; // human moved: end the ponder chain, keep the warm TT
}
export interface ResetRequest {
  kind: "reset"; // new game / takeback: end the chain and invalidate the TT
}
export type WorkerRequest = AiSearchRequest | PonderRequest | StopRequest | ResetRequest;

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
// `nnueSettled` gates pondering (§6.1): starting a ponder chain before the
// fetch resolves risks filling the TT with PST scores that the real search
// (once the net lands) would misread as net scores — one table, two
// evaluations, silently weaker play. `nnueReady` is exported purely so tests
// can await the same settling the gate relies on.
let nnueSettled = false;
export const nnueReady: Promise<void> = fetch(`${import.meta.env.BASE_URL}net-weights.json`)
  .then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
  .then((serialized: SerializedWeights) => setNnueWeights(loadWeights(serialized)))
  .catch(() => setNnueWeights(null))
  .finally(() => {
    nnueSettled = true;
  });

// Ponder tuning (ponder-spec.md §5.2/§9 milestone 5). `SLICE_MS` bounds a
// slice only because of evoSearch.ts's in-search abort (§4.2) — without it
// this constant bounds nothing.
//
// Measured (bench script, opening and a 6-ply-in position, bitboard/PST):
// the abort's 2048-node poll granularity puts per-slice overshoot at a
// roughly constant ~30-60ms *independent of SLICE_MS* (20/40/60ms slices all
// land in that band). So a shorter slice does not cost search efficiency —
// depth-vs-wall-clock growth was the same across 20/40/60ms in the same
// benchmark — but it does lower the worst-case pause after the human moves
// (that pause is bounded by one in-flight slice: `SLICE_MS` + overshoot).
// 40ms was chosen over the original 60ms on that basis.
const SLICE_MS = 40;
// Caps CPU burn once further slices buy little. Measured: depth plateaus
// around 5-7 in both benchmark positions and the cap is never approached
// even after 400 chained slices (~30s) — it does not bind in practice
// (confirming the ponder-spec.md §5.2 amendment) and is kept only as a
// cheap, harmless second condition alongside the wall-clock budget below.
const MAX_PONDER_DEPTH = 12;
// How long a single ponder chain may run before it stops on its own, however
// long the human keeps thinking — the real cap, since the depth cap above
// does not bind. Measured: depth plateaus within ~4-6s in both benchmarked
// positions, and 30s of further chaining past that point bought zero extra
// depth. The original 10s value spent roughly half its budget idling on an
// already-plateaued table; 7s keeps 1-3s of margin past the observed
// plateau (for slower devices or higher-branching positions) while cutting
// most of the measured waste.
const PONDER_BUDGET_MS = 7_000;
// Fixed, not random: pondering only wants cache fill, and a deterministic
// root tie-break makes slices reproducible for testing (§5.2).
const PONDER_SEED = 424242;

// Exposed purely for the milestone-5 tuning test (ponder-spec.md §9), so it
// asserts against the actual constants rather than a copy that can drift.
export const __ponderTuningForTest = { SLICE_MS, MAX_PONDER_DEPTH, PONDER_BUDGET_MS };

// Bumped by every ponder/stop/reset; a live chain checks this before each
// slice and exits the instant it no longer matches, so a stale chain (human
// moved, position changed, or a fresh ponder superseded it) stops on its own
// without needing a message to interrupt a running slice.
let ponderSeq = 0;
// Has anything been pondered (or searched) since the last `reset`? Threaded
// into `searchLevel`'s `keepTT` so a real search continues from the ponder's
// warm TT instead of the normal wipe-by-generation-bump behaviour.
let ttWarm = false;
// *Which evaluator* filled the warm table — the missing half of `ttWarm`.
// A TT entry stores a bare number with no record of what produced it, and PST
// and net scores are not interchangeable (§6.1): reading one as the other is
// silently weaker play with no crash and nothing in the logs. `nnueSettled`
// alone does not cover this, because it gates only the ponder — the AI's
// opening search can itself run (and warm the table with) PST before the
// fetch resolves, and the next search, now with a net, would read those
// entries as net scores. Recording the evaluator makes the mismatch
// detectable wherever it arises rather than at each call site.
let ttEvalWasNnue: boolean | null = null;

// The evaluator `searchLevel` will pick for this level, mirroring its own
// derivation exactly: Zen and Fun default `useNnue` to `hasNnueWeights()`,
// Easy passes `false` outright.
const evalIsNnue = (level: AiLevel): boolean => level !== "easy" && hasNnueWeights();

// Whether a search at `level` may continue from the current table.
// Two conditions, both necessary:
//  - same evaluator, per `ttEvalWasNnue` above;
//  - Fun only. §5.5: pondering (and thus TT continuation) only ever happens
//    at Fun — Easy and Zen never ponder, so a warm TT there would make them
//    stronger than intended, and §6.4 requires them to stay bit-identical to
//    pre-ponder behaviour.
const mayKeepTT = (level: AiLevel): boolean =>
  level === "fun" && ttWarm && ttEvalWasNnue === evalIsNnue(level);

// Test-only introspection into the chain state above (not read by any
// production code): lets unit tests observe stop/reset/gate behaviour
// without reaching into module internals.
// `mayKeep` reports the live `mayKeepTT` decision per level rather than a
// recorded one, so a test can assert the retention rule itself — the thing
// that has to hold — instead of a side effect of it.
export function __ponderStateForTest(): {
  seq: number;
  warm: boolean;
  evalWasNnue: boolean | null;
  mayKeep: Record<AiLevel, boolean>;
} {
  return {
    seq: ponderSeq,
    warm: ttWarm,
    evalWasNnue: ttEvalWasNnue,
    mayKeep: { fun: mayKeepTT("fun"), easy: mayKeepTT("easy"), zen: mayKeepTT("zen") },
  };
}

function ponderSlice(pos: EvoChessGame, mine: number, until: number): void {
  if (ponderSeq !== mine) return; // superseded, stopped, or reset
  const r = searchLevel(pos, "fun", PONDER_SEED, { timeMs: SLICE_MS, keepTT: mayKeepTT("fun") });
  ttWarm = true;
  ttEvalWasNnue = evalIsNnue("fun");
  if (r.depth >= MAX_PONDER_DEPTH) return; // saturated; stop burning CPU
  // Wall-clock backstop. `MAX_PONDER_DEPTH` turns out not to bind in practice
  // — measured, the chain plateaus around depth 7 and never reaches 12 — so
  // without this the chain would burn CPU for as long as the human thinks,
  // which is the §10 battery risk the depth cap was supposed to mitigate.
  if (Date.now() >= until) return;
  setTimeout(() => ponderSlice(pos, mine, until), 0); // yield: lets stop/reset/search arrive
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  switch (m.kind) {
    case "reset":
      ponderSeq++;
      ttWarm = false; // next search wipes the TT via the normal GEN++ path
      ttEvalWasNnue = null;
      return;

    case "stop":
      ponderSeq++; // ttWarm deliberately left alone: the work is still valid
      return;

    case "ponder": {
      if (!nnueSettled) return; // §6.1: don't mix PST and NNUE scores in one TT
      const mine = ++ponderSeq;
      ponderSlice(deserializeGame(m.game), mine, Date.now() + PONDER_BUDGET_MS);
      return;
    }

    case "search": {
      ponderSeq++; // a search always ends pondering
      const r = searchLevel(deserializeGame(m.game), m.level, m.seed, {
        keepTT: mayKeepTT(m.level),
      });
      ttWarm = true;
      ttEvalWasNnue = evalIsNnue(m.level);
      const response: AiSearchResponse = {
        id: m.id,
        candidate: r.move,
        score: r.score,
        nodes: r.nodes,
        timeMs: r.timeMs,
        method: r.method,
        depth: r.depth,
      };
      (self as unknown as { postMessage(data: AiSearchResponse): void }).postMessage(response);
      return;
    }
  }
};
