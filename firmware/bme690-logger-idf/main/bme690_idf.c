/* ESP-IDF SPI/GPIO transport for the portable BME690 core.
 * SPDX-License-Identifier: MIT */
#include "bme690_idf.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>

#define MAX_XFER 64   /* longest burst the core asks for is 51 bytes */

static int idf_read(void *vctx, uint8_t reg, uint8_t *buf, size_t len)
{
	struct bme690_idf_ctx *ctx = vctx;
	uint8_t tx[MAX_XFER + 1] = { 0 };
	uint8_t rx[MAX_XFER + 1] = { 0 };
	spi_transaction_t t = { 0 };
	esp_err_t err;

	if (len > MAX_XFER) {
		return -1;
	}
	tx[0] = reg;
	t.length = (len + 1) * 8;
	t.rxlength = (len + 1) * 8;
	t.tx_buffer = tx;
	t.rx_buffer = rx;

	gpio_set_level(ctx->cs, 0);
	err = spi_device_polling_transmit(ctx->spi, &t);
	gpio_set_level(ctx->cs, 1);
	if (err != ESP_OK) {
		return -1;
	}
	memcpy(buf, &rx[1], len);   /* first byte is shifted out during the address */
	return 0;
}

static int idf_write(void *vctx, uint8_t reg, const uint8_t *buf, size_t len)
{
	struct bme690_idf_ctx *ctx = vctx;
	uint8_t tx[MAX_XFER + 1] = { 0 };
	spi_transaction_t t = { 0 };
	esp_err_t err;

	if (len > MAX_XFER) {
		return -1;
	}
	tx[0] = reg;
	memcpy(&tx[1], buf, len);
	t.length = (len + 1) * 8;
	t.tx_buffer = tx;

	gpio_set_level(ctx->cs, 0);
	err = spi_device_polling_transmit(ctx->spi, &t);
	gpio_set_level(ctx->cs, 1);
	return (err == ESP_OK) ? 0 : -1;
}

static void idf_delay_ms(uint32_t ms)
{
	vTaskDelay(pdMS_TO_TICKS(ms ? ms : 1));
}

static spi_device_handle_t shared_spi;

int bme690_idf_attach(struct bme690_dev *dev, struct bme690_idf_ctx *ctx,
		      spi_host_device_t host, gpio_num_t cs, int freq_hz)
{
	spi_device_interface_config_t devcfg = {
		.clock_speed_hz = freq_hz,
		.mode = 0,                 /* CPOL 0, CPHA 0 */
		.spics_io_num = -1,        /* CS driven manually, see header */
		.queue_size = 1,
	};
	gpio_config_t io = {
		.pin_bit_mask = 1ULL << cs,
		.mode = GPIO_MODE_OUTPUT,
	};

	if (gpio_config(&io) != ESP_OK) {
		return -1;
	}
	gpio_set_level(cs, 1);   /* idle high */

	/* One SPI device serves every sensor. ESP-IDF allows only six devices
	 * per bus (SOC_SPI_MAX_CS_NUM), so a device per sensor silently loses
	 * sensors 6 and 7; with CS driven by hand the handle is shareable. */
	if (shared_spi == NULL &&
	    spi_bus_add_device(host, &devcfg, &shared_spi) != ESP_OK) {
		return -1;
	}
	ctx->spi = shared_spi;
	ctx->cs = cs;

	dev->read = idf_read;
	dev->write = idf_write;
	dev->delay_ms = idf_delay_ms;
	dev->ctx = ctx;
	return 0;
}
