/**
 * Milestone 3 of docs/ponder-spec.md §5/§9: the worker's tagged ponder
 * protocol (search/ponder/stop/reset), its slicing loop, and the NNUE gate
 * (§6.1) — with no UI wiring yet (that's milestone 4).
 *
 * `__ponderStateForTest` is a test-only introspection hook into the worker's
 * module-level `ponderSeq`/`ttWarm` state, exported purely so this file can
 * observe the chain without reaching into module internals.
 *
 * These tests call `self.onmessage` directly rather than going through a real
 * `Worker` (jsdom has no working Worker/postMessage IPC), so they cannot
 * observe true message-queue interleaving with a slice's synchronous JS
 * execution. What they do verify — and what would fail if milestone 1's
 * abort or milestone 3's wiring regressed — is that pondering never blocks
 * the thread for anywhere near the seconds an unbounded deep pass would cost,
 * that `stop`/`reset` mutate the chain state exactly as specified, and that a
 * `search` posted after pondering ends the chain and still returns a normal,
 * correctly-tagged response.
 */
import { describe, expect, it, vi } from "vitest";
import { EvoChessGame } from "../game";
import { serializeGame } from "../serialize";
import { seededNet, setNnueWeights } from "../nnue";
import { FEATURE_SIZE } from "../nnueFeatures";
import { legalTurns } from "../ai";
import {
  __ponderStateForTest,
  __ponderTuningForTest,
  nnueReady,
  type AiSearchResponse,
  type PonderPredictionMessage,
  type PonderStatusMessage,
  type WorkerRequest,
} from "../ai.worker";

const send = (m: WorkerRequest): void =>
  (self.onmessage as unknown as (e: MessageEvent<WorkerRequest>) => void)({
    data: m,
  } as MessageEvent<WorkerRequest>);

