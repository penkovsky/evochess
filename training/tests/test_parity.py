"""The Python half of the golden-vector parity gate (milestone 3).

This side is a regression guard: it asserts the committed `golden.json` still
matches what `features.extract` produces, so the golden file cannot drift out
of sync with the Python extractor without a red test. The genuine
*cross-language* check lives in `src/evochess/__tests__/nnueFeatures.test.ts`,
which holds the same golden file against the TypeScript extractor.

If this test fails after an intentional extractor change, regenerate with
`python -m nnue.parity` and re-run the TS parity test to confirm both sides
still agree.
"""

import json

import pytest

from nnue.parity import (
    FIXTURES_PATH,
    GOLDEN_PATH,
    active_indices,
    build_fixtures,
    golden_records,
)
from nnue.position import Position


@pytest.fixture(scope="module")
def golden() -> dict[str, list[int]]:
    assert GOLDEN_PATH.exists(), "run `python -m nnue.parity` to generate golden.json"
    return {r["name"]: r["active"] for r in json.loads(GOLDEN_PATH.read_text())}


def test_committed_golden_matches_the_extractor(golden):
    # The whole file at once: catches additions/removals as well as changes.
    assert golden_records() == json.loads(GOLDEN_PATH.read_text())


@pytest.mark.parametrize(
    "name,position", build_fixtures(), ids=[name for name, _ in build_fixtures()]
)
def test_each_fixture_matches_golden(name, position, golden):
    assert active_indices(position) == golden[name], f"{name} drifted from golden.json"


def test_fixtures_file_round_trips_to_the_same_positions():
    # The committed fixtures.json must rebuild the exact Position objects the
    # generator used, or the TS side is testing against different inputs.
    records = json.loads(FIXTURES_PATH.read_text())
    from_file = [(r["name"], Position.from_json(r["position"])) for r in records]
    assert from_file == build_fixtures()


def test_fixture_names_are_unique():
    names = [name for name, _ in build_fixtures()]
    assert len(names) == len(set(names))


def test_golden_indices_are_sorted_and_in_range():
    from nnue.features import FEATURE_SIZE

    for record in golden_records():
        active = record["active"]
        assert active == sorted(active), f"{record['name']} indices not sorted"
        assert all(0 <= i < FEATURE_SIZE for i in active), f"{record['name']} out of range"
