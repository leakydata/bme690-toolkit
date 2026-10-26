"""The terminal monitor's parsing and screen layout (no curses, no hardware)."""

import json

from bme690.monitor import (LEVELS, Model, clock_command, fmt_ohm, fmt_uptime, layout, render,
                            trend)


def status(n=8, recording=True):
    sensors = []
    for i in range(n):
        sensors.append({
            "index": i, "part": "U%d" % (i + 1), "shuttle_pin": "P1-%d" % (i + 4),
            "gpio": i + 1, "state": "ok", "chip_id": 97, "par_t1": 22000 + i,
            "expected_par_t1": 0, "cycle_ms": 10780, "cycles": 3, "heat_stable_pct": 99.5,
        })
    return {
        "fw": "2.4.0", "hw": {"name": "XIAO ESP32-S3 (Board B)"}, "board": "BME690-TEST",
        "uptime_ms": 3723000, "recording": recording, "session": "s0002",
        "file": "s0002_0000.bmerawdata", "rows_written": 42, "label": {"tag": 1, "name": "air"},
        "card": {"present": True, "total_mb": 2048, "free_mb": 1024, "error": None},
        "wifi": {"ssid": "BME690-TEST", "clients": 1}, "sensors": sensors,
        "problems": [{"level": "warning", "sensor": None, "text": "something to look at"}],
    }


def loaded(now=100.0):
    m = Model()
    m.feed("S," + json.dumps(status()), now)
    for s in range(8):
        for step in range(4):
            m.feed("D,%d,%d,33.5,1015.3,27.0,%d,%d,1" % (s, 1000 + step, 100000 * (step + 1), step), now)
    return m


def test_feed_data_status_and_replies():
    m = Model()
    m.feed("D,2,1234,33.5,1015.3,27.1,543000.5,3,1", 10.0)
    assert m.live[2].temp == 33.5 and m.live[2].gas == 543000.5 and m.live[2].step == 3
    assert m.rows == 1 and m.data_at == 10.0
    m.feed("D,2,1300,33.6,1015.3,27.1,1.0,4,0", 11.0)
    assert m.live[2].gas == 543000.5   # an unstable row does not replace the gas value
    assert 4 not in m.live[2].gas_by_step
    m.feed("S,{not json", 12.0)
    assert m.status is None
    m.feed("S," + json.dumps(status()), 12.0)
    assert m.status["fw"] == "2.4.0"
    m.feed("ERR no card", 13.0)
    assert m.message == "ERR no card"
    m.feed("D,99,1,1,1,1,1,1,1", 14.0)      # a sensor index far out of range is ignored
    m.feed("garbage", 14.0)
    assert m.rows == 2


def test_formatting():
    assert fmt_ohm(None) == "-"
    assert fmt_ohm(405785.6) == "405.8k"
    assert fmt_ohm(26554294.0) == "26.55M"
    assert fmt_ohm(950.0) == "950"
    assert fmt_uptime(3723000) == "1:02:03"


def test_trend_scale_and_gaps():
    t = trend({0: 3000.0, 1: 1e5, 3: 1e9})
    assert len(t) == 4 and t[2] == " "
    assert t[0] == LEVELS[0] and t[3] == LEVELS[-1]
    assert LEVELS.index(t[1]) > LEVELS.index(t[0])
    assert trend({}) == ""


def test_layout_by_width():
    assert "trend" not in layout(60)
    assert "par" not in layout(60)
    wide = layout(120)
    assert wide[0] == "u" and wide[-1] == "trend" and "par" in wide and "gpio" in wide


def test_render_fits_every_width():
    m = loaded()
    for width in (60, 80, 100, 140):
        screen = render(m, width, 30, 101.0)
        assert len(screen) == 30
        for text, _ in screen:
            assert len(text) <= width - 1
            assert text.isascii()
        joined = "\n".join(t for t, _ in screen)
        for u in range(1, 9):
            assert "U%d " % u in joined
        assert "Recording: ON" in joined and "Card: 1.0 GB free of 2.0 GB" in joined
        assert "q quit" in screen[-1][0]


def test_render_flags_problems():
    m = loaded()
    st = m.status
    st["sensors"][3]["state"] = "lost"
    st["sensors"][5]["par_t1"] = 22005
    st["sensors"][5]["expected_par_t1"] = 22999
    screen = render(m, 120, 30, 101.0)
    by_u = {t.split()[0]: (t, s) for t, s in screen if t[:1] == "U" and t[1:2].isdigit()}
    assert by_u["U4"][1] == "err"
    assert by_u["U6"][1] == "warn" and "22005!" in by_u["U6"][0]
    assert any("something to look at" in t for t, _ in screen)


def test_render_stale_and_no_data():
    m = loaded(now=100.0)
    screen = render(m, 120, 30, 140.0)
    assert any("NO DATA" in t for t, s in screen if s == "err")
    rows = [(t, s) for t, s in screen if t.startswith("U1 ")]
    assert rows and "stale" in rows[0][0] and rows[0][1] == "warn"


def test_render_without_status_and_link_down():
    m = Model()
    screen = render(m, 100, 20, 1.0, "waiting for /dev/ttyACM0 (gone)")
    assert any(t.startswith("Port: waiting") for t, _ in screen)
    assert len(screen) == 20
    screen = render(m, 100, 20, 1.0)
    assert any("Waiting for the board" in t for t, _ in screen)


def test_small_terminal_does_not_crash():
    m = loaded()
    assert len(render(m, 20, 3, 101.0)) == 3
    assert len(render(m, 5, 1, 101.0)) == 1


def test_clock_is_set_only_when_the_board_asks():
    m = Model()
    assert clock_command(m, 0.0, 1000.0) is None
    st = status()
    st["time_set"] = False
    m.feed("S," + json.dumps(st), 1000.0)
    assert clock_command(m, 0.0, 1000.0) == "time 1000"
    assert clock_command(m, 995.0, 1000.0) is None     # sent 5 s ago: wait
    assert clock_command(m, 985.0, 1000.0) == "time 1000"
    st["time_set"] = True
    m.feed("S," + json.dumps(st), 1001.0)
    assert clock_command(m, 0.0, 1002.0) is None
