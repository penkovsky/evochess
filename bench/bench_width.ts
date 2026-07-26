/**
 * Tests whether NNUE eval is memory-bound on weight width rather than
 * arithmetic-bound. `NnueWeights` stores every matrix as `Float64Array`:
 *   l1w = 1569 x 256 x 8B = 3.21 MB   (accumulator row reads: 2 KB per toggle)
 *   l2w =  256 x  32 x 8B = 64 KB     (exceeds a typical 32 KB L1d)
 * Narrowing to Float32 halves both and needs no quantization; int8 would cut
 * them 8×. If the win is memory traffic, it shows up here with zero accuracy
 * cost — and it re-prices the int8 milestone as a speed lever, not just a
 * download-size one.
 */
import { readFileSync } from "node:fs";
import { sampleCorpus } from "./corpus";
import { fromEvoGame } from "../src/evochess/evoBitboard";
import { loadWeights, setNnueWeights, type SerializedWeights } from "../src/evochess/nnue";
import { activeIndicesFromEvoPos, createAccStack, refresh } from "../src/evochess/nnueAccum";

const serialized = JSON.parse(readFileSync("public/net-weights.json", "utf8")) as SerializedWeights;
const w64 = loadWeights(serialized);
setNnueWeights(w64);
const { hidden1, hidden2 } = w64;

const l2w32 = Float32Array.from(w64.l2w);
const l1w32 = Float32Array.from(w64.l1w);
console.log(`# l1w ${(w64.l1w.byteLength / 1e6).toFixed(2)} MB f64 → ${(l1w32.byteLength / 1e6).toFixed(2)} MB f32`);
console.log(`# l2w ${(w64.l2w.byteLength / 1e3).toFixed(0)} KB f64 → ${(l2w32.byteLength / 1e3).toFixed(0)} KB f32\n`);

const games = sampleCorpus(12);
const stack = createAccStack(w64, 8);
const pre: Float32Array[] = [];
const activeSets: number[][] = [];
for (const g of games) {
  const s = fromEvoGame(g);
  refresh(stack[0], s, w64);
  pre.push(Float32Array.from(stack[0].w), Float32Array.from(stack[0].b));
  activeSets.push(activeIndicesFromEvoPos(s));
}

function time(fn: () => void, iters: number, per: number): number {
  for (let i = 0; i < 500; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return ((performance.now() - t0) * 1000) / (iters * per);
}
let sink = 0;

// ---- Layer 2/3 dense loop, f64 vs f32 weights ---------------------------
function layer23(l2w: Float64Array | Float32Array, preH1: Float32Array): number {
  const { l2b, l3w, l3b } = w64;
  const h1 = new Float64Array(hidden1);
  for (let o = 0; o < hidden1; o++) { const x = preH1[o]; h1[o] = x < 0 ? 0 : x > 1 ? 1 : x; }
  const h2 = new Float64Array(l2b);
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
const l2_64 = time(() => { for (const p of pre) sink += layer23(w64.l2w, p); }, 30_000, pre.length);
const l2_32 = time(() => { for (const p of pre) sink += layer23(l2w32, p); }, 30_000, pre.length);

// ---- Layer 1 row accumulation (the accumulator's addRow shape) ----------
const row = new Float32Array(hidden1);
function addRows(l1w: Float64Array | Float32Array, active: number[]): void {
  row.fill(0);
  for (const idx of active) {
    const base = idx * hidden1;
    for (let o = 0; o < hidden1; o++) row[o] += l1w[base + o];
  }
}
const l1_64 = time(() => { for (const a of activeSets) { addRows(w64.l1w, a); sink += row[0]; } }, 20_000, activeSets.length);
const l1_32 = time(() => { for (const a of activeSets) { addRows(l1w32, a); sink += row[0]; } }, 20_000, activeSets.length);

console.log(`(sink ${(sink % 7).toFixed(3)})\n`);
console.log(`| kernel | f64 weights µs | f32 weights µs | speedup |`);
console.log(`|---|---:|---:|---:|`);
console.log(`| Layer 2/3 dense (${hidden1}×${hidden2}, ~54% rows skipped) | ${l2_64.toFixed(2)} | ${l2_32.toFixed(2)} | **${(l2_64 / l2_32).toFixed(2)}×** |`);
console.log(`| Layer 1 full refresh (~${activeSets[0].length} active rows × ${hidden1}) | ${l1_64.toFixed(2)} | ${l1_32.toFixed(2)} | **${(l1_64 / l1_32).toFixed(2)}×** |`);
