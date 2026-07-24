"""Feature extractor tests.

The load-bearing ones are `test_mirrored_start_position_is_identical` (the
side-to-move encoding, which is what lets the net learn one function instead of
two) and `TestStateCoverage` (which asserts the feature set sees everything
stateKey() hashes — if it does not, the net is being asked to evaluate a
position it cannot see).
"""

import dataclasses

import numpy as np
import pytest

from nnue.features import (
    CLASS_INDEX,
    DENSE_OFFSETS,
    DENSE_SIZE,
    FEATURE_SIZE,
    PIECE_CLASSES,
    SPARSE_SIZE,
    active_features,
    extract,
    piece_class,
    relative_square,
    sparse_index,
)
from nnue.position import EvolvedEnPassant, Position

from .conftest import RICH_FEN


class TestLayout:
    def test_twelve_piece_classes(self):
        assert len(PIECE_CLASSES) == 12
        assert len(set(PIECE_CLASSES)) == 12

    def test_sparse_block_is_two_colours_by_twelve_classes_by_64_squares(self):
        assert SPARSE_SIZE == 2 * 12 * 64 == 1536

    def test_vector_is_sparse_block_plus_dense_block(self):
        assert FEATURE_SIZE == SPARSE_SIZE + DENSE_SIZE

    def test_sparse_indices_are_distinct_and_in_range(self):
        seen = {
            sparse_index(is_us, name, square)
            for is_us in (True, False)
            for name in PIECE_CLASSES
            for square in range(64)
        }
        assert len(seen) == SPARSE_SIZE
        assert min(seen) == 0 and max(seen) == SPARSE_SIZE - 1

    def test_dense_fields_do_not_overlap_and_sit_after_the_sparse_block(self):
        assert min(DENSE_OFFSETS.values()) == SPARSE_SIZE
        assert max(DENSE_OFFSETS.values()) < FEATURE_SIZE


class TestRelativeSquare:
    def test_white_to_move_reads_a1_as_zero_and_h8_as_63(self):
        assert relative_square("a1", "w") == 0
        assert relative_square("h8", "w") == 63

    def test_black_to_move_mirrors_the_rank(self):
        # Black looks up the board: its own back rank becomes index 0.
        assert relative_square("a8", "b") == 0
        assert relative_square("h1", "b") == 63

    def test_files_are_not_mirrored(self):
        # Mirroring files would fold together positions that genuinely differ.
        assert relative_square("a1", "w") != relative_square("h1", "w")
        assert relative_square("a1", "b") == 56
        assert relative_square("h1", "b") == 63

    @pytest.mark.parametrize("square", ["a1", "e4", "h8", "d7"])
    def test_mirroring_twice_returns_the_original(self, square):
        file_index = relative_square(square, "w") % 8
        rank_index = relative_square(square, "w") // 8
        mirrored = relative_square(square, "b")
        assert mirrored == (7 - rank_index) * 8 + file_index

    @pytest.mark.parametrize("bad", ["i1", "a9", "a0", "z9"])
    def test_rejects_non_squares(self, bad):
        with pytest.raises(ValueError):
            relative_square(bad, "w")


class TestStartPosition:
    def test_has_eighteen_active_pieces(self, start):
        assert len(list(active_features(start))) == 18  # 16 pawns + 2 kings

    def test_active_features_are_distinct(self, start):
        indices = list(active_features(start))
        assert len(set(indices)) == len(indices)

    def test_only_pawns_and_kings_are_active(self, start):
        vector = extract(start)
        for name in PIECE_CLASSES:
            if name in ("p", "k"):
                continue
            for is_us in (True, False):
                block = [sparse_index(is_us, name, sq) for sq in range(64)]
                assert vector[block].sum() == 0, f"{name} should not be on the board"

    def test_dense_block_is_all_zero_counters(self, start):
        vector = extract(start)
        # Every counter is zero and no rights are held, so each one-hot fires
        # in its zero bucket and the ep flag is clear: eight bucket-zeros.
        assert vector[SPARSE_SIZE:].sum() == 8
        assert vector[DENSE_OFFSETS["ep_evolved"]] == 0

    def test_mirrored_start_position_is_identical(self, start):
        """The whole point of side-to-move-relative encoding.

        The start position is colour-symmetric, so flipping only the side to
        move must produce a byte-identical vector: from Black's point of view
        the board looks exactly as it does from White's. If this fails, the
        mirroring is wrong and the net will learn two half-functions.
        """
        black_to_move = dataclasses.replace(start, fen=start.fen.replace(" w ", " b "))
        assert np.array_equal(extract(start), extract(black_to_move))


