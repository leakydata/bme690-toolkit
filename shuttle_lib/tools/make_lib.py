"""Write the Shuttle3 KiCad library: symbols and footprints shared by the
carrier boards.

Run with the system Python:  python shuttle_lib/tools/make_lib.py
then  kicad-cli sym upgrade / fp upgrade  bring the files to the current
KiCad format (build_all.py does both).

Sources for every dimension are in shuttle_lib/README.md.
"""

from pathlib import Path

LIB = Path(__file__).resolve().parent.parent
PITCH = 1.27
ROW_GAP = 17.78          # 14 x 1.27, P1 row to P2 row

# Shuttle outlines relative to P1-1, from the Bosch flyers:
# 8x board 20 x 22 mm with pin 1 at 12.5 mm from its far edge,
# single-sensor board 14 x 22 mm with pin 1 at 1.45 mm from its near edge.
SHUTTLE_8X = (-12.55, -2.11, 7.5, 19.89)
SHUTTLE_1X = (-12.55, -2.11, 1.45, 19.89)

# Sullins LPPBxx1NFFN-RC: 2.20 mm wide body, length B, 0.60 mm hole.
SOCKET_W = 2.20
SOCKET_B = {7: 9.29, 9: 11.83}
HOLE = 0.60
PAD = 1.05

P1_NAMES = ["VDD", "VDDIO", "GND", "GPIO0", "GPIO1", "GPIO2/INT1", "GPIO3/INT2"]
P2_NAMES = ["CS", "SCK/SCL", "SDO", "SDI/SDA", "GPIO4", "GPIO5", "GPIO6", "GPIO7", "PROM_RW"]


def f(v):
    text = ("%.4f" % v).rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def line(x1, y1, x2, y2, layer, width=0.12, dash=False):
    kind = "dash" if dash else "solid"
    return '\t(fp_line (start %s %s) (end %s %s) (stroke (width %s) (type %s)) (layer "%s"))\n' % (
        f(x1), f(y1), f(x2), f(y2), f(width), kind, layer)


def rect(x1, y1, x2, y2, layer, width=0.12, dash=False):
    return (line(x1, y1, x2, y1, layer, width, dash) + line(x2, y1, x2, y2, layer, width, dash)
            + line(x2, y2, x1, y2, layer, width, dash) + line(x1, y2, x1, y1, layer, width, dash))


def text(kind, value, x, y, layer, size=1.0, thick=0.15, hide=False, justify=None):
    j = " (justify %s)" % justify if justify else ""
    h = " hide" if hide else ""
    if kind in ("reference", "value"):
        name = "Reference" if kind == "reference" else "Value"
        return '\t(property "%s" "%s" (at %s %s 0) (layer "%s")%s (effects (font (size %s %s) (thickness %s))%s))\n' % (
            name, value, f(x), f(y), layer, " (hide yes)" if hide else "", f(size), f(size), f(thick), j)
    return '\t(fp_text user "%s" (at %s %s 0) (layer "%s")%s (effects (font (size %s %s) (thickness %s))%s))\n' % (
        value, f(x), f(y), layer, h, f(size), f(size), f(thick), j)


