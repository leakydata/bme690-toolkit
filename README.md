# bme690-toolkit

Open tooling for Bosch's **BME690** and **BME688** gas sensors on Linux —
capture data, feed it to BME AI-Studio, and train models to recognise smells.

Bosch make excellent sensors and ship almost no usable software with them. The
shuttle boards arrive empty, AI-Studio is Windows-only and hard to even find,
and the file format that connects a capture to the training tool is
undocumented. This repository fills those gaps.

> Not affiliated with, endorsed by, or supported by Bosch Sensortec GmbH.

## What's here

| | |
|---|---|
| **[`bme690` CLI](python/)** | Reads all eight sensors on a BME690 8x shuttle over USB and writes AI-Studio-importable files |
| **[BME Studio](studio/)** | Browser app, an open alternative to BME AI-Studio: import, explore, label and train, with honest test scores and live predictions over USB. [Open it](https://leakydata.github.io/bme690-toolkit/studio/) |
| **[Python lab](python/LAB.md)** | `bme690.lab` for researchers with a GPU: pandas data loading, honest cross-validation, deep models across all sensors and over time, self-supervised pre-training, models back to BME Studio. Notebooks included |
| **[`.bmerawdata` format spec](docs/bmerawdata-format.md)** | The undocumented format AI-Studio imports, reverse-engineered and verified |
| **[Wiring guide](docs/wiring.md)** | Shuttle board and microSD to an ESP32-S3 DevKitC-1: diagram, pin tables with header positions, and the wiring check |
| **[Hardware notes](docs/hardware-notes.md)** | AB3.1 + shuttle pinout, flash layout, and the traps that cost days |
| **[AI-Studio on Linux](scripts/rebuild-aistudio-linux.sh)** | Turns Bosch's Windows release into a native Linux install |
| **[ESP32-S3 firmware](firmware/bme690-logger-idf/)** | Runs the shuttle from a cheap ESP32-S3 with no Application Board: records AI-Studio files to SD, WiFi dashboard, plain-English wiring diagnosis |

## Quick start

**No Application Board?** Wire the shuttle to an ESP32-S3 DevKitC and install
the firmware from your browser at
**[leakydata.github.io/bme690-toolkit](https://leakydata.github.io/bme690-toolkit/)**,
with nothing to install. That is the easiest way in, and what most people
should use. Details are in
[firmware/bme690-logger-idf](firmware/bme690-logger-idf/).

The rest of this section drives the shuttle on Bosch's Application Board 3.1
from a PC.

Hardware: a **BME690 8x shuttle board** on a **Bosch Application Board 3.1**,
running the stock `coines_bridge` firmware (how it ships), connected by USB.

```bash
git clone https://github.com/leakydata/bme690-toolkit
cd bme690-toolkit
python3 -m venv .venv && . .venv/bin/activate
pip install -e "python/[board]"

bme690 info      # board, firmware, all eight sensor IDs
bme690 read -n 5 # live readings from every sensor
```

You should see something like:

```
Board            : 0x9 (Application Board 3.1)
Shuttle          : 0x57
Firmware         : v1.8.6
Sensors detected : 8 -> [0, 1, 2, 3, 4, 5, 6, 7]
  sensor 0: chip 0x61  variant 2  uid 0xd737182e
  ...
```

Add yourself to the `dialout` group if the board is not reachable.

## Recording data for AI-Studio

```bash
# a labelled run: 5 min with the sample present, then 5 min of clean air
bme690 record -o coffee.bmerawdata --labels "coffee:300,air:300"
```

This writes `coffee.bmerawdata` and `coffee.bmelabelinfo`. In AI-Studio:
**Import Data → Specimen Raw Data**. The labelled segments arrive as named
specimens, ready to assign to classes and train on.

Defaults match Bosch's standard scanning setup: heater profile **HP-354**
(ten steps, 140 ms time base, 10.78 s per cycle), continuous duty cycle.

### Stabilise new sensors first

Factory-new sensors drift badly — gas resistance can move several-fold in
minutes. Bosch recommend at least 12 hours of stabilisation before any
training data is worth collecting:

```bash
bme690 burn-in --hours 12
```

Run it under `tmux`, somewhere with clean, still air.

## Commands

```
bme690 info                  board, firmware, sensor IDs
bme690 scan                  which sensor sockets answer
bme690 read -n 5 -i 2        forced-mode measurements
bme690 profiles              heater and duty cycle profiles AI-Studio knows
bme690 record -o F [...]     record a scan to .bmerawdata
bme690 burn-in --hours 12    stabilise the sensors
bme690 ingest -o F --port P  convert the ESP32-S3 logger's USB output to .bmerawdata
```

### Two capture paths, one file format

| path | hardware | command |
|---|---|---|
| USB, host-driven | shuttle on an Application Board 3.1 | `bme690 record` |
| standalone firmware | shuttle on an ESP32-S3 | none: files are written to the SD card; or `bme690 ingest` over USB |

Both produce identical `.bmerawdata`, so captures from either import into the
same AI-Studio project.

```bash
# stream from the ESP32-S3 logger straight into a labelled capture
bme690 ingest --port /dev/ttyUSB0 -o coffee.bmerawdata --labels "coffee:300,air:300"

# or convert a log you captured earlier
cat /dev/ttyUSB0 > run.txt
bme690 ingest --from-file run.txt -o coffee.bmerawdata
```

`profiles` reads its catalogue from an AI-Studio installation, or from
`--config-dir` pointing at a directory holding `heater_profiles.json` and
`duty_cycle_profiles.json`.

## How it works

The Application Board 3.1 ships running Bosch's **COINES bridge firmware**,
which lets a host drive the shuttle board's SPI bus over USB. `bme690` talks
to it through the `coinespy` package, so **no reflashing is needed**.

- `device.py` — a Python port of Bosch's `bme69x.c` (float compensation path)
- `board.py` — the eight sensors and their SPI chip-selects
- `recorder.py` — parallel-mode scanning, where each sensor walks its ten-step
  heater profile autonomously and tags every result with the step index
- `rawdata.py` — the `.bmerawdata` / `.bmelabelinfo` writer

Two things that will bite you if you write your own: **coinespy takes volts,
not millivolts**, and **the SPI bus must be configured before the supply is
switched on**. Both are explained in [hardware notes](docs/hardware-notes.md);
`AppBoard31.open()` handles them.

## BME AI-Studio on Linux

AI-Studio is an Electron app, so its application code is portable JavaScript.
Only three native modules are Windows-specific — `better-sqlite3`, `sqlite3`
and `@tensorflow/tfjs-node`. Swap in Linux builds of the same versions, pair
with a Linux Electron 19.1.9 runtime, and it runs natively: project database,
TensorFlow training, BSEC export, all of it. No Wine.

```bash
scripts/rebuild-aistudio-linux.sh /path/to/bme_ai_studio_desktop_v3-1-0_win2
```

You supply Bosch's Windows release; the script contains no Bosch code.

## Which board is which

| board | interface | tooling |
|---|---|---|
| **BME690 8x shuttle** on an ESP32-S3 DevKitC | SD card, WiFi dashboard, USB | [firmware/bme690-logger-idf](firmware/bme690-logger-idf/) |
| **BME690 8x shuttle** on Application Board 3.1 | USB (COINES bridge) | `bme690`, this repo |
| **BME688 Development Kit** (8 sensors on ESP32) | SD card + BLE | AI-Studio board config + Bosch's mobile app |

The ESP32 dev kit runs its own autonomous firmware and is not driven by this
tool. Both produce `.bmerawdata`, so their data sits side by side in one
AI-Studio project — useful for cross-checking one sensor generation against
the other.

## Roadmap

The ESP32-S3 firmware does what the Application Board was meant to do:

- [x] Standalone scan, logging `.bmerawdata` to an SD card
- [x] Button and RGB LED: next sample label, start/stop
- [x] Retrieval by card reader or WiFi download
- [x] Heater profiles and duty cycles from AI-Studio `.bmeconfig` files
- [x] Wiring and sensor diagnosis in plain English
- [x] Built-in burn-in (Bosch HP-001)
- [x] Flash from the browser, so no toolchain is needed
- [ ] Battery operation
- [ ] BLE service and a phone app for field capture

`firmware/bme690-logger` is an earlier Zephyr build for a bare nRF52840. It is
no longer maintained and is kept for reference.

## Licensing

MIT, but it builds on Bosch software that is not. See
**[THIRD_PARTY.md](THIRD_PARTY.md)** — in short: the COINES SDK is fetched
rather than vendored, `coinespy` comes from PyPI, and BSEC and AI-Studio are
never distributed here.

```bash
scripts/setup-coines.sh   # needed only to build firmware
```

## Contributing

Issues and pull requests welcome — especially reports from other hardware
combinations. If you have a BME690 shuttle with a different EEPROM id, or an
AB3.1 with different firmware, please open an issue with `bme690 info` output.
