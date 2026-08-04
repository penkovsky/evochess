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
// turn, it re-searches in short slices, deepening the shared bitboard
// transposition table so the next real search starts warm. It does that in two
// phases — the position the human is looking at, then the position their most
// likely reply leads to (ponder-hit; see `PONDER_PREDICT_MS`).
import type { Square } from "chess.js";
import { type ApplyMoveOptions, type EvoChessGame } from "./game";
import { searchLevel, type AiLevel, type CandidateTurn } from "./ai";
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
  /** Easy's fixed-depth move, which returns near-instantly. */
  shallow: boolean;
}

// Fired once (from the `nnueReady` settle below) so the main thread can
// reflect NNUE availability in the UI — the weights live only in this
// worker's module instance, so it's the only place that knows.
export interface NnueStatusMessage {
  kind: "nnue-status";
  ready: boolean;
}

// Emitted whenever a ponder chain completes an iteration deeper than any it
// had completed before, in whichever phase it is in — the depth the chain has
// actually *reached*, which is otherwise invisible: a ponder posts no result,
// and its whole product is TT entries. `phase` distinguishes the two searches
// a chain runs (see `ponderSlice`), since they have separate ladders and their
// depths are not comparable: phase 1 is one ply shallower in the tree.
export interface PonderStatusMessage {
  kind: "ponder-status";
  phase: "position" | "predicted";
  depth: number;
  elapsedMs: number; // since the chain started, so the two phases are legible
}
// Emitted on the first real search after a chain committed to a predicted
// reply: did the human actually play it? Phase 2 bets the whole back half of
// the ponder budget on one line, and that bet is otherwise invisible — a miss
// looks exactly like a hit from the outside, since either way the search just
// returns a move. `actual` is reported alongside `predicted` even on a hit, so
// the line reads the same in both cases.
export interface PonderPredictionMessage {
  kind: "ponder-prediction";
  hit: boolean;
  predicted: string; // move-log notation of the reply phase 2 pondered
  actual: string; // what the human played instead (equal to `predicted` on a hit)
  depth: number; // chain depth behind the prediction, i.e. how informed the bet was
}
export type WorkerMessage =
  | AiSearchResponse
  | NnueStatusMessage
  | PonderStatusMessage
  | PonderPredictionMessage;

// DedicatedWorkerGlobalScope.postMessage(data) takes one argument; jsdom (used
// by tests) has no worker global scope, so `self` there is a plain Window,
// whose postMessage requires a second `targetOrigin` argument. Branch on
// `self.window` (present only on Window) so both real workers and jsdom tests
// get a call shape they accept.
const post = (data: WorkerMessage): void => {
  const g = self as unknown as {
    postMessage(data: WorkerMessage, targetOrigin: string): void;
    window?: unknown;
  };
  if (typeof g.window !== "undefined") g.postMessage(data, "*");
  else g.postMessage(data, undefined as unknown as string);
};

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
    const msg: NnueStatusMessage = { kind: "nnue-status", ready: hasNnueWeights() };
    post(msg);
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
//
// Re-measured against the resumable two-phase chain, sweeping 40/60/90/150ms
// (bench/bench10_slice_ms.ts): the depth the chain reaches is *identical*
// across 40-90ms and a ply worse in one position at 150ms, while the
// stop-latency bound climbs from 65-84ms to 115-129ms at 90ms. Raising it is
// therefore a strictly losing trade, and the ply that slicing does cost
// against one uninterrupted search does not come back at any slice length
// short enough to keep the UI responsive.
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

// Ponder-hit (ponder-spec.md §8, previously out of scope). A chain spends its
// first `PONDER_PREDICT_MS` on the position the human is actually looking at,
// then plays the reply that search likes best and spends the rest on *that*
// position — the one the next real search will most likely have as its root.
//
// Why split rather than switch immediately: the two phases warm different
// things, and only one of them can be wrong. Phase 1 deepens every reply at
// once (the real search's root is a child of it whatever the human plays), so
// it pays off on a miss as well as a hit; phase 2 concentrates on one line and
// pays only on a hit. Half the budget each keeps the guaranteed half intact
// while giving the likely line a depth no breadth-first chain reaches, and
// leaves phase 1 long enough (~3.5s against a measured ~4-6s plateau) for the
// prediction itself to be worth acting on. Deliberately not tuned against a
// hit rate: the opponent is a human, so the rate that matters cannot be
// measured from self-play, and this split is the conservative choice under
// that uncertainty.
const PONDER_PREDICT_MS = 3_500;
// Never predict off an iteration or two of search: a depth-1 root move is
// barely more than static ordering, and committing half the budget to the line
// it names would be a coin flip. Costs nothing — phase 1 is well past this
// depth by the time the window elapses.
const MIN_PREDICT_DEPTH = 3;

