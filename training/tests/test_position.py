"""Record-format tests: FEN parsing, JSONL round-trips, dedup, label soundness."""

import dataclasses

import pytest

from nnue.position import (
    SOUND_TERMINATIONS,
    EvolvedEnPassant,
    Position,
    deduplicate,
    parse_fen,
    read_positions,
    write_positions,
)

from .conftest import RICH_FEN, START_FEN


class TestParseFen:
    def test_start_position(self):
        board, turn = parse_fen(START_FEN)
        assert turn == "w"
        assert len(board) == 18
        assert board["e1"] == ("k", "w")
        assert board["e8"] == ("k", "b")
        assert board["a2"] == ("p", "w")
        assert board["h7"] == ("p", "b")

    def test_empty_squares_are_absent(self):
        board, _ = parse_fen(START_FEN)
        assert "e4" not in board

    def test_side_to_move(self):
        assert parse_fen(START_FEN.replace(" w ", " b "))[1] == "b"

    def test_rich_position_pieces(self):
        board, _ = parse_fen(RICH_FEN)
        assert board["a1"] == ("r", "w")
        assert board["c3"] == ("n", "w")
        assert board["f3"] == ("b", "w")
        assert len(board) == 15

    def test_case_carries_colour(self):
        board, _ = parse_fen("4k3/8/8/8/8/8/8/4K3 w - - 0 1")
        assert board["e1"][1] == "w"
        assert board["e8"][1] == "b"

    @pytest.mark.parametrize(
        "bad",
        [
            "",
            "4k3/8/8/8/8/8/8/4K3",  # no side to move
            "4k3/8/8/8/8/8/4K3 w - - 0 1",  # seven ranks
            "4k3/8/8/8/8/8/8/4K3/8 w - - 0 1",  # nine ranks
            "9/8/8/8/8/8/8/4K3 w - - 0 1",  # rank overflows
            "4k4/8/8/8/8/8/8/4K3 w - - 0 1",  # rank too long
            "4k2/8/8/8/8/8/8/4K3 w - - 0 1",  # rank too short
            "4k3/8/8/8/8/8/8/4K3 x - - 0 1",  # bad turn
        ],
    )
    def test_rejects_malformed_fens(self, bad):
        with pytest.raises(ValueError):
            parse_fen(bad)


class TestSerialisation:
    def test_round_trip_preserves_everything(self, rich):
        assert Position.from_json(rich.to_json()) == rich

    def test_start_position_round_trips(self, start):
        assert Position.from_json(start.to_json()) == start

    def test_zero_fields_are_omitted(self, start):
        # These files run to millions of lines, and at the start of a game
        # every optional field is empty.
        assert start.to_json() == {"fen": START_FEN}

    def test_ep_evolved_round_trips(self, start):
        position = dataclasses.replace(start, ep_evolved=EvolvedEnPassant("h6", "h5", "w"))
        assert Position.from_json(position.to_json()).ep_evolved == position.ep_evolved

    def test_jsonl_file_round_trip(self, tmp_path, start, rich):
        path = tmp_path / "positions.jsonl"
        assert write_positions(path, [start, rich]) == 2
        assert list(read_positions(path)) == [start, rich]

    def test_gzip_round_trip(self, tmp_path, start, rich):
        # The spec stages the dataset to the cloud box as one gzipped file.
        path = tmp_path / "positions.jsonl.gz"
        write_positions(path, [start, rich])
        assert list(read_positions(path)) == [start, rich]

    def test_one_line_per_position(self, tmp_path, start, rich):
        path = tmp_path / "positions.jsonl"
        write_positions(path, [start, rich])
        assert len(path.read_text().strip().splitlines()) == 2

    def test_reading_is_lazy(self, tmp_path, start):
        path = tmp_path / "positions.jsonl"
        write_positions(path, [start] * 3)
        stream = read_positions(path)
        assert next(stream) == start  # does not require the whole file


