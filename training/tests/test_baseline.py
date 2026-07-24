"""Baseline material() tests — the yardstick must be faithful to ai.ts."""

import pytest

from nnue.baseline import material, material_stm, rook_value
from nnue.position import Position

from .conftest import START_FEN


class TestRookValue:
    def test_full_charges_is_a_whole_rook(self):
        assert rook_value(5) == 5.0

    def test_drained_decays_toward_a_minor(self):
        assert rook_value(0) == 3.0  # a spent rook is worth a minor

    def test_one_charge_stays_above_a_minor(self):
        # Mirrors ai.ts: a 1-charge rook is 3.4, still above a 3.0 minor.
        assert rook_value(1) == pytest.approx(3.4)


class TestMaterial:
    def test_start_position_is_balanced(self):
        assert material(Position(fen=START_FEN)) == 0.0

    def test_counts_a_full_rook_as_five(self):
        pos = Position(fen="4k3/8/8/8/8/8/8/R3K3 w - - 0 1", rook_charges={"a1": 5})
        assert material(pos) == pytest.approx(5.0)

    def test_rook_absent_from_map_is_full(self):
        pos = Position(fen="4k3/8/8/8/8/8/8/R3K3 w - - 0 1")
        assert material(pos) == pytest.approx(5.0)

    def test_applies_charge_decay(self):
        pos = Position(fen="4k3/8/8/8/8/8/8/R3K3 w - - 0 1", rook_charges={"a1": 1})
        assert material(pos) == pytest.approx(3.4)

    def test_locked_minor_still_counts_as_a_minor(self):
        # A downgraded (locked) knight is worth 3, same as a free one.
        pos = Position(fen="4k3/8/8/8/8/2N5/8/4K3 w - - 0 1", rook_locked=frozenset({"c3"}))
        assert material(pos) == pytest.approx(3.0)

    def test_black_pieces_are_negative(self):
        pos = Position(fen="n3k3/8/8/8/8/8/8/4K3 w - - 0 1")
        assert material(pos) == pytest.approx(-3.0)


class TestMaterialStm:
    def test_white_to_move_matches_white_positive(self):
        pos = Position(fen="4k3/8/8/8/8/8/8/Q3K3 w - - 0 1")
        assert material_stm(pos) == pytest.approx(9.0)

    def test_black_to_move_negates(self):
        # Same board, Black to move: the queen is the opponent's, so from the
        # side-to-move's view it is worth -9.
        pos = Position(fen="4k3/8/8/8/8/8/8/Q3K3 b - - 0 1")
        assert material_stm(pos) == pytest.approx(-9.0)
