# BME690 8x shuttle logger (Zephyr / nRF52840)

Runs all eight BME690s on a **Shuttle Board 3.0** from a plain nRF52840 —
no Bosch Application Board required.

Built and tested against **nRF Connect SDK 2.9.3 / Zephyr 3.7**.

## Why not COINES

Bosch's COINES SDK targets their Application Board and uses the legacy nRF5
SDK with SoftDevice S140 and FreeRTOS. Once you drive the shuttle from your
own nRF52840, none of that applies, and Zephyr is the better base: actively
maintained, with SPI, littlefs, USB and BLE already there.

## Build

```bash
python3 -m venv .zephyrvenv
.zephyrvenv/bin/pip install west -r ~/ncs/zephyr/scripts/requirements-base.txt
export PATH="$PWD/.zephyrvenv/bin:$PATH"
export ZEPHYR_BASE=~/ncs/zephyr

west build -b xiao_ble -p always .
```

If CMake reports `ModuleNotFoundError: No module named 'pykwalify'`, it has
found your system Python rather than the venv — make sure the venv's `bin` is
first on `PATH`.

## Flash

The XIAO has an Adafruit UF2 bootloader: double-tap reset, then copy the
image to the mass-storage device that appears.

```bash
cp build/bme690-logger/zephyr/zephyr.uf2 /media/$USER/XIAO-SENSE/
```

## Wiring

`boards/xiao_ble.overlay` holds the mapping; the pin budget is exact, with
D8-D10 carrying SPI and D0-D7 the eight chip selects.

| shuttle pin | signal | XIAO |
|---|---|---|
| Row 1, pin 1 | Vdd | 3V3 |
| Row 1, pin 2 | VddIO | 3V3 |
| Row 1, pin 3 | Gnd | GND |
| Row 2, pin 2 | SCK | D8 (P1.13) |
| Row 2, pin 3 | SDO → MCU MISO | D9 (P1.14) |
| Row 2, pin 4 | SDI ← MCU MOSI | D10 (P1.15) |
| Row 1, pin 4 | GPIO0 = sensor 0 CS | D0 (P0.02) |
| Row 1, pin 5 | GPIO1 = sensor 1 CS | D1 (P0.03) |
| Row 1, pin 6 | GPIO2 = sensor 2 CS | D2 (P0.28) |
| Row 1, pin 7 | GPIO3 = sensor 3 CS | D3 (P0.29) |
| Row 2, pin 5 | GPIO4 = sensor 4 CS | D4 (P0.04) |
| Row 2, pin 6 | GPIO5 = sensor 5 CS | D5 (P0.05) |
| Row 2, pin 7 | GPIO6 = sensor 6 CS | D6 (P1.11) |
| Row 2, pin 8 | GPIO7 = sensor 7 CS | D7 (P1.12) |

Row 2 pin 9 (PROM-RW) only identifies the shuttle and is not needed.

**A partial build is useful.** Power, the three SPI lines and a single chip
select — seven wires — already proves the shuttle is alive and the bus works.
Add the remaining chip selects one at a time.

## Output

One line per heater step, over USB serial at any baud rate:

```
# sensor,t_ms,temp_C,press_hPa,hum_pct,gas_ohm,step,heat_stable
D,0,10782,33.47,998.78,35.46,234700.90,0,1
D,0,11482,33.44,998.77,35.51,9067.70,1,1
```

Feed it to `bme690-toolkit`'s writer to produce a `.bmerawdata` for AI-Studio.

## Status

Phase 1a: scanning and streaming. Onboard flash logging, buttons, MTP-style
retrieval and BLE are on the roadmap in the top-level README.