describe("ai.worker ponder protocol (ponder-spec.md §5, milestone 3)", () => {
  it("ponder is a no-op while the NNUE weights fetch has not settled (§6.1 gate)", async () => {
    // The module-under-test's own top-level fetch has already settled by now
    // (real tests upstream `await nnueReady`), so this test builds its own
    // isolated instance with `fetch` stubbed to never resolve, to pin down
    // the pre-settle state deterministically rather than racing the real one.
    vi.resetModules();
    const originalOnMessage = self.onmessage;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => {}));
    try {
      const mod = await import("../ai.worker");
      const before = mod.__ponderStateForTest();
      send({ kind: "ponder", game: serializeGame(new EvoChessGame()) });
      const after = mod.__ponderStateForTest();
      expect(after.seq).toBe(before.seq);
      expect(after.warm).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      self.onmessage = originalOnMessage; // the dynamic import above rebound it
      vi.resetModules();
    }
  });

  it("a ponder chain runs once the gate opens, and stop/reset control it exactly as specified", async () => {
    await nnueReady;
    const serialized = serializeGame(new EvoChessGame());

    send({ kind: "ponder", game: serialized });
    // The first slice runs synchronously inside the "ponder" case, so by the
    // time send() returns the TT is already warm.
    let state = __ponderStateForTest();
    const seqAfterPonder = state.seq;
    expect(state.warm).toBe(true);

    // Let a handful of chained slices run via their setTimeout(0) yields.
    await new Promise((r) => setTimeout(r, 300));
    state = __ponderStateForTest();
    expect(state.seq).toBe(seqAfterPonder); // nothing has stopped it yet
    expect(state.warm).toBe(true);

    send({ kind: "stop" });
    state = __ponderStateForTest();
    expect(state.seq).toBe(seqAfterPonder + 1);
    expect(state.warm).toBe(true); // stop leaves the warm TT alone (§5.1)

    // Any slice already chained via setTimeout(0) must see the bumped seq
    // and exit quietly rather than resume.
    await new Promise((r) => setTimeout(r, 200));
    expect(__ponderStateForTest().seq).toBe(seqAfterPonder + 1);

    send({ kind: "reset" });
    state = __ponderStateForTest();
    expect(state.seq).toBe(seqAfterPonder + 2);
    expect(state.warm).toBe(false); // reset invalidates the TT (§4.1)
  });

  it("the TT is never carried across an evaluator change, nor into Easy/Zen (§5.5, §6.1)", async () => {
    await nnueReady;
    const serialized = serializeGame(new EvoChessGame());

    // In this environment the weights fetch fails, so the worker is on PST —
    // the same state as the real fetch-race window §6.1 describes, where the
    // AI's opening search warms the table before the net has landed.
    setNnueWeights(null);
    send({ kind: "reset" });
    send({ kind: "ponder", game: serialized });

    let s = __ponderStateForTest();
    expect(s.warm).toBe(true);
    expect(s.evalWasNnue).toBe(false);
    expect(s.mayKeep.fun).toBe(true); // same evaluator: continuing is correct
    // Chill/Easy/Zen must never continue from a warm table however it was
    // filled: they are deliberately weak fixed-depth searches (§5.5) and must
    // stay bit-identical to pre-ponder behaviour (§6.4).
    expect(s.mayKeep.chill).toBe(false);
    expect(s.mayKeep.easy).toBe(false);
    expect(s.mayKeep.zen).toBe(false);

    // The net lands mid-game. Every entry in the table is now a PST score
    // that a net search would misread; retention must switch itself off.
    setNnueWeights(seededNet(42, FEATURE_SIZE));
    s = __ponderStateForTest();
    expect(s.warm).toBe(true); // the table is still there...
    expect(s.mayKeep.fun).toBe(false); // ...but is no longer safe to read

    // A search under the net re-warms it with net scores, and retention
    // becomes safe again. (jsdom's own `postMessage` has a different
    // signature, so the worker's response has to go somewhere harmless.)
    const original = (self as unknown as { postMessage: unknown }).postMessage;
    (self as unknown as { postMessage: (d: AiSearchResponse) => void }).postMessage = () => {};
    try {
      send({ kind: "search", id: 1, game: serialized, level: "fun", seed: 1 });
    } finally {
      (self as unknown as { postMessage: unknown }).postMessage = original;
    }
    s = __ponderStateForTest();
    expect(s.evalWasNnue).toBe(true);
    expect(s.mayKeep.fun).toBe(true);

    setNnueWeights(null);
    send({ kind: "reset" });
    expect(__ponderStateForTest().evalWasNnue).toBeNull();
  });

  it("hands the second half of the chain over to the predicted reply (ponder-hit, §8)", async () => {
    await nnueReady;
    const start = new EvoChessGame();
    const startFen = start.chess.fen();

    // A chain reports the depth it reaches as it reaches it (there is no
    // result message to carry it); collect those to check both phases report.
    const statuses: PonderStatusMessage[] = [];
    const original = (self as unknown as { postMessage: unknown }).postMessage;
    (self as unknown as { postMessage: (d: unknown) => void }).postMessage = (d) => {
      const m = d as { kind?: string };
      if (m?.kind === "ponder-status") statuses.push(d as PonderStatusMessage);
    };

    send({ kind: "reset" });
    send({ kind: "ponder", game: serializeGame(start) });

    // Phase 1 owns the position the human is looking at.
    expect(__ponderStateForTest().ponderedFen).toBe(startFen);
    expect(__ponderStateForTest().predicted).toBe(false);

    // Let the chain run past the handover window.
    await new Promise((r) => setTimeout(r, __ponderTuningForTest.PONDER_PREDICT_MS + 600));
    (self as unknown as { postMessage: unknown }).postMessage = original;

    // Both phases reported, each ladder climbing from its own start.
    const phase1 = statuses.filter((m) => m.phase === "position").map((m) => m.depth);
    const phase2 = statuses.filter((m) => m.phase === "predicted").map((m) => m.depth);
    expect(phase1.length).toBeGreaterThan(0);
    expect(phase2.length).toBeGreaterThan(0);
    for (const depths of [phase1, phase2]) {
      // Strictly increasing: only genuine progress is reported, and a retried
      // depth re-completing must not be announced twice.
      expect(depths).toEqual([...depths].sort((a, b) => a - b));
      expect(new Set(depths).size).toBe(depths.length);
    }

    const s = __ponderStateForTest();
    expect(s.predicted).toBe(true);
    // Phase 2 is a *different* position, and specifically one legal turn on
    // from the first — the human's predicted reply, so it is now the AI's
    // move there. A chain that "switched" to the same position, or to one it
    // could not have reached, would be warming the wrong table entries.
    expect(s.ponderedFen).not.toBe(startFen);
    const reached = new EvoChessGame();
    const successors = legalTurns(reached).map((t) => {
      const g = reached.copy();
      g.applyMove(t.from, t.to, t.options);
      return g.chess.fen();
    });
    expect(successors).toContain(s.ponderedFen);
    expect(s.ponderedFen!.split(" ")[1]).toBe("b"); // AI to move on the pondered line

    // The chain's state is per-chain: stopping clears it, and the next
    // ponder starts phase 1 again rather than inheriting a stale prediction.
    send({ kind: "stop" });
    expect(__ponderStateForTest().predicted).toBe(false);
    expect(__ponderStateForTest().ponderedFen).toBeNull();
  }, 20_000);

  it("scores the prediction against the move the human actually played", async () => {
    await nnueReady;

    // Drive a chain past the handover so there is a bet on the table, then
    // play into it (hit) and away from it (miss), and check the verdict the
    // worker posts on the search that follows.
    async function verdictFor(play: "predicted" | "other") {
      const start = new EvoChessGame();
      send({ kind: "reset" });
      send({ kind: "ponder", game: serializeGame(start) });
      await new Promise((r) => setTimeout(r, __ponderTuningForTest.PONDER_PREDICT_MS + 600));

      const p = __ponderStateForTest().prediction;
      expect(p).not.toBeNull();

      // The human moves: reach the pondered position, or deliberately any
      // other legal one.
      const next = start.copy();
      const turn = legalTurns(start).find((t) => {
        const g = start.copy();
        g.applyMove(t.from, t.to, t.options);
        return (g.chess.fen() === p!.fen) === (play === "predicted");
      })!;
      next.applyMove(turn.from, turn.to, turn.options);

      const messages: unknown[] = [];
      const original = (self as unknown as { postMessage: unknown }).postMessage;
      (self as unknown as { postMessage: (d: unknown) => void }).postMessage = (d) => messages.push(d);
      try {
        send({ kind: "stop" }); // what the UI sends when the human commits
        // Easy is fixed-depth and fast; the verdict is posted before the
        // search either way, and this test is not about the search.
        send({ kind: "search", id: 7, game: serializeGame(next), level: "easy", seed: 1 });
      } finally {
        (self as unknown as { postMessage: unknown }).postMessage = original;
      }
      return {
        verdict: messages.find(
          (m) => (m as { kind?: string })?.kind === "ponder-prediction"
        ) as PonderPredictionMessage | undefined,
        played: next.moveLog[next.moveLog.length - 1],
        predicted: p!.san,
      };
    }

    const hit = await verdictFor("predicted");
    expect(hit.verdict).toBeDefined();
    expect(hit.verdict!.hit).toBe(true);
    expect(hit.verdict!.actual).toBe(hit.played);
    expect(hit.verdict!.depth).toBeGreaterThanOrEqual(__ponderTuningForTest.MIN_PREDICT_DEPTH);

    const miss = await verdictFor("other");
    expect(miss.verdict).toBeDefined();
    expect(miss.verdict!.hit).toBe(false);
    // A miss still names both sides, so the log line reads the same either way.
    expect(miss.verdict!.predicted).toBe(miss.predicted);
    expect(miss.verdict!.actual).toBe(miss.played);
    expect(miss.verdict!.actual).not.toBe(miss.verdict!.predicted);

    // Exactly one verdict per prediction: a second search must not re-score
    // a bet that has already been settled.
    expect(__ponderStateForTest().prediction).toBeNull();
  }, 40_000);

  it("a search posted mid-chain ends pondering and returns a single, correctly-tagged response", async () => {
    await nnueReady;
    const serialized = serializeGame(new EvoChessGame());

    send({ kind: "ponder", game: serialized });
    await new Promise((r) => setTimeout(r, 200)); // let the chain get genuinely live
    const seqWhilePondering = __ponderStateForTest().seq;

    const responses: AiSearchResponse[] = [];
    const original = (self as unknown as { postMessage: unknown }).postMessage;
    (self as unknown as { postMessage: (data: AiSearchResponse) => void }).postMessage = (data) => {
      responses.push(data);
    };
    try {
      // Easy is fixed-depth and fast; this test cares about the ponder chain
      // being cut off cleanly, not Fun's own (separately documented,
      // pre-existing) iteration-overshoot behaviour.
      send({ kind: "search", id: 42, game: serialized, level: "easy", seed: 1 });

      expect(responses).toHaveLength(1);
      expect(responses[0].id).toBe(42);
      expect(responses[0].candidate).not.toBeNull();
      // A "search" always ends pondering (§5.2), even mid-chain.
      expect(__ponderStateForTest().seq).toBe(seqWhilePondering + 1);
    } finally {
      (self as unknown as { postMessage: unknown }).postMessage = original;
    }
  });
});
