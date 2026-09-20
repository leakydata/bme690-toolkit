"""Heater and duty-cycle profiles.

The canonical profile definitions ship with BME AI-Studio; this module reads
them from an installed copy so the profile a recording uses is exactly the one
AI-Studio knows by the same id.
"""

import json
import os
from dataclasses import dataclass
from typing import List, Optional, Sequence

DEFAULT_CONFIG_DIRS = [
    "/opt/bme-ai-studio/app/src/config",
    os.path.expanduser("~/.local/share/bme-ai-studio/config"),
    os.path.join(os.path.dirname(__file__), "config"),
]


@dataclass
class HeaterStep:
    temperature: int   # degC
    duration: int      # multiples of time_base


@dataclass
class HeaterProfile:
    uid: str
    name: str
    time_base: int              # ms per duration unit
    steps: List[HeaterStep]

    @property
    def temperatures(self) -> List[int]:
        return [s.temperature for s in self.steps]

    @property
    def durations(self) -> List[int]:
        return [s.duration for s in self.steps]

    @property
    def cycle_duration_ms(self) -> int:
        return sum(s.duration for s in self.steps) * self.time_base


@dataclass
class DutyCycleProfile:
    uid: str
    name: str
    scanning_cycles: int
    sleeping_cycles: int


def _config_dir(explicit: Optional[str] = None) -> str:
    for d in ([explicit] if explicit else []) + DEFAULT_CONFIG_DIRS:
        if d and os.path.isfile(os.path.join(d, "heater_profiles.json")):
            return d
    raise FileNotFoundError(
        "Could not find heater_profiles.json. Install BME AI-Studio or pass "
        "--config-dir pointing at a directory holding heater_profiles.json "
        "and duty_cycle_profiles.json."
    )


def load_heater_profiles(config_dir: Optional[str] = None) -> List[HeaterProfile]:
    with open(os.path.join(_config_dir(config_dir), "heater_profiles.json")) as f:
        raw = json.load(f)
    return [
        HeaterProfile(
            uid=p["id"],
            name=p["name"],
            time_base=p["timeBase"],
            steps=[HeaterStep(s["temperature"], s["duration"]) for s in p["steps"]],
        )
        for p in raw
    ]


def load_duty_cycle_profiles(config_dir: Optional[str] = None) -> List[DutyCycleProfile]:
    with open(os.path.join(_config_dir(config_dir), "duty_cycle_profiles.json")) as f:
        raw = json.load(f)
    return [
        DutyCycleProfile(
            uid=p["id"],
            name=p["name"],
            scanning_cycles=p["scanningCycles"],
            sleeping_cycles=p["sleepingCycles"],
        )
        for p in raw
    ]


def find(profiles: Sequence, key: str):
    """Look a profile up by its uid (heater_354) or display name (HP-354)."""
    for p in profiles:
        if p.uid == key or p.name == key:
            return p
    raise KeyError(
        f"No profile '{key}'. Available: {', '.join(f'{p.name} ({p.uid})' for p in profiles)}"
    )


# HP-001, Bosch's stabilization profile, is ten steps of 320 degC with a
# duration of 429 time bases each. In parallel mode the per-step gas_wait
# register is a single byte, so 429 does not fit. Because every step is the
# same temperature the heater simply sits at 320 degC throughout, so capping
# each step at 255 is thermally identical -- only the nominal cycle length
# changes (357 s instead of 600.6 s).
STABILIZATION = HeaterProfile(
    uid="heater_stab",
    name="HP-STAB",
    time_base=140,
    steps=[HeaterStep(320, 255) for _ in range(10)],
)


def stabilization_profile() -> HeaterProfile:
    """A parallel-mode-safe equivalent of HP-001 for sensor burn-in."""
    return STABILIZATION
