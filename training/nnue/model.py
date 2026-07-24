"""The net: a small sparse-input MLP, per nnue-spec.md.

    input (1569)
      -> Linear 1569 x 256  -> clipped ReLU
      -> Linear  256 x  32  -> ReLU
      -> Linear   32 x   1
    output: a pawn-unit score, from the side-to-move's point of view.

The spec's "accumulate only active columns" first layer is an *inference*
optimisation for the TypeScript engine (the ~32 active columns are all that
need touching). In training we feed dense vectors and let a plain `nn.Linear`
do the same arithmetic — mathematically identical, and PyTorch batches it
efficiently on the GPU. The sparse trick matters for shipping speed, not here.

Clipped ReLU (clamp to [0, 1]) rather than plain ReLU on the first layer is
standard NNUE: it bounds the activations, which is what later makes int8
quantisation lossless enough to ship. We keep it from the start so the float
and int8 nets share an architecture.
"""

from __future__ import annotations

import torch
from torch import nn

from .features import FEATURE_SIZE

DEFAULT_HIDDEN1 = 256
DEFAULT_HIDDEN2 = 32


class NnueNet(nn.Module):
    def __init__(self, hidden1: int = DEFAULT_HIDDEN1, hidden2: int = DEFAULT_HIDDEN2) -> None:
        super().__init__()
        self.l1 = nn.Linear(FEATURE_SIZE, hidden1)
        self.l2 = nn.Linear(hidden1, hidden2)
        self.l3 = nn.Linear(hidden2, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = torch.clamp(self.l1(x), 0.0, 1.0)  # clipped ReLU
        x = torch.relu(self.l2(x))
        return self.l3(x).squeeze(-1)  # pawn-unit score, side-to-move-relative
