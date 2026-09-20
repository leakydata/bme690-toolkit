/*
 * BME690 8x shuttle board logger -- ESP32-S3 / ESP-IDF.
 *
 * Runs all eight BME690s in parallel mode on a ten-step heater profile and
 * streams one record per heater step. Each sensor walks its profile
 * autonomously and tags every result with the step index, so the MCU only has
 * to poll often enough not to miss a step.
 *
 * SPDX-License-Identifier: MIT
 */
#include "bme690.h"
#include "bme690_idf.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"
#include "esp_log.h"
#include <stdio.h>
#include <string.h>

static const char *TAG = "bme690";

#define NUM_SENSORS  8
#define POLL_MS      40
#define SPI_HOST_ID  SPI2_HOST

/* ESP32-S3 DevKitC wiring. Any free GPIOs work; these avoid the strapping
 * pins, the PSRAM/flash pins (26-32) and the USB pins (19/20). */
#define PIN_SCK  GPIO_NUM_12
#define PIN_MOSI GPIO_NUM_11   /* -> shuttle SDI, Row 2 pin 4 */
#define PIN_MISO GPIO_NUM_13   /* <- shuttle SDO, Row 2 pin 3 */

static const gpio_num_t cs_pins[NUM_SENSORS] = {
	GPIO_NUM_1,  GPIO_NUM_2,  GPIO_NUM_4,  GPIO_NUM_5,
	GPIO_NUM_6,  GPIO_NUM_7,  GPIO_NUM_15, GPIO_NUM_16,
};

/* HP-354, Bosch's standard scanning profile: ten steps, 140 ms time base,
 * 77 * 140 ms = 10.78 s per cycle. */
#define HEATER_TIME_BASE_MS 140
static const uint16_t hp354_temp[BME690_PROFILE_LEN] = {
	320, 100, 100, 100, 200, 200, 200, 320, 320, 320,
};
static const uint16_t hp354_dur[BME690_PROFILE_LEN] = {
	5, 2, 10, 30, 5, 5, 5, 5, 5, 5,
};

static struct bme690_dev     sensors[NUM_SENSORS];
static struct bme690_idf_ctx sensor_ctx[NUM_SENSORS];
static uint8_t last_meas[NUM_SENSORS];
static bool    have_last[NUM_SENSORS];
static struct bme690_data pending[NUM_SENSORS];
static bool    have_pending[NUM_SENSORS];

static int64_t t0_us;

static void emit(uint8_t idx, const struct bme690_data *d)
{
	/* Same line format as the Zephyr build, so `bme690 ingest` accepts
	 * either. Pressure is converted to hPa here, as AI-Studio wants. */
	printf("D,%u,%lld,%.4f,%.4f,%.4f,%.2f,%u,%u\n",
	       idx, (long long)((esp_timer_get_time() - t0_us) / 1000),
	       d->temperature, d->pressure / 100.0f, d->humidity,
	       d->gas_resistance, d->gas_index,
	       (d->status & BME690_STATUS_HEAT_STAB) ? 1U : 0U);
}

static int init_bus(void)
{
	spi_bus_config_t cfg = {
		.sclk_io_num = PIN_SCK,
		.mosi_io_num = PIN_MOSI,
		.miso_io_num = PIN_MISO,
		.quadwp_io_num = -1,
		.quadhd_io_num = -1,
		.max_transfer_sz = 128,
	};

	return spi_bus_initialize(SPI_HOST_ID, &cfg, SPI_DMA_CH_AUTO) == ESP_OK
		? 0 : -1;
}

