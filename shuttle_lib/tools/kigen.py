"""Shared helpers that build a KiCad project from one parts-and-nets
description, so the schematic and the board can never disagree.

A design is a list of Part objects. Each part names its library symbol,
footprint, value, LCSC number and the net on every pin. The schematic gets
one net label per pin; the board gets the same net on every pad.
"""

import json
import uuid
from pathlib import Path

from sexpr import S, Sym, dump, find, find_all, parse

KICAD_SYMBOLS = Path("/usr/share/kicad/symbols")
KICAD_FOOTPRINTS = Path("/usr/share/kicad/footprints")
LIB_DIR = Path(__file__).resolve().parent.parent
NAMESPACE = uuid.UUID("6b1f2f0e-5d1c-4c57-9a0e-8d3b2f1a7c11")


def uid(*parts):
    """Stable UUID, so rebuilding gives the same file."""
    return str(uuid.uuid5(NAMESPACE, "/".join(str(p) for p in parts)))


class Part:
    def __init__(self, ref, lib_id, value, footprint, pins, lcsc="", mpn="", note="",
                 at=(0, 0), fields=None, in_bom=True):
        self.ref = ref
        self.lib_id = lib_id            # "Device:R"
        self.value = value
        self.footprint = footprint      # "Resistor_SMD:R_0603_1608Metric"
        self.pins = pins                # {"1": "NET", ...}
        self.lcsc = lcsc
        self.mpn = mpn
        self.note = note
        self.at = at                    # schematic position, mm
        self.fields = fields or {}
        self.in_bom = in_bom            # False for solder jumpers


# ---------------------------------------------------------------- symbols

_lib_cache = {}


def _library(name):
    if name not in _lib_cache:
        if name == "Shuttle3":
            path = LIB_DIR / "Shuttle3.kicad_sym"
        else:
            path = KICAD_SYMBOLS / (name + ".kicad_sym")
        _lib_cache[name] = parse(path.read_text())
    return _lib_cache[name]


def lib_symbol(lib_id):
    """The symbol definition, renamed "Lib:Name" for a schematic's
    lib_symbols section. Derived symbols are flattened onto their parent."""
    lib, name = lib_id.split(":")
    tree = _library(lib)
    sym = None
    for item in find_all(tree, "symbol"):
        if item[1] == name:
            sym = item
    if sym is None:
        raise KeyError(lib_id)
    ext = find(sym, "extends")
    if ext is not None:
        parent = [x for x in find_all(tree, "symbol") if x[1] == ext[1]][0]
        merged = [Sym("symbol"), name]
        own_props = {p[1]: p for p in find_all(sym, "property")}
        for item in parent[2:]:
            if isinstance(item, list) and item[0] == "property" and item[1] in own_props:
                merged.append(own_props.pop(item[1]))
            elif isinstance(item, list) and item[0] == "symbol":
                merged.append([Sym("symbol"), item[1].replace(ext[1], name, 1)] + item[2:])
            else:
                merged.append(item)
        merged.extend(own_props.values())
        sym = merged
    out = [Sym("symbol"), lib_id] + [x for x in sym[2:]]
    return out


def symbol_pins(lib_id):
    """{number: (x, y, angle)} of each pin's connection point, symbol coords
    (Y up)."""
    sym = lib_symbol(lib_id)
    pins = {}
    for unit in find_all(sym, "symbol"):
        for pin in find_all(unit, "pin"):
            at = find(pin, "at")
            num = find(pin, "number")[1]
            pins[num] = (at[1], at[2], at[3] if len(at) > 3 else 0)
    return pins


# --------------------------------------------------------------- schematic

def _effects(size=1.27, justify=None, hide=False):
    e = S("effects", S("font", S("size", size, size)))
    if justify:
        e.append([Sym("justify")] + [Sym(j) for j in justify.split()])
    if hide:
        e.append(S("hide", Sym("yes")))
    return e


