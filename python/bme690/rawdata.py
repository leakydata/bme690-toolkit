"""Writer for BME AI-Studio's .bmerawdata / .bmelabelinfo files.

The layout follows what AI-Studio's importer requires
(src/server/services/import/raw_data/parser). Units match the Bosch reference
data: pressure in hPa, temperature in degC, humidity in %RH, gas resistance in
Ohm, and exactly ten heater-profile steps (index 0..9) per cycle.
"""

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Sequence

from .profiles import DutyCycleProfile, HeaterProfile

DATA_COLUMNS = [
    {"name": "Sensor Index", "unit": "", "format": "integer", "key": "sensor_index"},
    {"name": "Sensor ID", "unit": "", "format": "integer", "key": "sensor_id"},
    {"name": "Time Since PowerOn", "unit": "Milliseconds", "format": "integer",
     "key": "timestamp_since_poweron"},
    {"name": "Real time clock", "unit": "Unix Timestamp: seconds since Jan 01 1970. (UTC)",
     "format": "integer", "key": "real_time_clock"},
    {"name": "Temperature", "unit": "DegreesCelcius", "format": "float", "key": "temperature"},
    {"name": "Pressure", "unit": "Hectopascals", "format": "float", "key": "pressure"},
    {"name": "Relative Humidity", "unit": "Percent", "format": "float",
     "key": "relative_humidity"},
    {"name": "Resistance Gassensor", "unit": "Ohms", "format": "float",
     "key": "resistance_gassensor"},
    {"name": "Heater Profile Step Index", "unit": "", "format": "integer",
     "key": "heater_profile_step_index"},
    {"name": "Scanning Mode Enabled", "unit": "", "format": "boolean",
     "key": "scanning_mode_enabled"},
    {"name": "Label Tag", "unit": "", "format": "integer", "key": "label_tag"},
    {"name": "Error Code", "unit": "", "format": "integer", "key": "error_code"},
]

# Column order used when appending rows; must match DATA_COLUMNS.
COL = {c["key"]: i for i, c in enumerate(DATA_COLUMNS)}


@dataclass
class Label:
    tag: int
    name: str
    description: str = ""


@dataclass
class RawDataWriter:
    """Accumulates data points and writes a .bmerawdata (+ .bmelabelinfo) pair."""

    heater_profile: HeaterProfile
    duty_cycle_profile: DutyCycleProfile
    sensor_indices: Sequence[int]
    sensor_ids: Dict[int, int] = field(default_factory=dict)
    board_type: str = "board_690"
    board_mode: str = "sensor_mode"
    board_id: str = ""
    firmware_version: str = ""
    date_created: Optional[str] = None
    rows: List[list] = field(default_factory=list)
    labels: Dict[int, Label] = field(default_factory=dict)

    def add_label(self, label: Label) -> None:
        self.labels[label.tag] = label

    def add(self, sensor_index: int, timestamp_ms: int, real_time_s: int,
            temperature: float, pressure_pa: float, humidity: float,
            gas_resistance: float, step_index: int, label_tag: int = 0,
            error_code: int = 0, scanning: bool = True) -> None:
        self.rows.append([
            sensor_index,
            self.sensor_ids.get(sensor_index, sensor_index),
            int(timestamp_ms),
            int(real_time_s),
            round(float(temperature), 4),
            round(float(pressure_pa) / 100.0, 4),   # Pa -> hPa
            round(float(humidity), 4),
            round(float(gas_resistance), 2),
            int(step_index),
            bool(scanning),
            int(label_tag),
            int(error_code),
        ])

    # ------------------------------------------------------------- rendering

    def _config_body(self) -> dict:
        hp = self.heater_profile
        dc = self.duty_cycle_profile
        return {
            "heaterProfiles": [{
                "id": hp.uid,
                "timeBase": hp.time_base,
                "temperatureTimeVectors": [[s.temperature, s.duration] for s in hp.steps],
            }],
            "dutyCycleProfiles": [{
                "id": dc.uid,
                "numberScanningCycles": dc.scanning_cycles,
                "numberSleepingCycles": dc.sleeping_cycles,
            }],
            "sensorConfigurations": [{
                "sensorIndex": i,
                "active": True,
                "heaterProfile": hp.uid,
                "dutyCycleProfile": dc.uid,
            } for i in self.sensor_indices],
        }

    def to_dict(self) -> dict:
        created = self.date_created or datetime.now(timezone.utc).isoformat()
        return {
            "configHeader": {
                "dateCreated": created,
                "appVersion": "bme690tool",
                "boardType": self.board_type,
                "boardMode": self.board_mode,
                "boardLayout": "",
            },
            "configBody": self._config_body(),
            "rawDataHeader": {
                "counterPowerOnOff": 1,
                "seedPowerOnOff": "",
                "counterFileLimit": 1,
                "dateCreated": created,
                "firmwareVersion": self.firmware_version,
                "boardId": self.board_id,
            },
            "rawDataBody": {
                "dataColumns": DATA_COLUMNS,
                "dataBlock": self.rows,
            },
        }

    def write(self, path: str) -> List[str]:
        if not path.endswith(".bmerawdata"):
            path += ".bmerawdata"
        data = self.to_dict()
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        with open(path, "w") as f:
            json.dump(data, f, indent=1)
        written = [path]

        if self.labels:
            label_path = path[: -len(".bmerawdata")] + ".bmelabelinfo"
            with open(label_path, "w") as f:
                json.dump({
                    "labelInformation": [
                        {
                            "labelTag": l.tag,
                            "labelName": l.name,
                            "labelDescription": l.description,
                        }
                        for l in sorted(self.labels.values(), key=lambda x: x.tag)
                    ]
                }, f, indent=1)
            written.append(label_path)
        return written