def socket_footprint():
    out = []
    out.append('(footprint "Bosch_Shuttle_3.0_Sockets"\n')
    out.append('\t(version 20241229)\n\t(generator "make_lib.py")\n\t(layer "F.Cu")\n')
    out.append('\t(descr "Socket pair for any Bosch Sensortec Shuttle Board 3.0: Sullins LPPB071NFFN-RC (P1, 7 pins) and LPPB091NFFN-RC (P2, 9 pins), 1.27 mm pitch, rows 17.78 mm apart, pin 1 of both rows at the same end. Pads 1-7 = P1-1..P1-7, pads 11-19 = P2-1..P2-9. Outlines on F.Fab: BME690 8x shuttle (20 x 22 mm) and single-sensor shuttle (14 x 22 mm).")\n')
    out.append('\t(tags "Bosch shuttle board 3.0 BME690 socket 1.27mm")\n')
    out.append(text("reference", "J**", -5.08, 8.89, "F.Fab", hide=False))
    out.append(text("value", "Bosch_Shuttle_3.0", -5.08, 10.6, "F.Fab"))
    out.append('\t(attr through_hole)\n')
    # socket bodies, fab and silk
    for row, n, y in (("P1", 7, 0.0), ("P2", 9, ROW_GAP)):
        cx = -(n - 1) * PITCH / 2.0
        half = SOCKET_B[n] / 2.0
        x1, x2 = cx - half, cx + half
        y1, y2 = y - SOCKET_W / 2.0, y + SOCKET_W / 2.0
        out.append(rect(x1, y1, x2, y2, "F.Fab", 0.1))
        out.append(rect(x1 - 0.12, y1 - 0.12, x2 + 0.12, y2 + 0.12, "F.SilkS", 0.15))
        out.append(rect(x1 - 0.37, y1 - 0.37, x2 + 0.37, y2 + 0.37, "F.CrtYd", 0.05))
        # pin 1 marker: a short bar outside the pin-1 end, as on the shuttle
        out.append(line(x2 + 0.45, y - 0.6, x2 + 0.45, y + 0.6, "F.SilkS", 0.2))
        out.append(text("user", row, x2 + 1.55, y, "F.SilkS"))
    # shuttle outlines
    a = SHUTTLE_8X
    out.append(rect(a[0], a[1], a[2], a[3], "F.Fab", 0.1))
    out.append(text("user", "8x shuttle outline", -2.5, 19.2, "F.Fab", size=0.6, thick=0.09))
    b = SHUTTLE_1X
    out.append(rect(b[0], b[1] + 0.2, b[2], b[3] - 0.2, "F.Fab", 0.08, dash=True))
    out.append(text("user", "${REFERENCE}", -5.08, 7.2, "F.Fab"))
    # pads
    for n in range(1, 8):
        out.append(pad(str(n), -(n - 1) * PITCH, 0.0, n == 1))
    for n in range(1, 10):
        out.append(pad(str(10 + n), -(n - 1) * PITCH, ROW_GAP, n == 1))
    # 3D: the generic KiCad 1.27 mm socket models, turned to run along -X
    for n, y in ((7, 0.0), (9, ROW_GAP)):
        out.append('\t(model "${KICAD10_3DMODEL_DIR}/Connector_PinSocket_1.27mm.3dshapes/PinSocket_1x%02d_P1.27mm_Vertical.step"\n' % n)
        out.append('\t\t(offset (xyz 0 %s 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 90)))\n' % f(-y))
    out.append(")\n")
    return "".join(out)


def pad(name, x, y, first):
    if first:
        shape = "roundrect"
        extra = " (roundrect_rratio 0.25)"
    else:
        shape = "circle"
        extra = ""
    return '\t(pad "%s" thru_hole %s (at %s %s) (size %s %s) (drill %s) (layers "*.Cu" "*.Mask")%s)\n' % (
        name, shape, f(x), f(y), f(PAD), f(PAD), f(HOLE), extra)


def sym_pin(kind, name, number, x, y, angle):
    return ('\t\t\t(pin %s line (at %s %s %d) (length 2.54)\n'
            '\t\t\t\t(name "%s" (effects (font (size 1.27 1.27))))\n'
            '\t\t\t\t(number "%s" (effects (font (size 1.27 1.27)))))\n') % (kind, f(x), f(y), angle, name, number)


def sym_prop(name, value, x, y, hide=False, justify=None):
    j = " (justify %s)" % justify if justify else ""
    h = " (hide yes)" if hide else ""
    return '\t\t(property "%s" "%s" (at %s %s 0)%s (effects (font (size 1.27 1.27))%s))\n' % (
        name, value, f(x), f(y), h, j)


