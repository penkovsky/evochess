"""Target-math tests: the K fit and the White-positive -> side-to-move flip.

These are the load-bearing correctness checks for milestone 4. `fit_k` recovers
a known scale, and `build_target` flips frames and honours label soundness — a
sign error here would train the net to prefer losing, silently."""

import dataclasses

import numpy as np
import pytest

from nnue.position import Position
from nnue.target import (
    MATE_SCORE_THRESHOLD,
    build_target,
    fit_k,
    is_mate_score,
    is_trainable,
    sigmoid,
    sound_label_pairs,
)

from .conftest import START_FEN


class TestFitK:
    def test_recovers_a_known_scale_from_clean_data(self):
        # If outcomes are exactly sigmoid(score / K_true), the fit must find K.
        k_true = 2.5
        scores = np.linspace(-10, 10, 400)
        outcomes = sigmoid(scores / k_true)
        assert fit_k(scores, outcomes) == pytest.approx(k_true, rel=1e-2)

    def test_recovers_scale_under_bernoulli_noise(self):
        k_true = 3.0
        rng = np.random.default_rng(0)
        scores = rng.uniform(-12, 12, 20_000)
        outcomes = (rng.uniform(size=scores.shape) < sigmoid(scores / k_true)).astype(float)
        assert fit_k(scores, outcomes) == pytest.approx(k_true, rel=0.1)

    def test_is_frame_invariant(self):
        # Flipping both score and outcome to the other side leaves K unchanged.
        k_true = 2.0
        scores = np.linspace(-8, 8, 200)
        outcomes = sigmoid(scores / k_true)
        assert fit_k(scores, outcomes) == pytest.approx(fit_k(-scores, 1 - outcomes), rel=1e-6)

    def test_rejects_signalless_outcomes(self):
        # All draws: K is unidentifiable and must not be silently invented.
        with pytest.raises(ValueError):
            fit_k([1.0, -2.0, 3.0], [0.5, 0.5, 0.5])

    def test_rejects_empty(self):
        with pytest.raises(ValueError):
            fit_k([], [])

    def test_pawn_unit_scores_do_not_want_k_400(self):
        # The whole reason K is fitted: our scores are pawns, not centipawns,
        # so the familiar K=400 would flatten the sigmoid to a constant.
        scores = np.linspace(-10, 10, 200)
        outcomes = sigmoid(scores / 2.0)
        assert fit_k(scores, outcomes) < 50


def _scored(fen: str, score: float, outcome: float, termination="checkmate") -> Position:
    return Position(fen=fen, score=score, outcome=outcome, termination=termination)


class TestBuildTarget:
    def test_white_to_move_blends_in_white_frame(self):
        k, lam = 2.0, 0.7
        pos = _scored(START_FEN, score=3.0, outcome=1.0)
        expected = lam * float(sigmoid(3.0 / k)) + (1 - lam) * 1.0
        assert build_target(pos, k, lam) == pytest.approx(expected)

    def test_black_to_move_flips_both_score_and_outcome(self):
        k, lam = 2.0, 0.7
        # Same stored White-positive labels, but Black to move: from Black's
        # view the score negates and the outcome becomes (1 - outcome).
        pos = _scored(START_FEN.replace(" w ", " b "), score=3.0, outcome=1.0)
        expected = lam * float(sigmoid(-3.0 / k)) + (1 - lam) * 0.0
        assert build_target(pos, k, lam) == pytest.approx(expected)

    def test_a_won_position_targets_above_a_half_for_the_winner(self):
        # White clearly winning, White to move: target should exceed 0.5.
        assert build_target(_scored(START_FEN, 5.0, 1.0), k=2.0) > 0.5
        # Same position from the loser's side: below 0.5.
        assert build_target(_scored(START_FEN.replace(" w ", " b "), 5.0, 1.0), k=2.0) < 0.5

    def test_unsound_outcome_falls_back_to_score_only(self):
        # A repetition label is partly unsound, so the outcome term is dropped
        # and the target is the pure search-score signal.
        k = 2.0
        pos = Position(fen=START_FEN, score=3.0, outcome=0.5, termination="repetition")
        assert build_target(pos, k, lam=0.7) == pytest.approx(float(sigmoid(3.0 / k)))

    def test_unsound_target_ignores_the_outcome_value(self):
        k = 2.0
        a = Position(fen=START_FEN, score=3.0, outcome=0.0, termination="repetition")
        b = dataclasses.replace(a, outcome=1.0)
        assert build_target(a, k) == build_target(b, k)

    def test_sound_target_depends_on_the_outcome_value(self):
        k = 2.0
        a = _scored(START_FEN, 3.0, 0.0)
        b = dataclasses.replace(a, outcome=1.0)
        assert build_target(a, k) != build_target(b, k)

    def test_lambda_one_is_pure_search_score(self):
        k = 2.0
        pos = _scored(START_FEN, 3.0, 0.0)
        assert build_target(pos, k, lam=1.0) == pytest.approx(float(sigmoid(3.0 / k)))

    def test_augmented_position_with_no_outcome_uses_pure_score(self):
        # Material augmentation (nnue-data-coverage-spec.md mechanism 2) emits
        # score-only records: no outcome, no termination. That must fall back
        # to the same effective-lambda-1 path as an unsound outcome, not raise
        # and not silently invent an outcome of 0.5.
        k = 2.0
        pos = Position(fen=START_FEN, score=3.0)
        assert pos.outcome is None
        assert pos.termination is None
        assert not pos.outcome_is_sound
        assert build_target(pos, k, lam=0.7) == pytest.approx(float(sigmoid(3.0 / k)))

    def test_unscored_position_raises(self):
        with pytest.raises(ValueError):
            build_target(Position(fen=START_FEN), k=2.0)


