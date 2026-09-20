"""Command line interface for the BME690 8x shuttle board on Linux."""

import argparse
import os
import sys
import time
from typing import List, Optional

from .board import AppBoard31, SHUTTLE_ID_BME690_8X
from .device import BME690Error, HeaterConf, TPHConf
from . import registers as R
from .profiles import (find, load_duty_cycle_profiles, load_heater_profiles,
                       stabilization_profile)
from .rawdata import Label, RawDataWriter
from .recorder import Recorder


def _open_board(args) -> AppBoard31:
    board = AppBoard31(amb_temp=args.ambient)
    board.open()
    if board.shuttle_id != SHUTTLE_ID_BME690_8X:
        print(f"warning: shuttle id 0x{board.shuttle_id:02x}, expected "
              f"0x{SHUTTLE_ID_BME690_8X:02x} (BME690 8x shuttle board)",
              file=sys.stderr)
    return board


# --------------------------------------------------------------- subcommands

def cmd_info(args) -> int:
    with _open_board(args) as board:
        i = board.board_info
        print(f"Board            : 0x{i.Board:x} (Application Board 3.1)")
        print(f"Shuttle          : 0x{i.ShuttleID:02x}")
        print(f"Hardware ID      : 0x{i.HardwareId:02x}")
        sw = i.SoftwareId
        print(f"Firmware         : v{(sw >> 12) & 0xF}.{(sw >> 6) & 0x3F}.{sw & 0x3F}")
        print(f"COINES SDK       : {board.cb.lib_version}")
        found = board.scan()
        print(f"Sensors detected : {len(found)} -> {found}")
        for dev in board.init_sensors(found):
            print(f"  sensor {dev.index}: chip 0x{dev.chip_id:02x}  variant {dev.variant_id}  "
                  f"uid 0x{dev.unique_id():08x}")
    return 0


def cmd_scan(args) -> int:
    with _open_board(args) as board:
        found = board.scan()
        print(" ".join(str(i) for i in found) if found else "no sensors found")
    return 0 if found else 1


def cmd_profiles(args) -> int:
    hps = load_heater_profiles(args.config_dir)
    dcs = load_duty_cycle_profiles(args.config_dir)
    print("Heater profiles:")
    for p in hps:
        print(f"  {p.name:10} {p.uid:14} {len(p.steps)} steps, "
              f"time base {p.time_base} ms, cycle {p.cycle_duration_ms / 1000:6.2f} s")
    print("\nDuty cycle profiles:")
    for p in dcs:
        print(f"  {p.name:22} {p.uid:12} scanning {p.scanning_cycles}, "
              f"sleeping {p.sleeping_cycles}")
    return 0


def cmd_read(args) -> int:
    """One-shot forced-mode measurement from every sensor."""
    with _open_board(args) as board:
        devs = board.init_sensors(board.scan())
        if not devs:
            print("no sensors found", file=sys.stderr)
            return 1
        tph = TPHConf(os_hum=R.OS_1X, os_temp=R.OS_2X, os_pres=R.OS_16X,
                      filter=R.FILTER_OFF, odr=R.ODR_NONE)
        heat = HeaterConf(enable=True, heatr_temp=args.heater_temp,
                          heatr_dur=args.heater_dur)
        for d in devs:
            d.set_conf(tph)
            d.set_heatr_conf(R.FORCED_MODE, heat)

        header = (f"{'sensor':>6}  {'T (C)':>8}  {'P (hPa)':>9}  {'RH (%)':>7}  "
                  f"{'Rgas (Ohm)':>13}  stable")
        for n in range(args.count):
            if n:
                time.sleep(args.interval)
            for d in devs:
                d.set_op_mode(R.FORCED_MODE)
            time.sleep(devs[0].get_meas_dur(R.FORCED_MODE, tph) / 1e6
                       + args.heater_dur / 1000.0 + 0.05)
            print(header)
            for d in devs:
                rs = d.get_data(R.FORCED_MODE)
                if not rs:
                    print(f"{d.index:>6}  (no data)")
                    continue
                r = rs[0]
                print(f"{d.index:>6}  {r.temperature:8.2f}  {r.pressure / 100:9.2f}  "
                      f"{r.humidity:7.2f}  {r.gas_resistance:13.1f}  "
                      f"{'yes' if r.heat_stable else 'no'}")
            print()
    return 0


def _parse_labels(spec: Optional[str]) -> List[tuple]:
    """'coffee:120,air:60' -> [('coffee', 120.0), ('air', 60.0)]"""
    if not spec:
        return []
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" not in part:
            raise ValueError(f"label '{part}' must be NAME:SECONDS")
        name, secs = part.rsplit(":", 1)
        out.append((name.strip(), float(secs)))
    return out


