"""Board-building helpers on KiCad's pcbnew Python module (KiCad 10)."""

import os
import subprocess
from pathlib import Path

import pcbnew

from kigen import KICAD_FOOTPRINTS, LIB_DIR, uid

MM = pcbnew.FromMM
FREEROUTING = Path(os.environ.get("FREEROUTING_JAR", str(Path.home() / ".local/share/freerouting/freerouting-2.4.1.jar")))


def pt(x, y):
    return pcbnew.VECTOR2I(MM(x), MM(y))


def footprint_path(lib):
    if lib == "Shuttle3":
        return str(LIB_DIR / "Shuttle3.pretty")
    return str(KICAD_FOOTPRINTS / (lib + ".pretty"))


class Builder:
    def __init__(self, pcb_path, project, origin=(100.0, 100.0)):
        self.path = Path(pcb_path)
        self.project = project
        self.ox, self.oy = origin
        self.board = pcbnew.NewBoard(str(self.path))
        self.nets = {}
        self.fps = {}
        self.netmap = self._netlist()

    def _netlist(self):
        """(ref, pad) -> net name, from the schematic via kicad-cli, so pad
        nets carry exactly the names KiCad gives them (including
        "unconnected-(...)" for no-connect pins)."""
        from sexpr import find, find_all, parse
        sch = self.path.with_suffix(".kicad_sch")
        net = self.path.with_suffix(".net")
        _kicad("sch", "export", "netlist", "-o", str(net), str(sch))
        tree = parse(net.read_text())
        net.unlink()
        out = {}
        for n in find_all(find(tree, "nets"), "net"):
            name = find(n, "name")[1]
            for node in find_all(n, "node"):
                out[(find(node, "ref")[1], find(node, "pin")[1])] = name
        return out

    def xy(self, x, y):
        return pt(self.ox + x, self.oy + y)

    def net(self, name):
        # local schematic labels make sheet-path net names, "/NAME"
        if not name.startswith("/") and not name.startswith("unconnected"):
            name = "/" + name
        if name not in self.nets:
            n = pcbnew.NETINFO_ITEM(self.board, name)
            self.board.Add(n)
            self.nets[name] = n
        return self.nets[name]

    def place(self, part, x, y, rot=0, side="top", show_ref=False):
        lib, name = part.footprint.split(":")
        fp = pcbnew.FootprintLoad(footprint_path(lib), name)
        if fp is None:
            raise RuntimeError("footprint not found: " + part.footprint)
        fp.SetFPID(pcbnew.LIB_ID(lib, name))
        fp.SetReference(part.ref)
        fp.SetValue(part.value)
        fp.SetPath(pcbnew.KIID_PATH("/" + uid(self.project, part.ref)))
        fp.SetSheetname("/")
        fp.SetSheetfile(self.project + ".kicad_sch")
        for key, val in (("LCSC", part.lcsc), ("MPN", part.mpn)):
            if val:
                fp.SetField(key, val)
                fp.GetField(key).SetVisible(False)
        self.board.Add(fp)
        if side == "top":
            fp.Value().SetLayer(pcbnew.F_Fab)
        fp.SetOrientationDegrees(rot)
        fp.SetPosition(self.xy(x, y))
        if side == "bottom":
            # mirror in X about the footprint origin, as when the board is
            # turned over sideways; rotation is applied before the flip
            fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
        fp.Reference().SetVisible(show_ref)
        for pad in fp.Pads():
            name = self.netmap.get((part.ref, pad.GetNumber()))
            if name:
                pad.SetNet(self.net(name))
        self.fps[part.ref] = fp
        return fp

    def strip_silk(self, ref):
        fp = self.fps[ref]
        for item in list(fp.GraphicalItems()):
            if item.GetLayer() in (pcbnew.F_SilkS, pcbnew.B_SilkS):
                fp.Remove(item)

    def drop_texts(self, ref, texts):
        """Remove a footprint's own silkscreen texts, e.g. labels that
        collide with something on this particular board."""
        fp = self.fps[ref]
        for item in list(fp.GraphicalItems()):
            if isinstance(item, pcbnew.PCB_TEXT) and item.GetText() in texts:
                fp.Remove(item)

    def pad_xy(self, ref, num):
        for pad in self.fps[ref].Pads():
            if pad.GetNumber() == num:
                p = pad.GetPosition()
                return (round(pcbnew.ToMM(p.x) - self.ox, 3), round(pcbnew.ToMM(p.y) - self.oy, 3))
        return None

    def outline(self, x1, y1, x2, y2, radius=1.0):
        s = pcbnew.PCB_SHAPE(self.board)
        s.SetShape(pcbnew.SHAPE_T_RECTANGLE)
        s.SetStart(self.xy(x1, y1))
        s.SetEnd(self.xy(x2, y2))
        s.SetCornerRadius(MM(radius))
        s.SetLayer(pcbnew.Edge_Cuts)
        s.SetWidth(MM(0.1))
        self.board.Add(s)
        self.box = (x1, y1, x2, y2)

    def text(self, value, x, y, layer=pcbnew.F_SilkS, size=1.0, thick=0.15, just="center", rot=0):
        t = pcbnew.PCB_TEXT(self.board)
        t.SetText(value)
        t.SetLayer(layer)
        t.SetTextSize(pt(size, size))
        t.SetTextThickness(MM(thick))
        if layer in (pcbnew.B_SilkS, pcbnew.B_Fab):
            t.SetMirrored(True)
        h = {"left": pcbnew.GR_TEXT_H_ALIGN_LEFT, "right": pcbnew.GR_TEXT_H_ALIGN_RIGHT,
             "center": pcbnew.GR_TEXT_H_ALIGN_CENTER}[just]
        t.SetHorizJustify(h)
        t.SetTextAngleDegrees(rot)
        t.SetPosition(self.xy(x, y))
        self.board.Add(t)
        return t

    def dot(self, x, y, layer=pcbnew.F_SilkS, radius=0.35):
        s = pcbnew.PCB_SHAPE(self.board)
        s.SetShape(pcbnew.SHAPE_T_CIRCLE)
        s.SetCenter(self.xy(x, y))
        s.SetEnd(self.xy(x + radius, y))
        s.SetFilled(True)
        s.SetWidth(MM(0.1))
        s.SetLayer(layer)
        self.board.Add(s)
        return s

    def zone(self, net, layer, inset=0.3, chamfer=0.8):
        x1, y1, x2, y2 = self.box
        x1, y1, x2, y2 = x1 + inset, y1 + inset, x2 - inset, y2 - inset
        c = chamfer
        z = pcbnew.ZONE(self.board)
        z.SetLayer(layer)
        z.SetNet(self.net(net))
        ol = z.Outline()
        ol.NewOutline()
        corners = ((x1 + c, y1), (x2 - c, y1), (x2, y1 + c), (x2, y2 - c),
                   (x2 - c, y2), (x1 + c, y2), (x1, y2 - c), (x1, y1 + c))
        for (x, y) in corners:
            ol.Append(MM(self.ox + x), MM(self.oy + y))
        z.SetMinThickness(MM(0.2))
        z.SetLocalClearance(MM(0.25))
        z.SetThermalReliefGap(MM(0.3))
        z.SetThermalReliefSpokeWidth(MM(0.35))
        z.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
        z.SetAssignedPriority(0)
        self.board.Add(z)
        return z

    def apply_rules(self, rules):
        ds = self.board.GetDesignSettings()
        ds.m_MinClearance = MM(rules["min_clearance"])
        ds.m_TrackMinWidth = MM(rules["min_track_width"])
        ds.m_ViasMinSize = MM(rules["min_via_diameter"])
        ds.m_ViasMinAnnularWidth = MM(rules["min_via_annular_width"])
        ds.m_MinThroughDrill = MM(rules["min_through_hole_diameter"])
        ds.m_HoleToHoleMin = MM(rules["min_hole_to_hole"])
        ds.m_HoleClearance = MM(rules["min_hole_clearance"])
        ds.m_CopperEdgeClearance = MM(rules["min_copper_edge_clearance"])
        ds.m_MinSilkTextHeight = MM(rules["min_text_height"])
        ds.m_MinSilkTextThickness = MM(rules["min_text_thickness"])
        ds.m_SilkClearance = MM(rules["min_silk_clearance"])

    def save(self):
        pcbnew.SaveBoard(str(self.path), self.board)

    def autoroute(self, passes=40):
        dsn = self.path.with_suffix(".dsn")
        ses = self.path.with_suffix(".ses")
        if ses.exists():
            ses.unlink()
        if not pcbnew.ExportSpecctraDSN(self.board, str(dsn)):
            raise RuntimeError("DSN export failed")
        cmd = ["java", "-jar", str(FREEROUTING), "-de", str(dsn), "-do", str(ses),
               "-mp", str(passes), "--gui.enabled=false"]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if not ses.exists():
            print(res.stdout[-3000:])
            print(res.stderr[-3000:])
            raise RuntimeError("Freerouting produced no session file")
        if not pcbnew.ImportSpecctraSES(self.board, str(ses)):
            raise RuntimeError("SES import failed")
        dsn.unlink()
        ses.unlink()
        return res.stdout

    def fill(self):
        pcbnew.ZONE_FILLER(self.board).Fill(self.board.Zones())


