# BME690 8x shuttle logger for the ESP32-S3

This firmware runs Bosch's **BME690 8x shuttle board** (eight gas sensors) from
an ordinary **ESP32-S3 DevKitC**. You don't need Bosch's Application Board,
a PC or an app.

- **Power it on and it records.** All eight sensors scan and the data goes
  to a microSD card as ready-to-import BME AI-Studio files.
- **It checks its own wiring.** At every start it probes each sensor and tells
  you in plain English which wire to check if something is wrong.
- **It has its own dashboard.** It creates a WiFi network. Join it from a phone
  or laptop to see live graphs, name your samples and download recordings.
- **No SD card works too.** Watch live, or record straight into your browser.
- **Your AI-Studio heater profiles run on it.** Upload the `.bmeconfig` you
  save in AI-Studio and every sensor runs its own profile and duty cycle.

## What you need

| part | notes |
|---|---|
| ESP32-S3 DevKitC-1 | any flash size; the N8, N16 and N16R8 all work |
| BME690 8x shuttle board 3.0 | the eight-sensor board Bosch sells for AI-Studio |
| 1.27 mm to 2.54 mm adapter, or 1.27 mm female headers | the shuttle's pins are 1.27 mm pitch |
| microSD card module + card | optional. Any SPI module works. Format the card as FAT32 |
| jumper wires | keep them under 20 cm |

## Wiring

The shuttle has two rows of pins. **P1** is the 7-pin row and **P2** is the
9-pin row. Pin 1 of each row is marked on the board.

| shuttle pin | signal | ESP32-S3 |
|---|---|---|
| P1-1 | VDD (power) | 3V3 |
| P1-2 | VDDIO (logic power) | 3V3 |
| P1-3 | GND | GND |
| P1-4 | sensor 0 (U1) chip select | GPIO1 |
| P1-5 | sensor 1 (U2) chip select | GPIO2 |
| P1-6 | sensor 2 (U3) chip select | GPIO4 |
| P1-7 | sensor 3 (U4) chip select | GPIO5 |
| P2-1 | CS, **not used** on the 8x board | leave unconnected |
| P2-2 | SCK | GPIO12 |
| P2-3 | SDO, data from the sensors | GPIO13 |
| P2-4 | SDI, data to the sensors | GPIO11 |
| P2-5 | sensor 4 (U5) chip select | GPIO6 |
| P2-6 | sensor 5 (U6) chip select | GPIO7 |
| P2-7 | sensor 6 (U7) chip select | GPIO15 |
| P2-8 | sensor 7 (U8) chip select | GPIO16 |
| P2-9 | PROM_RW, the shuttle's ID chip | leave unconnected |

**Never connect 5V to the shuttle.** The sensors are 3.3 V parts.

The microSD module gets **its own four GPIOs**. Many cheap modules have a
level-shifter chip that holds the data line, which would corrupt the sensor
readings if the two shared a bus.

| SD module | ESP32-S3 |
|---|---|
| CS | GPIO10 |
| SCK / CLK | GPIO18 |
| MOSI / DI | GPIO17 |
| MISO / DO | GPIO8 |
| VCC | 5V if the module has a regulator (a small 3-pin chip, usually AMS1117); otherwise 3V3 |
| GND | GND |

You can start with **just seven wires**: power, ground, the three SPI lines
and one chip select (P1-4 to GPIO1). That is enough to prove the shuttle is
alive. Add the other chip selects one at a time, pressing **Re-check sensors**
on the dashboard after each one.

## Install

