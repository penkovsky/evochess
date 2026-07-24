"""Inference tests: mulberry32 determinism, from_torch layout, and the net
golden regression guard (the Python half of the milestone-5 parity gate)."""

import json

import numpy as np
import pytest

from nnue.features import FEATURE_SIZE, active_features
from nnue.infer import (
    NET_GOLDEN_PATH,
    NetWeights,
    forward,
    mulberry32,
    net_golden_records,
    seeded_net,
)
from nnue.parity import build_fixtures


class TestMulberry32:
    def test_is_deterministic(self):
        a = mulberry32(42)
        b = mulberry32(42)
        assert [a() for _ in range(10)] == [b() for _ in range(10)]

    def test_stays_in_unit_interval(self):
        rng = mulberry32(7)
        values = [rng() for _ in range(1000)]
        assert all(0.0 <= v < 1.0 for v in values)

    def test_different_seeds_diverge(self):
        assert mulberry32(1)() != mulberry32(2)()

    def test_matches_known_javascript_output(self):
        # These constants are the JS mulberry32(20260716) sequence; if this
        # drifts, the seed-generated parity net no longer matches the TS side.
        rng = mulberry32(20260716)
        expected = [
            0.698475715005770,
            0.653089993633330,
            0.710733267478645,
            0.076086233835667,
            0.943533168174326,
        ]
        for want in expected:
            assert rng() == pytest.approx(want, abs=1e-15)


class TestForward:
    def test_shapes_of_test_net(self):
        w = seeded_net(1)
        assert w.l1w.shape == (FEATURE_SIZE, 256)
        assert w.l1b.shape == (256,)
        assert w.l2w.shape == (256, 32)
        assert w.l2b.shape == (32,)
        assert w.l3w.shape == (32,)

    def test_is_order_independent(self):
        w = seeded_net(2)
        assert forward(w, [3, 1, 2]) == pytest.approx(forward(w, [1, 2, 3]))

    def test_empty_active_is_bias_forward(self):
        w = seeded_net(2)
        assert np.isfinite(forward(w, []))

    def test_clipped_relu_bounds_the_first_layer(self):
        # Huge positive weights must saturate at 1, not blow up: the l2/l3 output
        # is then bounded by |l2w|*32 + |l3w|*... regardless of how many features
        # fire. Build a net with large positive l1 and check finiteness/bound.
        w = seeded_net(3)
        big = NetWeights(
            l1w=w.l1w + 100.0,
            l1b=w.l1b,
            l2w=np.ones_like(w.l2w),
            l2b=np.zeros_like(w.l2b),
            l3w=np.ones_like(w.l3w),
            l3b=0.0,
        )
        # Every h1 saturates to 1, so h2 = 256 (sum of ones), out = 32*256.
        out = forward(big, list(range(50)))
        assert out == pytest.approx(32 * 256)


class TestFromTorch:
    def test_matches_torch_forward(self):
        torch = pytest.importorskip("torch")
        from nnue.model import NnueNet

        torch.manual_seed(5)
        net = NnueNet().eval()
        weights = NetWeights.from_torch(net.state_dict())
        rng = np.random.default_rng(0)
        for _ in range(10):
            active = sorted(rng.choice(FEATURE_SIZE, size=40, replace=False).tolist())
            vec = torch.zeros(1, FEATURE_SIZE)
            vec[0, active] = 1.0
            torch_out = float(net(vec).item())
            assert forward(weights, active) == pytest.approx(torch_out, abs=1e-4)


class TestNetGolden:
    @pytest.fixture(scope="class")
    def golden(self):
        assert NET_GOLDEN_PATH.exists(), "run `python -m nnue.infer` to generate net-golden.json"
        return json.loads(NET_GOLDEN_PATH.read_text())

    def test_committed_golden_matches_the_reference(self, golden):
        assert net_golden_records() == golden

    def test_every_fixture_has_an_output(self, golden):
        fixture_names = {name for name, _ in build_fixtures()}
        golden_names = {row["name"] for row in golden["outputs"]}
        assert golden_names == fixture_names

    def test_outputs_are_finite(self, golden):
        assert all(np.isfinite(row["output"]) for row in golden["outputs"])
