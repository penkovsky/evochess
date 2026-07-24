"""Training targets and the K fit.

The net is trained to reproduce a blend of the engine's search score and the
game outcome (standard NNUE practice):

    target = lambda * sigmoid(search_score / K) + (1 - lambda) * wdl_outcome
    loss   = MSE(sigmoid(net_output / K), target)

The search score is a dense, low-variance signal that converges fast; the game
outcome stops the net inheriting the engine's blind spots. `lambda` weights the
two (0.7 to start).

Two things this module is careful about:

**K must be fitted, not assumed.** Every NNUE reference uses K=400 because its
scores are in centipawns. Ours are in *pawn units* (pawn = 1.0), so K=400 is
meaningless here — it would flatten sigmoid(score/K) to a constant. `fit_k`
recovers the right scale by regressing observed outcome against search score
over the data, exactly as the spec requires, before any training happens.

**The stored labels are White-positive; the target is side-to-move-relative.**
This is the one place the flip happens (position.py stores White-positive on
purpose so the file is readable). `build_target` converts, and it is the only
code that should.
"""

from __future__ import annotations

from typing import Iterable, Sequence

import numpy as np

from .position import Position

#: Default blend weight from the spec: mostly search score, some outcome.
DEFAULT_LAMBDA = 0.7

#: The search returns ±(MATE - ply) ≈ ±100000 for a forced mate. Those are
#: sentinels, not pawn-unit evaluations, and must be kept out of the training
#: signal: a static evaluator is not meant to reproduce mate distances, and
#: sigmoid(±1e5 / K) saturates to 0/1 regardless of K, which would corrupt the
#: K fit. Real material never approaches this — the observed non-mate maximum is
#: ~20 pawns — so any score past it is unambiguously a mate.
MATE_SCORE_THRESHOLD = 1000.0


def is_mate_score(score: float | None) -> bool:
    return score is not None and abs(score) >= MATE_SCORE_THRESHOLD


def is_trainable(position: Position) -> bool:
    """Whether a position carries a usable pawn-unit score label."""
    return position.score is not None and not is_mate_score(position.score)


def sigmoid(x: np.ndarray | float) -> np.ndarray | float:
    return 1.0 / (1.0 + np.exp(-np.asarray(x, dtype=np.float64)))


def fit_k(
    scores: Sequence[float],
    outcomes: Sequence[float],
    lo: float = 0.1,
    hi: float = 20.0,
) -> float:
    """Fit K by least-squares regression of outcome onto sigmoid(score / K).

    `scores` and `outcomes` must share a frame (both White-positive is the
    natural choice, and what `sound_label_pairs` returns). K is frame-invariant
    anyway — flipping both score and outcome to the other side leaves the fit
    unchanged — so the frame only has to be *consistent*, not any particular
    one.

    Raises if the outcomes carry no signal (all draws, say): K is
    unidentifiable when sigmoid's target is constant.
    """
    scores_arr = np.asarray(scores, dtype=np.float64)
    outcomes_arr = np.asarray(outcomes, dtype=np.float64)
    if scores_arr.size == 0:
        raise ValueError("fit_k needs at least one (score, outcome) pair")
    if np.ptp(outcomes_arr) < 1e-9:
        raise ValueError(
            "outcomes have no variance (all identical); K cannot be identified. "
            "Generate decisive games or widen adjudication."
        )

    def loss(k: float) -> float:
        return float(np.mean((sigmoid(scores_arr / k) - outcomes_arr) ** 2))

    # Coarse log-spaced scan to bracket the minimum, then golden-section refine.
    # The loss is smooth and unimodal in K in practice, but the scan guards
    # against the refinement starting in the wrong basin.
    grid = np.geomspace(lo, hi, 60)
    best = min(grid, key=loss)
    a, b = best / 1.5, best * 1.5
    inv_phi = (np.sqrt(5.0) - 1.0) / 2.0
    c, d = b - inv_phi * (b - a), a + inv_phi * (b - a)
    for _ in range(200):
        if loss(c) < loss(d):
            b = d
        else:
            a = c
        c, d = b - inv_phi * (b - a), a + inv_phi * (b - a)
        if b - a < 1e-7:
            break
    return float((a + b) / 2.0)


def sound_label_pairs(positions: Iterable[Position]) -> tuple[np.ndarray, np.ndarray]:
    """White-positive (score, outcome) pairs for K fitting.

    Only positions with a sound outcome are returned — the spec forbids fitting
    on repetition draws, whose labels are partly unsound because chess.js judges
    repetition on the board alone. Positions without a score are skipped too.
    """
    scores: list[float] = []
    outcomes: list[float] = []
    for position in positions:
        if not is_trainable(position) or not position.outcome_is_sound:
            continue
        scores.append(position.score)  # type: ignore[arg-type]
        outcomes.append(position.outcome)  # type: ignore[arg-type]
    return np.asarray(scores, dtype=np.float64), np.asarray(outcomes, dtype=np.float64)


def build_target(position: Position, k: float, lam: float = DEFAULT_LAMBDA) -> float:
    """The training target for one position, from the side-to-move's view.

    Converts the stored White-positive labels to the side-to-move frame the net
    is trained in, then blends. For a position whose outcome is *unsound*
    (repetition), the outcome term is dropped — the blend collapses to the
    search-score signal (effective lambda of 1) rather than trusting a bad
    label. Its search score is still perfectly good, so the position is kept.
    """
    if position.score is None:
        raise ValueError("cannot build a target for an unscored position")

    white_to_move = position.turn == "w"
    stm_score = position.score if white_to_move else -position.score

    effective_lambda = lam if position.outcome_is_sound else 1.0
    score_term = float(sigmoid(stm_score / k))
    if effective_lambda >= 1.0:
        return score_term

    stm_outcome = position.outcome if white_to_move else 1.0 - position.outcome  # type: ignore[operator]
    return effective_lambda * score_term + (1.0 - effective_lambda) * float(stm_outcome)
