/**
 * Experiments 7 + 8 re-measured at HEAD, with the *shipped* net
 * (public/net-weights.json), not a seeded one:
 *   - per-eval cost: PST vs from-scratch NNUE (Option B) vs incremental
 *     accumulator (the live path);
 *   - whole-search cost: `searchEvoTT` with PST vs with NNUE, equal depth.
 */
import { readFileSync } from "node:fs";
import { sampleCorpus } from "./corpus";
import { fromEvoGame, applyEvoTurn, generateEvoTurns, undoEvoTurn } from "../src/evochess/evoBitboard";
import { evalEvo, searchEvoTT } from "../src/evochess/evoSearch";
import { loadWeights, setNnueWeights, getNnueWeights, forwardActive, type SerializedWeights } from "../src/evochess/nnue";
import {
  activeIndicesFromEvoPos, applyAccum, createAccStack, evalAcc, refresh,
} from "../src/evochess/nnueAccum";

const serialized = JSON.parse(readFileSync("public/net-weights.json", "utf8")) as SerializedWeights;
const weights = loadWeights(serialized);
setNnueWeights(weights);
console.log(`# shipped net: ${weights.featureSize} → ${weights.hidden1} → ${weights.hidden2} → 1\n`);

const games = sampleCorpus(12);
const positions = games.map(fromEvoGame);

function bench(label: string, fn: () => void, iters: number): number {
  for (let i = 0; i < 200; i++) fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = performance.now() - t0;
  const per = ms / (iters * positions.length);
  console.log(`${label.padEnd(34)} ${per.toFixed(5)} ms/eval`);
  return per;
}

// ---- per-eval cost ------------------------------------------------------
console.log(`## Per-eval cost (12 positions, tight loop, no search)`);

const pst = bench("PST (evalEvo)", () => {
  for (const p of positions) evalEvo(p);
}, 2000);

const scratch = bench("NNUE from-scratch (indexer)", () => {
  for (const p of positions) forwardActive(weights, activeIndicesFromEvoPos(p));
}, 200);

// Incremental: parent accumulator already refreshed, cost of one child move.
// This is the real in-search case: apply a turn, update the accumulator, eval.
const stack = createAccStack(weights, 4);
const childCases = positions.map((p) => {
  refresh(stack[0], p, weights);
  const turns = generateEvoTurns(p);
  return { pos: p, turn: turns[0] };
}).filter((c) => c.turn);

void (() => {
  const run = () => {
    for (const c of childCases) {
      refresh(stack[0], c.pos, weights); // parent state, as the search would have it
      const u = applyEvoTurn(c.pos, c.turn);
      applyAccum(stack, 0, c.pos, c.turn, u, weights);
      evalAcc(stack[1], c.pos.us as 0 | 1, weights);
      undoEvoTurn(c.pos, u);
    }
  };
  for (let i = 0; i < 50; i++) run();
  const t0 = performance.now();
  const iters = 200;
  for (let i = 0; i < iters; i++) run();
  const ms = performance.now() - t0;
  // Subtract the parent `refresh` we pay only because this is a microbenchmark:
  // report both, since the refresh is not part of the in-search incremental cost.
  const perWithRefresh = ms / (iters * childCases.length);
  console.log(`${"NNUE incremental (+parent refresh)".padEnd(34)} ${perWithRefresh.toFixed(5)} ms/eval`);
  return perWithRefresh;
})();

// Incremental alone: refresh once, then repeatedly apply/undo the same move.
const incrOnly = (() => {
  const run = () => {
    for (const c of childCases) {
      const u = applyEvoTurn(c.pos, c.turn);
      applyAccum(stack, 0, c.pos, c.turn, u, weights);
      evalAcc(stack[1], c.pos.us as 0 | 1, weights);
      undoEvoTurn(c.pos, u);
    }
  };
  for (const c of childCases) refresh(stack[0], c.pos, weights);
  for (let i = 0; i < 200; i++) run();
  const t0 = performance.now();
  const iters = 1000;
  for (let i = 0; i < iters; i++) run();
  const ms = performance.now() - t0;
  const per = ms / (iters * childCases.length);
  console.log(`${"NNUE incremental (delta only)".padEnd(34)} ${per.toFixed(5)} ms/eval`);
  return per;
})();

console.log(`\nfrom-scratch vs PST:        ${(scratch / pst).toFixed(1)}×`);
console.log(`incremental vs PST:         ${(incrOnly / pst).toFixed(1)}×`);
console.log(`incremental vs from-scratch: ${(scratch / incrOnly).toFixed(2)}× faster`);

// ---- whole-search cost --------------------------------------------------
console.log(`\n## Whole search, searchEvoTT, 12 positions`);
console.log(`| depth | eval | nodes | wall ms | nodes/s | ms/node |`);
console.log(`|------:|------|------:|--------:|--------:|--------:|`);
for (const d of [3, 4]) {
  for (const useNnue of [false, true]) {
    let nodes = 0, ms = 0;
    for (const g of games) {
      const s = fromEvoGame(g);
      const t0 = performance.now();
      const r = searchEvoTT(s, d, 1, useNnue);
      ms += performance.now() - t0;
      nodes += r.nodes;
    }
    console.log(
      `| ${d} | ${useNnue ? "NNUE" : "PST "} | ${nodes.toLocaleString()} | ${ms.toFixed(0)} | ` +
      `${(nodes / (ms / 1000)).toFixed(0)} | ${(ms / nodes).toFixed(4)} |`
    );
  }
}
if (!getNnueWeights()) throw new Error("weights unloaded");
