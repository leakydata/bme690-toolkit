"""Turning cycles into arrays for models, and splitting them honestly.

Feature sets match BME Studio's, so a model trained here reads the same
inputs as one trained in the browser:

  aistudio  the ten resistances as they are (BME AI-Studio's input)
  log       log10 of each resistance
  shape     log resistances minus their mean (the pattern across heater
            steps) plus that mean (the level) -- usually the most robust

Array layouts:

  per_sensor(df)   X (N, F)          one sample per sensor-cycle, like AI-Studio
  fused(df)        X (N, S, 10)      the simultaneous cycles of S sensors
  sequences(df)    X (N, L, S, 10)   L consecutive fused cycles of one specimen

Splitting is where most gas-sensor results go wrong: neighbouring cycles of
one specimen are nearly identical, so a random split puts near-copies of the
test data into training. Every split here keeps each ``group`` (one
specimen of one recording) wholly on one side, unless you ask for
``random_split`` to compare with AI-Studio.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterator, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from .data import GAS, STEPS

FEATURE_SETS = ("aistudio", "log", "shape")


def features(df: pd.DataFrame, kind: str = "shape", environment: bool = False) -> np.ndarray:
    g = df[GAS].to_numpy(dtype=np.float64)
    if kind == "aistudio":
        x = g
    elif kind == "log":
        x = np.log10(np.maximum(g, 1.0))
    elif kind == "shape":
        l = np.log10(np.maximum(g, 1.0))
        m = l.mean(axis=1, keepdims=True)
        x = np.hstack([l - m, m])
    else:
        raise ValueError(f"unknown feature set {kind!r}; choose from {FEATURE_SETS}")
    if environment:
        x = np.hstack([x, df[["temp", "hum", "press"]].to_numpy(dtype=np.float64)])
    return x.astype(np.float32)


@dataclass
class Samples:
    X: np.ndarray
    y: np.ndarray            # label index
    labels: List[str]
    groups: np.ndarray       # "recording:specimen" per sample
    recordings: np.ndarray
    t: np.ndarray            # start time, ms
    sensors: Optional[List[int]] = None

    def __len__(self) -> int:
        return len(self.y)

    def subset(self, idx: np.ndarray) -> "Samples":
        return Samples(self.X[idx], self.y[idx], self.labels, self.groups[idx],
                       self.recordings[idx], self.t[idx], self.sensors)


def _select(df: pd.DataFrame, classes: Optional[Dict[str, str]], heater_profile: Optional[str]):
    d = df[df["cls"].notna()]
    if heater_profile is None:
        heater_profile = d["heater_profile"].value_counts().idxmax()
    d = d[d["heater_profile"] == heater_profile]
    if classes is not None:
        d = d[d["cls"].isin(classes)]
        lab = d["cls"].map(classes)
    else:
        lab = d["cls"]
    labels = sorted(lab.unique())
    return d.assign(label=lab.map({l: i for i, l in enumerate(labels)})), labels


def per_sensor(df: pd.DataFrame, kind: str = "shape", environment: bool = False,
               classes: Optional[Dict[str, str]] = None, heater_profile: Optional[str] = None,
               sensors: Optional[Sequence[int]] = None) -> Samples:
    """One sample per sensor-cycle (AI-Studio's way). ``classes`` maps class
    -> training label, so classes can be grouped ({"Espresso": "Coffee",
    "Filter Coffee": "Coffee", "Air": "Air"}); None keeps every class."""
    d, labels = _select(df, classes, heater_profile)
    if sensors is not None:
        d = d[d["sensor"].isin(sensors)]
    return Samples(features(d, kind, environment), d["label"].to_numpy(), labels,
                   d["group"].to_numpy(), d["recording"].to_numpy(), d["start"].to_numpy())


def _fused_rows(d: pd.DataFrame, sensors: List[int]) -> List[List[int]]:
    """Row indices of simultaneous cycles, one per sensor, anchored on the
    first sensor: each other sensor's cycle that started closest in time,
    kept only when every sensor has one within half a cycle and all are in
    the same specimen. Same rule as BME Studio's fused mode."""
    out = []
    for _, rec in d.groupby("recording", sort=False):
        by = {s: rec[rec["sensor"] == s] for s in sensors}
        if any(len(v) == 0 for v in by.values()):
            continue
        starts = {s: v["start"].to_numpy() for s, v in by.items()}
        for a_idx, a in by[sensors[0]].iterrows():
            window = (a["end"] - a["start"]) / 2 + 1
            rows = [a_idx]
            for s in sensors[1:]:
                j = int(np.abs(starts[s] - a["start"]).argmin())
                cand = by[s].iloc[j]
                if abs(cand["start"] - a["start"]) > window or cand["specimen"] != a["specimen"]:
                    break
                rows.append(by[s].index[j])
            else:
                out.append(rows)
    return out


def fused(df: pd.DataFrame, kind: str = "shape", classes: Optional[Dict[str, str]] = None,
          heater_profile: Optional[str] = None, sensors: Optional[Sequence[int]] = None) -> Samples:
    """The simultaneous cycles of several sensors as one sample, X (N, S, F)."""
    d, labels = _select(df, classes, heater_profile)
    sensors = sorted(sensors if sensors is not None else d["sensor"].unique())
    d = d[d["sensor"].isin(sensors)]
    rows = _fused_rows(d, list(sensors))
    if not rows:
        raise ValueError("no moment where every chosen sensor has a complete cycle; try fewer sensors")
    idx = np.asarray(rows)
    feats = features(d, kind)
    pos = {ix: k for k, ix in enumerate(d.index)}
    X = feats[np.vectorize(pos.get)(idx)]
    anchor = d.loc[idx[:, 0]]
    return Samples(X, anchor["label"].to_numpy(), labels, anchor["group"].to_numpy(),
                   anchor["recording"].to_numpy(), anchor["start"].to_numpy(), list(sensors))


def sequences(fused_samples: Samples, length: int = 6, stride: int = 1) -> Samples:
    """Windows of ``length`` consecutive fused samples within one specimen,
    X (N, length, S, F): what a model needs to see how the response evolves
    rather than a single snapshot."""
    s = fused_samples
    order = np.lexsort((s.t, s.groups))
    Xs, keep = [], []
    start = 0
    g = s.groups[order]
    while start < len(order):
        end = start
        while end < len(order) and g[end] == g[start]:
            end += 1
        run = order[start:end]
        for k in range(0, len(run) - length + 1, stride):
            win = run[k:k + length]
            Xs.append(s.X[win])
            keep.append(win[-1])
        start = end
    if not Xs:
        raise ValueError(f"no specimen has {length} consecutive cycles; use a shorter length")
    keep = np.asarray(keep)
    out = s.subset(keep)
    out.X = np.stack(Xs)
    return out


# ------------------------------------------------------------------ splits

def _rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def random_split(n: int, test_fraction: float = 0.3, seed: int = 1) -> Tuple[np.ndarray, np.ndarray]:
    """Individual cycles at random: optimistic, kept to compare with AI-Studio."""
    idx = _rng(seed).permutation(n)
    k = int(round(n * test_fraction))
    return np.sort(idx[k:]), np.sort(idx[:k])


def split_by_specimen(s: Samples, test_fraction: float = 0.3, seed: int = 1) -> Tuple[np.ndarray, np.ndarray]:
    """Whole specimens to test, per label, until about ``test_fraction`` of
    that label is held out, always leaving one specimen to train on. A label
    with a single specimen is split in time instead (first part train, last
    part test) -- optimistic, and flagged by :func:`split_warning`."""
    r = _rng(seed)
    test = np.zeros(len(s), dtype=bool)
    for y in np.unique(s.y):
        mask = s.y == y
        groups, counts = np.unique(s.groups[mask], return_counts=True)
        if len(groups) < 2:
            idx = np.flatnonzero(mask)
            idx = idx[np.argsort(s.t[idx], kind="stable")]
            test[idx[int(round(len(idx) * (1 - test_fraction))):]] = True
            continue
        order = r.permutation(len(groups))
        held, total = 0, counts.sum()
        for k, gi in enumerate(order):
            if held >= total * test_fraction or len(groups) - k <= 1:
                break
            test[mask & (s.groups == groups[gi])] = True
            held += counts[gi]
    return np.flatnonzero(~test), np.flatnonzero(test)


def split_warning(s: Samples) -> Optional[str]:
    thin = [s.labels[y] for y in np.unique(s.y) if len(np.unique(s.groups[s.y == y])) < 2]
    if not thin:
        return None
    return (f"{', '.join(thin)} {'has' if len(thin) == 1 else 'have'} only one specimen, so its test data "
            "comes from the end of that same specimen and the score is optimistic.")


def group_kfold(s: Samples, k: int = 5, seed: int = 1) -> Iterator[Tuple[np.ndarray, np.ndarray]]:
    """k folds over specimens: every specimen is tested exactly once, by a
    model that never saw it. The most thorough honest estimate."""
    groups = np.unique(s.groups)
    order = _rng(seed).permutation(len(groups))
    folds = np.array_split(groups[order], min(k, len(groups)))
    for held in folds:
        test = np.isin(s.groups, held)
        yield np.flatnonzero(~test), np.flatnonzero(test)


def leave_one_recording_out(s: Samples) -> Iterator[Tuple[str, np.ndarray, np.ndarray]]:
    """Train on every recording but one, test on that one: does the model
    survive a new day, a new room, sensor drift?"""
    for rec in np.unique(s.recordings):
        test = s.recordings == rec
        yield rec, np.flatnonzero(~test), np.flatnonzero(test)