def _prop(name, value, x, y, hide=False, justify=None):
    return S("property", name, value, S("at", x, y, 0), _effects(justify=justify, hide=hide))


def write_schematic(path, project, parts, title, notes=(), flags=(), comments=()):
    """flags: [(net, x, y)] where a PWR_FLAG goes. notes: [(text, x, y)]."""
    root = uid(project, "root")
    sch = S("kicad_sch", S("version", 20250114), S("generator", "kigen"),
            S("generator_version", "9.0"), S("uuid", root), S("paper", "A4"))
    tb = S("title_block", S("title", title), S("date", "2026-10-03"), S("rev", "1"))
    for i, c in enumerate(comments):
        tb.append(S("comment", i + 1, c))
    sch.append(tb)

    used = []
    for p in parts:
        if p.lib_id not in used:
            used.append(p.lib_id)
    if flags and "power:PWR_FLAG" not in used:
        used.append("power:PWR_FLAG")
    libs = S("lib_symbols")
    for lid in used:
        libs.append(lib_symbol(lid))
    sch.append(libs)

    for p in parts:
        x0, y0 = p.at
        pins = symbol_pins(p.lib_id)
        for num, net in p.pins.items():
            px, py, ang = pins[num]
            lx, ly = round(x0 + px, 4), round(y0 - py, 4)
            if net is None:
                sch.append(S("no_connect", S("at", lx, ly), S("uuid", uid(project, p.ref, num, "nc"))))
                continue
            # pin angle is the direction from the connection point into the
            # body; the label points the other way
            if ang == 0:
                la, just = 180, "right bottom"
            elif ang == 180:
                la, just = 0, "left bottom"
            elif ang == 90:
                la, just = 270, "right bottom"
            else:
                la, just = 90, "left bottom"
            sch.append(S("label", net, S("at", lx, ly, la), _effects(justify=just),
                         S("uuid", uid(project, p.ref, num, "label"))))
        sym_uuid = uid(project, p.ref)
        inst = S("symbol", S("lib_id", p.lib_id), S("at", x0, y0, 0), S("unit", 1),
                 S("exclude_from_sim", Sym("no")), S("in_bom", Sym("yes" if p.in_bom else "no")),
                 S("on_board", Sym("yes")), S("dnp", Sym("no")), S("uuid", sym_uuid))
        top = max(-v[1] for v in pins.values()) if pins else 0
        bottom = max(v[1] for v in pins.values()) if pins else 0
        inst.append(_prop("Reference", p.ref, x0 + 2.54, y0 - bottom - 1.27, justify="left"))
        inst.append(_prop("Value", p.value, x0 + 2.54, y0 + top + 1.27, justify="left"))
        inst.append(_prop("Footprint", p.footprint, x0, y0, hide=True))
        inst.append(_prop("Datasheet", "", x0, y0, hide=True))
        if p.lcsc:
            inst.append(_prop("LCSC", p.lcsc, x0, y0, hide=True))
        if p.mpn:
            inst.append(_prop("MPN", p.mpn, x0, y0, hide=True))
        for k, v in p.fields.items():
            inst.append(_prop(k, v, x0, y0, hide=True))
        for num in pins:
            inst.append(S("pin", num, S("uuid", uid(project, p.ref, num, "pin"))))
        inst.append(S("instances", S("project", project, S("path", "/" + root,
                                                           S("reference", p.ref), S("unit", 1)))))
        sch.append(inst)

    for i, (net, x, y) in enumerate(flags):
        sch.append(S("label", net, S("at", x, y, 0), _effects(justify="left bottom"),
                     S("uuid", uid(project, "flaglabel", i))))
        ref = "#FLG%02d" % (i + 1)
        inst = S("symbol", S("lib_id", "power:PWR_FLAG"), S("at", x, y, 0), S("unit", 1),
                 S("exclude_from_sim", Sym("no")), S("in_bom", Sym("yes")),
                 S("on_board", Sym("yes")), S("dnp", Sym("no")), S("uuid", uid(project, ref)))
        inst.append(_prop("Reference", ref, x, y - 3.81, hide=True))
        inst.append(_prop("Value", "PWR_FLAG", x, y - 3.81))
        inst.append(_prop("Footprint", "", x, y, hide=True))
        inst.append(_prop("Datasheet", "", x, y, hide=True))
        inst.append(S("pin", "1", S("uuid", uid(project, ref, "pin"))))
        inst.append(S("instances", S("project", project, S("path", "/" + root,
                                                           S("reference", ref), S("unit", 1)))))
        sch.append(inst)

    for i, (t, x, y) in enumerate(notes):
        sch.append(S("text", t, S("exclude_from_sim", Sym("no")), S("at", x, y, 0),
                     _effects(justify="left top"), S("uuid", uid(project, "note", i))))

    sch.append(S("sheet_instances", S("path", "/", S("page", "1"))))
    sch.append(S("embedded_fonts", Sym("no")))
    Path(path).write_text(dump(sch) + "\n", newline="\n")
    return root