class TestMateScoreFiltering:
    """Mate sentinels (±100000) are not evaluations and must not train the net."""

    @pytest.mark.parametrize("score", [99999.0, -99999.0, 100000.0, -100000.0, 1000.0])
    def test_recognises_mate_scores(self, score):
        assert is_mate_score(score)

    @pytest.mark.parametrize("score", [0.0, 5.0, -20.0, 30.0, None])
    def test_ordinary_scores_are_not_mate(self, score):
        assert not is_mate_score(score)

    def test_threshold_is_far_above_any_real_evaluation(self):
        # Real material never approaches this; the observed non-mate max is ~20.
        assert MATE_SCORE_THRESHOLD > 100

    def test_trainable_requires_a_non_mate_score(self):
        assert is_trainable(_scored(START_FEN, 5.0, 1.0))
        assert not is_trainable(_scored(START_FEN, 99998.0, 1.0))
        assert not is_trainable(Position(fen=START_FEN))  # unscored

    def test_mate_positions_are_excluded_from_k_fit(self):
        # A won position stored with a mate sentinel must not reach fit_k, where
        # sigmoid(1e5 / K) would saturate and bias the fit.
        positions = [
            _scored(START_FEN, 3.0, 1.0),
            _scored(START_FEN, 99999.0, 1.0),  # mate sentinel
            _scored(START_FEN, -2.0, 0.0),
        ]
        scores, _ = sound_label_pairs(positions)
        assert list(scores) == [3.0, -2.0]


class TestSoundLabelPairs:
    def test_excludes_repetition_and_unscored(self):
        positions = [
            _scored(START_FEN, 1.0, 1.0, "checkmate"),
            Position(fen=START_FEN, score=2.0, outcome=0.5, termination="repetition"),
            Position(fen=START_FEN, score=None, outcome=1.0, termination="cap"),
            _scored(START_FEN, -1.0, 0.0, "cap"),
        ]
        scores, outcomes = sound_label_pairs(positions)
        assert list(scores) == [1.0, -1.0]
        assert list(outcomes) == [1.0, 0.0]

    def test_excludes_score_only_augmented_positions(self):
        # A material-augmentation record (score, no outcome/termination) has
        # no outcome signal at all, so it must never reach the K fit — only
        # is_trainable (score-only training) sees it.
        positions = [
            _scored(START_FEN, 1.0, 1.0, "checkmate"),
            Position(fen=START_FEN, score=5.0),  # augmented: no outcome
        ]
        scores, outcomes = sound_label_pairs(positions)
        assert list(scores) == [1.0]
        assert list(outcomes) == [1.0]

    def test_feeds_fit_k_end_to_end(self):
        k_true = 2.0
        rng = np.random.default_rng(1)
        raw = rng.uniform(-10, 10, 5000)
        positions = [
            _scored(START_FEN, s, float(rng.uniform() < sigmoid(s / k_true))) for s in raw
        ]
        scores, outcomes = sound_label_pairs(positions)
        assert fit_k(scores, outcomes) == pytest.approx(k_true, rel=0.15)