class TestStateKey:
    """The Python twin of stateKey() in ai.ts, used to deduplicate.

    It is also the check that the record format covers the whole position: if
    two genuinely different positions collide here, a field is missing.
    """

    def test_identical_positions_share_a_key(self, rich):
        assert rich.state_key() == dataclasses.replace(rich).state_key()

    def test_labels_do_not_affect_the_key(self, rich):
        # Two records of the same position from different games are the same
        # position, however they were scored.
        assert dataclasses.replace(rich, score=-9.0, outcome=0.0).state_key() == rich.state_key()

    @pytest.mark.parametrize(
        "changes",
        [
            {"fen": RICH_FEN.replace(" w ", " b ")},
            {"minor_rights": {"w": 0, "b": 1}},
            {"rook_rights": {"w": 0, "b": 0}},
            {"pawn_move_progress": {"w": 0, "b": 1}},
            {"minor_move_progress": {"w": 0, "b": 2}},
            {"rook_charges": {"a1": 1}},
            {"rook_locked": frozenset()},
            {"ep_evolved": EvolvedEnPassant("h6", "h5", "b")},
        ],
        ids=[
            "turn",
            "minor_rights",
            "rook_rights",
            "pawn_progress",
            "minor_progress",
            "rook_charges",
            "rook_locked",
            "ep_evolved",
        ],
    )
    def test_every_state_component_changes_the_key(self, rich, changes):
        assert dataclasses.replace(rich, **changes).state_key() != rich.state_key()

    def test_key_is_order_independent(self, rich):
        # dict/set iteration order must not leak into the key, or the same
        # position hashes two ways and dedup silently stops working.
        a = dataclasses.replace(rich, rook_charges={"a1": 3, "h1": 5}, rook_locked=frozenset("cf"))
        b = dataclasses.replace(rich, rook_charges={"h1": 5, "a1": 3}, rook_locked=frozenset("fc"))
        assert a.state_key() == b.state_key()


class TestDeduplicate:
    def test_drops_repeats(self, rich):
        assert list(deduplicate([rich, rich, rich])) == [rich]

    def test_keeps_distinct_positions(self, start, rich):
        assert list(deduplicate([start, rich])) == [start, rich]

    def test_keeps_the_first_of_a_duplicate_pair(self, rich):
        later = dataclasses.replace(rich, score=-1.0)
        assert list(deduplicate([rich, later])) == [rich]

    def test_boards_that_differ_only_in_evolution_state_both_survive(self, rich):
        # The whole reason dedup keys on state_key() and not the FEN.
        other = dataclasses.replace(rich, minor_rights={"w": 0, "b": 0})
        assert other.fen == rich.fen
        assert list(deduplicate([rich, other])) == [rich, other]


class TestOutcomeSoundness:
    def test_repetition_outcomes_are_unsound(self, rich):
        """chess.js judges repetition on the chess position alone.

        Two identical boards with different minorRights/pawnMoveProgress are
        not the same EvoChess position, so isThreefoldRepetition() can declare
        a draw that isn't one. Those labels must not quietly reach training.
        """
        position = dataclasses.replace(rich, outcome=0.5, termination="repetition")
        assert not position.outcome_is_sound
        assert "repetition" not in SOUND_TERMINATIONS

    @pytest.mark.parametrize("termination", sorted(SOUND_TERMINATIONS))
    def test_other_terminations_are_sound(self, rich, termination):
        assert dataclasses.replace(rich, outcome=0.5, termination=termination).outcome_is_sound

    def test_unlabelled_positions_are_not_sound(self, rich):
        assert not dataclasses.replace(rich, outcome=None, termination=None).outcome_is_sound

    def test_turn_reads_from_the_fen(self, rich):
        assert rich.turn == "w"
        assert dataclasses.replace(rich, fen=RICH_FEN.replace(" w ", " b ")).turn == "b"