// Exposed purely for the milestone-5 tuning test (ponder-spec.md §9), so it
// asserts against the actual constants rather than a copy that can drift.
export const __ponderTuningForTest = {
  SLICE_MS,
  MAX_PONDER_DEPTH,
  PONDER_BUDGET_MS,
  PONDER_PREDICT_MS,
  MIN_PREDICT_DEPTH,
};

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
// derivation exactly: every level defaults `useNnue` to `hasNnueWeights()`.
// Easy's random moves do not enter into it. They skip the search, so they
// neither read nor write the table.
const evalIsNnue = (_level: AiLevel): boolean => hasNnueWeights();

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
// `predicted`/`ponderedFen` report the ponder-hit phase switch: whether the
// live chain has handed over to a predicted reply, and which position it is
// pondering now — the observable that says the handover actually happened,
// rather than a flag that says it was attempted.
export function __ponderStateForTest(): {
  seq: number;
  warm: boolean;
  evalWasNnue: boolean | null;
  mayKeep: Record<AiLevel, boolean>;
  predicted: boolean;
  ponderedFen: string | null;
  prediction: Prediction | null;
} {
  return {
    prediction,
    seq: ponderSeq,
    warm: ttWarm,
    evalWasNnue: ttEvalWasNnue,
    mayKeep: { fun: mayKeepTT("fun"), easy: mayKeepTT("easy"), zen: mayKeepTT("zen") },
    predicted: livePonder?.predicted ?? false,
    ponderedFen: livePonder?.pos.chess.fen() ?? null,
  };
}

// A live ponder chain's state, carried across its slices.
interface PonderChain {
  seq: number; // the `ponderSeq` this chain owns; any other value ends it
  pos: EvoChessGame; // the position currently being pondered (see `predicted`)
  depth: number; // ladder position: the iteration the next slice attempts first
  best: CandidateTurn | null; // root move of the deepest iteration completed here
  until: number; // wall-clock end of the whole chain
  predictUntil: number; // when phase 1 hands over to phase 2
  predicted: boolean; // has the phase switch been attempted? (once per chain)
  started: number; // chain start, for the elapsed figure in `ponder-status`
  reported: number; // deepest depth already reported for the current phase
}

// The live chain, for `__ponderStateForTest` only — the chain itself runs off
// the object threaded through `ponderSlice`, and staleness is decided by
// `seq`, not by this reference.
let livePonder: PonderChain | null = null;

// The reply the last chain handed over to, held until the next real search can
// say whether the human played it. Deliberately outlives the chain itself:
// `stop` clears `livePonder` and is sent *because* the human moved, so the
// verdict is only knowable after the chain the prediction belonged to is gone.
// Compared by resulting position rather than by move, since that is what phase
// 2 actually warmed — two routes to the same position are a hit.
interface Prediction {
  fen: string; // the position the predicted reply leads to
  san: string; // its move-log note, for the log line
  depth: number; // the chain's completed depth when it committed
}
let prediction: Prediction | null = null;

// The position after `move`, or null if there is no point pondering it: the
// move does not apply (a move the search returned always should, so this is
// belt and braces), or it ends the game, leaving no subtree to warm.
function afterMove(pos: EvoChessGame, move: CandidateTurn): EvoChessGame | null {
  const next = pos.copy();
  try {
    next.applyMove(move.from, move.to, move.options);
  } catch {
    return null;
  }
  return next.isGameOver() ? null : next;
}

