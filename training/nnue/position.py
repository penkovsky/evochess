"""The on-disk record format: an EvoChess position plus its labels.

Per nnue-spec.md we store the *position*, not the extracted features, so the
feature set can be revised without regenerating the dataset. One JSON object
per line; ~100 bytes/position uncompressed.

The set of fields is not a matter of taste: it must cover exactly what
`stateKey()` in `src/evochess/ai.ts` hashes, because that is the authoritative
definition of "an EvoChess position". Anything stateKey hashes and we omit is
state the net is being asked to evaluate without being able to see it.

Sign conventions, which differ from the training target on purpose:

- `score` and `outcome` are stored **White-positive**, matching `evaluate()`
  in ai.ts. The flip to the side-to-move's perspective that the net wants
  happens in the target builder, at one clearly marked place. Storing them
  White-relative keeps the file readable without knowing whose turn it is.
- `termination` exists so repetition-terminated games can be dropped from the
  outcome signal. chess.js judges repetition on the chess position alone, but
  two identical boards with different rights/progress are not the same
  EvoChess position, so those draw labels are partly unsound (see the spec).
"""

from __future__ import annotations

import gzip
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Iterable, Iterator, Literal

Color = Literal["w", "b"]

# Mirrors ROOK_CHARGES in src/evochess/game.ts.
ROOK_CHARGES = 5

FILES = "abcdefgh"
RANKS = "12345678"
SQUARES = tuple(f + r for r in RANKS for f in FILES)

# How a game ended. Only `repetition` carries an unsound outcome label; the
# rest are trustworthy. `cap` is the generator's move-cap adjudication, which
# the spec makes mandatory because random play does not terminate on its own.
Termination = Literal[
    "checkmate",
    "stalemate",
    "insufficient",
    "fifty_moves",
    "repetition",
    "cap",
]

#: Terminations whose outcome label is sound enough to train on.
SOUND_TERMINATIONS: frozenset[str] = frozenset(
    {"checkmate", "stalemate", "insufficient", "fifty_moves", "cap"}
)


@dataclass(frozen=True)
class EvolvedEnPassant:
    """An en-passant capture of a pawn that evolved on its own double move.

    Invisible to the FEN — chess.js has no idea it exists — so it must be
    carried separately. Mirrors `EvolvedEnPassant` in game.ts, minus the
    chess.js-internal 0x88 `index`, which is a detail of applying the move
    rather than part of the position.
    """

    skipped: str
    victim: str
    #: The side that made the double move, i.e. the victim's owner. Never the
    #: side to move: the right is created by one side's move and the turn then
    #: flips to the only side that can take it.
    color: Color


