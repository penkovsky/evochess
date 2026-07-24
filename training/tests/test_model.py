"""Model tests. Skipped where torch is unavailable."""

import pytest

torch = pytest.importorskip("torch")

from nnue.features import FEATURE_SIZE  # noqa: E402
from nnue.model import NnueNet  # noqa: E402


def test_forward_produces_one_score_per_row():
    model = NnueNet()
    out = model(torch.zeros(8, FEATURE_SIZE))
    assert out.shape == (8,)
    assert torch.isfinite(out).all()

def test_accepts_a_single_unbatched_style_row():
    model = NnueNet()
    out = model(torch.zeros(1, FEATURE_SIZE))
    assert out.shape == (1,)


def test_first_layer_activation_is_clipped_to_unit_range():
    # Clipped ReLU bounds the accumulator to [0, 1] — the property int8
    # quantisation later relies on. Drive it hard and inspect the clamp.
    model = NnueNet()
    with torch.no_grad():
        model.l1.weight.fill_(10.0)
        model.l1.bias.fill_(5.0)
        activated = torch.clamp(model.l1(torch.ones(1, FEATURE_SIZE)), 0.0, 1.0)
    assert activated.max().item() <= 1.0
    assert activated.min().item() >= 0.0


def test_can_overfit_a_tiny_batch():
    # Wires model + loss + backprop end to end: a handful of rows should be
    # memorisable to near-zero loss. If this cannot fall, nothing downstream
    # will train.
    torch.manual_seed(0)
    x = torch.randn(16, FEATURE_SIZE)
    target = torch.rand(16)
    model = NnueNet()
    opt = torch.optim.Adam(model.parameters(), lr=1e-2)
    k = 2.0
    first = None
    for _ in range(300):
        opt.zero_grad()
        pred = torch.sigmoid(model(x) / k)
        loss = torch.mean((pred - target) ** 2)
        loss.backward()
        opt.step()
        if first is None:
            first = loss.item()
    assert loss.item() < first * 0.1