**The easy way:** open
**[leakydata.github.io/bme690-toolkit](https://leakydata.github.io/bme690-toolkit/)**
in Chrome or Edge on a computer, plug in the board and click **Install**. You
don't need a toolchain or drivers. The page always carries the latest firmware
from this repository; a GitHub Action (`.github/workflows/installer.yml`)
rebuilds it on every change.

**From source**, with [ESP-IDF v5.5](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/get-started/)
installed:

```bash
. ~/esp-idf/export.sh
cd firmware/bme690-logger-idf
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/ttyUSB0 flash monitor
```

The DevKitC has two USB-C ports. Plug into the one labelled **UART**. On Linux
it appears as `/dev/ttyUSB0`, on Windows as a COM port and on macOS as
`/dev/cu.usbserial-…`. The board's output also appears on the other port
(`USB`), so either one works for watching it.

## Using it

### The dashboard

1. Power the board.
2. On your phone or laptop, join the WiFi network **`BME690-XXXX`**. It has no
   password.
3. The dashboard opens on its own. If it doesn't, browse to
   **http://192.168.4.1**.

| tab | what it's for |
|---|---|
| Health | is everything working? Each sensor's status, the plain-English problem list and the wiring table |
| Live graphs | gas resistance, temperature, humidity and pressure for all eight sensors |
| Sensor detail | one sensor's heater-step "fingerprint" and health check, for troubleshooting |
| Recording | start/stop, sample labels, SD card space, heater profile |
| Files | download or delete recordings on the card |
| Record here | record into your browser, without an SD card |

The dashboard sets the board's clock from your device when it connects.

### The BOOT button and the light

| action | effect |
|---|---|
| short press | **next sample**: new readings get the next label (sample 2, sample 3, …) |
| hold for 2 seconds | start or stop recording |

The RGB LED pulses once every two seconds:

| colour | meaning |
|---|---|
| green | recording, all fine |
| blue | running but not recording (no card, or stopped) |
| amber | running, with a warning; see the dashboard |
| red | a problem needs attention, such as a sensor not answering or a card error |
| white blink | a button press or command was received |

### Getting data into BME AI-Studio

A recording is saved to the card as `bme690/s0007_0000.bmerawdata`,
`s0007_0001.bmerawdata` and so on. A new chunk starts every 15 minutes, and
every chunk has a matching `.bmelabelinfo` holding your sample names.

1. Take the card out, or download the files from the **Files** tab. Keep each
   `.bmerawdata` next to its `.bmelabelinfo`.
2. In AI-Studio, **Import** any one chunk. The rest of the session is picked
   up automatically.

Each label becomes a separate specimen in AI-Studio.

If the power is cut, the file being written is closed properly at the next
start, so at most the last few seconds are lost.

### Custom heater profiles

1. In AI-Studio, set up a board configuration with board type **BME690 8x
   Shuttle board** and save it. You get a `.bmeconfig` file.
2. On the dashboard, go to **Recording → Heater profile → Upload**. You can
   also copy the file to the root of the SD card.

Every sensor can have its own heater profile and duty cycle. Sensors switched
off in the configuration are left idle. **Back to factory default** returns
all eight sensors to HP-354.

### Recording to a PC instead

The `bme690` Python tool in this repository records from the USB serial
stream into a `.bmerawdata` file:

```bash
bme690 ingest --port /dev/ttyUSB0 -o coffee.bmerawdata --labels "coffee:300,air:300"
```

## Troubleshooting

The dashboard's **Health** tab diagnoses most problems. It prints the same
text over USB serial at 115200 baud. Type `status` for the full report or
`help` for the other commands.

| symptom | likely cause |
|---|---|
| **No sensor answers** | a shared wire: power (P1-1, P1-2), GND (P1-3), SCK (P2-2), SDO (P2-3) or SDI (P2-4), or the shuttle is plugged in rotated |
| **One sensor not answering** | its chip-select wire; the dashboard names the exact pin and GPIO |
| "Answers as the same chip as sensor N" | two chip-select wires are on the same shuttle pin |
| **Scrambled answers** | loose or long SPI wires; reseat them and keep them short |
| "is a BME688, not a BME690" | a BME688 shuttle; this firmware supports BME690 only |
| **Sensor was working and stopped** | a loose wire; it resumes on its own once the contact is back |
| **No SD card found** | card not inserted, not FAT32, or the SD wiring (CS GPIO10, SCK GPIO18, MOSI GPIO17, MISO GPIO8) |

### New sensors need a burn-in

Fresh BME690s drift for their first hours of operation. Before collecting data
you plan to train on, run a burn-in: Bosch recommend **at least 12 hours** on their stabilization profile, HP-001. Start one from the dashboard (**Recording → Burn-in**) or type `burnin 12` over serial. It records under the label "burn-in" and switches back to your heater profile when it ends. The
recording lets you watch the drift settle.

## For developers

- [`API.md`](API.md): the HTTP, WebSocket and serial interface.
- The dashboard is the single file [`dashboard/index.html`](dashboard/index.html),
  gzipped into the firmware at build time. Open it straight from disk (or add
  `?mock=1`) to work on it with simulated data.
- The register-level driver in [`../common`](../common) is shared with the
  experimental Zephyr/nRF52840 build.

| file | role |
|---|---|
| `main/sensors.c` | bring-up, fault diagnosis, per-sensor heater and duty-cycle scheduling, dropout recovery |
| `main/storage.c` | SD card, chunked `.bmerawdata` writing, power-loss repair |
| `main/app.c` | labels, clock, recording, and the plain-English problem list |
| `main/net.c` | WiFi access point, captive-portal DNS, HTTP API and WebSocket |
| `main/ui.c` | BOOT button and RGB LED |
| `main/config.c` | reads and writes AI-Studio's `.bmeconfig` |
