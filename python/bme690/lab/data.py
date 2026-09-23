"""Loading recordings into pandas, the same way BME AI-Studio and BME Studio do.

A *recording* is one measurement session. Its data points are grouped into
*cycles* -- one pass of one sensor through its ten-step heater profile, the
unit models learn from -- and into *specimens*, stretches sharing one label.
Each specimen may belong to a *class* ("Coffee", "Air").

Cycle rules match AI-Studio's importer: per sensor, a new cycle starts when a
point has step 0, repeats a step already seen, or comes after a higher step;
a cycle counts only with all ten steps present and no error. Specimens are
runs of consecutive points (file order, sensors interleaved) with one label.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Union

import numpy as np
import pandas as pd

STEPS = 10
GAS = [f"gas_{i}" for i in range(STEPS)]
SETTLING = "settling"

PathLike = Union[str, Path]


@dataclass
class Recording:
    name: str
    config: dict                 # {"boardType", "heaterProfiles": [...], "sensors": [...], ...}
    points: pd.DataFrame         # sensor, t, rtc, temp, press, hum, gas, step, tag, error
    specimens: pd.DataFrame      # tag, name, comment, start, end, cls
    cycles: pd.DataFrame         # sensor, start, end, heater_profile, gas_0..gas_9, temp, hum, press, specimen
    dropped: int = 0
    board_id: str = ""
    firmware: str = ""
    sources: List[str] = field(default_factory=list)

    def __repr__(self) -> str:
        n = self.cycles["sensor"].nunique() if len(self.cycles) else 0
        return (f"<Recording {self.name!r}: {len(self.cycles)} cycles, {n} sensors, "
                f"{len(self.specimens)} specimens, {self.duration_min:.1f} min>")

    @property
    def duration_min(self) -> float:
        t = self.points["t"]
        return float(t.iloc[-1] - t.iloc[0]) / 60000 if len(t) else 0.0

    def heater_profile(self, pid: str) -> Optional[dict]:
        return next((h for h in self.config.get("heaterProfiles", []) if h["id"] == pid), None)

    def assign_classes(self, rule: Union[Dict[str, Optional[str]], Callable[[str], Optional[str]], None] = None) -> "Recording":
        """Set each specimen's class from its name.

        rule may be a dict {specimen name: class}, a function name -> class, or
        None for the default: the name without a trailing round number
        ("Coffee 3" -> "Coffee"), and no class for "settling" -- which is how
        BME Studio's Quick experiment names its specimens.
        """
        if rule is None:
            fn = default_class
        elif callable(rule):
            fn = rule
        else:
            fn = lambda name: rule.get(name)  # noqa: E731
        self.specimens["cls"] = [fn(n) for n in self.specimens["name"]]
        return self


def default_class(name: str) -> Optional[str]:
    if name.strip().lower() in (SETTLING, "", "unlabelled"):
        return None
    return re.sub(r"\s+\d+$", "", name.strip())


# ------------------------------------------------------------------ assembly

def _specimens(points: pd.DataFrame, labels: Dict[int, dict]) -> pd.DataFrame:
    tag = points["tag"].to_numpy()
    t = points["t"].to_numpy()
    if len(tag) == 0:
        return pd.DataFrame(columns=["tag", "name", "comment", "start", "end", "cls"])
    change = np.flatnonzero(np.r_[True, tag[1:] != tag[:-1]])
    ends = np.r_[change[1:] - 1, len(tag) - 1]
    rows = []
    for a, b in zip(change, ends):
        tg = int(tag[a])
        info = labels.get(tg, {})
        rows.append({
            "tag": tg,
            "name": info.get("name") or ("unlabelled" if tg == 0 else f"label {tg}"),
            "comment": info.get("description", ""),
            "start": float(t[a]),
            "end": float(t[b]),
            "cls": None,
        })
    return pd.DataFrame(rows)


def _cycles(points: pd.DataFrame, config: dict, specimens: pd.DataFrame):
    profile_of = {s["sensorIndex"]: s["heaterProfile"] for s in config.get("sensors", [])}
    starts = specimens["start"].to_numpy() if len(specimens) else np.array([0.0])
    sensor = points["sensor"].to_numpy()
    step = points["step"].to_numpy()
    err = points["error"].to_numpy()
    t = points["t"].to_numpy()
    cur: Dict[int, List[Optional[int]]] = {}
    out, dropped = [], 0

    def close(s: int, idx: List[Optional[int]]):
        nonlocal dropped
        present = [i for i in idx if i is not None]
        if not present:
            return
        if len(present) != STEPS or any(err[i] for i in present):
            dropped += 1
            return
        first, last = min(idx), max(idx)
        row = {"sensor": s, "start": float(t[first]), "end": float(t[last]),
               "heater_profile": profile_of.get(s, "")}
        for k, i in enumerate(idx):
            row[GAS[k]] = float(points["gas"].iat[i])
        i0 = idx[0]
        row["temp"] = float(points["temp"].iat[i0])
        row["hum"] = float(points["hum"].iat[i0])
        row["press"] = float(points["press"].iat[i0])
        row["specimen"] = int(max(0, np.searchsorted(starts, t[first], side="right") - 1))
        out.append(row)

    for i in range(len(sensor)):
        s, st = int(sensor[i]), int(step[i])
        if st >= STEPS:
            continue
        p = cur.get(s)
        is_new = (p is None or st == 0 or p[st] is not None
                  or any(v is not None and k > st for k, v in enumerate(p)))
        if is_new:
            if p is not None:
                close(s, p)
            p = [None] * STEPS
            cur[s] = p
        p[st] = i
    for s, p in cur.items():
        close(s, p)

    cols = ["sensor", "start", "end", "heater_profile", *GAS, "temp", "hum", "press", "specimen"]
    df = pd.DataFrame(out, columns=cols).sort_values(["start", "sensor"], kind="stable").reset_index(drop=True)
    return df, dropped


def _recording(name: str, config: dict, points: pd.DataFrame, labels: Dict[int, dict], **meta) -> Recording:
    points = points.reset_index(drop=True)
    specimens = _specimens(points, labels)
    cycles, dropped = _cycles(points, config, specimens)
    return Recording(name=name, config=config, points=points, specimens=specimens,
                     cycles=cycles, dropped=dropped, **meta)


# ------------------------------------------------------------------ .bmerawdata

_REQUIRED = ["sensor_index", "resistance_gassensor", "temperature", "pressure", "relative_humidity",
             "timestamp_since_poweron", "real_time_clock", "heater_profile_step_index", "error_code"]


def _config(doc: dict) -> dict:
    hdr, body = doc.get("configHeader", {}), doc.get("configBody", {})
    return {
        "boardType": hdr.get("boardType", "board_690"),
        "boardMode": hdr.get("boardMode", ""),
        "heaterProfiles": [
            {"id": str(h["id"]), "name": h.get("name"), "timeBase": h.get("timeBase"),
             "steps": [list(v) for v in h.get("temperatureTimeVectors", [])]}
            for h in body.get("heaterProfiles", [])
        ],
        "dutyCycleProfiles": [
            {"id": str(d["id"]), "scanningCycles": d.get("numberScanningCycles"),
             "sleepingCycles": d.get("numberSleepingCycles")}
            for d in body.get("dutyCycleProfiles", [])
        ],
        "sensors": [
            {"sensorIndex": int(s["sensorIndex"]), "active": s.get("active", True) is not False,
             "heaterProfile": str(s["heaterProfile"]), "dutyCycleProfile": str(s["dutyCycleProfile"])}
            for s in body.get("sensorConfigurations", [])
        ],
    }


def session_key(path: PathLike) -> str:
    """AI-Studio's rule: <stem>_<number>.bmerawdata files form one session."""
    name = Path(path).name
    parts = name.split(".")
    if len(parts) != 2:
        return name
    bits = parts[0].split("_")
    if len(bits) < 2 or not bits[-1].isdigit():
        return parts[0]
    return "_".join(bits[:-1])


