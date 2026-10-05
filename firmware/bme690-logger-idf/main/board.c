/* Shared sensor SPI bus start-up. See board.h.
 * SPDX-License-Identifier: MIT */
#include "board.h"
#include "esp_rom_sys.h"

static bool bus_up;

int board_spi_bus_init(void)
{
	spi_bus_config_t bus = {
		.sclk_io_num = PIN_SCK,
		.mosi_io_num = PIN_MOSI,
		.miso_io_num = PIN_MISO,
		.quadwp_io_num = -1,
		.quadhd_io_num = -1,
		/* the SD card moves 512-byte blocks; the sensors at most 52 bytes */
		.max_transfer_sz = SD_SHARES_SENSOR_BUS ? 4000 : 128,
	};
	uint64_t mask = 0;

	if (bus_up) {
		return 0;
	}
	for (int i = 0; i < NUM_SENSORS; i++) {
		mask |= 1ULL << sensor_slots[i].cs;
	}
	gpio_config_t io = {
		.pin_bit_mask = mask,
		.mode = GPIO_MODE_OUTPUT,
	};
	for (int i = 0; i < NUM_SENSORS; i++) {
		gpio_set_level(sensor_slots[i].cs, 1);
	}
	if (gpio_config(&io) != ESP_OK) {
		return -1;
	}
	for (int i = 0; i < NUM_SENSORS; i++) {
		gpio_set_level(sensor_slots[i].cs, 1);
	}
	if (spi_bus_initialize(SENSOR_SPI_HOST, &bus, SPI_DMA_CH_AUTO) != ESP_OK) {
		return -1;
	}
	/* With SDO disconnected, MISO floats and reads random bytes; the
	 * pull-up turns that into a clean 0xFF the diagnosis can name. */
	gpio_pullup_en(PIN_MISO);
#if SD_SHARES_SENSOR_BUS
	/* A falling CS edge puts a BME690 in SPI mode until power-off. */
	for (int i = 0; i < NUM_SENSORS; i++) {
		gpio_set_level(sensor_slots[i].cs, 0);
		esp_rom_delay_us(2);
		gpio_set_level(sensor_slots[i].cs, 1);
	}
#endif
	bus_up = true;
	return 0;
}
