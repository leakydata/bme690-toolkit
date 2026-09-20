# Hardware notes: Application Board 3.1 + BME690 8x shuttle

Findings from getting this combination working on Linux. Sources are Bosch's
AB3.1 user guide, the COINES SDK, and direct probing of the hardware.

## The board

| | |
|---|---|
| MCU module | u-blox NINA-B306 (Nordic **nRF52840**), USB 2.0 + BLE 5.0 |
| RAM / internal flash | 256 KB / 1 MB |
| External flash | **Winbond W25N02KWZEIR, 2 Gbit NAND (256 MB)**, on SPI |
| Buttons | **BTN-S1**, **BTN-S2** (both freely programmable) + Power button (PMIC) |
| LED | RGB, MCU controlled |
| Power | USB 5 V, or Li-ion battery (150 mA charge, 16 mA termination) |

Bosch: *"The external flash is used primarily for storing files, particularly
sensor data log files. The files can be accessed from a host by switching the
device to the pre-loaded MTP firmware mode and connecting via USB."*

The user guide is explicit that S1 and S2 have **no predefined function** —
they are yours to program.

### nRF52840 flash map

```
00000h  Nordic SoftDevice S140 (BLE stack)
28000h  reserved
        USB MTP firmware
F0000h  Default Application / User Application   <-- custom COINES app
FFFFFh
```

The stock "Default Application" is `coines_bridge`: a USB-to-SPI/I2C/GPIO
bridge. It is a **pure slave** — it does nothing until a host drives it, which
is why a board running it must stay tethered.

## Shuttle board

Shuttle EEPROM id **`0x57`**. AI-Studio calls this board type `board_690`.
(The single-sensor BME690 shuttle is `0x93`.)

The eight BME690s are on SPI, one chip-select each:

| sensor | shuttle pin | CS |
|---|---|---|
| 0 | `MINI_SHUTTLE_PIN_1_4` | 0x10 |
| 1 | `MINI_SHUTTLE_PIN_1_5` | 0x11 |
| 2 | `MINI_SHUTTLE_PIN_1_6` | 0x12 |
| 3 | `MINI_SHUTTLE_PIN_1_7` | 0x13 |
| 4 | `MINI_SHUTTLE_PIN_2_5` | 0x14 |
| 5 | `MINI_SHUTTLE_PIN_2_6` | 0x15 |
| 6 | `MINI_SHUTTLE_PIN_2_7` | 0x1d |
| 7 | `MINI_SHUTTLE_PIN_2_8` | 0x1e |

Each answers chip id `0x61` at register `0xD0`, variant id 2. I2C is not wired.

### Mapped to physical Shuttle Board 3.0 pins

Cross-referencing the CS lines found by probing against the connector pinout
in Bosch's AB3.1 user guide gives a complete picture. The eight sensors use
**GPIO0-GPIO7 as individual chip selects**, sharing one SPI bus:

| sensor | coinespy name | shuttle pin | documented function |
|---|---|---|---|
| 0 | `MINI_SHUTTLE_PIN_1_4` | Row 1, pin 4 | GPIO0 |
| 1 | `MINI_SHUTTLE_PIN_1_5` | Row 1, pin 5 | GPIO1 |
| 2 | `MINI_SHUTTLE_PIN_1_6` | Row 1, pin 6 | GPIO2/INT1 |
| 3 | `MINI_SHUTTLE_PIN_1_7` | Row 1, pin 7 | GPIO3/INT2 |
| 4 | `MINI_SHUTTLE_PIN_2_5` | Row 2, pin 5 | GPIO4/OCSB |
| 5 | `MINI_SHUTTLE_PIN_2_6` | Row 2, pin 6 | GPIO5/ASCx |
| 6 | `MINI_SHUTTLE_PIN_2_7` | Row 2, pin 7 | GPIO6/OSDO |
| 7 | `MINI_SHUTTLE_PIN_2_8` | Row 2, pin 8 | GPIO7/ASDx |

Shared lines:

