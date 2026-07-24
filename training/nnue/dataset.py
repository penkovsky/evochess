"""A torch Dataset over generated positions.

Feature vectors are extracted lazily in `__getitem__` rather than materialised
up front: a dense 1569-float row is 6KB, so a million of them would be 6GB, but
the *position* it comes from is ~100 bytes. Keeping positions and extracting on
demand is what lets training scale to the spec's 1-3M without holding the dense
matrix in memory. Targets are cheap scalars, so those we do precompute — once,
against the fitted K.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np
import torch
from torch.utils.data import Dataset

from .features import extract
from .position import Position
from .target import DEFAULT_LAMBDA, build_target


class PositionDataset(Dataset):
    def __init__(self, positions: Sequence[Position], k: float, lam: float = DEFAULT_LAMBDA) -> None:
        if not positions:
            raise ValueError("PositionDataset needs at least one position")
        self.positions = list(positions)
        self.k = k
        self.lam = lam
        self.targets = np.asarray(
            [build_target(p, k, lam) for p in self.positions], dtype=np.float32
        )

    def __len__(self) -> int:
        return len(self.positions)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        features = torch.from_numpy(extract(self.positions[index]))
        target = torch.tensor(self.targets[index], dtype=torch.float32)
        return features, target