void app_main(void)
{
	struct bme690_conf conf = {
		.os_hum = BME690_OS_1X,
		.os_temp = BME690_OS_2X,
		.os_pres = BME690_OS_16X,
		.filter = BME690_FILTER_OFF,
		.odr = BME690_ODR_NONE,
	};
	struct bme690_heatr_conf heat = { .enable = true };
	uint32_t meas_dur_ms;
	int found = 0;

	vTaskDelay(pdMS_TO_TICKS(2000));   /* let USB serial enumerate */

	if (init_bus() != 0) {
		ESP_LOGE(TAG, "SPI bus init failed");
		return;
	}

	meas_dur_ms = bme690_get_meas_dur_us(&conf, BME690_PARALLEL_MODE) / 1000U;
	if (HEATER_TIME_BASE_MS <= meas_dur_ms) {
		ESP_LOGE(TAG, "time base %d ms shorter than measurement %u ms",
			 HEATER_TIME_BASE_MS, (unsigned)meas_dur_ms);
		return;
	}
	heat.shared_heatr_dur = HEATER_TIME_BASE_MS - meas_dur_ms;
	memcpy(heat.temp_prof, hp354_temp, sizeof(hp354_temp));
	memcpy(heat.dur_prof, hp354_dur, sizeof(hp354_dur));

	/* Bring-up tolerates partial wiring: wiring eight chip selects one at a
	 * time is the normal case, so report and retry rather than refusing. */
	while (found == 0) {
		printf("\n--- BME690 shuttle bring-up ---\n");
		for (int i = 0; i < NUM_SENSORS; i++) {
			struct bme690_dev *d = &sensors[i];

			d->index = i;
			d->amb_temp = 25;
			if (bme690_idf_attach(d, &sensor_ctx[i], SPI_HOST_ID,
					      cs_pins[i], 5000000) != 0 ||
			    bme690_init(d) != 0) {
				printf("  sensor %d  --  no answer\n", i);
				d->chip_id = 0;
				continue;
			}
			printf("  sensor %d  OK  chip 0x%02x  variant %u  "
			       "par_t1=%u par_g1=%d\n",
			       i, d->chip_id, d->variant_id,
			       d->calib.par_t1, d->calib.par_g1);
			found++;
		}
		if (found == 0) {
			printf("\nNothing answered. Check:\n"
			       "  3V3 on shuttle Row 1 pins 1 (Vdd) and 2 (VddIO)\n"
			       "  GND on Row 1 pin 3\n"
			       "  SCK Row 2 pin 2 -> GPIO%d, SDO Row 2 pin 3 -> GPIO%d,"
			       " SDI Row 2 pin 4 -> GPIO%d\n"
			       "  at least one chip select, e.g. Row 1 pin 4 -> GPIO%d\n"
			       "Retrying in 3 s; wire as you watch.\n",
			       PIN_SCK, PIN_MISO, PIN_MOSI, cs_pins[0]);
			vTaskDelay(pdMS_TO_TICKS(3000));
		}
	}

	printf("\n%d of %d sensors responding.\n", found, NUM_SENSORS);

	for (int i = 0; i < NUM_SENSORS; i++) {
		struct bme690_dev *d = &sensors[i];

		if (d->chip_id != BME690_CHIP_ID) {
			continue;
		}
		if (bme690_set_conf(d, &conf) != 0 ||
		    bme690_set_heatr_conf(d, BME690_PARALLEL_MODE, &heat) != 0 ||
		    bme690_set_op_mode(d, BME690_PARALLEL_MODE) != 0) {
			ESP_LOGE(TAG, "sensor %d configuration failed", i);
			d->chip_id = 0;
			found--;
		}
	}

	printf("%d sensors scanning, shared heater duration %u ms\n",
	       found, heat.shared_heatr_dur);
	printf("# sensor,t_ms,temp_C,press_hPa,hum_pct,gas_ohm,step,heat_stable\n");

	t0_us = esp_timer_get_time();

	while (1) {
		for (int i = 0; i < NUM_SENSORS; i++) {
			struct bme690_data got[3];
			uint8_t n = 0;

			if (sensors[i].chip_id != BME690_CHIP_ID) {
				continue;
			}
			if (bme690_get_data(&sensors[i], BME690_PARALLEL_MODE,
					    got, &n) != 0) {
				continue;
			}
			for (int j = 0; j < n; j++) {
				if (have_last[i] && got[j].meas_index == last_meas[i]) {
					continue;
				}
				last_meas[i] = got[j].meas_index;
				have_last[i] = true;

				/* One point per heater step: the sensor measures
				 * once per time base, so a step lasting N time
				 * bases yields N readings with the same index.
				 * Keep the last -- the heater has then been
				 * longest at that temperature. */
				if (have_pending[i] &&
				    pending[i].gas_index != got[j].gas_index) {
					emit(i, &pending[i]);
				}
				pending[i] = got[j];
				have_pending[i] = true;
			}
		}
		vTaskDelay(pdMS_TO_TICKS(POLL_MS));
	}
}