# ------------------------------------------------------------ project files

def write_lib_tables(folder):
    rel = "${KIPRJMOD}/../shuttle_lib/"
    Path(folder, "sym-lib-table").write_text(
        '(sym_lib_table\n\t(version 7)\n\t(lib (name "Shuttle3") (type "KiCad") (uri "%sShuttle3.kicad_sym") (options "") (descr "Bosch Shuttle 3.0 carrier parts"))\n)\n' % rel,
        newline="\n")
    Path(folder, "fp-lib-table").write_text(
        '(fp_lib_table\n\t(version 7)\n\t(lib (name "Shuttle3") (type "KiCad") (uri "%sShuttle3.pretty") (options "") (descr "Bosch Shuttle 3.0 carrier parts"))\n)\n' % rel,
        newline="\n")


def write_project(path, name, rules, classes, patterns):
    """A .kicad_pro holding JLCPCB design rules and net classes."""
    pro = {
        "board": {
            "design_settings": {
                "defaults": {
                    "silk_line_width": 0.15,
                    "silk_text_size_h": 1.0,
                    "silk_text_size_v": 1.0,
                    "silk_text_thickness": 0.15,
                    "copper_line_width": 0.2,
                    "board_outline_line_width": 0.1,
                },
                "rules": rules,
                "rule_severities": {
                    "lib_footprint_issues": "ignore",
                    "lib_footprint_mismatch": "ignore",
                },
                "track_widths": [0.0, 0.2, 0.3, 0.4],
                "via_dimensions": [{"diameter": 0.0, "drill": 0.0}, {"diameter": 0.6, "drill": 0.3}],
            }
        },
        "net_settings": {
            "classes": classes,
            "meta": {"version": 4},
            "netclass_patterns": [{"netclass": c, "pattern": p} for p, c in patterns],
        },
        "meta": {"filename": name + ".kicad_pro", "version": 3},
        "schematic": {"meta": {"version": 1}},
        "sheets": [],
    }
    Path(path).write_text(json.dumps(pro, indent=2) + "\n", newline="\n")


def netclass(name, clearance, track, via=0.6, drill=0.3):
    return {
        "name": name, "clearance": clearance, "track_width": track,
        "via_diameter": via, "via_drill": drill,
        "microvia_diameter": 0.3, "microvia_drill": 0.1,
        "diff_pair_width": 0.2, "diff_pair_gap": 0.25, "diff_pair_via_gap": 0.25,
        "wire_width": 6, "bus_width": 12, "line_style": 0, "pcb_color": "rgba(0, 0, 0, 0.000)",
        "schematic_color": "rgba(0, 0, 0, 0.000)", "priority": 2147483647 if name == "Default" else 0,
    }
