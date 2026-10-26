"""Live terminal monitor for the BME690 8x logger firmware (ESP32-S3).

    bme690 monitor                       find the board's USB port by itself
    bme690 monitor --port /dev/ttyACM0
    bme690 monitor --demo                fake data, no hardware needed

It reads the logger's USB serial console: the "D," sample rows give the live
values, and the "S," status object (asked for with the `status` command every
couple of seconds) gives the sensor, card and recording state.

Keys:  r  start or stop recording     l  next label
       s  rescan the sensors          q  quit

curses is part of Python on Linux and macOS. On Windows install it with
    pip install windows-curses
"""

import glob
import json
import math
import queue
import random
import threading
import time
from typing import List, Optional, Tuple

from .ingest import parse_line

STATUS_EVERY_S = 2.0
NO_DATA_AFTER_S = 5.0
STALE_MIN_S = 15.0
MESSAGE_S = 6.0
CLOCK_RETRY_S = 10.0
HEAP_WARN_BYTES = 24 * 1024
MAX_SENSORS = 16

LEVELS = ".:-=+*#%@"
LOG_LO = 3.5
LOG_HI = 8.0

PYSERIAL_HELP = "reading the board needs pyserial:  pip install pyserial"

# Column key -> (title, width, alignment)
COLUMNS = {
    "u": ("U", 3, "<"),
    "pin": ("PIN", 5, "<"),
    "gpio": ("GPIO", 4, ">"),
    "state": ("STATE", 7, "<"),
    "par": ("PAR_T1", 7, ">"),
    "temp": ("TEMP C", 6, ">"),
    "press": ("hPa", 7, ">"),
    "hum": ("RH %", 5, ">"),
    "gas": ("GAS ohm", 8, ">"),
    "step": ("STEP", 4, ">"),
    "heat": ("HEAT%", 5, ">"),
}
ORDER = ["u", "pin", "gpio", "state", "par", "temp", "press", "hum", "gas", "step", "heat", "trend"]
REQUIRED = ["u", "pin", "state", "temp", "press", "hum", "gas", "step", "heat"]
OPTIONAL = ["par", "gpio"]
TREND_MIN = 10
TREND_MAX = 24


class Live:
    """The newest values seen for one sensor in the "D," rows."""

    def __init__(self):
        self.temp = None
        self.press = None
        self.hum = None
        self.gas = None
        self.step = None
        self.stable = False
        self.seen = 0.0
        self.rows = 0
        self.gas_by_step = {}


class Model:
    def __init__(self):
        self.live: List[Live] = [Live() for _ in range(8)]
        self.status: Optional[dict] = None
        self.status_at = 0.0
        self.data_at = 0.0
        self.message = ""
        self.message_at = 0.0
        self.rows = 0

    def feed(self, line: str, now: float) -> None:
        line = line.strip()
        if line.startswith("D,"):
            rec = parse_line(line)
            if rec is None or not 0 <= rec.sensor_index < MAX_SENSORS:
                return
            while rec.sensor_index >= len(self.live):
                self.live.append(Live())
            s = self.live[rec.sensor_index]
            s.temp = rec.temperature
            s.press = rec.pressure_hpa
            s.hum = rec.humidity
            s.step = rec.step_index
            s.stable = rec.heat_stable
            s.seen = now
            s.rows += 1
            if rec.heat_stable:
                s.gas = rec.gas_resistance
                s.gas_by_step[rec.step_index] = rec.gas_resistance
            self.data_at = now
            self.rows += 1
        elif line.startswith("S,"):
            try:
                self.status = json.loads(line[2:])
            except ValueError:
                return
            self.status_at = now
        elif line == "OK" or line.startswith("ERR"):
            self.message = line
            self.message_at = now


def fmt_ohm(v: Optional[float]) -> str:
    if v is None:
        return "-"
    if v >= 1e6:
        return "%.2fM" % (v / 1e6)
    if v >= 1e3:
        return "%.1fk" % (v / 1e3)
    return "%.0f" % v


def fmt_num(v: Optional[float], spec: str) -> str:
    return "-" if v is None else spec % v


