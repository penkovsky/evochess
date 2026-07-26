/**
 * NNUE-specific levers:
 *
 *   1. whole-search NNUE vs PST at equal depth — how big the eval denominator
 *      actually is once the accumulator is live;
 *   2. the split *inside* one incremental eval: `applyAccum` (Layer-1 row
 *      toggles, the accumulator's own work, and §3's `addRow` target) vs
 *      `evalAcc` (clipped ReLU + the 256×32 Layer-2 matmul + Layer 3 — the
 *      "fixed floor" the accumulator spec §1 says it cannot touch);
 *   3. what fraction of an NNUE search each of those is, i.e. the ceiling on
 *      §3 (SIMD) if it were applied to one or both.
 */
import { readFileSync } from "node:fs";
import { sampleCorpus } from "./corpus";
import { applyEvoTurn, fromEvoGame, generateEvoTurns, undoEvoTurn } from "../src/evochess/evoBitboard";
import { searchEvoTT } from "../src/evochess/evoSearch";
import { loadWeights, setNnueWeights, type SerializedWeights } from "../src/evochess/nnue";
import { applyAccum, createAccStack, evalAcc, refresh, type Perspective } from "../src/evochess/nnueAccum";

const serialized = JSON.parse(readFileSync("public/net-weights.json", "utf8")) as SerializedWeights;
const weights = loadWeights(serialized);
setNnueWeights(weights);
console.log(`# shipped net: ${weights.featureSize} → ${weights.hidden1} → ${weights.hidden2} → 1\n`);

const games = sampleCorpus(12);

// ---- 1. whole search, NNUE vs PST ---------------------------------------
console.log(`## Whole search, equal depth (12 positions)`);
console.log(`| depth | PST ms | PST nodes | NNUE ms | NNUE nodes | NNUE ms/node | PST ms/node |`);
console.log(`|------:|-------:|----------:|--------:|-----------:|-------------:|------------:|`);
const nnueMs: Record<number, number> = {};
const nnueNodes: Record<number, number> = {};
for (const d of [3, 4]) {
  let pMs = 0, pN = 0, nMs = 0, nN = 0;
  for (const g of games) {
    let s = fromEvoGame(g);
    let t0 = performance.now();
    pN += searchEvoTT(s, d, undefined, false).nodes;
    pMs += performance.now() - t0;

    s = fromEvoGame(g);
    t0 = performance.now();
    nN += searchEvoTT(s, d, undefined, true).nodes;
    nMs += performance.now() - t0;
  }
  nnueMs[d] = nMs; nnueNodes[d] = nN;
  console.log(
    `| ${d} | ${pMs.toFixed(0)} | ${pN.toLocaleString()} | ${nMs.toFixed(0)} | ${nN.toLocaleString()} | ` +
    `${((nMs * 1000) / nN).toFixed(1)} µs | ${((pMs * 1000) / pN).toFixed(1)} µs |`
  );
}

// ---- 2. inside one incremental eval -------------------------------------
// Build the real in-search shape: a refreshed parent, one move applied, the
// child accumulator derived by applyAccum, then evaluated.
const stack = createAccStack(weights, 8);
type Case = { s: ReturnType<typeof fromEvoGame>; t: ReturnType<typeof generateEvoTurns>[number] };
const cases: Case[] = [];
for (const g of games) {
  const s = fromEvoGame(g);
  const turns = generateEvoTurns(s);
  if (turns.length) cases.push({ s, t: turns[0] });
}

const ITERS = 20_000;
let sink = 0;

// applyAccum alone (Layer-1 toggles). Apply the move, toggle, undo — then
// subtract the make/unmake cost measured separately below.
function timeApply(): number {
  const t0 = performance.now();
  for (let i = 0; i < ITERS; i++) {
    for (const c of cases) {
      refresh(stack[0], c.s, weights);
      const u = applyEvoTurn(c.s, c.t);
      applyAccum(stack, 0, c.s, c.t, u, weights);
      undoEvoTurn(c.s, u);
    }
  }
  return performance.now() - t0;
}
function timeApplyBaseline(): number {
  const t0 = performance.now();
  for (let i = 0; i < ITERS; i++) {
    for (const c of cases) {
      refresh(stack[0], c.s, weights);
      const u = applyEvoTurn(c.s, c.t);
      undoEvoTurn(c.s, u);
    }
  }
  return performance.now() - t0;
}
function timeEvalAcc(): number {
  const t0 = performance.now();
  for (let i = 0; i < ITERS; i++) {
    for (const c of cases) sink += evalAcc(stack[1], c.s.pos.us as Perspective, weights);
  }
  return performance.now() - t0;
}

timeApply(); timeApplyBaseline(); timeEvalAcc(); // warm
const withApply = timeApply();
const baseline = timeApplyBaseline();
const evalOnly = timeEvalAcc();
const n = ITERS * cases.length;
const applyUs = ((withApply - baseline) * 1000) / n;
const evalUs = (evalOnly * 1000) / n;

console.log(`\n(sink ${(sink % 7).toFixed(3)})`);
console.log(`\n## Inside one incremental eval (${cases.length} positions × ${ITERS} iters)`);
console.log(`| stage | µs | share of eval |`);
console.log(`|---|---:|---:|`);
console.log(`| applyAccum (Layer-1 toggles — §3's addRow target) | ${applyUs.toFixed(2)} | ${((100 * applyUs) / (applyUs + evalUs)).toFixed(0)}% |`);
console.log(`| evalAcc (clipped ReLU + 256×32 Layer 2 + Layer 3) | ${evalUs.toFixed(2)} | ${((100 * evalUs) / (applyUs + evalUs)).toFixed(0)}% |`);
console.log(`| **total incremental eval** | **${(applyUs + evalUs).toFixed(2)}** | 100% |`);

// ---- 3. eval share of the NNUE search, and §3's ceiling -----------------
// evalAcc runs on the ~54% of nodes that are quiesce stand-pats plus depth-0
// entries; applyAccum runs on every applied move. Use the measured node
// counts and the experiment-8 ~54% eval-call rate as the estimate basis.
const EVAL_RATE = 0.54;
console.log(`\n## Share of the NNUE search (assuming experiment 8's ~54% eval-call rate)`);
console.log(`| depth | NNUE search ms | evalAcc ms | applyAccum ms | eval total share | 2× SIMD on both → | 4× SIMD on both → |`);
console.log(`|------:|---------------:|-----------:|--------------:|-----------------:|------------------:|------------------:|`);
for (const d of [3, 4]) {
  const ev = (nnueNodes[d] * EVAL_RATE * evalUs) / 1000;
  const ap = (nnueNodes[d] * applyUs) / 1000; // one toggle per applied move ≈ per node
  const tot = ev + ap;
  const s2 = nnueMs[d] / (nnueMs[d] - tot / 2);
  const s4 = nnueMs[d] / (nnueMs[d] - (tot * 3) / 4);
  console.log(
    `| ${d} | ${nnueMs[d].toFixed(0)} | ${ev.toFixed(0)} | ${ap.toFixed(0)} | ` +
    `${((100 * tot) / nnueMs[d]).toFixed(0)}% | ${s2.toFixed(2)}× | ${s4.toFixed(2)}× |`
  );
}
