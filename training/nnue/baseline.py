"""The material baseline the net must beat, mirroring `material()` in ai.ts.

Milestone 4's gate is that the net beats `material()` as a static evaluator on
held-out positions. This is that yardstick in Python: same piece values, same
linear rook-charge decay. It is not a shipped-parity concern (the real engine's
material() stays authoritative in TS), so a faithful re-implementation is
enough — but keep it faithful, or the gate lies.
"""

from __future__ import annotations

import numpy as np

from .position import ROOK_CHARGES, Position, parse_fen

# Mirror PIECE_VALUES in ai.ts (pawn units).
PIECE_VALUES: dict[str, float] = {"p": 1, "n": 3, "b": 3, "r": 5, "q": 9, "k": 0}


def rook_value(charges: int) -> float:
    """A rook decays linearly from a full rook toward a minor as charges drain.

    Mirrors `rookValue()` in ai.ts: a 1-charge rook is worth 3.4, still clearly
    above a minor because it has one rook move left to spend.
    """
    minor = PIECE_VALUES["n"]
    return minor + (PIECE_VALUES["r"] - minor) * (charges / ROOK_CHARGES)


def material(position: Position) -> float:
    """Material score, White-positive, in pawn units. Mirrors `material()`."""
    board, _ = parse_fen(position.fen)
    score = 0.0
    for square, (piece_type, color) in board.items():
        if piece_type == "r":
            value = rook_value(position.rook_charges.get(square, ROOK_CHARGES))
        else:
            # Locked minors (downgraded rooks) are still knights/bishops to the
            # material count, exactly as ai.ts sees them.
            value = PIECE_VALUES[piece_type]
        score += value if color == "w" else -value
    return score


def material_stm(position: Position) -> float:
    """Material from the side-to-move's point of view (net's frame)."""
    score = material(position)
    return score if position.turn == "w" else -score


def baseline_predictions(positions, k: float) -> np.ndarray:
    """The material baseline's probability predictions, side-to-move-relative.

    Mapped through the same sigmoid(score / K) the net's output passes through,
    so the two are compared on equal footing against the training target.
    """
    from .target import sigmoid

    return np.asarray([float(sigmoid(material_stm(p) / k)) for p in positions], dtype=np.float64)
