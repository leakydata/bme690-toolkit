"""The lab must read data exactly as BME AI-Studio and BME Studio do."""
from pathlib import Path

import numpy as np
import pytest

from bme690 import lab

FIX = Path(__file__).resolve().parents[2] / "studio" / "test" / "fixtures"
DEMO = Path("/opt/bme-ai-studio/app/src/config/demo.bmeproject")


def test_board_files_match_aistudio():
    recs = {r.name: r for r in lab.load(FIX)}
    # AI-Studio 3.1.0's parser: 48 complete cycles in each file.
    assert len(recs["s0001"].cycles) == 48
    assert len(recs["s0002"].cycles) == 48
    assert list(recs["s0002"].specimens["name"]) == ["sample 1", "coffee test"]
    assert recs["s0002"].config["boardType"] == "board_690"


def test_default_classes_strip_round_numbers():
    assert lab.default_class("Coffee 3") == "Coffee"
    assert lab.default_class("settling") is None
    assert lab.default_class("coffee test") == "coffee test"


@pytest.mark.skipif(not DEMO.exists(), reason="AI-Studio demo project not installed")
def test_aistudio_demo_project():
    (r,) = lab.load_aistudio(DEMO)
    assert len(r.cycles) == 3256 - 8               # 8 cycles are marked dropped in the project
    assert len(r.specimens) == 6                   # 27 rows, 21 of them per-algorithm copies
    cls = dict(zip(r.specimens["name"], r.specimens["cls"]))
    assert cls["Espresso Coffee"] == "Espresso"    # most specific class wins
    assert cls["Neutral Air"] == "Air"


@pytest.mark.skipif(not DEMO.exists(), reason="AI-Studio demo project not installed")
def test_arrays_and_honest_split():
    df = lab.cycles_table(lab.load_aistudio(DEMO))
    s = lab.per_sensor(df, classes={"Air": "Air", "Espresso": "Coffee", "Filter Coffee": "Coffee"})
    assert s.X.shape[1] == 11 and s.labels == ["Air", "Coffee"]
    tr, te = lab.split_by_specimen(s)
    assert not set(s.groups[tr]) & set(s.groups[te])            # no specimen on both sides
    f = lab.fused(df, classes={"Air": "Air", "Espresso": "Coffee", "Filter Coffee": "Coffee"})
    assert f.X.ndim == 3 and f.X.shape[2] == 11
    q = lab.sequences(f, length=4)
    assert q.X.shape[1:] == (4, f.X.shape[1], 11)
    folds = list(lab.group_kfold(s, k=3))
    tested = np.concatenate([t for _, t in folds])
    assert sorted(tested) == list(range(len(s)))                 # every sample tested once
