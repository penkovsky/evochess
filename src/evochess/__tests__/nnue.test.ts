/**
 * Net-parity gate (milestone 5): TS inference must reproduce the Python net's
 * outputs. Feature parity proved the inputs match across languages; this proves
 * the arithmetic does — the sparse first-layer accumulation, the weight layout,
 * the clipped-ReLU-then-ReLU order.
 *
 * Both sides build the same net from a shared seed (`seededNet` / `test_net`,
 * identical mulberry32 draw order), so the check is a handful of committed
 * floats in `net-golden.json` rather than a multi-megabyte weight blob, while
 * still exercising every code path on real positions.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Color } from "chess.js";
import { evaluatePosition, forwardActive, loadWeights, seededNet } from "../nnue";
import { activeIndices, denseActiveIndices, FEATURE_SIZE, SPARSE_SIZE, type NnuePosition } from "../nnueFeatures";

const here = dirname(fileURLToPath(import.meta.url));
const parityDir = resolve(here, "../../../training/parity");

interface FixtureJson {
  fen: string;
  minorRights?: [number, number];
  rookRights?: [number, number];
  pawnMoveProgress?: [number, number];
  minorMoveProgress?: [number, number];
  rookCharges?: Record<string, number>;
  rookLocked?: string[];
  epEvolved?: [string, string, Color];
}

function pair(value: [number, number] | undefined): Record<Color, number> {
  const [w, b] = value ?? [0, 0];
  return { w, b };
}

function positionFromFixture(json: FixtureJson): NnuePosition {
  return {
    fen: json.fen,
    minorRights: pair(json.minorRights),
    rookRights: pair(json.rookRights),
    pawnMoveProgress: pair(json.pawnMoveProgress),
    minorMoveProgress: pair(json.minorMoveProgress),
    rookCharges: new Map(Object.entries(json.rookCharges ?? {})),
    rookLocked: new Set(json.rookLocked ?? []),
    epEvolved: json.epEvolved
      ? { skipped: json.epEvolved[0], victim: json.epEvolved[1], color: json.epEvolved[2] }
      : null,
  };
}

const fixtures: { name: string; position: FixtureJson }[] = JSON.parse(
  readFileSync(resolve(parityDir, "fixtures.json"), "utf8")
);
const golden: {
  seed: number;
  featureSize: number;
  hidden1: number;
  hidden2: number;
  scale: number;
  outputs: { name: string; output: number }[];
} = JSON.parse(readFileSync(resolve(parityDir, "net-golden.json"), "utf8"));

const fixtureByName = new Map(fixtures.map((f) => [f.name, f.position]));

describe("NNUE inference parity with Python", () => {
  const weights = seededNet(
    golden.seed,
    golden.featureSize,
    golden.hidden1,
    golden.hidden2,
    golden.scale
  );

  it("uses the same feature size as the golden net", () => {
    expect(golden.featureSize).toBe(FEATURE_SIZE);
  });

  it.each(golden.outputs)("$name matches the Python net output", ({ name, output }) => {
    const fixture = fixtureByName.get(name);
    expect(fixture, `no fixture named ${name}`).toBeDefined();
    // float64 both sides, same weights -> parity is ~1e-9; 1e-6 is slack.
    expect(evaluatePosition(weights, positionFromFixture(fixture!))).toBeCloseTo(output, 6);
  });
});

describe("NNUE inference internals", () => {
  const weights = seededNet(12345, FEATURE_SIZE);

  it("is deterministic", () => {
    expect(forwardActive(weights, [0, 5, 100])).toBe(forwardActive(weights, [0, 5, 100]));
  });

  it("does not depend on the order of active indices", () => {
    expect(forwardActive(weights, [3, 1, 2])).toBeCloseTo(forwardActive(weights, [1, 2, 3]), 12);
  });

  it("with no active features returns the bias-only forward", () => {
    // Accumulator starts at l1b; a valid position always has pieces, but the
    // empty case must still be finite and well-defined.
    expect(Number.isFinite(forwardActive(weights, []))).toBe(true);
  });

  it("two seeds give different nets", () => {
    const a = seededNet(1, FEATURE_SIZE);
    const b = seededNet(2, FEATURE_SIZE);
    expect(forwardActive(a, [10, 20])).not.toBe(forwardActive(b, [10, 20]));
  });
});

describe("evaluatePosition sees the dense evolution-state block", () => {
  // Regression test for the bug found while investigating why more/better
  // training data never improved the equal-time match: evaluatePosition()
  // called activeFeatures() (sparse piece-square only) and never included
  // denseActiveIndices(), so every real evaluation was blind to minor/rook
  // rights, progress counters, and the ep-evolved flag — exactly the state
  // "a material evaluation cannot express, and the whole reason for the
  // exercise" (features.py).
  const weights = seededNet(777, FEATURE_SIZE);
  const base: NnuePosition = {
    fen: "4k3/8/8/8/8/8/8/4K2Q w - - 0 1",
    minorRights: { w: 0, b: 0 },
    rookRights: { w: 0, b: 0 },
    pawnMoveProgress: { w: 0, b: 0 },
    minorMoveProgress: { w: 0, b: 0 },
    rookCharges: new Map(),
    rookLocked: new Set(),
    epEvolved: null,
  };

  it("scores two positions with identical pieces but different rights differently", () => {
    const withRights: NnuePosition = {
      ...base,
      rookRights: { w: 4, b: 0 },
      minorRights: { w: 4, b: 0 },
    };
    expect(evaluatePosition(weights, withRights)).not.toBe(evaluatePosition(weights, base));
  });

  it("scores two positions with identical pieces but different progress counters differently", () => {
    const withProgress: NnuePosition = {
      ...base,
      pawnMoveProgress: { w: 2, b: 1 },
      minorMoveProgress: { w: 1, b: 2 },
    };
    expect(evaluatePosition(weights, withProgress)).not.toBe(evaluatePosition(weights, base));
  });

  it("the fast dense-active-index path agrees with the already-parity-tested full extractor", () => {
    // activeIndices() (extract() + full scan) is what the golden-vector
    // parity tests already pin down as correct; denseActiveIndices() is the
    // fast path evaluatePosition() actually uses. They must produce the same
    // dense-block indices for both a zero-state and a nonzero-state position.
    for (const position of [
      base,
      { ...base, rookRights: { w: 3, b: 1 }, epEvolved: { skipped: "e6", victim: "e5", color: "w" as const } },
    ]) {
      const fromFullExtract = activeIndices(position)
        .filter((i) => i >= SPARSE_SIZE)
        .sort((a, b) => a - b);
      const fast = [...denseActiveIndices(position)].sort((a, b) => a - b);
      expect(fast).toEqual(fromFullExtract);
    }
  });
});

describe("loadWeights (base64 float32 decode)", () => {
  // Little-endian float32 base64, matching export.py's encoding.
  function f32b64(values: number[]): string {
    const buf = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
    return buf.toString("base64");
  }

  it("decodes each array into the flat layout inference expects", () => {
    // Values chosen to be exactly representable in float32.
    const weights = loadWeights({
      featureSize: 2,
      hidden1: 2,
      hidden2: 1,
      l1w: f32b64([0.5, -0.25, 1, 2]),
      l1b: f32b64([0.75, -1.5]),
      l2w: f32b64([0.25, -0.5]),
      l2b: f32b64([0.125]),
      l3w: f32b64([1.5]),
      l3b: 0.375,
    });
    expect(Array.from(weights.l1w)).toEqual([0.5, -0.25, 1, 2]);
    expect(Array.from(weights.l1b)).toEqual([0.75, -1.5]);
    expect(Array.from(weights.l2w)).toEqual([0.25, -0.5]);
    expect(weights.l3b).toBe(0.375);
    expect(weights.featureSize).toBe(2);
  });

  it("round-trips a seeded net through the serialized form", () => {
    // Encode a real-shape net's arrays, reload, and confirm identical outputs —
    // the export -> load path must preserve the weight layout exactly.
    const net = seededNet(999, FEATURE_SIZE);
    const reloaded = loadWeights({
      featureSize: net.featureSize,
      hidden1: net.hidden1,
      hidden2: net.hidden2,
      l1w: f32b64(Array.from(net.l1w)),
      l1b: f32b64(Array.from(net.l1b)),
      l2w: f32b64(Array.from(net.l2w)),
      l2b: f32b64(Array.from(net.l2b)),
      l3w: f32b64(Array.from(net.l3w)),
      l3b: net.l3b,
    });
    const active = [3, 40, 800, 1560];
    // float32 round-trip loses a little precision vs the float64 seeded net.
    expect(forwardActive(reloaded, active)).toBeCloseTo(forwardActive(net, active), 4);
  });
});
