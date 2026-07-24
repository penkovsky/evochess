/**
 * NNUE inference for the shipped engine (milestone 5).
 *
 * Loads a trained net and evaluates a position from the side-to-move's point of
 * view, in pawn units. The twin of `training/nnue/infer.py`; the two must agree,
 * which the net-parity test (`__tests__/nnue.test.ts` here, `test_infer.py`
 * there) enforces against a shared seed-generated net.
 *
 * The whole feature vector is binary — piece features and one-hot evolution
 * features are all 0/1 — so a position is fully described by its active feature
 * indices, and the first layer is a pure accumulation of active weight rows.
 * That sparse-column accumulation (only ~40 of 1569 rows touched) is what makes
 * this fast enough to run without the incremental accumulator NNUE usually
 * needs; see nnue-spec.md.
 *
 * Weights are stored input-major and flat (Float64Array) so each layer's inner
 * loop walks contiguous memory. Inference runs in float64 to match the Python
 * reference exactly.
 */
import { EvoChessGame } from "./game";
import { activeFeatures, denseActiveIndices, positionFromGame, type NnuePosition } from "./nnueFeatures";

export const DEFAULT_HIDDEN1 = 256;
export const DEFAULT_HIDDEN2 = 32;

export interface NnueWeights {
  featureSize: number;
  hidden1: number;
  hidden2: number;
  /** (featureSize x hidden1), row-major by input feature: l1w[j*hidden1 + o]. */
  l1w: Float64Array;
  l1b: Float64Array;
  /** (hidden1 x hidden2), row-major by hidden-1 unit: l2w[i*hidden2 + o]. */
  l2w: Float64Array;
  l2b: Float64Array;
  l3w: Float64Array;
  l3b: number;
}

/** Bit-exact port of mulberry32 (ai.ts / gen.ts / infer.py). */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A deterministic net for parity testing — the real architecture with seeded
 * weights. The draw order (l1w with the input index outermost, then l1b, l2w,
 * l2b, l3w, l3b) must match `seeded_net` in infer.py exactly, or the two nets
 * differ and the parity test is meaningless.
 */
export function seededNet(
  seed: number,
  featureSize: number,
  hidden1 = DEFAULT_HIDDEN1,
  hidden2 = DEFAULT_HIDDEN2,
  scale = 0.1
): NnueWeights {
  const rng = mulberry32(seed);
  const draw = (n: number): Float64Array => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = (rng() * 2 - 1) * scale;
    return out;
  };
  return {
    featureSize,
    hidden1,
    hidden2,
    l1w: draw(featureSize * hidden1),
    l1b: draw(hidden1),
    l2w: draw(hidden1 * hidden2),
    l2b: draw(hidden2),
    l3w: draw(hidden2),
    l3b: (rng() * 2 - 1) * scale,
  };
}

/**
 * The serialized weight format written by `training/nnue/export.py`: each array
 * is little-endian float32 packed and base64-encoded, in the same flat layout
 * `NnueWeights` uses. Ship float32 first (spec); int8 is a later size win.
 */
