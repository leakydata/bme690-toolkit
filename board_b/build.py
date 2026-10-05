"""Board B: Seeed XIAO ESP32-S3 (or ESP32-S3 Sense) carrier for a Bosch
Shuttle Board 3.0. The shuttle plugs in on top; the XIAO plugs into two
1x7 female sockets underneath.

Builds board_b.kicad_sch and board_b.kicad_pcb from the parts list below.
This script made the first version of the design; once you edit the files
in KiCad, edit them there rather than re-running it.

    python board_b/build.py sch      schematic + ERC
    python board_b/build.py pcb      placement, autoroute, zones + DRC
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "shuttle_lib" / "tools"))

from kigen import Part, write_lib_tables, write_project, write_schematic, netclass  # noqa: E402

NAME = "board_b"

R0603 = "Resistor_SMD:R_0603_1608Metric"
C0603 = "Capacitor_SMD:C_0603_1608Metric"
SJ2 = "Jumper:SolderJumper-2_P1.3mm_Bridged_RoundedPad1.0x1.5mm"
SJ3 = "Jumper:SolderJumper-3_P1.3mm_Bridged12_RoundedPad1.0x1.5mm"


def parts():
    return [
        Part("J1", "Shuttle3:Bosch_Shuttle_3.0", "Shuttle 3.0 sockets", "Shuttle3:Bosch_Shuttle_3.0_Sockets",
             {"1": "VDD", "2": "3V3", "3": "GND", "4": "SH_GPIO0", "5": "GPIO1", "6": "GPIO2", "7": "GPIO3",
              "11": "CS", "12": "SCK", "13": "SDO", "14": "SDI", "15": "GPIO4", "16": "GPIO5",
              "17": "GPIO6", "18": "SH_GPIO7", "19": "PROM"},
             mpn="Sullins LPPB071NFFN-RC + LPPB091NFFN-RC", at=(76.2, 88.9)),
        # D0-D7 are the 8x shuttle's chip selects, D8-D10 the SPI bus
        Part("U1", "Shuttle3:XIAO_ESP32S3", "XIAO ESP32S3", "Shuttle3:XIAO_ESP32S3_THT",
             {"1": "D0", "2": "GPIO1", "3": "GPIO2", "4": "GPIO3", "5": "GPIO4", "6": "GPIO5", "7": "GPIO6",
              "8": "D7", "9": "SCK", "10": "SDO", "11": "SDI", "12": "3V3", "13": "GND", "14": None},
             mpn="2x Sullins PPTC071LFBN-RC (1x7 female 2.54 mm, 8.5 mm) for a Seeed XIAO ESP32S3 / Sense",
             at=(165.1, 88.9)),
        Part("JP2", "Jumper:SolderJumper_3_Bridged12", "D0 select", SJ3,
             {"1": "SH_GPIO0", "2": "D0", "3": "CS"}, at=(119.38, 124.46), in_bom=False),
        Part("JP5", "Jumper:SolderJumper_3_Bridged12", "D7 select", SJ3,
             {"1": "SH_GPIO7", "2": "D7", "3": "PROM"}, at=(144.78, 124.46), in_bom=False),
        Part("J3", "Connector_Generic:Conn_01x02", "IDD meter", "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
             {"1": "3V3", "2": "VDD"}, mpn="1x2 male header 2.54 mm", at=(165.1, 129.54)),
        Part("JP1", "Jumper:SolderJumper_2_Bridged", "IDD", SJ2, {"1": "3V3", "2": "VDD"}, at=(124.46, 147.32), in_bom=False),
        Part("JP3", "Jumper:SolderJumper_2_Bridged", "SDA pull-up", SJ2, {"1": "3V3", "2": "PU_SDA"}, at=(40.64, 134.62), in_bom=False),
        Part("R1", "Device:R", "4.7k", R0603, {"1": "PU_SDA", "2": "SDI"}, lcsc="C23162", at=(55.88, 134.62)),
        Part("JP4", "Jumper:SolderJumper_2_Bridged", "SCL pull-up", SJ2, {"1": "3V3", "2": "PU_SCL"}, at=(40.64, 147.32), in_bom=False),
        Part("R2", "Device:R", "4.7k", R0603, {"1": "PU_SCL", "2": "SCK"}, lcsc="C23162", at=(55.88, 147.32)),
        Part("R3", "Device:R", "1k", R0603, {"1": "3V3", "2": "PROM"}, lcsc="C21190", at=(71.12, 147.32)),
        Part("R4", "Device:R", "10k", R0603, {"1": "3V3", "2": "CS"}, lcsc="C25804", at=(83.82, 147.32)),
        Part("C1", "Device:C", "100nF", C0603, {"1": "VDD", "2": "GND"}, lcsc="C14663", at=(96.52, 134.62)),
        Part("C2", "Device:C", "10uF", C0603, {"1": "VDD", "2": "GND"}, lcsc="C19702", at=(106.68, 134.62)),
        Part("C3", "Device:C", "100nF", C0603, {"1": "3V3", "2": "GND"}, lcsc="C14663", at=(96.52, 147.32)),
        Part("C4", "Device:C", "10uF", C0603, {"1": "3V3", "2": "GND"}, lcsc="C19702", at=(106.68, 147.32)),
    ]


NOTES = [
    ("Board B: XIAO ESP32-S3 carrier for a Bosch Shuttle Board 3.0. Shuttle on top, XIAO underneath. 3.3 V only.\n"
     "BME690 8x shuttle: D0-D7 (GPIO1, 2, 3, 4, 5, 6, 43, 44) are the chip selects of sensors U1-U8;\n"
     "D8 SCK (GPIO7), D9 SDO/MISO (GPIO8), D10 SDI/MOSI (GPIO9). The XIAO Sense's microSD card shares\n"
     "D8-D10 (its own CS is GPIO21), so on the 8x board the card and the sensors take turns on one SPI bus.", 25.4, 22.86),
    ("Selector jumpers, set for the 8x shuttle as made (pads 1-2 joined):\n"
     "JP2: D0 -> shuttle GPIO0 (8x: sensor U1 CS). Cut 1-2, bridge 2-3: D0 -> shuttle CS (single-sensor shuttles).\n"
     "JP5: D7 -> shuttle GPIO7 (8x: sensor U8 CS). Cut 1-2, bridge 2-3: D7 -> PROM_RW (shuttle ID chip).\n"
     "JP1 IDD: cut and put a meter across J3 to measure the sensor VDD current.\n"
     "JP3 / JP4: 4.7k I2C pull-ups on SDA / SCL; cut to remove.", 25.4, 160.02),
    ("R3 1k: PROM_RW pull-up for the DS28E05 1-Wire ID chip (datasheet: 300-1500 ohm at 3.3 V,\n"
     "overdrive speed only). R4 10k: CS pull-up so single-sensor shuttles start in I2C mode.\n"
     "VDDIO is tied to the XIAO's 3V3 (its logic level), so there is no TIE jumper on this board.", 25.4, 182.88),
]


def flags():
    return [("VDD", 205.74, 50.8), ("GND", 220.98, 50.8)]


def build_sch():
    write_lib_tables(HERE)
    write_project(HERE / (NAME + ".kicad_pro"), NAME, RULES, CLASSES, PATTERNS)
    write_schematic(HERE / (NAME + ".kicad_sch"), NAME, parts(),
                    "Board B - XIAO ESP32-S3 shuttle carrier", notes=NOTES, flags=flags(),
                    comments=["Seeed XIAO ESP32-S3 / Sense carrier for a Bosch Shuttle Board 3.0",
                              "github.com/leakydata/bme690-toolkit"])


# Same JLCPCB rules as Board A (see board_a/build.py).
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
PATTERNS = [("/VDD", "Power"), ("/3V3", "Power"), ("/GND", "Power")]


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "sch"
    if step == "sch":
        build_sch()
        print("schematic written")
    elif step == "pcb":
        from pcb import build_pcb
        build_pcb()