class TestPieceClasses:
    def test_locked_minors_are_distinct_from_free_minors(self, rich):
        # c3 holds a knight downgraded from a rook: permanently barred from
        # ever becoming one again, and so strictly worse than a normal knight.
        assert piece_class("c3", "n", rich) == "n_locked"
        assert piece_class("f3", "b", rich) == "b"

        free = dataclasses.replace(rich, rook_locked=frozenset())
        assert piece_class("c3", "n", free) == "n"
        assert not np.array_equal(extract(rich), extract(free))

    def test_locked_bishop_is_its_own_class(self, rich):
        locked = dataclasses.replace(rich, rook_locked=frozenset({"c3", "f3"}))
        assert piece_class("f3", "b", locked) == "b_locked"

    @pytest.mark.parametrize("charges", [1, 2, 3, 4, 5])
    def test_rooks_bucket_by_remaining_charges(self, rich, charges):
        position = dataclasses.replace(rich, rook_charges={"a1": charges})
        assert piece_class("a1", "r", position) == f"r{charges}"

    def test_each_charge_count_gets_a_different_feature(self, rich):
        # A 1-charge rook is nearly a minor and a 5-charge rook is a real rook,
        # so they must not share a column.
        vectors = [
            extract(dataclasses.replace(rich, rook_charges={"a1": c})) for c in (1, 2, 3, 4, 5)
        ]
        for i in range(len(vectors)):
            for j in range(i + 1, len(vectors)):
                assert not np.array_equal(vectors[i], vectors[j])

    def test_rook_absent_from_charges_map_carries_full_charges(self, rich):
        # Matches game.ts: a rook with no entry is treated as freshly promoted.
        fresh = dataclasses.replace(rich, rook_charges={})
        assert piece_class("a1", "r", fresh) == "r5"
        assert np.array_equal(
            extract(fresh),
            extract(dataclasses.replace(rich, rook_charges={"a1": 5})),
        )

    def test_charges_are_clamped_into_range(self, rich):
        # A zero-charge rook cannot stand on the board — spending the last
        # charge downgrades it the same turn — but clamp rather than emit an
        # out-of-range index if the generator ever writes one.
        assert piece_class("a1", "r", dataclasses.replace(rich, rook_charges={"a1": 0})) == "r1"
        assert piece_class("a1", "r", dataclasses.replace(rich, rook_charges={"a1": 9})) == "r5"

    def test_ours_and_theirs_use_different_columns(self):
        white = Position(fen="4k3/8/8/8/8/8/8/N3K3 w - - 0 1")  # our knight on a1
        black = Position(fen="n3k3/8/8/8/8/8/8/4K3 w - - 0 1")  # their knight on a8
        assert sparse_index(True, "n", 0) != sparse_index(False, "n", 0)
        assert not np.array_equal(extract(white), extract(black))


class TestDenseFeatures:
    @pytest.mark.parametrize("held,bucket", [(0, 0), (1, 1), (2, 2), (3, 3), (4, 4)])
    def test_rights_one_hot_by_count(self, start, held, bucket):
        position = dataclasses.replace(start, minor_rights={"w": held, "b": 0})
        vector = extract(position)
        assert vector[DENSE_OFFSETS["minor_rights_us"] + bucket] == 1.0

    @pytest.mark.parametrize("held", [4, 5, 9, 100])
    def test_rights_clip_at_four_plus(self, start, held):
        # Rights accumulate without bound; the input must stay finite.
        position = dataclasses.replace(start, minor_rights={"w": held, "b": 0})
        assert extract(position)[DENSE_OFFSETS["minor_rights_us"] + 4] == 1.0

    def test_rights_below_the_clip_are_distinguishable(self, start):
        vectors = [
            extract(dataclasses.replace(start, minor_rights={"w": n, "b": 0})) for n in range(5)
        ]
        for i in range(len(vectors)):
            for j in range(i + 1, len(vectors)):
                assert not np.array_equal(vectors[i], vectors[j])

    @pytest.mark.parametrize("field", ["minor_rights_us", "rook_rights_us", "pawn_progress_us"])
    def test_each_one_hot_fires_exactly_once(self, rich, field):
        vector = extract(rich)
        width = 5 if "rights" in field else 3
        offset = DENSE_OFFSETS[field]
        assert vector[offset : offset + width].sum() == 1.0

    @pytest.mark.parametrize("progress", [0, 1, 2])
    def test_pawn_progress_one_hot_over_zero_to_two(self, start, progress):
        # N_MINOR is 3, so progress lives in 0..2 and resets on earning a right.
        position = dataclasses.replace(start, pawn_move_progress={"w": progress, "b": 0})
        assert extract(position)[DENSE_OFFSETS["pawn_progress_us"] + progress] == 1.0

    @pytest.mark.parametrize("progress", [0, 1, 2])
    def test_minor_progress_one_hot_over_zero_to_two(self, start, progress):
        position = dataclasses.replace(start, minor_move_progress={"w": progress, "b": 0})
        assert extract(position)[DENSE_OFFSETS["minor_progress_us"] + progress] == 1.0

    def test_us_and_them_swap_with_the_side_to_move(self, start):
        white_to_move = dataclasses.replace(start, minor_rights={"w": 3, "b": 1})
        black_to_move = dataclasses.replace(
            start, fen=start.fen.replace(" w ", " b "), minor_rights={"w": 1, "b": 3}
        )
        # Same board, and each side holds the same rights relative to itself:
        # the two must encode identically.
        assert np.array_equal(extract(white_to_move), extract(black_to_move))

    def test_ep_evolved_flag(self, start):
        assert extract(start)[DENSE_OFFSETS["ep_evolved"]] == 0.0
        pending = dataclasses.replace(
            start,
            fen=start.fen.replace(" w ", " b "),
            ep_evolved=EvolvedEnPassant(skipped="h6", victim="h5", color="w"),
        )
        assert extract(pending)[DENSE_OFFSETS["ep_evolved"]] == 1.0


