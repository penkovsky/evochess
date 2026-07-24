"""Train the NNUE evaluator (milestone 4).

    python -m nnue.train --data training/data --epochs 20 \
        --out training/checkpoints/net.pt

Pipeline: load the generated shards, deduplicate on `stateKey`, split off a
validation set, **fit K on the training split** (never assumed), then train the
net to match the blended target. Each epoch reports train loss, validation
loss, and the material baseline's validation loss — the milestone-4 gate is
that the net's val loss drops below the baseline's.

Checkpoints are written every epoch and `--resume` continues from one, because
the compute plan is a rented GPU / Colab box that can vanish mid-run.
"""

from __future__ import annotations

import argparse
import random
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

from .baseline import baseline_predictions
from .dataset import PositionDataset
from .model import NnueNet
from .position import Position, deduplicate, read_positions
from .target import DEFAULT_LAMBDA, fit_k, is_trainable, sound_label_pairs


@dataclass
class TrainConfig:
    epochs: int = 20
    batch_size: int = 256
    lr: float = 1e-3
    weight_decay: float = 1e-4
    lam: float = DEFAULT_LAMBDA
    val_frac: float = 0.1
    seed: int = 0
    split_seed: int | None = None  # defaults to `seed` if unset; set explicitly to hold the val split fixed across seeds
    limit: int | None = None
    k: float | None = None  # override the fit, mainly for tests


def load_positions(paths: list[str], limit: int | None = None) -> list[Position]:
    """Read every shard under `paths` (files or directories), deduplicated."""
    files: list[Path] = []
    for raw in paths:
        p = Path(raw)
        files.extend(sorted(p.glob("*.jsonl*")) if p.is_dir() else [p])
    if not files:
        raise FileNotFoundError(f"no shards found under {paths}")

    def stream():
        for f in files:
            yield from read_positions(f)

    # Drop positions the net can't learn from: mate sentinels (±100000, not
    # evaluations) and any unscored record. Done here so every downstream
    # consumer — K fit, dataset, baseline — sees only trainable positions.
    out: list[Position] = []
    for position in deduplicate(stream()):
        if not is_trainable(position):
            continue
        out.append(position)
        if limit is not None and len(out) >= limit:
            break
    return out


def split(positions: list[Position], val_frac: float, seed: int):
    order = list(range(len(positions)))
    random.Random(seed).shuffle(order)
    n_val = max(1, int(len(positions) * val_frac)) if len(positions) > 1 else 0
    val_idx = set(order[:n_val])
    train = [positions[i] for i in order[n_val:]]
    val = [positions[i] for i in order[:n_val]]
    return train, val


def evaluate_loss(model: NnueNet, loader: DataLoader, k: float, device: torch.device) -> float:
    model.eval()
    total, count = 0.0, 0
    with torch.no_grad():
        for features, target in loader:
            features, target = features.to(device), target.to(device)
            pred = torch.sigmoid(model(features) / k)
            total += torch.sum((pred - target) ** 2).item()
            count += target.numel()
    return total / max(count, 1)


def baseline_loss(positions: list[Position], targets: np.ndarray, k: float) -> float:
    preds = baseline_predictions(positions, k)
    return float(np.mean((preds - targets) ** 2))