def shuttle_symbol():
    out = []
    out.append('\t(symbol "Bosch_Shuttle_3.0" (pin_names (offset 1.016)) (exclude_from_sim no) (in_bom yes) (on_board yes)\n')
    out.append(sym_prop("Reference", "J", 0, 13.97))
    out.append(sym_prop("Value", "Bosch_Shuttle_3.0", 0, -13.97))
    out.append(sym_prop("Footprint", "Shuttle3:Bosch_Shuttle_3.0_Sockets", 0, -16.51, hide=True))
    out.append(sym_prop("Datasheet", "https://www.bosch-sensortec.com/", 0, -19.05, hide=True))
    out.append(sym_prop("Description", "Bosch Sensortec Shuttle Board 3.0 socket pair (P1 7 pins, P2 9 pins, 1.27 mm). Pins 1-7 = P1, 11-19 = P2.", 0, -21.59, hide=True))
    out.append(sym_prop("MPN", "LPPB071NFFN-RC + LPPB091NFFN-RC", 0, -24.13, hide=True))
    out.append(sym_prop("ki_keywords", "Bosch shuttle BME690 BMA580 sensor socket", 0, 0, hide=True))
    out.append('\t\t(symbol "Bosch_Shuttle_3.0_0_1"\n')
    out.append('\t\t\t(rectangle (start -10.16 12.7) (end 10.16 -12.7) (stroke (width 0.254) (type default)) (fill (type background)))\n')
    out.append('\t\t\t(text "P1" (at -7.62 13.97 0) (effects (font (size 1.27 1.27))))\n')
    out.append('\t\t\t(text "P2" (at 7.62 13.97 0) (effects (font (size 1.27 1.27))))\n')
    out.append('\t\t)\n')
    out.append('\t\t(symbol "Bosch_Shuttle_3.0_1_1"\n')
    kinds = ["power_in", "power_in", "power_in", "bidirectional", "bidirectional", "bidirectional", "bidirectional"]
    for i, name in enumerate(P1_NAMES):
        out.append(sym_pin(kinds[i], name, str(i + 1), -12.7, 10.16 - i * 2.54, 0))
    for i, name in enumerate(P2_NAMES):
        out.append(sym_pin("bidirectional", name, str(11 + i), 12.7, 10.16 - i * 2.54, 180))
    out.append('\t\t)\n\t)\n')
    return "".join(out)


def xiao_symbol():
    """Seeed XIAO ESP32-S3, numbered like Seeed's own KiCad symbol and board
    file: 1-7 = D0-D6 down the left, 8-14 = D7, D8, D9, D10, 3V3, GND, 5V up
    the right. Names give the ESP32-S3 GPIO."""
    left = ["D0/GPIO1", "D1/GPIO2", "D2/GPIO3", "D3/GPIO4", "D4/SDA/GPIO5", "D5/SCL/GPIO6", "D6/TX/GPIO43"]
    right = ["D7/RX/GPIO44", "D8/SCK/GPIO7", "D9/MISO/GPIO8", "D10/MOSI/GPIO9", "3V3", "GND", "5V"]
    right_kind = ["bidirectional"] * 4 + ["power_out", "power_in", "power_in"]
    out = []
    out.append('\t(symbol "XIAO_ESP32S3" (pin_names (offset 1.016)) (exclude_from_sim no) (in_bom yes) (on_board yes)\n')
    out.append(sym_prop("Reference", "U", 0, 11.43))
    out.append(sym_prop("Value", "XIAO_ESP32S3", 0, -11.43))
    out.append(sym_prop("Footprint", "Shuttle3:XIAO_ESP32S3_THT", 0, -13.97, hide=True))
    out.append(sym_prop("Datasheet", "https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/", 0, -16.51, hide=True))
    out.append(sym_prop("Description", "Seeed Studio XIAO ESP32-S3 or ESP32-S3 Sense on 2.54 mm headers", 0, -19.05, hide=True))
    out.append('\t\t(symbol "XIAO_ESP32S3_0_1"\n')
    out.append('\t\t\t(rectangle (start -10.16 10.16) (end 10.16 -10.16) (stroke (width 0.254) (type default)) (fill (type background)))\n')
    out.append('\t\t)\n\t\t(symbol "XIAO_ESP32S3_1_1"\n')
    for i, name in enumerate(left):
        out.append(sym_pin("bidirectional", name, str(i + 1), -12.7, 7.62 - i * 2.54, 0))
    for i, name in enumerate(right):
        out.append(sym_pin(right_kind[i], name, str(8 + i), 12.7, -7.62 + i * 2.54, 180))
    out.append('\t\t)\n\t)\n')
    return "".join(out)