class TestStateCoverage:
    """The feature set must cover everything `stateKey()` in ai.ts hashes.

    stateKey is the authoritative definition of what an EvoChess position is.
    Any component it hashes that the features ignore is state the net cannot
    see, and it will evaluate two genuinely different positions identically.
    Each case below perturbs exactly one component of `rich`.
    """

    @staticmethod
    def _differs(base: Position, **changes) -> bool:
        return not np.array_equal(extract(base), extract(dataclasses.replace(base, **changes)))

    def test_board_is_seen(self, rich):
        assert self._differs(rich, fen=RICH_FEN.replace("2N2B2", "2N3B1"))

    def test_side_to_move_is_seen(self, rich):
        assert self._differs(rich, fen=RICH_FEN.replace(" w ", " b "))

    @pytest.mark.parametrize("color", ["w", "b"])
    def test_minor_rights_are_seen(self, rich, color):
        rights = dict(rich.minor_rights) | {color: rich.minor_rights[color] + 1}
        assert self._differs(rich, minor_rights=rights)

    @pytest.mark.parametrize("color", ["w", "b"])
    def test_rook_rights_are_seen(self, rich, color):
        rights = dict(rich.rook_rights) | {color: rich.rook_rights[color] + 1}
        assert self._differs(rich, rook_rights=rights)

    @pytest.mark.parametrize("color", ["w", "b"])
    def test_pawn_move_progress_is_seen(self, rich, color):
        progress = dict(rich.pawn_move_progress) | {color: (rich.pawn_move_progress[color] + 1) % 3}
        assert self._differs(rich, pawn_move_progress=progress)

    @pytest.mark.parametrize("color", ["w", "b"])
    def test_minor_move_progress_is_seen(self, rich, color):
        progress = dict(rich.minor_move_progress) | {
            color: (rich.minor_move_progress[color] + 1) % 3
        }
        assert self._differs(rich, minor_move_progress=progress)

    def test_rook_charges_are_seen(self, rich):
        assert self._differs(rich, rook_charges={"a1": 1})

    def test_rook_locked_is_seen(self, rich):
        assert self._differs(rich, rook_locked=frozenset())

    def test_ep_evolved_is_seen(self, rich):
        assert self._differs(rich, ep_evolved=EvolvedEnPassant("h6", "h5", "b"))

    def test_labels_are_not_seen(self, rich):
        """Scores and outcomes are targets, not inputs.

        Leaking either into the feature vector would let the net read the
        answer off its own input and train to a loss of zero while learning
        nothing.
        """
        assert not self._differs(rich, score=-5.0)
        assert not self._differs(rich, outcome=0.0)
        assert not self._differs(rich, termination="cap")


class TestExtractShape:
    def test_dtype_and_shape(self, rich):
        vector = extract(rich)
        assert vector.shape == (FEATURE_SIZE,)
        assert vector.dtype == np.float32

    def test_vector_is_binary(self, rich):
        assert set(np.unique(extract(rich))).issubset({0.0, 1.0})

    def test_extract_agrees_with_the_sparse_iterator(self, rich):
        vector = extract(rich)
        active = set(active_features(rich))
        assert {int(i) for i in np.flatnonzero(vector[:SPARSE_SIZE])} == active

    def test_sparse_block_has_one_feature_per_piece(self, rich):
        vector = extract(rich)
        assert vector[:SPARSE_SIZE].sum() == 15  # 10 pawns, 2 kings, N, B, R

    def test_class_index_matches_declared_order(self):
        assert [CLASS_INDEX[name] for name in PIECE_CLASSES] == list(range(12))
