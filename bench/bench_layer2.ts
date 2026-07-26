/**
 * Two go/no-go inputs for the Layer-2 SIMD decision:
 *   1. how sparse `h1` is after the clipped ReLU — the existing scalar loops
 *      (`forwardFromPreactivation`, `forwardActiveInt8`) both `continue` on
 *      zero rows, so a branchless SIMD kernel gives that sparsity back and
 *      must beat the *effective* row count, not 256;
 *   2. what the two per-eval allocations (`new Float64Array(hidden1)`,
 *      `new Float64Array(l2b)`) cost, i.e. how much is available from plain-JS
 *      scratch-buffer reuse before any WASM toolchain.
 */
import { readFileSync } from "node:fs";
import { sampleCorpus } from "./corpus";
import { applyEvoTurn, fromEvoGame, generateEvoTurns, undoEvoTurn } from "../src/evochess/evoBitboard";
import { forwardFromPreactivation, loadWeights, setNnueWeights, type NnueWeights, type SerializedWeights } from "../src/evochess/nnue";
import { createAccStack, refresh, applyAccum } from "../src/evochess/nnueAccum";

const serialized = JSON.parse(readFileSync("public/net-weights.json", "utf8")) as SerializedWeights;
const weights = loadWeights(serialized);
setNnueWeights(weights);

const games = sampleCorpus(12);
const stack = createAccStack(weights, 8);

// Collect realistic pre-activation rows: refresh at each corpus position, plus
// one child per position through applyAccum.
const pre: Float32Array[] = [];
for (const g of games) {
  const s = fromEvoGame(g);
  refresh(stack[0], s, weights);
  pre.push(Float32Array.from(stack[0].w), Float32Array.from(stack[0].b));
  const turns = generateEvoTurns(s);
  if (turns.length) {
    const u = applyEvoTurn(s, turns[0]);
    applyAccum(stack, 0, s, turns[0], u, weights);
    pre.push(Float32Array.from(stack[1].w), Float32Array.from(stack[1].b));
    undoEvoTurn(s, u);
  }
}

// ---- 1. sparsity of h1 after clipped ReLU -------------------------------
let zero = 0, clamped = 0, total = 0;
for (const p of pre) {
  for (let o = 0; o < weights.hidden1; o++) {
    const x = p[o];
    total++;
    if (x <= 0) zero++;
    else if (x >= 1) clamped++;
  }
}
console.log(`# h1 occupancy over ${pre.length} real pre-activation vectors (hidden1=${weights.hidden1})\n`);
console.log(`| bucket | count | share |`);
console.log(`|---|---:|---:|`);
console.log(`| zero (skipped by the \`continue\`) | ${zero} | ${((100 * zero) / total).toFixed(1)}% |`);
console.log(`| clamped to 1 | ${clamped} | ${((100 * clamped) / total).toFixed(1)}% |`);
console.log(`| in (0,1) | ${total - zero - clamped} | ${((100 * (total - zero - clamped)) / total).toFixed(1)}% |`);
console.log(`\n→ effective Layer-2 rows: ${((weights.hidden1 * (total - zero)) / total).toFixed(0)} of ${weights.hidden1}`);

// ---- 2. allocation cost: current vs scratch-buffer reuse ----------------
function forwardScratch(w: NnueWeights, preH1: Float32Array, h1: Float64Array, h2: Float64Array): number {
  const { hidden1, hidden2, l2w, l2b, l3w, l3b } = w;
  for (let o = 0; o < hidden1; o++) {
    const x = preH1[o];
    h1[o] = x < 0 ? 0 : x > 1 ? 1 : x;
  }
  h2.set(l2b);
  for (let i = 0; i < hidden1; i++) {
    const hi = h1[i];
    if (hi === 0) continue;
    const base = i * hidden2;
    for (let o = 0; o < hidden2; o++) h2[o] += hi * l2w[base + o];
  }
  for (let o = 0; o < hidden2; o++) if (h2[o] < 0) h2[o] = 0;
  let out = l3b;
  for (let o = 0; o < hidden2; o++) out += h2[o] * l3w[o];
  return out;
}

const scratchH1 = new Float64Array(weights.hidden1);
const scratchH2 = new Float64Array(weights.hidden2);
const ITERS = 30_000;
let sink = 0;

function time(fn: () => void): number {
  for (let i = 0; i < 500; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < ITERS; i++) fn();
  return ((performance.now() - t0) * 1000) / (ITERS * pre.length);
}

const cur = time(() => { for (const p of pre) sink += forwardFromPreactivation(weights, p); });
const scr = time(() => { for (const p of pre) sink += forwardScratch(weights, p, scratchH1, scratchH2); });

// correctness: the scratch version must agree with the current one
let maxDiff = 0;
for (const p of pre) {
  maxDiff = Math.max(maxDiff, Math.abs(forwardFromPreactivation(weights, p) - forwardScratch(weights, p, scratchH1, scratchH2)));
}

console.log(`\n(sink ${(sink % 7).toFixed(3)})`);
console.log(`\n| Layer 2/3 variant | µs/call |`);
console.log(`|---|---:|`);
console.log(`| current (\`forwardFromPreactivation\`, 2 allocs/call) | ${cur.toFixed(2)} |`);
console.log(`| scratch buffers reused | ${scr.toFixed(2)} |`);
console.log(`| saving | ${(cur - scr).toFixed(2)} µs (${(cur / scr).toFixed(2)}×) |`);
console.log(`| max |diff| vs current | ${maxDiff.toExponential(1)} |`);