// One slice of a ponder chain. `c.depth` is the iteration this slice should
// attempt first — the chain's ladder position, carried across slices rather
// than restarted at 1.
//
// Measured, this is worth between zero and one ply — not the fix for the depth
// plateau it looks like (bench/bench8_ponder_resume.ts, and see the plateau
// note on `PONDER_BUDGET_MS` above). The re-walk it removes was nearly free:
// against a warm TT the d=1..n-1 iterations a restarting chain repeats are
// answered mostly out of the table, so they were never where a slice's time
// went. What the plateau actually costs is measurable a different way — one
// uninterrupted 7s search reaches depth 8-9 where 7s of 40ms slices reaches
// 7-8 — and that missing ply is work the abort throws away and no table
// recovers: quiescence, which `evoSearch.ts` never caches, and deep entries
// evicted from an always-replace table by the shallow ones above them.
// Resuming is kept because it is strictly less wasted work and makes the
// chain's ladder position explicit, not because it bought depth.
function ponderSlice(c: PonderChain): void {
  if (ponderSeq !== c.seq) return; // superseded, stopped, or reset
  const r = searchLevel(c.pos, "fun", PONDER_SEED, {
    timeMs: SLICE_MS,
    keepTT: mayKeepTT("fun"),
    startDepth: c.depth,
  });
  ttWarm = true;
  ttEvalWasNnue = evalIsNnue("fun");
  // `r.depth` is the deepest iteration that completed *in this slice*, or 0 if
  // the slice's deadline cut the first one short. Advance on progress; on none,
  // retry the same depth — the aborted attempt still wrote every subtree it
  // finished, so the retry starts from a strictly better table than it did.
  if (r.depth > 0) {
    c.depth = r.depth + 1;
    c.best = r.move;
    // Report only genuine progress. A slice that re-completes a depth an
    // earlier slice already reached (possible after a retry) is not news, and
    // a chain runs on the order of a hundred slices.
    if (r.depth > c.reported) {
      c.reported = r.depth;
      post({
        kind: "ponder-status",
        phase: c.predicted ? "predicted" : "position",
        depth: r.depth,
        elapsedMs: Date.now() - c.started,
      });
    }
  }

  // Phase 1 → 2: hand over to the predicted reply, once (whether or not the
  // handover finds somewhere to go — retrying it every slice would just spend
  // the rest of the chain re-deciding). Saturating phase 1 triggers it early:
  // there is nothing left to gain here, and the alternative is idling.
  //
  // The depth gate reads the *chain's* ladder (`c.depth - 1` is its deepest
  // completed iteration), not this slice's `r.depth`. Once the ladder is deep
  // enough that an iteration spans several slices, most slices complete
  // nothing and report 0 — gating on that would keep the handover from ever
  // firing, exactly in the positions where it is worth the most.
  const now = Date.now();
  const saturated = c.depth > MAX_PONDER_DEPTH;
  if (!c.predicted && (saturated || now >= c.predictUntil) && c.depth - 1 >= MIN_PREDICT_DEPTH && c.best) {
    c.predicted = true;
    const depth = c.depth - 1;
    const next = afterMove(c.pos, c.best);
    if (next) {
      prediction = {
        fen: next.chess.fen(),
        san: next.moveLog[next.moveLog.length - 1] ?? `${c.best.from}${c.best.to}`,
        depth,
      };
      c.pos = next;
      c.depth = 1; // new root, new ladder; the shared TT carries over as-is
      c.best = null;
      c.reported = 0; // phase 2's ladder is its own; report it from scratch
    }
  }

  if (c.depth > MAX_PONDER_DEPTH) return; // saturated with nowhere left to go
  // Wall-clock backstop, and still the cap that binds first: even resumed, the
  // ladder reaches 7-8 inside `PONDER_BUDGET_MS`, not `MAX_PONDER_DEPTH`, so
  // without this the chain would burn CPU for as long as the human thinks —
  // the §10 battery risk the depth cap was meant to mitigate.
  if (now >= c.until) return;
  setTimeout(() => ponderSlice(c), 0); // yield: lets stop/reset/search arrive
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  switch (m.kind) {
    case "reset":
      ponderSeq++;
      livePonder = null;
      prediction = null; // the position it was made from is gone
      ttWarm = false; // next search wipes the TT via the normal GEN++ path
      ttEvalWasNnue = null;
      return;

    case "stop":
      ponderSeq++; // ttWarm deliberately left alone: the work is still valid
      livePonder = null; // the chain is over; its TT entries are not
      return;

    case "ponder": {
      if (!nnueSettled) return; // §6.1: don't mix PST and NNUE scores in one TT
      const mine = ++ponderSeq;
      // A prediction belongs to the chain that made it. Restarting a chain on
      // the same position (the illegal-move path) means this one will make its
      // own; carrying the old one over would credit a chain for a bet a
      // different chain placed.
      prediction = null;
      // A fresh chain always starts its ladder at 1: the position is new, so
      // no shallower iteration has been completed against this table for it.
      const now = Date.now();
      livePonder = {
        seq: mine,
        pos: deserializeGame(m.game),
        depth: 1,
        best: null,
        until: now + PONDER_BUDGET_MS,
        predictUntil: now + PONDER_PREDICT_MS,
        predicted: false,
        started: now,
        reported: 0,
      };
      ponderSlice(livePonder);
      return;
    }

    case "search": {
      ponderSeq++; // a search always ends pondering
      const game = deserializeGame(m.game);
      // This search's root is the position the human's move produced, which is
      // exactly what a prediction named — so the verdict is available here and
      // nowhere else. Reported before searching, so the log line lands even if
      // the search below is slow.
      if (prediction !== null) {
        const fen = game.chess.fen();
        post({
          kind: "ponder-prediction",
          hit: fen === prediction.fen,
          predicted: prediction.san,
          actual: game.moveLog[game.moveLog.length - 1] ?? "?",
          depth: prediction.depth,
        });
        prediction = null; // one verdict per prediction
      }
      const r = searchLevel(game, m.level, m.seed, {
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
        shallow: !!r.shallow,
      };
      post(response);
      return;
    }
  }
};
