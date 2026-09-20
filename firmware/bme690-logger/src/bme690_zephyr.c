/* Zephyr SPI/GPIO transport for the portable BME690 core.
 * SPDX-License-Identifier: MIT */
#include "bme690_zephyr.h"
#include <zephyr/kernel.h>

static int z_read(void *vctx, uint8_t reg, uint8_t *buf, size_t len)
{
	struct bme690_zephyr_ctx *ctx = vctx;
	uint8_t hdr = reg;
	const struct spi_buf tx_bufs[] = { { .buf = &hdr, .len = 1 } };
	const struct spi_buf_set tx_set = { .buffers = tx_bufs, .count = 1 };
	struct spi_buf rx_bufs[] = {
		{ .buf = NULL, .len = 1 },
		{ .buf = buf, .len = len },
	};
	const struct spi_buf_set rx_set = { .buffers = rx_bufs, .count = 2 };
	int rc;

	gpio_pin_set_dt(&ctx->cs, 1);
	rc = spi_transceive(ctx->spi, &ctx->spi_cfg, &tx_set, &rx_set);
	gpio_pin_set_dt(&ctx->cs, 0);
	return rc;
}

static int z_write(void *vctx, uint8_t reg, const uint8_t *buf, size_t len)
{
	struct bme690_zephyr_ctx *ctx = vctx;
	uint8_t hdr = reg;
	const struct spi_buf tx_bufs[] = {
		{ .buf = &hdr, .len = 1 },
		{ .buf = (void *)buf, .len = len },
	};
	const struct spi_buf_set tx_set = { .buffers = tx_bufs, .count = 2 };
	int rc;

	gpio_pin_set_dt(&ctx->cs, 1);
	rc = spi_write(ctx->spi, &ctx->spi_cfg, &tx_set);
	gpio_pin_set_dt(&ctx->cs, 0);
	return rc;
}

static void z_delay_ms(uint32_t ms)
{
	k_msleep(ms);
}

int bme690_zephyr_attach(struct bme690_dev *dev, struct bme690_zephyr_ctx *ctx,
			 const struct device *spi, struct gpio_dt_spec cs,
			 uint32_t freq_hz)
{
	int rc;

	if (!gpio_is_ready_dt(&cs)) {
		return -ENODEV;
	}
	rc = gpio_pin_configure_dt(&cs, GPIO_OUTPUT_INACTIVE);
	if (rc) {
		return rc;
	}
	ctx->spi = spi;
	ctx->cs = cs;
	ctx->spi_cfg.frequency = freq_hz;
	ctx->spi_cfg.operation = SPI_WORD_SET(8) | SPI_TRANSFER_MSB |
				 SPI_OP_MODE_MASTER;

	dev->read = z_read;
	dev->write = z_write;
	dev->delay_ms = z_delay_ms;
	dev->ctx = ctx;
	return 0;
}
