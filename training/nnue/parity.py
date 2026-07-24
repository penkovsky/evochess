"""Golden-vector parity between the TS and Python feature extractors.

Milestone 3, "the critical one". Feature-extraction skew between the trainer
(Python) and inference (TypeScript) is the number-one cause of silently
worthless NNUE nets: the net trains fine and plays badly, with nothing pointing
at the cause. The only defence is to pin both extractors to the same fixed
point and fail loudly the instant they drift.

That fixed point is two committed files under `training/parity/`:

    fixtures.json   canonical positions, chosen to hit every branch of the
                    extractor — each piece class, rights buckets, the rank
                    mirroring for both colours, a pending evolved en passant.
    golden.json     each fixture's active feature indices.

Because every feature is binary, the sorted list of active indices *is* the
vector, exactly and byte-comparably. Python generates golden.json (it is the
mutation-tested side); both languages then assert their own extractor
reproduces it — `tests/test_parity.py` here, `__tests__/nnueFeatures.test.ts`
in the app. Regenerate with `python -m nnue.parity`; the Python test fails if
the committed file is stale, so it can never rot silently.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .features import extract
from .position import EvolvedEnPassant, Position

PARITY_DIR = Path(__file__).resolve().parent.parent / "parity"
FIXTURES_PATH = PARITY_DIR / "fixtures.json"
GOLDEN_PATH = PARITY_DIR / "golden.json"


def build_fixtures() -> list[tuple[str, Position]]:
    """The canonical parity positions.

    Each is chosen to light up a branch the others do not. If you add a code
    path to the extractor, add a fixture that exercises it, or the parity test
    guards nothing there.
    """
    start = "4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1"
    fixtures: list[tuple[str, Position]] = [
        # The colour-symmetric start position from both sides: the sharpest
        # test of the side-to-move mirroring, since the two must come out
        # identical.
        ("start_white_to_move", Position(fen=start)),
        ("start_black_to_move", Position(fen=start.replace(" w ", " b "))),
        # A lone piece in a corner, White then Black to move, to pin the rank
        # mirroring in `relative_square` down to specific indices.
        ("corner_piece_white", Position(fen="4k3/8/8/8/8/8/8/N3K3 w - - 0 1")),
        ("corner_piece_black", Position(fen="n3k3/8/8/8/8/8/8/4K3 b - - 0 1")),
        # Free vs locked minors: same squares, different classes.
        ("free_minors", Position(fen="4k3/8/8/8/8/2N2B2/8/4K3 w - - 0 1")),
        (
            "locked_minors",
            Position(
                fen="4k3/8/8/8/8/2N2B2/8/4K3 w - - 0 1",
                rook_locked=frozenset({"c3", "f3"}),
            ),
        ),
        # A queen and king only, to cover those two classes in isolation.
        ("queen_and_kings", Position(fen="4k3/8/8/8/3Q4/8/8/4K3 w - - 0 1")),
    ]

    # Every rook-charge bucket r1..r5, one fixture each.
    for charges in range(1, 6):
        fixtures.append(
            (
                f"rook_charges_{charges}",
                Position(fen="4k3/8/8/8/8/8/8/R3K3 w - - 0 1", rook_charges={"a1": charges}),
            )
        )
    # A rook absent from the charge map must read as full (r5).
    fixtures.append(("rook_full_by_default", Position(fen="4k3/8/8/8/8/8/8/R3K3 w - - 0 1")))

    # Rights buckets 0..4, plus a clip case, on the side to move.
    for held in (0, 1, 2, 3, 4, 7):
        fixtures.append(
            (
                f"minor_rights_{held}",
                Position(fen=start, minor_rights={"w": held, "b": 0}),
            )
        )
    fixtures.append(
        ("rook_rights_both_sides", Position(fen=start, rook_rights={"w": 2, "b": 3}))
    )

    # Progress counters over their full 0..2 range, for both counters.
    for progress in (0, 1, 2):
        fixtures.append(
            (
                f"pawn_progress_{progress}",
                Position(fen=start, pawn_move_progress={"w": progress, "b": (progress + 1) % 3}),
            )
        )
        fixtures.append(
            (
                f"minor_progress_{progress}",
                Position(fen=start, minor_move_progress={"w": progress, "b": (progress + 2) % 3}),
            )
        )

    # A pending evolved en passant: Black to move, having just watched White's
    # double-moved pawn evolve on h5.
    fixtures.append(
        (
            "evolved_en_passant",
            Position(
                fen="4k3/8/8/7N/6p1/8/8/4K3 b - - 0 1",
                ep_evolved=EvolvedEnPassant(skipped="h6", victim="h5", color="w"),
            ),
        )
    )

    # A dense position with several kinds of state switched on at once — the
    # kind of thing that actually occurs mid-game.
    fixtures.append(
        (
            "mixed_state",
            Position(
                fen="4k3/pp3ppp/8/8/8/2N2B2/PP3PPP/R3K2r w - - 0 1",
                minor_rights={"w": 2, "b": 1},
                rook_rights={"w": 1, "b": 0},
                pawn_move_progress={"w": 2, "b": 1},
                minor_move_progress={"w": 1, "b": 2},
                rook_charges={"a1": 3, "h1": 1},
                rook_locked=frozenset({"c3"}),
            ),
        )
    )
    return fixtures


def active_indices(position: Position) -> list[int]:
    """Sorted indices of the active features — the golden representation."""
    return [int(i) for i in np.flatnonzero(extract(position))]


def golden_records() -> list[dict]:
    return [
        {"name": name, "active": active_indices(position)}
        for name, position in build_fixtures()
    ]


def fixture_records() -> list[dict]:
    return [
        {"name": name, "position": position.to_json()}
        for name, position in build_fixtures()
    ]


def write_parity_files() -> None:
    PARITY_DIR.mkdir(parents=True, exist_ok=True)
    FIXTURES_PATH.write_text(json.dumps(fixture_records(), indent=2) + "\n")
    GOLDEN_PATH.write_text(json.dumps(golden_records(), indent=2) + "\n")


if __name__ == "__main__":
    write_parity_files()
    print(f"wrote {len(build_fixtures())} fixtures to {FIXTURES_PATH}")
    print(f"wrote golden vectors to {GOLDEN_PATH}")