def _resolve_heater_profile(name: str, config_dir):
    """Resolve a heater profile, substituting HP-001 with a parallel-safe twin."""
    if name.upper() in ("HP-STAB", "HEATER_STAB"):
        return stabilization_profile()
    hp = find(load_heater_profiles(config_dir), name)
    over = [(i, s.duration) for i, s in enumerate(hp.steps) if s.duration > 255]
    if not over:
        return hp
    if len({s.temperature for s in hp.steps}) == 1:
        stab = stabilization_profile()
        print(f"note: {hp.name} has step durations up to "
              f"{max(d for _, d in over)}, which do not fit the single-byte "
              f"parallel-mode multiplier. Every step is the same temperature "
              f"({hp.steps[0].temperature} degC), so using {stab.name} instead "
              f"-- the heater is held at the same temperature, only the nominal "
              f"cycle length differs ({stab.cycle_duration_ms / 1000:.0f} s vs "
              f"{hp.cycle_duration_ms / 1000:.0f} s).")
        return stab
    raise ValueError(
        f"{hp.name} has step durations up to {max(d for _, d in over)}; the "
        "parallel-mode gas_wait multiplier is a single byte (max 255) and the "
        "steps are not all at one temperature, so it cannot be run as-is."
    )


def cmd_record(args) -> int:
    hp = _resolve_heater_profile(args.heater_profile, args.config_dir)
    dc = find(load_duty_cycle_profiles(args.config_dir), args.duty_cycle)
    schedule = _parse_labels(args.labels)
    duration = sum(s for _, s in schedule) if schedule else args.duration

    with _open_board(args) as board:
        devs = board.init_sensors(board.scan())
        if not devs:
            print("no sensors found", file=sys.stderr)
            return 1

        rec = Recorder(board, hp, dc, poll_interval=args.poll_interval)
        rec.configure()

        i = board.board_info
        sw = i.SoftwareId
        writer = RawDataWriter(
            heater_profile=hp,
            duty_cycle_profile=dc,
            sensor_indices=[d.index for d in devs],
            sensor_ids={d.index: d.unique_id() for d in devs},
            board_id=f"0x{i.ShuttleID:02x}",
            firmware_version=f"{(sw >> 12) & 0xF}.{(sw >> 6) & 0x3F}.{sw & 0x3F}",
        )
        for n, (name, _) in enumerate(schedule, start=1):
            writer.add_label(Label(tag=n, name=name, description="recorded by bme690tool"))

        print(f"Heater profile   : {hp.name} ({hp.uid}), cycle "
              f"{hp.cycle_duration_ms / 1000:.2f} s, shared heater dur "
              f"{rec.shared_heatr_dur} ms")
        print(f"Duty cycle       : {dc.name}")
        print(f"Sensors          : {[d.index for d in devs]}")
        print(f"Duration         : {duration:.0f} s "
              f"(~{duration / (hp.cycle_duration_ms / 1000):.1f} cycles)")
        if schedule:
            print("Label schedule   : " +
                  ", ".join(f"{n}={name} ({s:.0f}s)"
                            for n, (name, s) in enumerate(schedule, start=1)))
        print()

        state = {"n": 0, "label": 0, "seg": 0, "seg_end": None, "announced": None,
                 "last_print": -1.0, "last_save": 0.0}
        start = [None]

        def current_label(now: float) -> int:
            if not schedule:
                return 0
            if start[0] is None:
                start[0] = now
            if state["seg_end"] is None:
                state["seg_end"] = start[0] + schedule[0][1]
            while state["seg"] < len(schedule) and now >= state["seg_end"]:
                state["seg"] += 1
                if state["seg"] < len(schedule):
                    state["seg_end"] += schedule[state["seg"]][1]
            return state["seg"] + 1 if state["seg"] < len(schedule) else len(schedule)

        def on_data(points):
            for p in points:
                tag = current_label(time.time())
                if schedule and tag != state["announced"]:
                    state["announced"] = tag
                    name = schedule[min(tag, len(schedule)) - 1][0]
                    print(f"\n  >>> now recording label {tag}: {name}")
                writer.add(
                    sensor_index=p.sensor_index,
                    timestamp_ms=p.timestamp_ms,
                    real_time_s=p.real_time_s,
                    temperature=p.temperature,
                    pressure_pa=p.pressure,
                    humidity=p.humidity,
                    gas_resistance=p.gas_resistance,
                    step_index=p.step_index,
                    label_tag=tag,
                    error_code=0,
                )
                state["n"] += 1
            elapsed = time.time() - rec.t0
            # Checkpoint to disk periodically: a long unattended run must not
            # lose everything if it dies before the final write.
            if elapsed - state["last_save"] >= args.checkpoint:
                state["last_save"] = elapsed
                try:
                    writer.write(args.output)
                except Exception as e:
                    print(f"\n  checkpoint failed: {e}", flush=True)
            if elapsed - state["last_print"] < 1.0:
                return
            state["last_print"] = elapsed
            line = (f"  {elapsed:6.1f}s / {duration:.0f}s   {state['n']:6d} points"
                    f"   {state['n'] / max(elapsed, 1e-9):5.1f}/s")
            if sys.stdout.isatty():
                print("\r" + line, end="", flush=True)
            else:
                print(line, flush=True)

        try:
            rec.run(duration, on_data=on_data)
        except KeyboardInterrupt:
            print("\n  interrupted, saving what was recorded")
        print()

        if not writer.rows:
            print("no data recorded", file=sys.stderr)
            return 1
        written = writer.write(args.output)
        print(f"\nWrote {state['n']} data points:")
        for w in written:
            print(f"  {w}")
        print("\nImport it in BME AI-Studio with "
              "'Import Data' -> 'Specimen Raw Data'.")
    return 0


