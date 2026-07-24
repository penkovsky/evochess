"""Plain-numpy inference for the NNUE net, and the TS/Python net-parity gate.

Two jobs:

1. A float64 forward pass (`forward`) that mirrors the shipped TypeScript
   inference exactly, plus `NetWeights.from_torch` to pull weights out of a
   trained checkpoint. Kept in float64 (not torch/float32) so it is the
   canonical reference the TS side is held against — same precision on both
   sides makes "parity within epsilon" mean ~1e-9, not ~1e-3.

2. The net-parity fixture generator (milestone 5). Feature parity (parity.py)
   proved the *inputs* match across languages; this proves the *arithmetic*
   does — the sparse first-layer accumulation, the weight layout, the clipped
   ReLU order. It uses a seed-generated net of the real architecture rather
   than the trained weights, so the check is a few committed floats instead of
   a ~2MB blob, and still drives every code path.

The input is entirely binary (piece features and one-hot evolution features are
all 0/1), so the whole input is described by its active indices and the first
layer is a pure accumulation of active weight rows — no dense/sparse split.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .features import FEATURE_SIZE, active_features, dense_active_indices
from .position import Position

DEFAULT_HIDDEN1 = 256
DEFAULT_HIDDEN2 = 32


def _imul(x: int, y: int) -> int:
    return (x * y) & 0xFFFFFFFF


def mulberry32(seed: int):
    """Bit-exact port of the mulberry32 PRNG used in ai.ts / gen.ts / nnue.ts.

    Kept identical across languages so a seed-generated net produces the same
    weights in Python and TypeScript. All arithmetic is unsigned 32-bit; the
    final division by 2^32 is exact in float64, matching JS's `>>> 0 / 2**32`.
    """
    a = seed & 0xFFFFFFFF

    def rng() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t1 = _imul(a ^ (a >> 15), 1 | a)
        t2 = (t1 + _imul(t1 ^ (t1 >> 7), 61 | t1)) & 0xFFFFFFFF
        t = t2 ^ t1
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rng


@dataclass(frozen=True)
class NetWeights:
    """All weights in float64, input-major so a sparse row-sum is contiguous.

    - `l1w`: (FEATURE_SIZE, H1) — row per input feature; accumulate active rows.
    - `l2w`: (H1, H2) — row per hidden-1 unit.
    - `l3w`: (H2,)   `l3b`: scalar.
    """

    l1w: np.ndarray
    l1b: np.ndarray
    l2w: np.ndarray
    l2b: np.ndarray
    l3w: np.ndarray
    l3b: float

    @classmethod
    def from_torch(cls, state_dict: dict) -> "NetWeights":
        """Extract weights from an NnueNet checkpoint (torch Linear is out-major)."""

        def arr(key: str) -> np.ndarray:
            t = state_dict[key]
            return t.detach().cpu().numpy().astype(np.float64)

        return cls(
            l1w=arr("l1.weight").T.copy(),  # (out,in) -> (in,out)
            l1b=arr("l1.bias"),
            l2w=arr("l2.weight").T.copy(),
            l2b=arr("l2.bias"),
            l3w=arr("l3.weight").reshape(-1),
            l3b=float(arr("l3.bias")[0]),
        )


def seeded_net(
    seed: int,
    n_in: int = FEATURE_SIZE,
    h1: int = DEFAULT_HIDDEN1,
    h2: int = DEFAULT_HIDDEN2,
    scale: float = 0.1,
) -> NetWeights:
    """A deterministic net for parity testing — real shape, seeded weights.

    The fill order (l1w row-major with the input index outermost, then l1b, l2w,
    l2b, l3w, l3b) is part of the contract: `seededNet` in nnue.ts must draw from
    the same mulberry32 stream in the same order, or the two nets differ.
    """
    rng = mulberry32(seed)

    def draw(n: int) -> np.ndarray:
        return np.array([(rng() * 2.0 - 1.0) * scale for _ in range(n)], dtype=np.float64)

    return NetWeights(
        l1w=draw(n_in * h1).reshape(n_in, h1),
        l1b=draw(h1),
        l2w=draw(h1 * h2).reshape(h1, h2),
        l2b=draw(h2),
        l3w=draw(h2),
        l3b=float((rng() * 2.0 - 1.0) * scale),
    )


def forward(weights: NetWeights, active_indices) -> float:
    """One evaluation from active feature indices. Side-to-move pawn score."""
    active = np.asarray(list(active_indices), dtype=np.intp)
    acc1 = weights.l1b + (weights.l1w[active].sum(axis=0) if active.size else 0.0)
    h1 = np.clip(acc1, 0.0, 1.0)  # clipped ReLU
    acc2 = weights.l2b + h1 @ weights.l2w
    h2 = np.maximum(acc2, 0.0)  # ReLU
    return float(weights.l3b + h2 @ weights.l3w)


def evaluate_position(weights: NetWeights, position: Position) -> float:
    """Net evaluation of a position, from the side-to-move's point of view.

    Must include both the sparse piece-square block and the dense
    evolution-state block (`dense_active_indices`).
    """
    active = [*active_features(position), *dense_active_indices(position)]
    return forward(weights, active)


# -- net-parity fixtures ----------------------------------------------------

PARITY_DIR = Path(__file__).resolve().parent.parent / "parity"
NET_GOLDEN_PATH = PARITY_DIR / "net-golden.json"

#: Seed for the parity net. Arbitrary but fixed — both languages use it.
PARITY_SEED = 20260716
#: Deliberately large: with ~18 active features per fixture this pushes L1
#: accumulator values well past 1 and below 0, so the parity check exercises
#: *both* bounds of the clipped ReLU. At the trained net's smaller scale the
#: upper clamp never fires on these positions, and a bug dropping it would slip
#: through unnoticed.
PARITY_SCALE = 0.5


def net_golden_records() -> dict:
    from .parity import build_fixtures

    weights = seeded_net(PARITY_SEED, scale=PARITY_SCALE)
    return {
        "seed": PARITY_SEED,
        "featureSize": FEATURE_SIZE,
        "hidden1": DEFAULT_HIDDEN1,
        "hidden2": DEFAULT_HIDDEN2,
        "scale": PARITY_SCALE,
        "outputs": [
            {"name": name, "output": evaluate_position(weights, position)}
            for name, position in build_fixtures()
        ],
    }


def write_net_golden() -> None:
    import json

    PARITY_DIR.mkdir(parents=True, exist_ok=True)
    NET_GOLDEN_PATH.write_text(json.dumps(net_golden_records(), indent=2) + "\n")


if __name__ == "__main__":
    write_net_golden()
    print(f"wrote net parity golden to {NET_GOLDEN_PATH}")
