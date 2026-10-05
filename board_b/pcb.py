"""Board B layout. Coordinates are mm from shuttle pin P1-1, seen from the
top (shuttle) side.

The shuttle sits on top over x -12.55..7.5, y -2.11..19.89. The XIAO plugs
in underneath, its USB end towards P1. Its pin columns (x 3.34 and -11.9)
sit just outside the ends of the shuttle's socket rows, so the 2.54 mm
and 1.27 mm socket pins never meet. The SMD parts sit between the XIAO
columns, under the shuttle. The IDD meter pins are on the right, clear of
both modules.
"""

import sys
from pathlib import Path

import pcbnew

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "shuttle_lib" / "tools"))

import build  # noqa: E402
from pcbgen import Builder, export_fab, run_drc  # noqa: E402

PLACE = {
    # ref: (x, y, rotation, side)
    "J1": (0.0, 0.0, 0, "top"),
    "U1": (2.94, 1.27, 0, "bottom"),
    "J3": (10.0, 7.6, 0, "top"),
    "JP1": (6.8, 8.9, 90, "top"),
    "JP2": (0.6, 10.8, 270, "top"),
    "JP5": (-8.6, 14.8, 0, "top"),
    "JP3": (-5.3, 11.4, 90, "top"),
    "JP4": (-2.4, 11.4, 90, "top"),
    "R1": (-5.3, 14.8, 90, "top"),
    "R2": (-2.4, 14.8, 90, "top"),
    "R3": (-7.4, 11.0, 90, "top"),
    "R4": (1.0, 14.8, 90, "top"),
    "C1": (0.6, 3.0, 90, "top"),
    "C2": (0.6, 6.0, 90, "top"),
    "C3": (-2.5, 3.0, 90, "top"),
    "C4": (-2.5, 6.0, 90, "top"),
}

OUTLINE = (-14.1, -3.4, 11.4, 21.2)

LEGEND = [
    "BOARD B r1",
    "XIAO ESP32S3",
    "3.3 V ONLY",
    "D0-7 CS U1-8",
    "D8-10 = SPI",
    "JP2 JP5:",
    "1-2 = 8x",
    "2-3 = CS/ID",
]


def build_pcb(route=True):
    pcb_path = HERE / (build.NAME + ".kicad_pcb")
    b = Builder(pcb_path, build.NAME)
    b.apply_rules(build.RULES)
    parts = {p.ref: p for p in build.parts()}
    for ref, (x, y, rot, side) in PLACE.items():
        b.place(parts[ref], x, y, rot, side=side)
    b.outline(*OUTLINE, radius=1.0)
    b.strip_silk("J3")
    # the socket footprint's P1/P2 labels would sit under XIAO pins here
    b.drop_texts("J1", ("P1", "P2"))
    b.drop_texts("U1", ("USB",))
    b.text("P1", -9.9, 0.0)
    b.text("P2", 2.6, 18.9)

    b.text("IDD", 10.0, 5.6)
    b.text("IDD", 5.1, 8.9, rot=90)
    b.text("SDA", -5.3, 8.65, rot=90)
    b.text("SCL", -2.4, 8.65, rot=90)
    b.text("D0", 0.6, 7.85)
    b.text("D7", -7.6, 13.2)
    for i, line in enumerate(LEGEND):
        b.text(line, -4.7, 2.6 + i * 1.8, layer=pcbnew.B_SilkS, size=1.0)
    b.text("IDD", 10.0, 5.6, layer=pcbnew.B_SilkS)
    b.text("USB", -4.7, -2.55, layer=pcbnew.B_SilkS)
    b.text("JLCJLCJLCJLC", -4.7, 20.4, layer=pcbnew.B_SilkS, size=1.0)

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
    if "--fab" in sys.argv:
        export_fab(HERE / (build.NAME + ".kicad_pcb"), HERE / (build.NAME + ".kicad_sch"), HERE / "fab", build.NAME)
    else:
        build_pcb(route="--noroute" not in sys.argv)
