"""Python-side material ladder check: the same diagnostic as
`training/ladder.ts`, but running the raw PyTorch checkpoint directly rather
than needing a TS export/inference port.

    python -m training.nnue.ladder_check --checkpoint training/checkpoints/net.pt

Rung positions and checks are kept identical to ladder.ts's (bare kings plus
one isolated material swing, White to move) so results are directly
comparable across the two scripts.
"""

from __future__ import annotations

import argparse

import torch

from .baseline import material
from .features import extract
from .model import NnueNet
from .position import Position

# Mirrors training/ladder.ts's RUNGS exactly.
RUNGS: tuple[tuple[str, str, float], ...] = (
    ("even (kings only)", "4k3/8/8/8/8/8/8/4K3 w - - 0 1", 0.0),
    ("+1 pawn", "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", 1.0),
    ("+1 knight", "4k3/8/8/8/8/8/8/4K1N1 w - - 0 1", 3.0),
    ("+1 bishop", "4k3/8/8/8/8/8/8/4K1B1 w - - 0 1", 3.0),
    ("+1 rook (full charges)", "4k3/8/8/8/8/8/8/4K2R w - - 0 1", 5.0),
    ("+1 queen", "4k3/8/8/8/8/8/8/4K2Q w - - 0 1", 9.0),
    ("+2 queens", "3QK2Q/8/8/8/8/8/8/4k3 w - - 0 1", 18.0),
    ("Black +1 queen", "3qk3/8/8/8/8/8/8/4K3 w - - 0 1", -9.0),
)


def run_ladder(checkpoint_path: str) -> bool:
    state = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    model = NnueNet()
    model.load_state_dict(state["model"])
    model.eval()

    param_count = sum(p.numel() for p in model.parameters())
    print(f"checkpoint: {checkpoint_path}  ({param_count:,} parameters)")
    header = f"{'rung':<24}{'truth':<10}{'material()':<12}{'net':<12}"
    print(header)
    print("-" * len(header))

    results: dict[str, float] = {}
    with torch.no_grad():
        for name, fen, truth in RUNGS:
            position = Position(fen=fen)
            actual_material = material(position)
            features = torch.from_numpy(extract(position)).unsqueeze(0)
            net_score = model(features).item()
            results[name] = net_score
            print(f"{name:<24}{truth:<10.2f}{actual_material:<12.2f}{net_score:<12.4f}")

    checks = [
        (
            "monotonic: 0 < pawn < minor < rook < queen",
            results["even (kings only)"] < results["+1 pawn"]
            and results["+1 pawn"] < results["+1 knight"]
            and results["+1 knight"] < results["+1 rook (full charges)"]
            and results["+1 rook (full charges)"] < results["+1 queen"],
        ),
        ("+2 queens > +1 queen", results["+2 queens"] > results["+1 queen"]),
        ("+1 queen clearly positive (> +5)", results["+1 queen"] > 5),
        ("Black +1 queen is negative for White", results["Black +1 queen"] < 0),
    ]
    print()
    print("checks:")
    all_pass = True
    for label, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
        all_pass = all_pass and passed

    print()
    print("LADDER: all checks passed" if all_pass else "LADDER: at least one check failed")
    return all_pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", default="training/checkpoints/net.pt")
    args = parser.parse_args()
    all_pass = run_ladder(args.checkpoint)
    raise SystemExit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
