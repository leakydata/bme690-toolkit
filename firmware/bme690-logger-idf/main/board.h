/* Pin map and fixed facts about the hardware.
 * SPDX-License-Identifier: MIT */
#ifndef BOARD_H_
#define BOARD_H_

#include "driver/gpio.h"
#include "driver/spi_master.h"

#define FW_VERSION  "2.2.0"
#define NUM_SENSORS 8

/* Sensor bus. Any free GPIOs work; these avoid the strapping pins, the
 * PSRAM/flash pins (26-32) and the USB pins (19/20). */
#define SENSOR_SPI_HOST SPI2_HOST
#define PIN_SCK   GPIO_NUM_12   /* -> shuttle SCK, P2-2 */
#define PIN_MOSI  GPIO_NUM_11   /* -> shuttle SDI, P2-4 */
#define PIN_MISO  GPIO_NUM_13   /* <- shuttle SDO, P2-3 */

/* The SD card gets its own bus: many TF modules put a level shifter on MISO
 * that never releases it, which would corrupt every sensor read. */
#define SD_SPI_HOST SPI3_HOST
#define PIN_SD_CS   GPIO_NUM_10
#define PIN_SD_SCK  GPIO_NUM_18
#define PIN_SD_MOSI GPIO_NUM_17
#define PIN_SD_MISO GPIO_NUM_8

#define PIN_BUTTON  GPIO_NUM_0   /* the DevKitC's BOOT button */

/* The DevKitC-1's RGB LED is on GPIO48 on v1.0 boards and GPIO38 on v1.1.
 * Neither pin is used for anything else, so both are driven. */
#define PIN_LED_V10 GPIO_NUM_48
#define PIN_LED_V11 GPIO_NUM_38

struct sensor_slot {
	gpio_num_t  cs;
	const char *part;         /* designator on the shuttle board */
	const char *shuttle_pin;
};

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

#endif /* BOARD_H_ */
