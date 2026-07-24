"""The feature extractor: an EvoChess position -> the net's input vector.

Everything is encoded **from the side-to-move's point of view** — ranks
mirrored, colours swapped — so the net learns one function rather than two,
and its output is a score from the side-to-move's perspective.

This file has a twin in TypeScript. They must agree exactly: feature-extraction
skew between trainer and inference is the number-one cause of silently
worthless NNUE nets, and it fails *quietly* — the net trains fine and plays
badly. `tests/test_parity.py` and its golden vectors exist solely to catch that,
so treat any change here as a change to both implementations.

Layout (1569 features):

    [0,    1536)  sparse piece-square: 2 colours x 12 classes x 64 squares
    [1536, 1569)  dense evolution state

Only ~32 of the sparse block are ever active — one per piece on the board —
which is what lets the first layer touch ~32 of its 1560 columns and makes the
net fast enough to skip incremental accumulator updates entirely.
"""

from __future__ import annotations

from typing import Iterator

import numpy as np

from .position import ROOK_CHARGES, Color, Position, parse_fen

# Mirror N_MINOR and M_ROOK in src/evochess/game.ts. Both are 3, so both
# progress counters live in 0..2 and one-hot to width 3.
N_MINOR = 3
M_ROOK = 3

#: The 12 piece classes. EvoChess-specific, and where most of the design lives:
#:
#: - `n`/`b`        a minor that may still become a rook
#: - `n_locked`/`b_locked`
#:                  downgraded from a rook, permanently barred from returning.
#:                  Strictly worse than a normal minor, and the net must be
#:                  able to see the difference.
#: - `r1`..`r5`     a rook bucketed by remaining charges. A 1-charge rook is
#:                  nearly a minor; a 5-charge rook is a real rook. Giving each
#:                  bucket its own class lets the net learn that curve rather
#:                  than inheriting rookValue()'s linear guess.
PIECE_CLASSES: tuple[str, ...] = (
    "p",
    "n",
    "b",
    "n_locked",
    "b_locked",
    "r1",
    "r2",
    "r3",
    "r4",
    "r5",
    "q",
    "k",
)
CLASS_INDEX = {name: i for i, name in enumerate(PIECE_CLASSES)}

NUM_SQUARES = 64
NUM_CLASSES = len(PIECE_CLASSES)
SPARSE_SIZE = 2 * NUM_CLASSES * NUM_SQUARES  # 1536

#: Rights accumulate without bound, so they are bucketed 0,1,2,3,4+ to keep the
#: input finite. One-hot rather than a clipped scalar: the width is free at this
#: size, and "is this right worth banking or spending" is the exact non-linear
#: judgement the net exists to make. (The spec estimates "~24" dense features
#: and one-hots only the progress counters; this is 33.)
RIGHTS_BUCKETS = 5

DENSE_FIELDS: tuple[tuple[str, int], ...] = (
    ("minor_rights_us", RIGHTS_BUCKETS),
    ("minor_rights_them", RIGHTS_BUCKETS),
    ("rook_rights_us", RIGHTS_BUCKETS),
    ("rook_rights_them", RIGHTS_BUCKETS),
    ("pawn_progress_us", N_MINOR),
    ("pawn_progress_them", N_MINOR),
    ("minor_progress_us", M_ROOK),
    ("minor_progress_them", M_ROOK),
    ("ep_evolved", 1),
)
DENSE_SIZE = sum(width for _, width in DENSE_FIELDS)  # 33
DENSE_OFFSET = SPARSE_SIZE
FEATURE_SIZE = SPARSE_SIZE + DENSE_SIZE  # 1569

#: Start of each dense field within the full vector.
DENSE_OFFSETS: dict[str, int] = {}
_offset = DENSE_OFFSET
for _name, _width in DENSE_FIELDS:
    DENSE_OFFSETS[_name] = _offset
    _offset += _width
del _offset, _name, _width


def opposite(color: Color) -> Color:
    return "b" if color == "w" else "w"