# ---------------------------------------------------------------------- main

def cmd_burn_in(args) -> int:
    """Hold every sensor at 320 degC to stabilise factory-new elements."""
    args.heater_profile = "HP-STAB"
    args.duty_cycle = "RDC-1-0 Continuous"
    args.labels = None
    args.poll_interval = 0.25          # nothing to miss; keep USB traffic low
    args.checkpoint = 300.0
    if not args.output:
        args.output = os.path.join(
            "recordings",
            f"burn_in_{time.strftime('%Y%m%d_%H%M%S')}.bmerawdata")
    hours = args.hours
    args.duration = hours * 3600
    print(f"Burn-in: holding all sensors at 320 degC for {hours:g} hours.")
    print("Bosch recommend at least 12 hours for factory-new sensors.")
    print("Leave the board somewhere with clean, still air.\n")
    return cmd_record(args)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="bme690",
        description="Read and record the Bosch BME690 8x shuttle board on an "
                    "Application Board 3.1, and write files BME AI-Studio can import.",
    )
    p.add_argument("--ambient", type=int, default=25,
                   help="ambient temperature in degC, used for heater resistance (default: 25)")
    p.add_argument("--config-dir", default=None,
                   help="directory holding heater_profiles.json and duty_cycle_profiles.json")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("info", help="show board, firmware and sensor information").set_defaults(func=cmd_info)
    sub.add_parser("scan", help="list the sensor sockets that answer").set_defaults(func=cmd_scan)
    sub.add_parser("profiles", help="list available heater and duty cycle profiles").set_defaults(func=cmd_profiles)

    r = sub.add_parser("read", help="one-shot forced-mode measurement from every sensor")
    r.add_argument("-n", "--count", type=int, default=1, help="number of measurements (default: 1)")
    r.add_argument("-i", "--interval", type=float, default=1.0, help="seconds between measurements")
    r.add_argument("--heater-temp", type=int, default=300, help="heater target in degC (default: 300)")
    r.add_argument("--heater-dur", type=int, default=100, help="heater duration in ms (default: 100)")
    r.set_defaults(func=cmd_read)

    rec = sub.add_parser("record", help="record a scan to a .bmerawdata file for AI-Studio")
    rec.add_argument("-o", "--output", required=True, help="output path (.bmerawdata)")
    rec.add_argument("-d", "--duration", type=float, default=600, help="seconds to record (default: 600)")
    rec.add_argument("--heater-profile", default="HP-354", help="heater profile name or id (default: HP-354)")
    rec.add_argument("--duty-cycle", default="RDC-1-0 Continuous", help="duty cycle profile (default: continuous)")
    rec.add_argument("--labels", default=None,
                     help="label schedule 'NAME:SECONDS,NAME:SECONDS'; overrides --duration")
    rec.add_argument("--poll-interval", type=float, default=0.04, help="seconds between polls (default: 0.04)")
    rec.add_argument("--checkpoint", type=float, default=300.0,
                     help="seconds between writing the file out (default: 300)")
    rec.set_defaults(func=cmd_record)

    b = sub.add_parser("burn-in",
                       help="stabilise factory-new sensors (Bosch: >= 12 hours)")
    b.add_argument("--hours", type=float, default=12.0, help="hours to run (default: 12)")
    b.add_argument("-o", "--output", default=None,
                   help="where to log the run (default: recordings/burn_in_<timestamp>.bmerawdata)")
    b.set_defaults(func=cmd_burn_in)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except BME690Error as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
