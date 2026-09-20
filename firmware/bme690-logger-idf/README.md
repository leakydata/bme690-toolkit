# BME690 8x shuttle logger (ESP-IDF / ESP32-S3)

Runs all eight BME690s on a **Shuttle Board 3.0** from an ESP32-S3 using pure
Espressif tooling — no Zephyr, no Bosch Application Board.

Built against **ESP-IDF v5.5.4**. Binary is ~219 KB.

## Why ESP32-S3 is the default recommendation

Cheap, actually in stock, and a DevKitC breaks out enough GPIO that all eight
chip selects fit alongside an SD card and buttons with no decoder chip. WiFi
can also replace storage entirely by streaming to a host.

The nRF52840 build in `../bme690-logger` is the low-power option — see the
power comparison in the top-level README.

## Build and flash

```bash
. ~/esp-idf/export.sh
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/ttyACM0 flash monitor
```

## Wiring (ESP32-S3 DevKitC)

Pins avoid the strapping pins, the flash/PSRAM pins (26–32) and the USB pins
(19/20). Any free GPIOs work — edit `main/main.c` if yours differ.

| shuttle pin | signal | ESP32-S3 |
|---|---|---|
| Row 1, pin 1 | Vdd | 3V3 |
| Row 1, pin 2 | VddIO | 3V3 |
| Row 1, pin 3 | Gnd | GND |
| Row 2, pin 2 | SCK | GPIO12 |
| Row 2, pin 3 | SDO → MCU MISO | GPIO13 |
| Row 2, pin 4 | SDI ← MCU MOSI | GPIO11 |
| Row 1, pin 4 | GPIO0 = sensor 0 CS | GPIO1 |
| Row 1, pin 5 | GPIO1 = sensor 1 CS | GPIO2 |
| Row 1, pin 6 | GPIO2 = sensor 2 CS | GPIO4 |
| Row 1, pin 7 | GPIO3 = sensor 3 CS | GPIO5 |
| Row 2, pin 5 | GPIO4 = sensor 4 CS | GPIO6 |
| Row 2, pin 6 | GPIO5 = sensor 5 CS | GPIO7 |
| Row 2, pin 7 | GPIO6 = sensor 6 CS | GPIO15 |
| Row 2, pin 8 | GPIO7 = sensor 7 CS | GPIO16 |

**Seven wires are enough to start.** Power, the three SPI lines and a single
chip select already prove the shuttle is alive; bring-up reports what answered
and retries every 3 s, so you can wire as you watch.

Chip select is driven as a plain GPIO rather than by the SPI peripheral: the
ESP32 has only three hardware CS lines per host, and eight sensors share one
bus.

## Output

Identical to the Zephyr build, so `bme690 ingest` accepts either:

```
# sensor,t_ms,temp_C,press_hPa,hum_pct,gas_ohm,step,heat_stable
D,0,10782,33.47,998.78,35.46,234700.90,0,1
```

```bash
bme690 ingest --port /dev/ttyACM0 -o coffee.bmerawdata --labels "coffee:300,air:300"
```
