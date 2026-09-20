"""Turn the nRF52840 logger's serial stream into a .bmerawdata file.

The firmware emits one CSV-ish line per heater step:

    # sensor,t_ms,temp_C,press_hPa,hum_pct,gas_ohm,step,heat_stable
    D,0,10782,33.47,998.78,35.46,234700.90,0,1

This module parses that and hands it to the same writer the USB tool uses, so
both capture paths produce identical files.
"""

import sys
import time
from dataclasses import dataclass
from typing import Iterable, Iterator, Optional

from .profiles import DutyCycleProfile, HeaterProfile
from .rawdata import Label, RawDataWriter


@dataclass
class Record:
    sensor_index: int
    t_ms: int
    temperature: float
    pressure_hpa: float
    humidity: float
    gas_resistance: float
    step_index: int
    heat_stable: bool


def parse_line(line: str) -> Optional[Record]:
    line = line.strip()
    if not line.startswith("D,"):
        return None
    parts = line.split(",")
    if len(parts) != 9:
        return None
    try:
        return Record(
            sensor_index=int(parts[1]),
            t_ms=int(parts[2]),
            temperature=float(parts[3]),
            pressure_hpa=float(parts[4]),
            humidity=float(parts[5]),
            gas_resistance=float(parts[6]),
            step_index=int(parts[7]),
            heat_stable=bool(int(parts[8])),
        )
    except ValueError:
        return None


def parse_stream(lines: Iterable[str]) -> Iterator[Record]:
    for line in lines:
        rec = parse_line(line)
        if rec is not None:
            yield rec


def open_serial(port: str, baudrate: int = 115200, timeout: float = 1.0):
    try:
        import serial  # noqa: PLC0415
    except ImportError:
        raise SystemExit(
            "reading from a serial port needs pyserial:  pip install pyserial\n"
            "Or capture to a file first:  cat /dev/ttyACM0 > run.txt"
        )
    return serial.Serial(port, baudrate=baudrate, timeout=timeout)


def serial_lines(port: str, duration: Optional[float] = None) -> Iterator[str]:
    ser = open_serial(port)
    deadline = None if duration is None else time.time() + duration
    try:
        while deadline is None or time.time() < deadline:
            raw = ser.readline()
            if raw:
                yield raw.decode("utf-8", errors="replace")
    finally:
        ser.close()


def build(records: Iterable[Record], heater_profile: HeaterProfile,
          duty_cycle_profile: DutyCycleProfile,
          labels: Optional[list] = None,
          t0_unix: Optional[float] = None,
          progress=None) -> RawDataWriter:
    """labels: [(name, seconds), ...] applied against the firmware's own clock."""
    labels = labels or []
    seen = set()
    rows = []
    for rec in records:
        seen.add(rec.sensor_index)
        rows.append(rec)
        if progress:
            progress(len(rows), rec)

    writer = RawDataWriter(
        heater_profile=heater_profile,
        duty_cycle_profile=duty_cycle_profile,
        sensor_indices=sorted(seen),
        board_id="nrf52840",
        firmware_version="bme690-logger",
    )
    for n, (name, _) in enumerate(labels, start=1):
        writer.add_label(Label(tag=n, name=name,
                               description="recorded by bme690-logger"))

    base = t0_unix if t0_unix is not None else time.time()

    def tag_for(t_ms: int) -> int:
        if not labels:
            return 0
        elapsed = t_ms / 1000.0
        acc = 0.0
        for n, (_, secs) in enumerate(labels, start=1):
            acc += secs
            if elapsed < acc:
                return n
        return len(labels)

    for rec in rows:
        writer.add(
            sensor_index=rec.sensor_index,
            timestamp_ms=rec.t_ms,
            real_time_s=int(base + rec.t_ms / 1000.0),
            temperature=rec.temperature,
            pressure_pa=rec.pressure_hpa * 100.0,   # writer converts back to hPa
            humidity=rec.humidity,
            gas_resistance=rec.gas_resistance,
            step_index=rec.step_index,
            label_tag=tag_for(rec.t_ms),
            error_code=0,
        )
    return writer
