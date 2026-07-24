"""Export a trained checkpoint to the base64-float32 form nnue.ts loads.

    python -m nnue.export --checkpoint training/checkpoints/net.pt \
        --out training/checkpoints/net-weights.json

Float32 first, per the spec — the driver for later int8 quantisation is bundle
size on GitHub Pages, not speed, and it should wait until the float net is
proven in a strength match. The arrays are written in exactly the flat,
input-major layout `NnueWeights` in nnue.ts expects, so inference on the loaded
weights matches the Python `forward` reference.
"""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path

import numpy as np
import torch

from .features import FEATURE_SIZE
from .infer import DEFAULT_HIDDEN1, DEFAULT_HIDDEN2, NetWeights


def _encode(array: np.ndarray) -> str:
    # Little-endian float32, C-order flat — the byte layout DataView.getFloat32
    # reads back on the TS side.
    return base64.b64encode(np.ascontiguousarray(array, dtype="<f4").ravel().tobytes()).decode()


def export_weights(checkpoint: str) -> dict:
    state = torch.load(checkpoint, map_location="cpu", weights_only=False)
    weights = NetWeights.from_torch(state["model"])
    return {
        "featureSize": FEATURE_SIZE,
        "hidden1": DEFAULT_HIDDEN1,
        "hidden2": DEFAULT_HIDDEN2,
        "l1w": _encode(weights.l1w),  # (FEATURE_SIZE, H1) -> [j*H1 + o]
        "l1b": _encode(weights.l1b),
        "l2w": _encode(weights.l2w),  # (H1, H2) -> [i*H2 + o]
        "l2b": _encode(weights.l2b),
        "l3w": _encode(weights.l3w),
        "l3b": float(weights.l3b),
        # Metadata: the net outputs pawn scores directly, so K is not needed at
        # inference, but it records the scale the net was trained against.
        "k": state.get("k"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", default="training/checkpoints/net.pt")
    parser.add_argument("--out", default="training/checkpoints/net-weights.json")
    args = parser.parse_args()

    data = export_weights(args.checkpoint)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(data))
    print(f"exported {args.checkpoint} -> {args.out}")


if __name__ == "__main__":
    main()