def fmt_uptime(ms: Optional[float]) -> str:
    if ms is None:
        return "-"
    s = int(ms / 1000)
    return "%d:%02d:%02d" % (s // 3600, (s // 60) % 60, s % 60)


def trend(gas_by_step: dict) -> str:
    """One character per heater step, by log10 of its newest stable gas value."""
    if not gas_by_step:
        return ""
    n = min(max(gas_by_step) + 1, 32)
    out = []
    for step in range(n):
        g = gas_by_step.get(step)
        if g is None or g <= 0:
            out.append(" ")
            continue
        x = (math.log10(g) - LOG_LO) / (LOG_HI - LOG_LO)
        i = int(x * len(LEVELS))
        out.append(LEVELS[max(0, min(len(LEVELS) - 1, i))])
    return "".join(out)


def layout(width: int) -> List[str]:
    """The columns that fit in `width`, in display order."""
    def total(keys):
        return sum(COLUMNS[k][1] for k in keys) + len(keys) - 1

    keys = list(REQUIRED)
    for k in OPTIONAL:
        if total(keys + [k]) <= width - 1:
            keys.append(k)
    chosen = keys
    room = width - 1 - total(chosen) - 1
    if room >= TREND_MIN:
        chosen = chosen + ["trend"]
    return [k for k in ORDER if k in chosen]


def _cell(key: str, text: str, trend_w: int) -> str:
    if key == "trend":
        return text[:trend_w].ljust(trend_w)
    _, w, align = COLUMNS[key]
    text = text[:w]
    return text.ljust(w) if align == "<" else text.rjust(w)


def _trend_width(keys: List[str], width: int) -> int:
    used = sum(COLUMNS[k][1] for k in keys if k != "trend") + len(keys) - 1
    return max(0, min(TREND_MAX, width - 1 - used))


def _row_text(keys: List[str], cells: dict, width: int) -> str:
    tw = _trend_width(keys, width)
    return " ".join(_cell(k, cells.get(k, ""), tw) for k in keys)


def _header_text(keys: List[str], width: int) -> str:
    tw = _trend_width(keys, width)
    cells = {k: COLUMNS[k][0] for k in keys if k != "trend"}
    cells["trend"] = "GAS BY HEATER STEP"
    return " ".join(_cell(k, cells[k], tw) for k in keys)


def _sensor_row(index: int, status_sensor: dict, live: Live, now: float) -> Tuple[dict, str]:
    last = status_sensor.get("last") or {}
    cycle_s = (status_sensor.get("cycle_ms") or 0) / 1000.0
    stale_after = max(STALE_MIN_S, 3 * cycle_s)
    state = status_sensor.get("state") or "?"
    style = "norm"
    if state != "ok":
        style = "err"
    elif live.rows and now - live.seen > stale_after:
        state = "stale"
        style = "warn"
    elif not live.rows:
        style = "dim"

    par = status_sensor.get("par_t1")
    expected = status_sensor.get("expected_par_t1")
    par_text = "-" if par is None else str(par)
    if par is not None and expected and expected != par:
        par_text += "!"
        style = "warn" if style == "norm" else style

    def pick(mine, key):
        return mine if mine is not None else last.get(key)

    step = pick(live.step, "step")
    stable = live.stable if live.rows else bool(last.get("stable"))
    step_text = "-" if step is None else "%d%s" % (step, "*" if stable else ".")
    heat = status_sensor.get("heat_stable_pct")
    cells = {
        "u": status_sensor.get("part") or "U%d" % (index + 1),
        "pin": status_sensor.get("shuttle_pin") or "",
        "gpio": str(status_sensor.get("gpio", "")),
        "state": state,
        "par": par_text,
        "temp": fmt_num(pick(live.temp, "temp"), "%.2f"),
        "press": fmt_num(pick(live.press, "press"), "%.2f"),
        "hum": fmt_num(pick(live.hum, "hum"), "%.1f"),
        "gas": fmt_ohm(pick(live.gas, "gas")),
        "step": step_text,
        "heat": fmt_num(heat, "%.1f"),
        "trend": trend(live.gas_by_step),
    }
    return cells, style


def render(model: Model, width: int, height: int, now: float, link_state: str = "ok") -> List[Tuple[str, str]]:
    """The screen as (text, style) lines. Pure, so it can be tested without curses."""
    st = model.status or {}
    hw = st.get("hw") or {}
    lines: List[Tuple[str, str]] = []

    title = "BME690 monitor"
    if hw.get("name"):
        title += "  %s" % hw["name"]
    if st.get("fw"):
        title += "  fw %s" % st["fw"]
    if st.get("board"):
        title += "  %s" % st["board"]
    if st.get("uptime_ms") is not None:
        title += "  up %s" % fmt_uptime(st["uptime_ms"])
    lines.append((title, "head"))

    if link_state != "ok":
        lines.append(("Port: %s" % link_state, "err"))
    elif model.rows == 0 and not model.status:
        lines.append(("Waiting for the board ...", "dim"))
    elif model.data_at and now - model.data_at > NO_DATA_AFTER_S:
        lines.append(("NO DATA for %d s: is the logger running?" % int(now - model.data_at), "err"))

    if model.status:
        if st.get("recording"):
            text = "Recording: ON   session %s   file %s   rows %s" % (
                st.get("session", "-"), st.get("file", "-"), st.get("rows_written", "-"))
            lines.append((text, "rec"))
        else:
            lines.append(("Recording: off", "norm"))
        label = st.get("label") or {}
        extra = []
        if label:
            extra.append("label %s %s" % (label.get("tag", ""), label.get("name", "")))
        burnin = st.get("burnin")
        if burnin:
            extra.append("BURN-IN %.1f h left" % (burnin.get("remaining_s", 0) / 3600.0))
        if st.get("time_set") is False:
            extra.append("clock not set")
        if extra:
            lines.append(("   ".join(extra), "norm"))
        card = st.get("card") or {}
        if card.get("present"):
            text = "Card: %.1f GB free of %.1f GB" % (card.get("free_mb", 0) / 1024.0, card.get("total_mb", 0) / 1024.0)
            style = "norm"
        else:
            text = "Card: none (live only)"
            style = "dim"
            if card.get("error"):
                text = "Card: %s" % card["error"]
                style = "warn"
        wifi = st.get("wifi") or {}
        if wifi.get("ssid"):
            text += "   WiFi %s (%s clients)" % (wifi["ssid"], wifi.get("clients", 0))
        heap = st.get("heap") or {}
        if heap.get("free") is not None:
            text += "   heap %dk free (low %dk)" % (heap["free"] // 1024, heap.get("min_free", 0) // 1024)
            if heap.get("min_free", HEAP_WARN_BYTES) < HEAP_WARN_BYTES:
                style = "warn"
        lines.append((text, style))

    lines.append(("", "norm"))
    keys = layout(width)
    lines.append((_header_text(keys, width), "head"))
    sensors = st.get("sensors") or [{} for _ in range(len(model.live))]
    for i, ss in enumerate(sensors):
        live = model.live[i] if i < len(model.live) else Live()
        cells, style = _sensor_row(i, ss, live, now)
        lines.append((_row_text(keys, cells, width), style))

    for p in (st.get("problems") or [])[:3]:
        level = p.get("level", "info")
        style = "err" if level == "error" else ("warn" if level == "warning" else "dim")
        lines.append(("%s: %s" % (level, p.get("text", "")), style))

    footer = [("r record on/off   l next label   s rescan sensors   q quit", "head")]
    if model.message and now - model.message_at < MESSAGE_S:
        footer.insert(0, ("> " + model.message, "err" if model.message.startswith("ERR") else "ok"))
    body = lines[:max(0, height - len(footer))]
    while len(body) < height - len(footer):
        body.append(("", "norm"))
    out = body + footer
    return [(t[:max(0, width - 1)], s) for t, s in out][:height]


def clock_command(model: Model, last_sent: float, now: float) -> Optional[str]:
    """The `time` command to send when the board says its clock was never set.

    The dashboard does this when it is opened; without it a recording has no
    real timestamps. Retried every 10 s until the status shows the clock set.
    """
    st = model.status
    if st and st.get("time_set") is False and now - last_sent >= CLOCK_RETRY_S:
        return "time %d" % int(now)
    return None


def find_port() -> Optional[str]:
    try:
        from serial.tools import list_ports  # noqa: PLC0415
    except ImportError:
        raise SystemExit(PYSERIAL_HELP)
    ports = list(list_ports.comports())
    for p in ports:
        if p.vid == 0x303A:
            return p.device
    for p in ports:
        for hint in ("ACM", "USB", "usbmodem", "usbserial", "COM"):
            if hint in p.device:
                return p.device
    names = sorted(glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*"))
    return names[0] if names else None


class SerialLink:
    """Reads the console on a thread; send() writes a command line."""

    def __init__(self, port: str):
        self.port = port
        self.lines: "queue.Queue[str]" = queue.Queue()
        self.state = "connecting to %s" % port
        self._ser = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _open(self):
        try:
            import serial  # noqa: PLC0415
        except ImportError:
            raise SystemExit(PYSERIAL_HELP)
        ser = serial.Serial()
        ser.port = self.port
        ser.baudrate = 115200
        ser.timeout = 0.2
        # Do not touch DTR or RTS. Opening the port leaves both high, which is
        # idle; dropping them afterwards runs the ESP32-S3's reset sequence
        # and restarts the logger (and its recording).
        ser.open()
        return ser

    def _run(self) -> None:
        buf = b""
        while not self._stop.is_set():
            if self._ser is None:
                try:
                    self._ser = self._open()
                    self.state = "ok"
                except Exception as e:
                    self.state = "waiting for %s (%s)" % (self.port, e)
                    self._stop.wait(1.0)
                    continue
            try:
                chunk = self._ser.read(max(1, self._ser.in_waiting))
            except Exception as e:
                self._close_port()
                self.state = "lost %s, reconnecting (%s)" % (self.port, e)
                buf = b""
                self._stop.wait(1.0)
                continue
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                self.lines.put(raw.decode("utf-8", errors="replace"))

    def _close_port(self) -> None:
        ser, self._ser = self._ser, None
        if ser is not None:
            try:
                ser.close()
            except Exception:
                pass

    def send(self, cmd: str) -> None:
        ser = self._ser
        if ser is None:
            return
        try:
            ser.write((cmd + "\n").encode("ascii"))
        except Exception:
            pass

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1.0)
        self._close_port()


class DemoLink:
    """Made-up data in the logger's own formats, for trying the screen without a board."""

    STEPS = 10

    def __init__(self):
        self.lines: "queue.Queue[str]" = queue.Queue()
        self.state = "ok"
        self._rng = random.Random(1)
        self._t0 = time.time()
        self._recording = True
        self._label = 1
        self._rows = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        n = 0
        base = [3.0e5, 5.0e5, 5.4e5, 6.9e5, 6.3e5, 5.0e5, 5.1e5, 7.6e5]
        while not self._stop.is_set():
            sensor = n % 8
            step = (n // 8) % self.STEPS
            ms = int((time.time() - self._t0) * 1000)
            gas = base[sensor] * (0.4 + 0.25 * step) * (1 + 0.05 * self._rng.random())
            temp = 33.0 + sensor * 0.1 + self._rng.random() * 0.1
            hum = 27.0 + self._rng.random()
            self.lines.put("D,%d,%d,%.2f,%.2f,%.2f,%.2f,%d,1" % (sensor, ms, temp, 1015.3, hum, gas, step))
            if self._recording:
                self._rows += 1
            n += 1
            self._stop.wait(0.12)

    def _status(self) -> str:
        sensors = []
        for i in range(8):
            sensors.append({
                "index": i, "part": "U%d" % (i + 1), "shuttle_pin": "P1-%d" % (i + 4) if i < 4 else "P2-%d" % (i + 1),
                "gpio": i + 1, "state": "ok", "chip_id": 97, "par_t1": 22400 + i * 20,
                "expected_par_t1": 0, "cycle_ms": 10780, "cycles": 5, "heat_stable_pct": 99.0,
            })
        st = {
            "fw": "demo", "hw": {"name": "Demo board"}, "board": "BME690-DEMO",
            "uptime_ms": int((time.time() - self._t0) * 1000), "time_set": True,
            "recording": self._recording, "session": "s0001", "file": "s0001_0000.bmerawdata",
            "rows_written": self._rows, "label": {"tag": self._label, "name": "demo"},
            "card": {"present": True, "total_mb": 59998, "free_mb": 59900, "error": None},
            "wifi": {"ssid": "BME690-DEMO", "clients": 0}, "sensors": sensors, "problems": [],
        }
        return "S," + json.dumps(st)

    def send(self, cmd: str) -> None:
        if cmd == "status":
            self.lines.put(self._status())
        elif cmd in ("rec start", "rec stop"):
            self._recording = cmd == "rec start"
            self.lines.put("OK")
        elif cmd == "label next":
            self._label += 1
            self.lines.put("OK")
        elif cmd == "rescan":
            self.lines.put("OK")

    def close(self) -> None:
        self._stop.set()


def _run_ui(stdscr, link, once: bool = False) -> None:
    import curses  # noqa: PLC0415

    try:
        curses.curs_set(0)
    except curses.error:
        pass
    styles = {"norm": 0, "head": curses.A_BOLD, "dim": curses.A_DIM, "ok": 0, "warn": 0, "err": 0, "rec": curses.A_BOLD}
    if curses.has_colors():
        curses.start_color()
        try:
            curses.use_default_colors()
            bg = -1
        except curses.error:
            bg = curses.COLOR_BLACK
        curses.init_pair(1, curses.COLOR_GREEN, bg)
        curses.init_pair(2, curses.COLOR_YELLOW, bg)
        curses.init_pair(3, curses.COLOR_RED, bg)
        styles["ok"] = curses.color_pair(1)
        styles["warn"] = curses.color_pair(2)
        styles["err"] = curses.color_pair(3) | curses.A_BOLD
        styles["rec"] = curses.color_pair(3) | curses.A_BOLD
    stdscr.timeout(100)

    model = Model()
    last_poll = 0.0
    last_clock = 0.0
    shown = 0
    while True:
        now = time.time()
        while True:
            try:
                model.feed(link.lines.get_nowait(), now)
            except queue.Empty:
                break
        if now - last_poll >= STATUS_EVERY_S:
            link.send("status")
            last_poll = now
        cmd = clock_command(model, last_clock, now)
        if cmd:
            link.send(cmd)
            last_clock = now
            last_poll = 0.0

        height, width = stdscr.getmaxyx()
        stdscr.erase()
        for y, (text, style) in enumerate(render(model, width, height, now, link.state)):
            try:
                stdscr.addstr(y, 0, text, styles.get(style, 0))
            except curses.error:
                pass
        stdscr.refresh()
        shown += 1
        if once and shown >= 20:
            return

        key = stdscr.getch()
        if key in (ord("q"), ord("Q"), 27):
            return
        recording = bool((model.status or {}).get("recording"))
        if key in (ord("r"), ord("R")):
            link.send("rec stop" if recording else "rec start")
            last_poll = 0.0
        elif key in (ord("l"), ord("L")):
            link.send("label next")
            last_poll = 0.0
        elif key in (ord("s"), ord("S")):
            link.send("rescan")
            last_poll = 0.0


def run(port: Optional[str], demo: bool = False, once: bool = False) -> int:
    try:
        import curses  # noqa: PLC0415
    except ImportError:
        raise SystemExit("the monitor needs curses; on Windows:  pip install windows-curses")
    if demo:
        link = DemoLink()
    else:
        port = port or find_port()
        if not port:
            raise SystemExit("no serial port found: plug the board in, or pass --port")
        link = SerialLink(port)
    try:
        curses.wrapper(_run_ui, link, once)
    finally:
        link.close()
    return 0