def run_drc(pcb_path, report):
    cmd = ["kicad-cli", "pcb", "drc", "--schematic-parity", "--severity-all", "-o", str(report), str(pcb_path)]
    res = subprocess.run(cmd, capture_output=True, text=True)
    return res.stdout + res.stderr


# ------------------------------------------------------------ fab outputs

def _kicad(*args):
    res = subprocess.run(["kicad-cli"] + list(args), capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(" ".join(args) + "\n" + res.stdout + res.stderr)
    return res.stdout


def export_fab(pcb_path, sch_path, outdir, name):
    """JLCPCB order files: Gerbers + drill zip, assembly BOM and CPL (parts
    with an LCSC number only), plus a full BOM and PDFs for checking."""
    import csv
    import zipfile

    pcb_path = Path(pcb_path)
    out = Path(outdir)
    gerb = out / "gerbers"
    if gerb.exists():
        for f in gerb.iterdir():
            f.unlink()
    gerb.mkdir(parents=True, exist_ok=True)
    layers = "F.Cu,B.Cu,F.Mask,B.Mask,F.Paste,B.Paste,F.Silkscreen,B.Silkscreen,Edge.Cuts"
    _kicad("pcb", "export", "gerbers", "--layers", layers, "--subtract-soldermask",
           "--check-zones", "--exclude-value", "-o", str(gerb) + "/", str(pcb_path))
    _kicad("pcb", "export", "drill", "--format", "excellon", "--excellon-units", "mm",
           "--drill-origin", "absolute", "--excellon-zeros-format", "decimal",
           "--excellon-oval-format", "alternate", "--generate-map", "--map-format", "pdf",
           "-o", str(gerb) + "/", str(pcb_path))
    zpath = out / (name + "-gerbers.zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(gerb.iterdir()):
            if f.suffix.lower() != ".pdf":
                z.write(f, f.name)

    board = pcbnew.LoadBoard(str(pcb_path))
    rows = []
    for fp in board.GetFootprints():
        def field(key):
            return fp.GetFieldText(key) if fp.HasField(key) else ""
        rows.append({
            "ref": fp.GetReference(), "value": fp.GetValue(),
            "footprint": fp.GetFPID().GetLibItemName().wx_str(),
            "lcsc": field("LCSC"), "mpn": field("MPN"),
            "x": pcbnew.ToMM(fp.GetPosition().x), "y": -pcbnew.ToMM(fp.GetPosition().y),
            "rot": fp.GetOrientationDegrees(),
            "side": "Bottom" if fp.IsFlipped() else "Top",
            "smd": fp.GetAttributes() & pcbnew.FP_SMD != 0,
            "in_bom": not (fp.GetAttributes() & pcbnew.FP_EXCLUDE_FROM_BOM),
        })
    rows.sort(key=lambda r: (r["ref"].rstrip("0123456789"), int("0" + "".join(c for c in r["ref"] if c.isdigit()))))

    asm = [r for r in rows if r["lcsc"]]
    groups = {}
    for r in asm:
        groups.setdefault((r["value"], r["footprint"], r["lcsc"]), []).append(r["ref"])
    with open(out / (name + "-bom-jlcpcb.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Comment", "Designator", "Footprint", "LCSC Part #"])
        for (val, fpn, lcsc), refs in groups.items():
            w.writerow([val, ",".join(refs), fpn, lcsc])
    with open(out / (name + "-cpl-jlcpcb.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
        for r in asm:
            w.writerow([r["ref"], "%.4fmm" % r["x"], "%.4fmm" % r["y"], r["side"], "%g" % (r["rot"] % 360)])
    with open(out / (name + "-bom-full.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Designator", "Value", "Footprint", "LCSC", "MPN", "Fitted by"])
        for r in rows:
            if not r["in_bom"]:
                continue
            who = "JLCPCB" if r["lcsc"] else "you (hand solder)"
            w.writerow([r["ref"], r["value"], r["footprint"], r["lcsc"], r["mpn"], who])

    _kicad("sch", "export", "pdf", "-o", str(out / (name + "-schematic.pdf")), str(sch_path))
    _kicad("pcb", "export", "pdf", "--layers", "F.Cu,F.Silkscreen,Edge.Cuts", "--mode-multipage",
           "--cl", "Edge.Cuts", "-o", str(out / (name + "-layout.pdf")), str(pcb_path))
    return zpath
