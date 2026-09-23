"""Fusing every sensor of the board, even when they run different heater profiles.

:func:`bme690.lab.fused` matches BME Studio's fused mode: one heater profile,
cycles that start together. Boards are usually set up differently -- AI-Studio's
demo runs four heater profiles on pairs of sensors, with cycles from 10 s to
31 s long -- so a "moment" cannot be cycles that start together.

:func:`fused_all` takes one sample per cycle of an *anchor* sensor (by default
the fastest) and, for every other sensor, the latest cycle that had finished
by then -- what a live system would know at that instant. A sensor with no
recent cycle in the same specimen is missing: its row is NaN, and the deep
models (``SensorSetNet``, ``TemporalNet``) mask it out. Slow sensors' cycles
are therefore reused for several consecutive samples, like a sample-and-hold.
"""

from __future__ import annotations

from typing import Dict, Optional, Sequence

import numpy as np
import pandas as pd

from .prep import Samples, features


def fused_all(df: pd.DataFrame, kind: str = "shape", classes: Optional[Dict[str, str]] = None,
              sensors: Optional[Sequence[int]] = None, anchor: Optional[int] = None,
              labelled_only: bool = True, max_age: float = 1.5, min_sensors: int = 1) -> Samples:
    """X (N, S, F) over all sensors, whatever their heater profiles; NaN rows
    for sensors with no fresh cycle.

    classes      class -> training label, as in :func:`per_sensor`
    labelled_only  False keeps cycles with no class (warm-up, unlabelled
                 logging) with y = -1 -- the input for self-supervised
                 pre-training
    max_age      a sensor's cycle counts if it ended at most ``max_age`` of its
                 own cycle lengths before the anchor cycle ended
    min_sensors  drop samples with fewer sensors present
    """
    d = df
    if classes is not None:
        keep = d["cls"].isin(classes) | ((not labelled_only) & d["cls"].isna())
        d = d[keep]
        lab = d["cls"].map(classes)
    else:
        if labelled_only:
            d = d[d["cls"].notna()]
        lab = d["cls"]
    labels = sorted(l for l in lab.dropna().unique())
    code = {l: i for i, l in enumerate(labels)}
    y_all = lab.map(code).fillna(-1).astype(int).to_numpy()
    sensors = sorted(int(s) for s in (sensors if sensors is not None else d["sensor"].unique()))
    feats = features(d, kind)
    F = feats.shape[1]
    pos = np.arange(len(d))

    Xs, ys, gs, rs, ts = [], [], [], [], []
    for rec, idx in d.groupby("recording", sort=False).indices.items():
        sub = d.iloc[idx]
        counts = sub["sensor"].value_counts()
        a = anchor if anchor is not None else int(counts.reindex(sensors).fillna(0).idxmax())
        am = (sub["sensor"] == a).to_numpy()
        a_end = sub["end"].to_numpy()[am]
        a_spec = sub["specimen"].to_numpy()[am]
        n = int(am.sum())
        if n == 0:
            continue
        X = np.full((n, len(sensors), F), np.nan, dtype=np.float32)
        for j, s in enumerate(sensors):
            sm = (sub["sensor"] == s).to_numpy()
            if not sm.any():
                continue
            ends = sub["end"].to_numpy()[sm]
            order = np.argsort(ends, kind="stable")
            ends = ends[order]
            rows = pos[idx][sm][order]
            spec = sub["specimen"].to_numpy()[sm][order]
            length = float(np.median((sub["end"] - sub["start"]).to_numpy()[sm])) or 1.0
            k = np.searchsorted(ends, a_end + 1e-6, side="right") - 1
            ok = k >= 0
            kk = np.where(ok, k, 0)
            ok &= spec[kk] == a_spec
            ok &= (a_end - ends[kk]) <= max_age * length
            X[ok, j] = feats[rows[kk[ok]]]
        present = (~np.isnan(X[..., 0])).sum(axis=1)
        keep = present >= min_sensors
        a_rows = sub[am]
        Xs.append(X[keep])
        ys.append(y_all[pos[idx][am]][keep])
        gs.append(a_rows["group"].to_numpy()[keep])
        rs.append(a_rows["recording"].to_numpy()[keep])
        ts.append(a_rows["start"].to_numpy()[keep])
    if not Xs or sum(len(x) for x in Xs) == 0:
        raise ValueError("no samples: check the classes and sensors")
    return Samples(np.concatenate(Xs), np.concatenate(ys), labels, np.concatenate(gs),
                   np.concatenate(rs), np.concatenate(ts), sensors)
