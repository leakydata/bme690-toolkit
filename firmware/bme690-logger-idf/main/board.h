/* Pin map and fixed facts about the hardware. Two boards are supported,
 * chosen at build time (menuconfig "BME690 logger", see Kconfig.projbuild):
 *
 *   DevKitC  ESP32-S3 DevKitC-1 wired to the shuttle (docs/wiring.md), SD
 *            card module on its own bus, RGB LED.
 *   XIAO     Seeed XIAO ESP32-S3 / Sense on carrier Board B (board_b/). The
 *            Sense's SD card shares the sensor bus; console on USB.
 *
 * SPDX-License-Identifier: MIT */
#ifndef BOARD_H_
#define BOARD_H_

#include "sdkconfig.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"

#define FW_VERSION  "2.4.0"
#define NUM_SENSORS 8

#define SENSOR_SPI_HOST SPI2_HOST

struct sensor_slot {
	gpio_num_t  cs;
	const char *part;         /* designator on the shuttle board */
	const char *shuttle_pin;
};

#if CONFIG_BME690_BOARD_XIAO

#define BOARD_NAME "XIAO ESP32-S3 (Board B)"

/* XIAO D8 / D10 / D9, the XIAO's hardware SPI pins. */
#define PIN_SCK   GPIO_NUM_7    /* D8  -> shuttle SCK, P2-2 */
#define PIN_MOSI  GPIO_NUM_9    /* D10 -> shuttle SDI, P2-4 */
#define PIN_MISO  GPIO_NUM_8    /* D9  <- shuttle SDO, P2-3 */
#define WIRE_SCK  "D8 (GPIO7)"
#define WIRE_SDI  "D10 (GPIO9)"
#define WIRE_SDO  "D9 (GPIO8)"

/* The XIAO ESP32-S3 Sense's microSD card is on the same three lines with
 * its own chip select; the card and the sensors take turns on the bus. */
#define SD_SHARES_SENSOR_BUS 1
#define SD_SPI_HOST SENSOR_SPI_HOST
#define PIN_SD_CS   GPIO_NUM_21
#define PIN_SD_SCK  PIN_SCK
#define PIN_SD_MOSI PIN_MOSI
#define PIN_SD_MISO PIN_MISO
#define SD_WIRING   "the card slot on the XIAO ESP32-S3 Sense expansion board"

#define PIN_BUTTON  GPIO_NUM_0   /* the XIAO's B (BOOT) button */

/* The XIAO's orange user LED, lit when GPIO21 is low. On the Sense the
 * same pin is the SD card's chip select, so the LED is only used when no
 * card is mounted. */
#define LED_SIMPLE        1
#define PIN_LED           GPIO_NUM_21
#define LED_ON_LEVEL      0
#define LED_SHARES_SD_CS  1

/* Board B: XIAO D0-D7 are the 8x shuttle's chip selects. */
static const struct sensor_slot sensor_slots[NUM_SENSORS] = {
	{ GPIO_NUM_1,  "U1", "P1-4" },   /* D0, via JP2 */
	{ GPIO_NUM_2,  "U2", "P1-5" },   /* D1 */
	{ GPIO_NUM_3,  "U3", "P1-6" },   /* D2 */
	{ GPIO_NUM_4,  "U4", "P1-7" },   /* D3 */
	{ GPIO_NUM_5,  "U5", "P2-5" },   /* D4 */
	{ GPIO_NUM_6,  "U6", "P2-6" },   /* D5 */
	{ GPIO_NUM_43, "U7", "P2-7" },   /* D6 */
	{ GPIO_NUM_44, "U8", "P2-8" },   /* D7, via JP5 */
};

#else /* DevKitC-1 */

#define BOARD_NAME "ESP32-S3 DevKitC-1"

/* Sensor bus. Any free GPIOs work; these avoid the strapping pins, the
 * PSRAM/flash pins (26-32) and the USB pins (19/20). */
#define PIN_SCK   GPIO_NUM_12   /* -> shuttle SCK, P2-2 */
#define PIN_MOSI  GPIO_NUM_11   /* -> shuttle SDI, P2-4 */
#define PIN_MISO  GPIO_NUM_13   /* <- shuttle SDO, P2-3 */
#define WIRE_SCK  "GPIO12"
#define WIRE_SDI  "GPIO11"
#define WIRE_SDO  "GPIO13"

/* The SD card gets its own bus: many TF modules put a level shifter on MISO
 * that never releases it, which would corrupt every sensor read. */
#define SD_SHARES_SENSOR_BUS 0
#define SD_SPI_HOST SPI3_HOST
#define PIN_SD_CS   GPIO_NUM_10
#define PIN_SD_SCK  GPIO_NUM_18
#define PIN_SD_MOSI GPIO_NUM_17
#define PIN_SD_MISO GPIO_NUM_8
#define SD_WIRING   "the card wiring: CS GPIO10, SCK GPIO18, MOSI GPIO17, MISO GPIO8, and power"

#define PIN_BUTTON  GPIO_NUM_0   /* the DevKitC's BOOT button */

/* The DevKitC-1's RGB LED is on GPIO48 on v1.0 boards and GPIO38 on v1.1.
 * Neither pin is used for anything else, so both are driven. */
#define LED_SIMPLE  0
#define PIN_LED_V10 GPIO_NUM_48
#define PIN_LED_V11 GPIO_NUM_38

/* Sensor N is shuttle part U(N+1); its chip select is GPIO N of the
 * Application Board, which the shuttle routes to these connector pins. */
static const struct sensor_slot sensor_slots[NUM_SENSORS] = {
	{ GPIO_NUM_1,  "U1", "P1-4" },
	{ GPIO_NUM_2,  "U2", "P1-5" },
	{ GPIO_NUM_4,  "U3", "P1-6" },
	{ GPIO_NUM_5,  "U4", "P1-7" },
	{ GPIO_NUM_6,  "U5", "P2-5" },
	{ GPIO_NUM_7,  "U6", "P2-6" },
	{ GPIO_NUM_15, "U7", "P2-7" },
	{ GPIO_NUM_16, "U8", "P2-8" },
};

#endif

/* Start the sensor SPI bus once, for whichever of sensors.c and storage.c
 * gets there first. Every chip select is driven high, and when the SD card
 * shares the bus each sensor is first switched to SPI mode (a BME690 is in
 * I2C mode until its CS goes low once, and could answer card traffic). */
int board_spi_bus_init(void);

#endif /* BOARD_H_ */