def read_session(files: Sequence[PathLike], name: Optional[str] = None) -> Recording:
    """One session from its .bmerawdata chunks; .bmelabelinfo files beside
    them supply the label names."""
    files = sorted((Path(f) for f in files), key=lambda p: p.name)
    frames, labels, config, meta = [], {}, None, {}
    t0 = None
    for f in files:
        try:
            doc = json.loads(f.read_text())
        except json.JSONDecodeError as e:
            raise ValueError(f"{f.name} is not valid JSON; it may have been cut short ({e})") from None
        for key in ("configHeader", "configBody", "rawDataHeader", "rawDataBody"):
            if key not in doc:
                raise ValueError(f"{f.name} has no {key}, so it is not a .bmerawdata file")
        if config is None:
            config = _config(doc)
            hdr = doc.get("rawDataHeader", {})
            meta = {"board_id": str(hdr.get("boardId", "")), "firmware": str(hdr.get("firmwareVersion", ""))}
        cols = {c["key"]: i for i, c in enumerate(doc["rawDataBody"]["dataColumns"])}
        missing = [k for k in _REQUIRED if k not in cols]
        if missing:
            raise ValueError(f"{f.name} lacks the columns {missing}, which AI-Studio requires")
        block = np.asarray(doc["rawDataBody"]["dataBlock"], dtype=object)
        if len(block) == 0:
            continue

        def col(k, dtype=float):
            return block[:, cols[k]].astype(dtype)

        df = pd.DataFrame({
            "sensor": col("sensor_index", int),
            "t": col("timestamp_since_poweron"),
            "rtc": col("real_time_clock"),
            "temp": col("temperature"),
            "press": col("pressure"),
            "hum": col("relative_humidity"),
            "gas": col("resistance_gassensor"),
            "step": col("heater_profile_step_index", int),
            "tag": col("label_tag", int) if "label_tag" in cols else 0,
            "error": (col("error_code") != 0).astype(int),
        })
        df = df[(df["step"] >= 0) & (df["step"] < STEPS)]
        if t0 is None and len(df):
            t0 = df["t"].iat[0]
        frames.append(df)
        lab = f.with_suffix(".bmelabelinfo")
        if lab.exists():
            for l in json.loads(lab.read_text()).get("labelInformation", []):
                labels[int(l["labelTag"])] = {"name": str(l.get("labelName", "")),
                                             "description": str(l.get("labelDescription", "")),
                                             "className": l.get("className")}
    if config is None:
        raise ValueError("no .bmerawdata files given")
    points = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(
        columns=["sensor", "t", "rtc", "temp", "press", "hum", "gas", "step", "tag", "error"])
    if t0 is not None:
        points["t"] = points["t"] - t0
    rec = _recording(name or session_key(files[0]), config, points, labels,
                     sources=[f.name for f in files], **meta)
    rec.assign_classes()
    # BME Studio's exports name each label's class; that beats guessing.
    named = {tag: info["className"] for tag, info in labels.items() if info.get("className")}
    if named:
        rec.specimens["cls"] = [named.get(t, c) for t, c in zip(rec.specimens["tag"], rec.specimens["cls"])]
    return rec