@dataclass(frozen=True)
class Position:
    """One labelled EvoChess position."""

    fen: str
    minor_rights: dict[Color, int] = field(default_factory=lambda: {"w": 0, "b": 0})
    rook_rights: dict[Color, int] = field(default_factory=lambda: {"w": 0, "b": 0})
    pawn_move_progress: dict[Color, int] = field(default_factory=lambda: {"w": 0, "b": 0})
    minor_move_progress: dict[Color, int] = field(default_factory=lambda: {"w": 0, "b": 0})
    #: Charges left on each rook on the board, by square. A rook with no entry
    #: is freshly promoted and carries full charges, matching game.ts.
    rook_charges: dict[str, int] = field(default_factory=dict)
    #: Squares holding a minor that was downgraded from a rook, and so is
    #: permanently barred from becoming one again.
    rook_locked: frozenset[str] = frozenset()
    ep_evolved: EvolvedEnPassant | None = None
    #: Root search score in pawn units, White-positive. None if unlabelled.
    score: float | None = None
    #: Game result in {0.0, 0.5, 1.0}, White-positive. Backfilled at game end.
    outcome: float | None = None
    termination: Termination | None = None

    @property
    def turn(self) -> Color:
        return parse_fen(self.fen)[1]

    @property
    def outcome_is_sound(self) -> bool:
        """Whether `outcome` may be trained on. See the module docstring."""
        return self.outcome is not None and self.termination in SOUND_TERMINATIONS

    def to_json(self) -> dict:
        d: dict = {"fen": self.fen}
        # Counters are omitted when zero and rook state when empty: at the
        # start of a game that is every field, and these files are millions of
        # lines long.
        for key, value in (
            ("minorRights", self.minor_rights),
            ("rookRights", self.rook_rights),
            ("pawnMoveProgress", self.pawn_move_progress),
            ("minorMoveProgress", self.minor_move_progress),
        ):
            if value["w"] or value["b"]:
                d[key] = [value["w"], value["b"]]
        if self.rook_charges:
            d["rookCharges"] = self.rook_charges
        if self.rook_locked:
            d["rookLocked"] = sorted(self.rook_locked)
        if self.ep_evolved is not None:
            d["epEvolved"] = [
                self.ep_evolved.skipped,
                self.ep_evolved.victim,
                self.ep_evolved.color,
            ]
        if self.score is not None:
            d["score"] = self.score
        if self.outcome is not None:
            d["outcome"] = self.outcome
        if self.termination is not None:
            d["termination"] = self.termination
        return d

    @classmethod
    def from_json(cls, d: dict) -> "Position":
        def pair(key: str) -> dict[Color, int]:
            w, b = d.get(key, (0, 0))
            return {"w": w, "b": b}

        ep = d.get("epEvolved")
        return cls(
            fen=d["fen"],
            minor_rights=pair("minorRights"),
            rook_rights=pair("rookRights"),
            pawn_move_progress=pair("pawnMoveProgress"),
            minor_move_progress=pair("minorMoveProgress"),
            rook_charges=dict(d.get("rookCharges", {})),
            rook_locked=frozenset(d.get("rookLocked", ())),
            ep_evolved=EvolvedEnPassant(ep[0], ep[1], ep[2]) if ep else None,
            score=d.get("score"),
            outcome=d.get("outcome"),
            termination=d.get("termination"),
        )

    def state_key(self) -> str:
        """The Python twin of `stateKey()` in ai.ts.

        Used to deduplicate the dataset, which the spec requires because the
        generator's forced randomisation still revisits positions. It is also
        the check that this record format covers the whole position: if two
        genuinely different positions collide here, a field is missing.
        """
        charges = "".join(f"{sq}{n}" for sq, n in sorted(self.rook_charges.items()))
        locked = "".join(sorted(self.rook_locked))
        ep = f"{self.ep_evolved.skipped}{self.ep_evolved.victim}" if self.ep_evolved else ""
        return "|".join(
            (
                self.fen,
                f"{self.minor_rights['w']},{self.minor_rights['b']},"
                f"{self.rook_rights['w']},{self.rook_rights['b']}",
                f"{self.pawn_move_progress['w']},{self.pawn_move_progress['b']},"
                f"{self.minor_move_progress['w']},{self.minor_move_progress['b']}",
                charges,
                locked,
                ep,
            )
        )


def parse_fen(fen: str) -> tuple[dict[str, tuple[str, Color]], Color]:
    """Piece placement and side to move, as `({square: (type, colour)}, turn)`.

    Hand-rolled rather than pulled from python-chess: the feature extractor
    needs placement and the turn and nothing else, and python-chess models
    none of the EvoChess state that makes this position what it is. Keeping
    the parity-critical path dependency-free is worth thirty lines.
    """
    parts = fen.split()
    if len(parts) < 2:
        raise ValueError(f"not a FEN: {fen!r}")
    placement, turn = parts[0], parts[1]
    if turn not in ("w", "b"):
        raise ValueError(f"bad side to move in FEN: {turn!r}")

    rows = placement.split("/")
    if len(rows) != 8:
        raise ValueError(f"FEN has {len(rows)} ranks, want 8: {fen!r}")

    board: dict[str, tuple[str, Color]] = {}
    for row_index, row in enumerate(rows):
        rank = 8 - row_index  # FEN is written rank 8 first.
        file_index = 0
        for ch in row:
            if ch.isdigit():
                file_index += int(ch)
            else:
                if file_index >= 8:
                    raise ValueError(f"rank {rank} overflows in FEN: {fen!r}")
                square = f"{FILES[file_index]}{rank}"
                board[square] = (ch.lower(), "w" if ch.isupper() else "b")
                file_index += 1
        if file_index != 8:
            raise ValueError(f"rank {rank} has {file_index} files, want 8: {fen!r}")
    return board, turn  # type: ignore[return-value]


def _open(path: Path, mode: str) -> IO:
    return gzip.open(path, mode + "t") if path.suffix == ".gz" else open(path, mode)


def write_positions(path: Path | str, positions: Iterable[Position]) -> int:
    """Write JSONL (gzipped when `path` ends in .gz). Returns the count."""
    path = Path(path)
    written = 0
    with _open(path, "w") as fh:
        for position in positions:
            fh.write(json.dumps(position.to_json(), separators=(",", ":")) + "\n")
            written += 1
    return written


def read_positions(path: Path | str) -> Iterator[Position]:
    """Stream JSONL. Lazy: a 1M-position file need not fit in memory."""
    path = Path(path)
    with _open(path, "r") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield Position.from_json(json.loads(line))


def deduplicate(positions: Iterable[Position]) -> Iterator[Position]:
    """Drop repeat positions, keyed on `state_key()` as the spec requires."""
    seen: set[str] = set()
    for position in positions:
        key = position.state_key()
        if key not in seen:
            seen.add(key)
            yield position
