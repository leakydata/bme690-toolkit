/*
 * BME690 8x shuttle board logger.
 *
 * Runs all eight sensors in parallel mode on a ten-step heater profile and
 * streams one record per heater step over USB serial. Each sensor walks its
 * profile autonomously and tags every result with the step index, so the MCU
 * only has to poll often enough not to miss a step.
 *
 * SPDX-License-Identifier: MIT
 */
#include "bme690.h"
#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/logging/log.h>
#include <zephyr/usb/usb_device.h>

LOG_MODULE_REGISTER(main, LOG_LEVEL_INF);

#define NUM_SENSORS 8
#define POLL_MS     40

/* HP-354, Bosch's standard scanning profile: ten steps, 140 ms time base,
 * 77 * 140 ms = 10.78 s per cycle. */
#define HEATER_TIME_BASE_MS 140
static const uint16_t hp354_temp[BME690_PROFILE_LEN] = {
	320, 100, 100, 100, 200, 200, 200, 320, 320, 320,
};
static const uint16_t hp354_dur[BME690_PROFILE_LEN] = {
	5, 2, 10, 30, 5, 5, 5, 5, 5, 5,
};

#define CS_SPEC(node) GPIO_DT_SPEC_GET(DT_NODELABEL(node), gpios)
static const struct gpio_dt_spec cs_pins[NUM_SENSORS] = {
	CS_SPEC(cs0), CS_SPEC(cs1), CS_SPEC(cs2), CS_SPEC(cs3),
	CS_SPEC(cs4), CS_SPEC(cs5), CS_SPEC(cs6), CS_SPEC(cs7),
};

static struct bme690_dev sensors[NUM_SENSORS];
static uint8_t last_meas[NUM_SENSORS];
static bool    have_last[NUM_SENSORS];
static struct bme690_data pending[NUM_SENSORS];
static bool    have_pending[NUM_SENSORS];

static void emit(uint8_t idx, const struct bme690_data *d, int64_t t_ms)
{
	/* One line per heater step, in the column order the .bmerawdata writer
	 * expects. Pressure is converted to hPa here, as AI-Studio wants. */
	printk("D,%u,%lld,%.4f,%.4f,%.4f,%.2f,%u,%u\n",
	       idx, (long long)t_ms,
	       (double)d->temperature,
	       (double)d->pressure / 100.0,
	       (double)d->humidity,
	       (double)d->gas_resistance,
	       d->gas_index,
	       (d->status & BME690_STATUS_HEAT_STAB) ? 1U : 0U);
}

int main(void)
{
	const struct device *spi = DEVICE_DT_GET(DT_NODELABEL(spi2));
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

	if (IS_ENABLED(CONFIG_USB_DEVICE_STACK)) {
		usb_enable(NULL);
		k_msleep(2000);   /* let the host enumerate before we talk */
	}

	if (!device_is_ready(spi)) {
		LOG_ERR("SPI not ready");
		return -ENODEV;
	}

	meas_dur_ms = bme690_get_meas_dur_us(&conf, BME690_PARALLEL_MODE) / 1000U;
	if (HEATER_TIME_BASE_MS <= meas_dur_ms) {
		LOG_ERR("time base %d ms shorter than measurement %u ms",
			HEATER_TIME_BASE_MS, meas_dur_ms);
		return -EINVAL;
	}
	heat.shared_heatr_dur = HEATER_TIME_BASE_MS - meas_dur_ms;
	memcpy(heat.temp_prof, hp354_temp, sizeof(hp354_temp));
	memcpy(heat.dur_prof, hp354_dur, sizeof(hp354_dur));

	/* Bring-up is deliberately forgiving: wiring eight chip selects one at
	 * a time is normal, so report what answered and keep retrying rather
	 * than refusing to start. Watch this while you wire. */
	while (found == 0) {
		printk("\n--- BME690 shuttle bring-up ---\n");
		for (int i = 0; i < NUM_SENSORS; i++) {
			struct bme690_dev *d = &sensors[i];

			d->spi = spi;
			d->cs = cs_pins[i];
			d->index = i;
			d->amb_temp = 25;
			d->spi_cfg.frequency = 5000000;
			d->spi_cfg.operation = SPI_WORD_SET(8) | SPI_TRANSFER_MSB |
					       SPI_OP_MODE_MASTER;

			if (bme690_init(d) != 0) {
				printk("  sensor %d  --  no answer\n", i);
				d->chip_id = 0;
				continue;
			}
			printk("  sensor %d  OK  chip 0x%02x  variant %u  "
			       "par_t1=%u par_g1=%d\n",
			       i, d->chip_id, d->variant_id,
			       d->calib.par_t1, d->calib.par_g1);
			found++;
		}

		if (found == 0) {
			printk("\nNothing answered. Check:\n"
			       "  3V3 on shuttle Row 1 pins 1 (Vdd) and 2 (VddIO)\n"
			       "  GND on Row 1 pin 3\n"
			       "  SCK Row 2 pin 2 -> D8, SDO Row 2 pin 3 -> D9, "
			       "SDI Row 2 pin 4 -> D10\n"
			       "  at least one chip select, e.g. Row 1 pin 4 -> D0\n"
			       "Retrying in 3 s; wire as you watch.\n");
			k_msleep(3000);
		}
	}

	printk("\n%d of %d sensors responding.\n", found, NUM_SENSORS);

	for (int i = 0; i < NUM_SENSORS; i++) {
		struct bme690_dev *d = &sensors[i];

		if (d->chip_id != BME690_CHIP_ID) {
			continue;
		}
		if (bme690_set_conf(d, &conf) != 0 ||
		    bme690_set_heatr_conf(d, BME690_PARALLEL_MODE, &heat) != 0 ||
		    bme690_set_op_mode(d, BME690_PARALLEL_MODE) != 0) {
			LOG_ERR("sensor %d configuration failed", i);
			d->chip_id = 0;
			found--;
		}
	}

	LOG_INF("%d sensors scanning, shared heater duration %u ms",
		found, heat.shared_heatr_dur);
	printk("# sensor,t_ms,temp_C,press_hPa,hum_pct,gas_ohm,step,heat_stable\n");

	int64_t t0 = k_uptime_get();

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

				/* The sensor measures once per time base, so a
				 * step lasting N time bases yields N readings
				 * with the same index. AI-Studio wants exactly
				 * one point per step, so emit the last reading
				 * of each step -- the heater has then been
				 * longest at that temperature. */
				if (have_pending[i] &&
				    pending[i].gas_index != got[j].gas_index) {
					emit(i, &pending[i], k_uptime_get() - t0);
				}
				pending[i] = got[j];
				have_pending[i] = true;
			}
		}
		k_msleep(POLL_MS);
	}
	return 0;
}