def xiao_footprint():
    """Through-hole XIAO footprint for 2.54 mm headers. Geometry from Seeed's
    own board file (XIAO ESP32S3 v1.1 .brd): rows 15.24 mm apart, 2.54 mm
    pitch, board 17.78 x 21.135 mm, pin 1 (D0) 2.92 mm from the USB end.
    Origin at pin 1; pins 1-7 run down (+Y), 8-14 run back up the other row."""
    out = []
    out.append('(footprint "XIAO_ESP32S3_THT"\n')
    out.append('\t(version 20241229)\n\t(generator "make_lib.py")\n\t(layer "F.Cu")\n')
    out.append('\t(descr "Seeed Studio XIAO ESP32-S3 / ESP32-S3 Sense on 2.54 mm pin headers (1x7 female sockets on the carrier). Pad positions from Seeed XIAO ESP32S3 v1.1 board file.")\n')
    out.append('\t(tags "XIAO ESP32S3 Seeed")\n')
    out.append(text("reference", "U**", 7.62, 7.62, "F.Fab"))
    out.append(text("value", "XIAO_ESP32S3", 7.62, 9.4, "F.Fab"))
    out.append('\t(attr through_hole)\n')
    # module outline: x from -1.27 to 16.51, y from -2.92 (USB end) to 18.215
    x1, x2, y1, y2 = -1.27, 16.51, -2.92, 21.135 - 2.92
    out.append(rect(x1, y1, x2, y2, "F.Fab", 0.1))
    out.append(rect(x1 - 0.12, y1 - 0.12, x2 + 0.12, y2 + 0.12, "F.SilkS", 0.15))
    # courtyard: the two 1x7 sockets. The module itself rides 8.5 mm up on
    # them, clear of anything short on the board (e.g. another connector's
    # pin tails); its outline is on F.Fab and F.SilkS.
    for cx in (0.0, 15.24):
        out.append(rect(cx - 1.52, -1.52, cx + 1.52, 6 * 2.54 + 1.52, "F.CrtYd", 0.05))
    # USB-C, which overhangs the module end by about 1.5 mm
    out.append(rect(3.86, y1 - 1.5, 11.38, y1 + 5.5, "F.Fab", 0.1))
    out.append(text("user", "USB", 7.62, y1 + 1.2, "F.SilkS"))
    for i in range(7):
        out.append(xpad(str(i + 1), 0.0, i * 2.54, i == 0))
    for i in range(7):
        out.append(xpad(str(8 + i), 15.24, (6 - i) * 2.54, False))
    # the two 1x7 female sockets the XIAO plugs into
    for x in (0.0, 15.24):
        out.append('\t(model "${KICAD10_3DMODEL_DIR}/Connector_PinSocket_2.54mm.3dshapes/PinSocket_1x07_P2.54mm_Vertical.step"\n')
        out.append('\t\t(offset (xyz %s 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))\n' % f(x))
    out.append(")\n")
    return "".join(out)


def xpad(name, x, y, first):
    shape = "rect" if first else "circle"
    return '\t(pad "%s" thru_hole %s (at %s %s) (size 1.7 1.7) (drill 1.0) (layers "*.Cu" "*.Mask"))\n' % (
        name, shape, f(x), f(y))


def main():
    sym = ['(kicad_symbol_lib (version 20241209) (generator "make_lib.py")\n']
    sym.append(shuttle_symbol())
    sym.append(xiao_symbol())
    sym.append(")\n")
    (LIB / "Shuttle3.kicad_sym").write_text("".join(sym), newline="\n")
    pretty = LIB / "Shuttle3.pretty"
    pretty.mkdir(exist_ok=True)
    (pretty / "Bosch_Shuttle_3.0_Sockets.kicad_mod").write_text(socket_footprint(), newline="\n")
    (pretty / "XIAO_ESP32S3_THT.kicad_mod").write_text(xiao_footprint(), newline="\n")
    print("wrote", LIB)


if __name__ == "__main__":
    main()