def train(paths: list[str], out: str, cfg: TrainConfig, resume: str | None = None) -> dict:
    torch.manual_seed(cfg.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    positions = load_positions(paths, cfg.limit)
    split_seed = cfg.split_seed if cfg.split_seed is not None else cfg.seed
    train_positions, val_positions = split(positions, cfg.val_frac, split_seed)
    print(f"{len(positions)} unique positions -> {len(train_positions)} train, {len(val_positions)} val")

    if cfg.k is not None:
        k = cfg.k
    else:
        scores, outcomes = sound_label_pairs(train_positions)
        k = fit_k(scores, outcomes)
    print(f"K = {k:.4f} (fitted on {len(train_positions)} train positions)")

    train_ds = PositionDataset(train_positions, k, cfg.lam)
    train_loader = DataLoader(train_ds, batch_size=cfg.batch_size, shuffle=True)
    val_ds = PositionDataset(val_positions, k, cfg.lam) if val_positions else None
    val_loader = DataLoader(val_ds, batch_size=cfg.batch_size) if val_ds else None
    base_val = baseline_loss(val_positions, val_ds.targets, k) if val_ds else float("nan")

    model = NnueNet().to(device)
    if cfg.weight_decay > 0:
        print("Using AdamW")
        optimizer = torch.optim.AdamW(model.parameters(), lr=cfg.lr, weight_decay=cfg.weight_decay)
    else:
        optimizer = torch.optim.Adam(model.parameters(), lr=cfg.lr)
    start_epoch = 0
    if resume:
        # weights_only=False: this is our own checkpoint, and it carries
        # optimizer state and config, not just tensors.
        state = torch.load(resume, map_location=device, weights_only=False)
        model.load_state_dict(state["model"])
        optimizer.load_state_dict(state["optimizer"])
        k = state["k"]
        start_epoch = state["epoch"] + 1
        print(f"resumed from {resume} at epoch {start_epoch}, K = {k:.4f}")

    history = []
    best_val = float("inf")
    best_epoch = -1
    for epoch in range(start_epoch, cfg.epochs):
        model.train()
        running, seen = 0.0, 0
        for features, target in train_loader:
            features, target = features.to(device), target.to(device)
            optimizer.zero_grad()
            pred = torch.sigmoid(model(features) / k)
            loss = torch.mean((pred - target) ** 2)
            loss.backward()
            optimizer.step()
            running += loss.item() * target.numel()
            seen += target.numel()
        train_loss = running / max(seen, 1)
        val_loss = evaluate_loss(model, val_loader, k, device) if val_loader else float("nan")
        history.append({"epoch": epoch, "train": train_loss, "val": val_loss})
        beats = "beats baseline" if val_loss < base_val else "BELOW baseline"
        # Keep the best-validation checkpoint in `out`, not the last epoch: the
        # net overfits well before cfg.epochs (train loss keeps dropping while
        # val rises), so the final epoch is a weaker evaluator than the best.
        # `out` is what export/match consume, so it must be the best net.
        # The latest epoch always goes to the `.last` sidecar so `--resume`
        # (and crash recovery) can continue from where training actually
        # stopped. With no validation split there's no early-stopping signal,
        # so `out` tracks the latest epoch too.
        save_checkpoint(last_checkpoint_path(out), model, optimizer, epoch, k, cfg)
        improved = val_loss < best_val if val_loader is not None else True
        marker = ""
        if improved:
            best_val, best_epoch = val_loss, epoch
            save_checkpoint(out, model, optimizer, epoch, k, cfg)
            marker = "  <- saved (best val)" if val_loader is not None else ""
        print(
            f"epoch {epoch:3d}  train {train_loss:.5f}  val {val_loss:.5f}  "
            f"baseline {base_val:.5f}  [{beats}]{marker}"
        )

    if val_loader is not None and best_epoch >= 0:
        print(f"kept epoch {best_epoch} (val {best_val:.5f}) -> {out}")

    return {"k": k, "history": history, "baseline_val": base_val, "best_epoch": best_epoch}


def last_checkpoint_path(out: str) -> str:
    """Sidecar path holding the latest-epoch state for --resume, kept separate
    from `out` (which holds the best-val net that export/match consume)."""
    p = Path(out)
    return str(p.with_name(p.stem + ".last" + p.suffix))


def save_checkpoint(
    out: str, model: NnueNet, optimizer: torch.optim.Optimizer, epoch: int, k: float, cfg: TrainConfig
) -> None:
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "model": model.state_dict(),
            "optimizer": optimizer.state_dict(),
            "epoch": epoch,
            "k": k,
            "config": asdict(cfg),
        },
        out,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", nargs="+", required=True, help="shard files or directories")
    parser.add_argument("--out", default="training/checkpoints/net.pt")
    parser.add_argument("--resume", default=None)
    parser.add_argument("--epochs", type=int, default=TrainConfig.epochs)
    parser.add_argument("--batch", type=int, default=TrainConfig.batch_size, dest="batch_size")
    parser.add_argument("--lr", type=float, default=TrainConfig.lr)
    parser.add_argument("--weight-decay", type=float, default=TrainConfig.weight_decay, dest="weight_decay")
    parser.add_argument("--lambda", type=float, default=TrainConfig.lam, dest="lam")
    parser.add_argument("--val-frac", type=float, default=TrainConfig.val_frac)
    parser.add_argument("--seed", type=int, default=TrainConfig.seed)
    parser.add_argument(
        "--split-seed", type=int, default=TrainConfig.split_seed,
        help="seed for the train/val split; defaults to --seed if unset (set explicitly to hold the val set fixed while --seed varies)",
    )
    parser.add_argument("--limit", type=int, default=None, help="cap positions (for dev)")
    parser.add_argument("--k", type=float, default=None, help="override the fitted K")
    args = parser.parse_args()

    cfg = TrainConfig(
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        weight_decay=args.weight_decay,
        lam=args.lam,
        val_frac=args.val_frac,
        seed=args.seed,
        split_seed=args.split_seed,
        limit=args.limit,
        k=args.k,
    )
    train(args.data, args.out, cfg, args.resume)


if __name__ == "__main__":
    main()
