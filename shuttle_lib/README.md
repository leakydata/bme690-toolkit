# Shuttle3 KiCad library

Parts shared by the carrier boards (`board_a/`, `board_b/`). Every board
project loads this library through its own `sym-lib-table` and
`fp-lib-table`, as `Shuttle3`.

| item | what it is |
|---|---|
| symbol `Bosch_Shuttle_3.0` | the 16 shuttle pins. Pins 1-7 are P1-1..P1-7, pins 11-19 are P2-1..P2-9 |
| footprint `Bosch_Shuttle_3.0_Sockets` | both sockets in one footprint, so the row spacing can't drift |
| symbol `XIAO_ESP32S3` | Seeed XIAO ESP32-S3, numbered like Seeed's own library, with the GPIO in each pin name |
| footprint `XIAO_ESP32S3_THT` | the XIAO on 2.54 mm headers (Board B) |

## Shuttle socket footprint

- **Pads:** origin at P1-1, with P1 running along -X and P2 parallel to it,
  17.78 mm away in +Y. Pin 1 of both rows is at the same end, which
  matches Bosch's top view.
- **Parts:** one 7-pin socket and one 9-pin socket, so a shuttle can't go
  in rotated.
- **F.Fab outlines:** both shuttle outlines, for clearance checks. The 8x
  board is 20 x 22 mm; the single-sensor board is 14 x 22 mm.

| dimension | value | source |
|---|---|---|
| pin pitch | 1.27 mm | Bosch shuttle flyers (BMA580, BME690, BME690 8x) |
| row spacing | 17.78 mm (14 x 1.27) | the same three flyers |
| shuttle pins | 0.4 mm square, 3 mm below the plastic | Bosch flyers |
| 8x shuttle outline | 20 x 22 mm, pin 1 12.5 mm from the far edge | `bst-bme690-sf001` drawing, measured |
| single shuttle outline | 14 x 22 mm, pin 1 1.45 mm from the near edge | `bst-bme690-sf000` drawing, measured |
| sockets | Sullins LPPB071NFFN-RC (7) and LPPB091NFFN-RC (9) | Sullins catalogue p. 96-97 |
| socket body | 2.20 mm wide, 4.50 mm tall; 9.29 / 11.83 mm long | Sullins catalogue |
| hole | 0.60 mm drill (Sullins recommends 0.60 +/- 0.05), 1.05 mm pad | Sullins catalogue |

The annular ring is 0.225 mm. That's above JLCPCB's 0.18 mm minimum but
below their 0.25 mm recommendation; 1.27 mm pitch leaves no room for more.

## XIAO footprint

The geometry comes from Seeed's own board file (`XIAO ESP32S3 v1.1 .brd`):

- rows 15.24 mm apart at 2.54 mm pitch
- module 17.78 x 21.135 mm
- pin 1 (D0) 2.92 mm from the USB end

Holes are 1.0 mm for standard square header pins.

## Rebuilding

`tools/make_lib.py` wrote these files; `kicad-cli sym upgrade` /
`fp upgrade` bring them to the current KiCad format. The other scripts in
`tools/` build the board projects:

| script | job |
|---|---|
| `kigen.py` | schematic and project files |
| `pcbgen.py` | placement, Freerouting, zones, DRC and JLCPCB outputs |
| `sexpr.py` | reads and writes KiCad files |

Freerouting is expected at `~/.local/share/freerouting/freerouting-2.4.1.jar`
(set `FREEROUTING_JAR` to override).