def load(path: Union[PathLike, Iterable[PathLike]]) -> List[Recording]:
    """Every session in a folder (e.g. the SD card's bme690 folder), or in a
    list of files, grouped the way AI-Studio groups them."""
    if isinstance(path, (str, Path)) and Path(path).is_dir():
        files = sorted(Path(path).glob("*.bmerawdata"))
    elif isinstance(path, (str, Path)):
        files = [Path(path)]
    else:
        files = [Path(p) for p in path]
    sessions: Dict[str, List[Path]] = {}
    for f in files:
        sessions.setdefault(session_key(f), []).append(f)
    return [read_session(fs, stem) for stem, fs in sorted(sessions.items())]


# ------------------------------------------------------------------ AI-Studio projects

def load_aistudio(path: PathLike) -> List[Recording]:
    """Sessions of a BME AI-Studio project: pass the .bmeproject folder or its
    project.db. AI-Studio copies a specimen for every algorithm and may class
    the copies differently; each original specimen gets the class from the
    algorithm with the most classes, then the class covering the fewest
    specimens -- the most specific one."""
    p = Path(path)
    if p.is_dir():
        p = p / "project.db"
    con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    q = lambda sql, *a: con.execute(sql, a).fetchall()  # noqa: E731
    try:
        class_count = {r["algorithm_id"]: r["n"] for r in q(
            "select algorithm_id, count(*) n from specimen_classes group by algorithm_id")}
        links = q("""select coalesce(o.id, s.id) orig, c.name name, c.algorithm_id alg
                     from specimen_classes_specimen_data l
                     join specimen_classes c on c.id = l.specimen_class_id
                     join specimen_data s on s.id = l.specimen_data_id
                     left join specimen_data o on o.uuid = s.clone_of_uuid order by l.id""")
        covers: Dict[str, set] = {}
        for l in links:
            covers.setdefault(l["name"], set()).add(l["orig"])
        best: Dict[int, tuple] = {}
        for l in links:
            cand = (class_count.get(l["alg"], 0), -len(covers[l["name"]]))
            if l["orig"] not in best or cand > best[l["orig"]][0]:
                best[l["orig"]] = (cand, l["name"])

        recs = []
        for s in q("select id, name, board_id from measurement_sessions order by id"):
            config = _aistudio_config(q, s["id"])
            specs = q("""select id, name, comment, start_time, end_time from specimen_data
                         where measurement_session_id = ? and clone_of_uuid is null
                         order by start_time""", s["id"])
            pts = pd.read_sql_query(
                """select p.time t, p.gas_resistance gas, p.temperature temp, p.pressure press,
                          p.humidity hum, p.initial_real_time rtc, p.cycle_step_index step,
                          p.error_code error, se.idx sensor
                   from specimen_data_points p join cycles c on c.id = p.cycle_id
                   join sensors se on se.id = c.sensor_id
                   where c.measurement_session_id = ? order by p.time, se.idx""", con, params=(s["id"],))
            if pts.empty:
                continue
            pts["error"] = (pts["error"] != 0).astype(int)
            labels, tag = {}, np.zeros(len(pts), dtype=int)
            t = pts["t"].to_numpy()
            for k, sp in enumerate(specs, start=1):
                labels[k] = {"name": sp["name"] or f"specimen {k}", "description": sp["comment"] or ""}
                tag[(t >= sp["start_time"]) & (t <= sp["end_time"])] = k
            pts["tag"] = tag
            pts = pts[["sensor", "t", "rtc", "temp", "press", "hum", "gas", "step", "tag", "error"]]
            rec = _recording(s["name"] or f"session {s['id']}", config, pts, labels,
                             board_id=str(s["board_id"] or ""), sources=[p.name])
            cls_by_tag = {k: best.get(sp["id"], (None, None))[1] for k, sp in enumerate(specs, start=1)}
            rec.specimens["cls"] = [cls_by_tag.get(tg) for tg in rec.specimens["tag"]]
            recs.append(rec)
        return recs
    finally:
        con.close()


