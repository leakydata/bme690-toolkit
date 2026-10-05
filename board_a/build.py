"""Board A: Bosch Shuttle Board 3.0 to 2.54 mm (Dupont) breakout.

Builds board_a.kicad_sch and board_a.kicad_pcb from the parts list below.
This script made the first version of the design; once you edit the files
in KiCad, edit them there rather than re-running it.

    python board_a/build.py sch      schematic + ERC
    python board_a/build.py pcb      placement, autoroute, zones + DRC
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "shuttle_lib" / "tools"))

from kigen import Part, write_lib_tables, write_project, write_schematic, netclass  # noqa: E402

NAME = "board_a"

R0603 = "Resistor_SMD:R_0603_1608Metric"
C0603 = "Capacitor_SMD:C_0603_1608Metric"
SJ = "Jumper:SolderJumper-2_P1.3mm_Bridged_RoundedPad1.0x1.5mm"

# The 2x8 header. Odd pins (the column next to the shuttle) carry the
# shuttle's GPIO0-7 in order; even pins carry power and the bus.
HEADER_EVEN = ["VDDIO", "VDD_IN", "GND", "SCK", "SDO", "SDI", "CS", "PROM"]
HEADER_LABELS = ["VIO", "VDD", "GND", "SCK", "SDO", "SDI", "CS", "ID"]


def parts():
    header = {}
    for r in range(8):
        header[str(2 * r + 1)] = "GPIO%d" % r
        header[str(2 * r + 2)] = HEADER_EVEN[r]
    return [
        Part("J1", "Shuttle3:Bosch_Shuttle_3.0", "Shuttle 3.0 sockets", "Shuttle3:Bosch_Shuttle_3.0_Sockets",
             {"1": "VDD", "2": "VDDIO", "3": "GND", "4": "GPIO0", "5": "GPIO1", "6": "GPIO2", "7": "GPIO3",
              "11": "CS", "12": "SCK", "13": "SDO", "14": "SDI", "15": "GPIO4", "16": "GPIO5",
              "17": "GPIO6", "18": "GPIO7", "19": "PROM"},
             mpn="Sullins LPPB071NFFN-RC + LPPB091NFFN-RC", note="hand solder", at=(76.2, 88.9)),
        Part("J2", "Connector_Generic:Conn_02x08_Odd_Even", "2x8 header", "Connector_PinHeader_2.54mm:PinHeader_2x08_P2.54mm_Vertical",
             header, mpn="2x8 male header 2.54 mm", note="hand solder", at=(162.56, 88.9)),
        Part("J3", "Connector_Generic:Conn_01x02", "IDD meter", "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
             {"1": "VDD_IN", "2": "VDD"}, mpn="1x2 male header 2.54 mm", note="hand solder, optional", at=(162.56, 121.92)),
        Part("JP1", "Jumper:SolderJumper_2_Bridged", "IDD", SJ, {"1": "VDD_IN", "2": "VDD"}, at=(124.46, 134.62), in_bom=False),
        Part("JP2", "Jumper:SolderJumper_2_Bridged", "TIE", SJ, {"1": "VDD_IN", "2": "VDDIO"}, at=(124.46, 147.32), in_bom=False),
        Part("JP3", "Jumper:SolderJumper_2_Bridged", "SDA pull-up", SJ, {"1": "VDDIO", "2": "PU_SDA"}, at=(40.64, 134.62), in_bom=False),
        Part("R1", "Device:R", "4.7k", R0603, {"1": "PU_SDA", "2": "SDI"}, lcsc="C23162", at=(55.88, 134.62)),
        Part("JP4", "Jumper:SolderJumper_2_Bridged", "SCL pull-up", SJ, {"1": "VDDIO", "2": "PU_SCL"}, at=(40.64, 147.32), in_bom=False),
        Part("R2", "Device:R", "4.7k", R0603, {"1": "PU_SCL", "2": "SCK"}, lcsc="C23162", at=(55.88, 147.32)),
        Part("R3", "Device:R", "1k", R0603, {"1": "VDDIO", "2": "PROM"}, lcsc="C21190", at=(71.12, 147.32)),
        Part("R4", "Device:R", "10k", R0603, {"1": "VDDIO", "2": "CS"}, lcsc="C25804", at=(83.82, 147.32)),
        Part("C1", "Device:C", "100nF", C0603, {"1": "VDD", "2": "GND"}, lcsc="C14663", at=(96.52, 134.62)),
        Part("C2", "Device:C", "10uF", C0603, {"1": "VDD", "2": "GND"}, lcsc="C19702", at=(106.68, 134.62)),
        Part("C3", "Device:C", "100nF", C0603, {"1": "VDDIO", "2": "GND"}, lcsc="C14663", at=(96.52, 147.32)),
        Part("C4", "Device:C", "10uF", C0603, {"1": "VDDIO", "2": "GND"}, lcsc="C19702", at=(106.68, 147.32)),
    ]


NOTES = [
    ("Board A: Bosch Shuttle Board 3.0 to 2.54 mm header. 3.3 V only, never 5 V.\n"
     "J2 odd pins 1-15 = shuttle GPIO0-7 (on the BME690 8x shuttle these are the eight chip selects).\n"
     "J2 even pins: 2 VDDIO, 4 VDD, 6 GND, 8 SCK/SCL, 10 SDO, 12 SDI/SDA, 14 CS, 16 PROM_RW (shuttle ID chip).", 25.4, 22.86),
    ("Solder jumpers, all closed as made:\n"
     "JP1 IDD: cut it and put a meter across J3 to measure the sensor's VDD current.\n"
     "JP2 TIE: VDD and VDDIO from one supply. Cut it to feed VDDIO separately on J2-2.\n"
     "JP3 / JP4: 4.7k I2C pull-ups on SDA / SCL. Cut to remove them (e.g. for SPI or when the host has its own).", 25.4, 160.02),
    ("R3 1k: PROM_RW pull-up for the DS28E05 1-Wire ID chip. Its datasheet allows 300-1500 ohm at 3.3 V\n"
     "(4.7k is too weak). The DS28E05 talks at 1-Wire overdrive speed only.\n"
     "R4 10k: CS pull-up so single-sensor shuttles start in I2C mode. Drive CS low for SPI.", 25.4, 177.8),
]


def flags():
    # PWR_FLAGs tell ERC these nets are supplied from the header
    return [("VDDIO", 175.26, 50.8), ("VDD_IN", 190.5, 50.8), ("VDD", 205.74, 50.8), ("GND", 220.98, 50.8)]


def build_sch():
    write_lib_tables(HERE)
    write_project(HERE / (NAME + ".kicad_pro"), NAME, RULES, CLASSES, PATTERNS)
    write_schematic(HERE / (NAME + ".kicad_sch"), NAME, parts(),
                    "Board A - Shuttle 3.0 breakout", notes=NOTES, flags=flags(),
                    comments=["Bosch Shuttle Board 3.0 to 2.54 mm header",
                              "github.com/leakydata/bme690-toolkit"])


# JLCPCB 2-layer standard capabilities (jlcpcb.com/capabilities, Oct 2026),
# with margin: 0.15 mm clearance and track, 0.3 mm drill, 0.6 mm vias.
RULES = {
    "min_clearance": 0.15,
    "min_track_width": 0.15,
    "min_connection": 0.15,
    "min_via_diameter": 0.5,
    "min_via_annular_width": 0.13,
    "min_through_hole_diameter": 0.3,
    "min_hole_to_hole": 0.5,
    "min_hole_clearance": 0.25,
    "min_copper_edge_clearance": 0.3,
    "min_silk_clearance": 0.0,
    "min_text_height": 1.0,
    "min_text_thickness": 0.15,
    "solder_mask_to_copper_clearance": 0.0,
    "min_microvia_diameter": 0.2,
    "min_microvia_drill": 0.1,
    "min_resolved_spokes": 1,
    "allow_blind_buried_vias": False,
    "allow_microvias": False,
}
CLASSES = [netclass("Default", 0.15, 0.2), netclass("Power", 0.15, 0.4)]
PATTERNS = [("/VDD*", "Power"), ("/GND", "Power")]


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "sch"
    if step == "sch":
        build_sch()
        print("schematic written")
    elif step == "pcb":
        from pcb import build_pcb
        build_pcb()
