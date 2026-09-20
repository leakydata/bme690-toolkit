"""Parallel-mode scan loop for the BME690 8x shuttle board.

In parallel mode the sensor walks its ten-step heater profile on its own and
tags each result with the step (gas) index; the host only has to poll often
enough not to miss a step. Each sensor keeps three field registers, so one
read returns up to three results and a poll interval well under the shortest
step is plenty.
"""

import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

from .device import BME690, HeaterConf, Reading, TPHConf
from . import registers as R
from .profiles import DutyCycleProfile, HeaterProfile

STEPS_PER_CYCLE = 10


@dataclass
class DataPoint:
    sensor_index: int
    timestamp_ms: int
    real_time_s: int
    temperature: float
    pressure: float          # Pa
    humidity: float
    gas_resistance: float
    step_index: int
    heat_stable: bool
    gas_valid: bool


class Recorder:
    def __init__(self, board, heater_profile: HeaterProfile,
                 duty_cycle_profile: Optional[DutyCycleProfile] = None,
                 tph: Optional[TPHConf] = None, poll_interval: float = 0.05,
                 one_per_step: bool = True):
        if len(heater_profile.steps) != STEPS_PER_CYCLE:
            raise ValueError(
                f"AI-Studio expects {STEPS_PER_CYCLE} heater steps per cycle, "
                f"profile '{heater_profile.name}' has {len(heater_profile.steps)}"
            )
        self.board = board
        self.hp = heater_profile
        self.dc = duty_cycle_profile
        self.tph = tph or TPHConf(os_hum=R.OS_1X, os_temp=R.OS_2X,
                                  os_pres=R.OS_16X, filter=R.FILTER_OFF,
                                  odr=R.ODR_NONE)
        self.poll_interval = poll_interval
        # In parallel mode the sensor measures once per heater time base, so a
        # step that lasts N time bases yields N readings with the same gas
        # index. AI-Studio's importer wants exactly one point per step, so by
        # default only the last reading of each step is emitted -- the one
        # taken after the heater has been longest at that temperature.
        self.one_per_step = one_per_step
        self._last_meas: Dict[int, int] = {}
        self._pending: Dict[int, DataPoint] = {}
        self.errors: Dict[int, int] = {}
        self.recoveries = 0
        self.t0 = 0.0

    # ------------------------------------------------------------- configure

    def configure(self) -> None:
        sensors: List[BME690] = self.board.sensors
        if not sensors:
            raise RuntimeError("no sensors initialised on the board")

        meas_dur_ms = sensors[0].get_meas_dur(R.PARALLEL_MODE, self.tph) / 1000.0
        shared = int(round(self.hp.time_base - meas_dur_ms))
        if shared <= 0:
            raise ValueError(
                f"heater time base {self.hp.time_base} ms is shorter than the "
                f"measurement duration {meas_dur_ms:.1f} ms; reduce oversampling"
            )
        self.shared_heatr_dur = shared

        heat = HeaterConf(
            enable=True,
            heatr_temp_prof=self.hp.temperatures,
            heatr_dur_prof=self.hp.durations,
            shared_heatr_dur=shared,
        )
        for s in sensors:
            s.set_conf(self.tph)
            s.set_heatr_conf(R.PARALLEL_MODE, heat)

    def start(self) -> None:
        for s in self.board.sensors:
            s.set_op_mode(R.PARALLEL_MODE)
        self.t0 = time.time()
        self._last_meas = {}
        self._pending = {}

    def stop(self) -> None:
        for s in self.board.sensors:
            try:
                s.set_op_mode(R.SLEEP_MODE)
            except Exception:
                pass

    # ------------------------------------------------------------------ poll

    def poll_once(self) -> List[DataPoint]:
        out: List[DataPoint] = []
        now = time.time()
        for s in self.board.sensors:
            try:
                readings = s.get_data(R.PARALLEL_MODE)
                self.errors.pop(s.index, None)
            except Exception as e:
                # Never swallow silently: a persistent read failure during a
                # long unattended run used to look exactly like "no new data".
                n = self.errors.get(s.index, 0) + 1
                self.errors[s.index] = n
                if n in (1, 10) or n % 100 == 0:
                    print(f"\n  sensor {s.index}: read failed ({n}x): {e}",
                          flush=True)
                continue
            for r in readings:
                last = self._last_meas.get(s.index)
                if last is not None and r.meas_index == last:
                    continue
                self._last_meas[s.index] = r.meas_index
                point = DataPoint(
                    sensor_index=s.index,
                    timestamp_ms=int((now - self.t0) * 1000),
                    real_time_s=int(now),
                    temperature=r.temperature,
                    pressure=r.pressure,
                    humidity=r.humidity,
                    gas_resistance=r.gas_resistance,
                    step_index=r.gas_index,
                    heat_stable=r.heat_stable,
                    gas_valid=r.gas_valid,
                )
                if not self.one_per_step:
                    out.append(point)
                    continue
                held = self._pending.get(s.index)
                if held is not None and held.step_index != point.step_index:
                    out.append(held)
                self._pending[s.index] = point
        return out

    def flush(self) -> List[DataPoint]:
        """Emit the reading still held for each sensor's in-progress step."""
        out = [p for p in self._pending.values() if p is not None]
        self._pending = {}
        return sorted(out, key=lambda p: (p.timestamp_ms, p.sensor_index))

    def restart_scan(self) -> None:
        """Re-apply the configuration and put the sensors back in parallel mode."""
        for s in self.board.sensors:
            try:
                s.set_op_mode(R.SLEEP_MODE)
            except Exception:
                pass
        self.configure()
        for s in self.board.sensors:
            s.set_op_mode(R.PARALLEL_MODE)
        self._last_meas = {}
        self._pending = {}
        self.errors = {}

    def run(self, duration_s: float,
            on_data: Optional[Callable[[List[DataPoint]], None]] = None,
            stop_flag: Optional[Callable[[], bool]] = None,
            stall_timeout: float = 180.0,
            max_recoveries: int = 20) -> None:
        """Scan for duration_s seconds, handing each batch of new points to on_data.

        If no new data arrives for stall_timeout seconds the scan is restarted:
        over a long unattended run the sensors can quietly stop producing new
        fields, and silently logging nothing for hours is the worst outcome.
        """
        self.start()
        deadline = self.t0 + duration_s
        last_data = self.t0
        try:
            while time.time() < deadline:
                if stop_flag and stop_flag():
                    break
                points = self.poll_once()
                now = time.time()
                if points:
                    last_data = now
                    if on_data:
                        on_data(points)
                elif now - last_data > stall_timeout:
                    self.recoveries += 1
                    print(f"\n  no new data for {now - last_data:.0f}s -- "
                          f"restarting scan (recovery {self.recoveries})",
                          flush=True)
                    if self.recoveries > max_recoveries:
                        raise RuntimeError(
                            f"scan stalled {self.recoveries} times; giving up")
                    try:
                        self.restart_scan()
                    except Exception as e:
                        print(f"  restart failed: {e}; resetting board",
                              flush=True)
                        self.board.reset_board()
                        self.board.init_sensors(self.board.scan())
                        self.restart_scan()
                    last_data = time.time()
                time.sleep(self.poll_interval)
            tail = self.flush()
            if tail and on_data:
                on_data(tail)
        finally:
            self.stop()
