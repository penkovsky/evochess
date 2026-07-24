import pytest

from nnue.position import Position

#: The initial EvoChess position: 8 pawns and a king per side, nothing else.
#: Mirrors START_FEN in src/evochess/game.ts.
START_FEN = "4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1"

#: A position exercising every piece class the start position cannot reach:
#: a charged rook on a1, a knight on c3 that was downgraded from a rook (so it
#: is locked), and a free bishop on f3.
RICH_FEN = "4k3/pp3ppp/8/8/8/2N2B2/PP3PPP/R3K3 w - - 0 1"


@pytest.fixture
def start() -> Position:
    return Position(fen=START_FEN)


@pytest.fixture
def rich() -> Position:
    """A position with every kind of EvoChess state switched on at once.

    Deliberately dense: it is the base for the state-coverage test, which
    perturbs one field at a time and expects the feature vector to notice.
    """
    return Position(
        fen=RICH_FEN,
        minor_rights={"w": 2, "b": 1},
        rook_rights={"w": 1, "b": 0},
        pawn_move_progress={"w": 2, "b": 1},
        minor_move_progress={"w": 1, "b": 2},
        rook_charges={"a1": 3},
        rook_locked=frozenset({"c3"}),
        ep_evolved=None,
        score=0.75,
        outcome=1.0,
        termination="checkmate",
    )