export interface SerializedWeights {
  featureSize: number;
  hidden1: number;
  hidden2: number;
  l1w: string;
  l1b: string;
  l2w: string;
  l2b: string;
  l3w: string;
  l3b: number;
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decode base64'd little-endian float32 into a Float64Array (inference is f64). */
function decodeFloat32(b64: string): Float64Array {
  const bytes = base64ToBytes(b64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.byteLength / 4;
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Build inference weights from the exported (base64 float32) form. */
export function loadWeights(serialized: SerializedWeights): NnueWeights {
  return {
    featureSize: serialized.featureSize,
    hidden1: serialized.hidden1,
    hidden2: serialized.hidden2,
    l1w: decodeFloat32(serialized.l1w),
    l1b: decodeFloat32(serialized.l1b),
    l2w: decodeFloat32(serialized.l2w),
    l2b: decodeFloat32(serialized.l2b),
    l3w: decodeFloat32(serialized.l3w),
    l3b: serialized.l3b,
  };
}

/**
 * Layers 2 and 3, from a **pre-activation** (pre-clipped-ReLU) Layer-1 output.
 * The shared tail both `forwardActive` (from-scratch) and the incremental
 * accumulator's `evalAcc` (nnueAccum.ts, nnue-accumulator-spec.md §7) call —
 * factored out so the two paths can never drift on Layers 2/3, only ever on
 * how they arrive at `preH1`. Accepts either a `Float64Array` (the
 * from-scratch path) or a `Float32Array` (the accumulator's storage type,
 * §3 of that spec); indexed reads widen to double either way, so the layer-2
 * math itself is unaffected by which one is passed.
 */
export function forwardFromPreactivation(weights: NnueWeights, preH1: Float64Array | Float32Array): number {
  const { hidden1, hidden2, l2w, l2b, l3w, l3b } = weights;

  const h1 = new Float64Array(hidden1);
  for (let o = 0; o < hidden1; o++) {
    const x = preH1[o];
    h1[o] = x < 0 ? 0 : x > 1 ? 1 : x;
  }

  // Layer 2: dense, then ReLU.
  const h2 = new Float64Array(l2b);
  for (let i = 0; i < hidden1; i++) {
    const hi = h1[i];
    if (hi === 0) continue;
    const base = i * hidden2;
    for (let o = 0; o < hidden2; o++) h2[o] += hi * l2w[base + o];
  }
  for (let o = 0; o < hidden2; o++) if (h2[o] < 0) h2[o] = 0;

  // Layer 3: to a scalar.
  let out = l3b;
  for (let o = 0; o < hidden2; o++) out += h2[o] * l3w[o];
  return out;
}

/** Evaluate from active feature indices. Side-to-move pawn score. */
export function forwardActive(weights: NnueWeights, active: number[]): number {
  const { hidden1, l1w, l1b } = weights;

  // Layer 1: accumulate only the active input rows (pre-activation).
  const preH1 = new Float64Array(l1b); // copy of biases
  for (const j of active) {
    const base = j * hidden1;
    for (let o = 0; o < hidden1; o++) preH1[o] += l1w[base + o];
  }

  return forwardFromPreactivation(weights, preH1);
}

/**
 * Net evaluation of a position, from the side-to-move's point of view.
 *
 * Must include both the sparse piece-square block and the dense
 * evolution-state block (`denseActiveIndices`).
 */
export function evaluatePosition(weights: NnueWeights, position: NnuePosition): number {
  const active = activeFeatures(position).concat(denseActiveIndices(position));
  return forwardActive(weights, active);
}

// -- integration with the search ------------------------------------------

let loadedWeights: NnueWeights | null = null;

/** Install (or clear) the net the engine evaluates with. */
export function setNnueWeights(weights: NnueWeights | null): void {
  loadedWeights = weights;
}

export function hasNnueWeights(): boolean {
  return loadedWeights !== null;
}

/**
 * The loaded net itself, or null. Callers that need to pass `NnueWeights`
 * into their own eval path (the bitboard search's accumulator, `nnueAccum.ts`)
 * rather than go through `evaluateNnuePosition`/`evaluateActive` use this;
 * still the same module-state `loadedWeights` everything else reads.
 */
export function getNnueWeights(): NnueWeights | null {
  return loadedWeights;
}

/**
 * Evaluate `position` with the loaded net, from the side-to-move's point of
 * view. The single accessor other backends (the bitboard search) go through,
 * so there is one source of truth for "which net is loaded" — the worker's
 * `setNnueWeights` feeds every caller of this function. Throws if no weights
 * are loaded; check `hasNnueWeights()` first.
 */
export function evaluateNnuePosition(position: NnuePosition): number {
  if (loadedWeights === null) throw new Error("no NNUE weights loaded");
  return evaluatePosition(loadedWeights, position);
}

/**
 * Evaluate a pre-built active-index list with the loaded net. The Option-B
 * (bitboard-native indexer) counterpart of `evaluateNnuePosition`: callers
 * that already have indices (no `NnuePosition`/FEN to build) go through this
 * instead, still against the same module-state `loadedWeights`. Throws if no
 * weights are loaded; check `hasNnueWeights()` first.
 */
export function evaluateActive(active: number[]): number {
  if (loadedWeights === null) throw new Error("no NNUE weights loaded");
  return forwardActive(loadedWeights, active);
}

/**
 * The engine's NNUE evaluation of `game`, from the side-to-move's point of
 * view. Callers that need a White-positive score (like `evaluate()` in ai.ts)
 * must negate for Black. Throws if no weights are loaded — check
 * `hasNnueWeights()` first.
 */
export function evaluateNNUE(game: EvoChessGame): number {
  if (loadedWeights === null) throw new Error("no NNUE weights loaded");
  return evaluatePosition(loadedWeights, positionFromGame(game));
}
