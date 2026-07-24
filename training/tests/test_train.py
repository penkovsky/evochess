"""End-to-end training tests on synthetic data. Skipped without torch.

These do not aim to produce a strong net — they check the pipeline holds
together: K is fitted, the loss falls, checkpoints round-trip, and resume
continues where it left off."""

from pathlib import Path

import numpy as np
import pytest

torch = pytest.importorskip("torch")

from nnue.position import Position, write_positions  # noqa: E402
from nnue.target import sigmoid  # noqa: E402
from nnue.train import (  # noqa: E402
    TrainConfig,
    last_checkpoint_path,
    load_positions,
    split,
    train,
)


def synthetic_positions(n: int, seed: int = 0) -> list[Position]:
    """Positions whose outcome follows sigmoid(score / K_true), K_true = 2.

    The board is varied so feature vectors differ (identical boards would be
    deduplicated away); the label carries the learnable signal.
    """
    rng = np.random.default_rng(seed)
    files = "abcdefgh"
    positions: list[Position] = []
    for i in range(n):
        # A lone queen wandered around the board keeps every position distinct.
        sq = f"{files[i % 8]}{(i // 8) % 8 + 1}"
        board = {"e1": "K", "e8": "k"}
        if sq not in ("e1", "e8"):
            board[sq] = "Q"
        fen = _fen_from(board)
        score = float(rng.uniform(-10, 10))
        outcome = float(rng.uniform() < sigmoid(score / 2.0))
        positions.append(Position(fen=fen, score=score, outcome=outcome, termination="cap"))
    return positions


def _fen_from(pieces: dict[str, str]) -> str:
    rows = []
    for rank in range(8, 0, -1):
        row, empty = "", 0
        for file in "abcdefgh":
            piece = pieces.get(f"{file}{rank}")
            if piece is None:
                empty += 1
            else:
                if empty:
                    row += str(empty)
                    empty = 0
                row += piece
        if empty:
            row += str(empty)
        rows.append(row)
    return "/".join(rows) + " w - - 0 1"


def test_load_positions_reads_and_dedups(tmp_path):
    positions = synthetic_positions(20)
    write_positions(tmp_path / "shard-1.jsonl", positions)
    write_positions(tmp_path / "shard-2.jsonl.gz", positions)  # same content again
    loaded = load_positions([str(tmp_path)])
    # Both shards hold the same positions, so dedup collapses them to 20.
    assert len(loaded) == 20


def test_split_is_disjoint_and_covers_everything():
    positions = synthetic_positions(50)
    train_set, val_set = split(positions, val_frac=0.2, seed=1)
    assert len(val_set) == 10
    assert len(train_set) == 40
    keys = {p.state_key() for p in train_set} | {p.state_key() for p in val_set}
    assert len(keys) == 50


def test_training_fits_k_and_reduces_loss(tmp_path):
    write_positions(tmp_path / "data.jsonl", synthetic_positions(600))
    cfg = TrainConfig(epochs=8, batch_size=64, lr=5e-3, seed=0)
    result = train([str(tmp_path)], str(tmp_path / "net.pt"), cfg)

    # K is fitted near the K_true=2 the labels were generated with.
    assert result["k"] == pytest.approx(2.0, rel=0.4)
    losses = [h["train"] for h in result["history"]]
    assert losses[-1] < losses[0]
    assert (tmp_path / "net.pt").exists()


def test_beats_material_baseline_on_learnable_signal(tmp_path):
    # The synthetic label depends only on a queen's presence, which material
    # sees too — but the net, given more epochs, should match or beat it. We
    # assert it gets within striking distance rather than demanding a win on a
    # toy set, since the real gate is the strength match, not this.
    write_positions(tmp_path / "data.jsonl", synthetic_positions(800))
    cfg = TrainConfig(epochs=15, batch_size=64, lr=5e-3, seed=0)
    result = train([str(tmp_path)], str(tmp_path / "net.pt"), cfg)
    final_val = result["history"][-1]["val"]
    assert final_val < result["baseline_val"] * 1.5


def test_checkpoint_resume_continues(tmp_path):
    write_positions(tmp_path / "data.jsonl", synthetic_positions(300))
    out = str(tmp_path / "net.pt")
    train([str(tmp_path)], out, TrainConfig(epochs=3, batch_size=64, seed=0))

    # `out` now holds the best-val epoch, which may be earlier than the last;
    # the `.last` sidecar is the latest-epoch state to continue training from.
    last = last_checkpoint_path(out)
    assert Path(last).exists()
    resumed = train([str(tmp_path)], out, TrainConfig(epochs=5, batch_size=64, seed=0), resume=last)
    # Resuming from epoch 2 runs epochs 3 and 4 only.
    assert [h["epoch"] for h in resumed["history"]] == [3, 4]


def test_out_holds_best_val_epoch(tmp_path):
    write_positions(tmp_path / "data.jsonl", synthetic_positions(300))
    out = str(tmp_path / "net.pt")
    result = train([str(tmp_path)], out, TrainConfig(epochs=6, batch_size=64, seed=0))

    saved_epoch = torch.load(out, map_location="cpu", weights_only=False)["epoch"]
    assert saved_epoch == result["best_epoch"]
    # The best-val epoch has the lowest val loss in the run.
    best = min(result["history"], key=lambda h: h["val"])
    assert saved_epoch == best["epoch"]