| shuttle pin | function |
|---|---|
| Row 1, pin 1 | **Vdd** — sensor supply, 0.8-3.3 V from the PMIC |
| Row 1, pin 2 | **VddIO** — IO reference, 1.8-3.3 V |
| Row 1, pin 3 | **Gnd** |
| Row 2, pin 2 | **SCK** |
| Row 2, pin 3 | **SDO** (sensor data out → host MISO) |
| Row 2, pin 4 | **SDI** (host MOSI → sensor) |
| Row 2, pin 9 | PROM-RW — 1-Wire EEPROM holding the shuttle id (`0x57`) |

Probing confirms this: Row 2 pins 1 and 3 answer nothing when used as chip
selects, because they are the shared bus lines, not per-sensor selects.

### Driving the shuttle without an Application Board

Nothing above is specific to the AB3.1. The shuttle board needs only:

- 3.3 V on **Vdd** and **VddIO**, plus **Gnd**
- three SPI lines — **SCK**, **SDI**, **SDO**
- **eight GPIOs** for the chip selects

So any MCU with a spare SPI bus and eight GPIOs can run all eight sensors —
a bare nRF52840, an ESP32, a Pi. The register-level driver in this repository
is transport-agnostic (`device.py` talks to anything exposing `read(reg, len)`
and `write(reg, data)`), so only the transport needs replacing.

The 1-Wire EEPROM on Row 2 pin 9 is only there to identify the shuttle; it is
not needed to read sensors.

## Traps

### coinespy takes volts, not millivolts

`set_shuttleboard_vdd_vddio_config(3300, 3300)` reads like millivolts. It is
not: coinespy multiplies by 1000 into a `uint16`, so 3300 becomes 3 300 000,
truncates to **23200**, and latches a supply setpoint the hardware cannot
honour. Every sensor then reads chip id `0x00` — indistinguishable from dead
hardware — and it **survives USB re-enumeration**. Only a board `soft_reset()`
clears it.

```python
board.set_shuttleboard_vdd_vddio_config(3.3, 3.3)   # volts
```

### Configure SPI before switching the supply on

And the configuration persists in board firmware across USB sessions, so a
second run gets `COINES_E_SPI_CONFIG_FAILED` unless the bus is torn down
first:

```python
cb.deconfig_spi_bus(SPIBus.BUS_SPI_0)
cb.config_spi_bus(SPIBus.BUS_SPI_0, CS_PINS[0], speed, SPIMode.MODE0)
cb.set_shuttleboard_vdd_vddio_config(3.3, 3.3)
```

`AppBoard31.open()` in this repository does all of the above and resets the
board automatically if the sensors come up dark.

### Parallel-mode step duration is one byte

Each heater step's duration is a plain multiplier of the shared heater
duration, held in a **single byte** — maximum 255.

**HP-001 is the only stock profile that breaks this.** Its ten steps have a
duration of 429, which truncates to 173, giving 24.2 s steps instead of 60.1 s
— silently. This driver refuses instead of truncating.

Since all ten HP-001 steps are at the same temperature, the heater simply sits
at 320 °C throughout, so `HP-STAB` (ten steps of 320 °C x 255) is thermally
identical; only the nominal cycle length differs, 357 s versus 600.6 s.

## Firmware modes

`app_switch` jumps between them (source in `tools/app_switch`; only a Windows
binary ships, so build it for Linux):

| target | command |
|---|---|
| USB DFU bootloader | `app_switch usb_dfu_bl` |
| USB MTP firmware | `app_switch usb_mtp` |
| application at address | `app_switch 0x32000` |

In MTP mode the board appears as VID `0x108C`, PID `0xAB31` and the NAND flash
can be browsed like a camera.

Stock firmware lives in `firmware/app3.1/coines_bridge/` in the COINES SDK
with an update script, so custom firmware is always reversible.

## Nordic software stack

COINES targets the **legacy nRF5 SDK**, not Zephyr / nRF Connect SDK:

```
CFLAGS += -DS140 -DSOFTDEVICE_PRESENT
nRF5_SDK_DIR ?= ../../thirdparty/nRF5_SDK
FREERTOS_PATH = $(nRF5_SDK_DIR)/external/freertos
gcc_startup_nrf52840.S
```

BLE is SoftDevice S140; FreeRTOS is available. The SDK also vendors
**LittleFS** and **FLogFs**, both useful for logging to the NAND flash.