def _aistudio_config(q, session_id: int) -> dict:
    bc = q("""select b.id, b.board_mode, t.uid from board_configs b
              left join board_types t on t.id = b.board_type_id
              where b.measurement_session_id = ? limit 1""", session_id)
    sensors = q("""select se.idx, h.uid hp, d.uid dc from sensor_configs sc
                   join sensors se on se.id = sc.sensor_id
                   join heater_profiles h on h.id = sc.heater_profile_id
                   join duty_cycle_profiles d on d.id = sc.duty_cycle_profile_id
                   where sc.board_config_id = ? order by se.idx""", bc[0]["id"]) if bc else []
    hp = {s["hp"] for s in sensors}
    return {
        "boardType": bc[0]["uid"] if bc else "board_8",
        "boardMode": bc[0]["board_mode"] if bc else "",
        "heaterProfiles": [
            {"id": h["uid"], "name": h["name"], "timeBase": h["time_base"],
             "steps": [[x["temperature"], x["duration"]] for x in json.loads(h["steps"] or "[]")]}
            for h in q("select uid, name, time_base, steps from heater_profiles") if h["uid"] in hp
        ],
        "dutyCycleProfiles": [],
        "sensors": [{"sensorIndex": s["idx"], "active": True, "heaterProfile": s["hp"],
                     "dutyCycleProfile": s["dc"]} for s in sensors],
    }


# ------------------------------------------------------------------ one table for many recordings

def cycles_table(recordings: Sequence[Recording]) -> pd.DataFrame:
    """All cycles of several recordings in one DataFrame, with the recording
    name, specimen name, class, and ``group`` -- the unit an honest test keeps
    together (one specimen of one recording)."""
    parts = []
    for r in recordings:
        c = r.cycles.copy()
        c.insert(0, "recording", r.name)
        sp = r.specimens.reset_index(drop=True)
        c["specimen_name"] = sp["name"].to_numpy()[c["specimen"]] if len(sp) else None
        c["cls"] = sp["cls"].to_numpy()[c["specimen"]] if len(sp) else None
        c["group"] = r.name + ":" + c["specimen"].astype(str)
        parts.append(c)
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
