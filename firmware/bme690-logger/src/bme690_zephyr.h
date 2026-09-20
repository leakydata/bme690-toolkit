/* Zephyr SPI/GPIO transport for the portable BME690 core.
 * SPDX-License-Identifier: MIT */
#ifndef BME690_ZEPHYR_H_
#define BME690_ZEPHYR_H_

#include "bme690.h"
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/spi.h>

struct bme690_zephyr_ctx {
	const struct device *spi;
	struct spi_config    spi_cfg;
	struct gpio_dt_spec  cs;
};

/* Wires ctx into dev and configures the chip select. */
int bme690_zephyr_attach(struct bme690_dev *dev, struct bme690_zephyr_ctx *ctx,
			 const struct device *spi, struct gpio_dt_spec cs,
			 uint32_t freq_hz);

#endif /* BME690_ZEPHYR_H_ */
