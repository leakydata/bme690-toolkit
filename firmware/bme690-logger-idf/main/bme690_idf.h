/* ESP-IDF SPI/GPIO transport for the portable BME690 core.
 * SPDX-License-Identifier: MIT */
#ifndef BME690_IDF_H_
#define BME690_IDF_H_

#include "bme690.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"

struct bme690_idf_ctx {
	spi_device_handle_t spi;
	gpio_num_t          cs;
};

/*
 * Chip select is driven by hand rather than by the SPI peripheral: eight
 * sensors share one bus and the ESP32's hardware CS lines are limited to
 * three per host, so a plain GPIO per sensor is simpler and scales.
 */
int bme690_idf_attach(struct bme690_dev *dev, struct bme690_idf_ctx *ctx,
		      spi_host_device_t host, gpio_num_t cs, int freq_hz);

#endif /* BME690_IDF_H_ */
