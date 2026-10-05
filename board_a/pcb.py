"""Board A layout. Coordinates are mm from shuttle pin P1-1.

The shuttle sits over x -12.55..7.5, y -2.11..19.89 (8x board; the
single-sensor board fits inside). Everything under it is low SMD parts;
the 2x8 header and the IDD pins sit outside it so wires and a meter can
reach them with the shuttle plugged in.
"""

import sys
from pathlib import Path

import pcbnew

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "shuttle_lib" / "tools"))

import build  # noqa: E402
from pcbgen import Builder, run_drc  # noqa: E402

PLACE = {
    # ref: (x, y, rotation)
    "J1": (0.0, 0.0, 0),
    "J2": (10.16, 0.0, 0),
    "J3": (10.16, 21.6, 90),
    "JP1": (6.6, 21.6, 0),
    "JP2": (4.4, 8.9, 90),
    "JP3": (-3.81, 11.0, 90),
    "JP4": (-1.27, 11.0, 90),
    "R1": (-3.81, 14.6, 90),
    "R2": (-1.27, 14.6, 90),
    "R3": (-10.16, 14.6, 90),
    "R4": (1.6, 14.6, 90),
    "C1": (0.6, 3.0, 90),
    "C2": (0.6, 6.2, 90),
    "C3": (-2.5, 3.0, 90),
    "C4": (-2.5, 6.2, 90),
}

OUTLINE = (-11.9, -3.0, 17.4, 23.2)

LEGEND = [
    "BREAKOUT A  rev 1",
    "3.3 V ONLY",
    "SCK=SCL  SDI=SDA",
    "ID = PROM_RW",
    "0-7 = GPIO0-7",
    "CUT SDA/SCL: no",
    "4.7k pull-ups",
    "CUT TIE: own VIO",
    "CUT IDD: meter J3",
]


def build_pcb(route=True):
    pcb_path = HERE / (build.NAME + ".kicad_pcb")
    b = Builder(pcb_path, build.NAME)
    b.apply_rules(build.RULES)
    parts = {p.ref: p for p in build.parts()}
    for ref, (x, y, rot) in PLACE.items():
        b.place(parts[ref], x, y, rot)
    b.outline(*OUTLINE, radius=1.0)
    # the header outlines would collide with the pin labels, which show
    # orientation anyway
    for ref in ("J2", "J3"):
        b.strip_silk(ref)

    # header labels on both sides, so the header can be fitted either way:
    # GPIO numbers next to the odd column, names after the even one
    # (mirrored back-side text is anchored at its other end)
    for layer, just in ((pcbnew.F_SilkS, "left"), (pcbnew.B_SilkS, "right")):
        for r in range(8):
            b.text(str(r), 8.65, 2.54 * r, layer=layer)
            b.text(build.HEADER_LABELS[r], 13.85, 2.54 * r, layer=layer, just=just)
        b.text("IDD", 13.85, 21.6, layer=layer, just=just)
        # pin 1 of the 2x8, for orienting a ribbon-cable socket
        b.dot(10.16, -1.65, layer=layer)
    b.text("IDD", 5.0, 21.6, just="right")
    b.text("TIE", 6.2, 8.9, rot=90)
    b.text("SDA", -3.81, 8.0, rot=90)
    b.text("SCL", -1.27, 8.0, rot=90)
    for i, line in enumerate(LEGEND):
        b.text(line, -2.2, 2.2 + i * 1.6, layer=pcbnew.B_SilkS, size=1.0)

    b.save()
    if route:
        print(b.autoroute(passes=200)[-600:])
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        b.zone("GND", layer)
    b.fill()
    b.save()
    print(run_drc(pcb_path, HERE / "drc.rpt"))
    return b


if __name__ == "__main__":
    build_pcb(route="--noroute" not in sys.argv)