def relative_square(square: str, stm: Color) -> int:
    """Square index 0..63 from the side-to-move's point of view.

    A1 is 0 and H8 is 63 when White is to move. When Black is to move the rank
    is mirrored, so the side to move always looks up the board. Files are not
    mirrored — the board is symmetric left-to-right only by accident, and
    mirroring them would fold together genuinely different positions.
    """
    file_index = ord(square[0]) - ord("a")
    rank_index = int(square[1]) - 1
    if not (0 <= file_index < 8 and 0 <= rank_index < 8):
        raise ValueError(f"not a square: {square!r}")
    if stm == "b":
        rank_index = 7 - rank_index
    return rank_index * 8 + file_index


def piece_class(square: str, piece_type: str, position: Position) -> str:
    """Which of the 12 classes a piece on `square` belongs to."""
    if piece_type == "n" or piece_type == "b":
        return f"{piece_type}_locked" if square in position.rook_locked else piece_type
    if piece_type == "r":
        # A rook absent from rookCharges is freshly promoted and carries full
        # charges, matching game.ts. A rook can never sit on the board with
        # zero charges — spending the last one downgrades it that same turn —
        # but clamp anyway rather than emit an out-of-range index.
        charges = position.rook_charges.get(square, ROOK_CHARGES)
        return f"r{min(max(charges, 1), ROOK_CHARGES)}"
    return piece_type


def sparse_index(is_us: bool, class_name: str, relative_sq: int) -> int:
    """Index of one active piece-square feature."""
    return ((0 if is_us else 1) * NUM_CLASSES + CLASS_INDEX[class_name]) * NUM_SQUARES + relative_sq


def active_features(position: Position) -> Iterator[int]:
    """The ~32 active sparse indices — one per piece on the board."""
    board, stm = parse_fen(position.fen)
    for square, (piece_type, color) in board.items():
        yield sparse_index(
            color == stm,
            piece_class(square, piece_type, position),
            relative_square(square, stm),
        )


def _one_hot_index(field: str, value: int, width: int) -> int:
    return DENSE_OFFSETS[field] + min(max(value, 0), width - 1)


def dense_active_indices(position: Position) -> list[int]:
    """The ~8-9 active indices in the dense evolution-state block.

    This is the part a material evaluation cannot express, and the whole reason
    for the exercise: it is where "this right is worth more in three moves than
    it is now" has to come from. Must be included in every real evaluation, not
    just `extract()`'s full-vector materialisation — `infer.py`'s
    `evaluate_position` was found to skip this entirely (mirroring the same bug
    independently present in nnue.ts), so the golden-vector parity fixtures
    silently compared two implementations that agreed only because both
    dropped the dense block the same way.
    """
    stm = parse_fen(position.fen)[1]
    them = opposite(stm)

    indices = [
        _one_hot_index("minor_rights_us", position.minor_rights[stm], RIGHTS_BUCKETS),
        _one_hot_index("minor_rights_them", position.minor_rights[them], RIGHTS_BUCKETS),
        _one_hot_index("rook_rights_us", position.rook_rights[stm], RIGHTS_BUCKETS),
        _one_hot_index("rook_rights_them", position.rook_rights[them], RIGHTS_BUCKETS),
        _one_hot_index("pawn_progress_us", position.pawn_move_progress[stm], N_MINOR),
        _one_hot_index("pawn_progress_them", position.pawn_move_progress[them], N_MINOR),
        _one_hot_index("minor_progress_us", position.minor_move_progress[stm], M_ROOK),
        _one_hot_index("minor_progress_them", position.minor_move_progress[them], M_ROOK),
    ]

    # One flag suffices, with no need to say whose: the right is created by one
    # side's double move and the turn then flips, so a pending evolved en
    # passant is always the side to move's to take.
    if position.ep_evolved is not None:
        indices.append(DENSE_OFFSETS["ep_evolved"])

    return indices


def dense_features(position: Position, vector: np.ndarray) -> None:
    """Write the evolution-state block into `vector` in place."""
    for index in dense_active_indices(position):
        vector[index] = 1.0


def extract(position: Position) -> np.ndarray:
    """The full dense input vector. Mostly for tests and the parity check.

    Training and inference use `active_features()` plus `dense_features()`
    directly — materialising 1569 floats to read 32 of them is the thing the
    sparse-column trick exists to avoid.
    """
    vector = np.zeros(FEATURE_SIZE, dtype=np.float32)
    for index in active_features(position):
        vector[index] = 1.0
    dense_features(position, vector)
    return vector
