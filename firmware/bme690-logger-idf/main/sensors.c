/* The eight sensors: bring-up, diagnosis and scanning.
 *
 * Every sensor runs in parallel mode, walking its own ten-step heater profile
 * autonomously and tagging each result with the step index, so the MCU only
 * has to poll often enough not to miss a step. Sensors can have different
 * profiles and duty cycles; each is scheduled on its own.
 *
 * SPDX-License-Identifier: MIT */
#include "sensors.h"
#include "bme690_idf.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_task_wdt.h"
#include <string.h>

#define POLL_MS            40
#define SPI_HZ             5000000
#define RETRY_LOST_US      (3 * 1000000LL)
#define HEALTH_CHECK_US    (2 * 1000000LL)
#define VARIANT_BME690     0x02   /* BME690_VARIANT_GAS_HIGH in Bosch's API */

static const char *TAG = "sensors";

static const struct bme690_conf meas_conf = {
	.os_hum = BME690_OS_1X,
	.os_temp = BME690_OS_2X,
	.os_pres = BME690_OS_16X,
	.filter = BME690_FILTER_OFF,
	.odr = BME690_ODR_NONE,
};

struct slot {
	struct bme690_dev     dev;
	struct bme690_idf_ctx ctx;
	struct sensor_info    info;      /* shared: take lock */

	/* scanning state, sensor task only */
	uint8_t  last_meas;
	bool     have_last_meas;
	struct bme690_data pending;
	bool     have_pending;
	uint32_t scans_left;             /* cycles before the duty-cycle rest */
	int64_t  sleep_until_us;
	int64_t  last_new_us;
	int64_t  next_check_us;
	int64_t  stale_us;               /* no new data for this long = lost */
};

static struct board_config cfg;
static struct slot slots[NUM_SENSORS];
static reading_sink sink;
static SemaphoreHandle_t lock;
static volatile bool rescan_requested;
static struct board_config pending_cfg;
static volatile bool cfg_pending;
static volatile uint32_t rescans_done;
static volatile uint32_t generation;

static void set_state(struct slot *s, enum sensor_state st)
{
	xSemaphoreTake(lock, portMAX_DELAY);
	if (s->info.state != st) {
		s->info.state = st;
		generation++;
	}
	xSemaphoreGive(lock);
}

static const struct heater_profile *profile_of(int i)
{
	return &cfg.heater[cfg.sensor[i].heater];
}

static const struct duty_cycle_profile *duty_of(int i)
{
	return &cfg.duty[cfg.sensor[i].duty];
}

/* Chip id, variant and calibration; classifies what came back so the
 * dashboard can say which wire to check. */
static enum probe_result probe(struct slot *s)
{
	int rc = bme690_init(&s->dev);

	if (rc == 0) {
		return s->dev.variant_id == VARIANT_BME690 ? PROBE_OK : PROBE_WRONG_PART;
	}
	if (rc != BME690_E_NOT_FOUND) {
		return PROBE_GARBLED;
	}
	switch (s->dev.chip_id) {
	case 0xFF: return PROBE_NO_ANSWER;
	case 0x00: return PROBE_STUCK_LOW;
	default:   return PROBE_GARBLED;
	}
}

static int configure(int i)
{
	struct slot *s = &slots[i];
	const struct heater_profile *hp = profile_of(i);
	struct bme690_heatr_conf heat = { .enable = true };
	uint32_t meas_ms = bme690_get_meas_dur_us(&meas_conf, BME690_PARALLEL_MODE) / 1000U;
	uint16_t longest = 0;

	if (hp->time_base_ms <= meas_ms) {
		ESP_LOGE(TAG, "profile %s: time base %u ms is shorter than a measurement (%u ms)",
			 hp->id, hp->time_base_ms, (unsigned)meas_ms);
		return -1;
	}
	heat.shared_heatr_dur = hp->time_base_ms - meas_ms;
	memcpy(heat.temp_prof, hp->temp, sizeof(heat.temp_prof));
	memcpy(heat.dur_prof, hp->dur, sizeof(heat.dur_prof));
	for (int k = 0; k < BME690_PROFILE_LEN; k++) {
		longest = hp->dur[k] > longest ? hp->dur[k] : longest;
	}

	if (bme690_set_conf(&s->dev, &meas_conf) != 0 ||
	    bme690_set_heatr_conf(&s->dev, BME690_PARALLEL_MODE, &heat) != 0 ||
	    bme690_set_op_mode(&s->dev, BME690_PARALLEL_MODE) != 0) {
		return -1;
	}

	s->have_last_meas = false;
	s->have_pending = false;
	s->scans_left = duty_of(i)->scanning_cycles;
	s->sleep_until_us = 0;
	s->last_new_us = esp_timer_get_time();
	s->next_check_us = s->last_new_us + HEALTH_CHECK_US;
	/* The longest step yields one reading per time base, so silence
	 * longer than a few steps means the sensor has gone. */
	s->stale_us = (int64_t)(3 * longest * hp->time_base_ms + 2000) * 1000;
	return 0;
}

static void bring_up(void)
{
	/* Every chip select idles high before anything is probed: a floating
	 * CSB can select a second sensor and garble the first one's reply. */
	for (int i = 0; i < NUM_SENSORS; i++) {
		gpio_config_t io = {
			.pin_bit_mask = 1ULL << sensor_slots[i].cs,
			.mode = GPIO_MODE_OUTPUT,
		};

		gpio_config(&io);
		gpio_set_level(sensor_slots[i].cs, 1);
	}

	for (int i = 0; i < NUM_SENSORS; i++) {
		struct slot *s = &slots[i];
		struct sensor_info info = { .duplicate_of = -1 };

		s->dev.index = i;
		s->dev.amb_temp = 25;
		bme690_idf_attach(&s->dev, &s->ctx, SENSOR_SPI_HOST,
				  sensor_slots[i].cs, SPI_HZ);
		info.probe = probe(s);
		info.chip_id = s->dev.chip_id;
		info.variant_id = s->dev.variant_id;
		info.par_t1 = info.probe == PROBE_OK ? s->dev.calib.par_t1 : 0;

		/* Two slots returning identical factory calibration are the
		 * same chip: two chip-select wires landed on one shuttle pin. */
		for (int j = 0; j < i && info.probe == PROBE_OK; j++) {
			if (slots[j].info.probe == PROBE_OK &&
			    memcmp(&slots[j].dev.calib, &s->dev.calib, sizeof(s->dev.calib)) == 0) {
				info.probe = PROBE_DUPLICATE;
				info.duplicate_of = j;
			}
		}

		if (!cfg.sensor[i].active) {
			info.state = SENSOR_INACTIVE;
		} else if (info.probe != PROBE_OK) {
			info.state = SENSOR_MISSING;
		} else if (configure(i) != 0) {
			info.probe = PROBE_CONFIG_FAILED;
			info.state = SENSOR_MISSING;
		} else {
			info.state = SENSOR_OK;
		}

		xSemaphoreTake(lock, portMAX_DELAY);
		s->info = info;
		generation++;
		xSemaphoreGive(lock);

		printf("  sensor %d (%s, %s -> GPIO%d)  %s  chip 0x%02x variant %u par_t1=%u\n",
		       i, sensor_slots[i].part, sensor_slots[i].shuttle_pin,
		       sensor_slots[i].cs,
		       info.state == SENSOR_OK ? "OK" :
		       info.state == SENSOR_INACTIVE ? "off" : "--",
		       info.chip_id, info.variant_id, info.par_t1);
	}
}

static bool plausible(const struct reading *r)
{
	return r->temp > -40.0f && r->temp < 85.0f &&
	       r->press > 300.0f && r->press < 1100.0f &&
	       r->hum >= 0.0f && r->hum <= 100.0f &&
	       r->gas > 100.0f && r->gas < 1.0e9f;
}

static void emit(int i, const struct bme690_data *d)
{
	struct slot *s = &slots[i];
	struct reading r = {
		.sensor = i,
		.step = d->gas_index,
		.stable = (d->status & BME690_STATUS_HEAT_STAB) != 0,
		.ms = (uint32_t)(esp_timer_get_time() / 1000),
		.temp = d->temperature,
		.press = d->pressure / 100.0f,
		.hum = d->humidity,
		.gas = d->gas_resistance,
	};

	xSemaphoreTake(lock, portMAX_DELAY);
	s->info.steps++;
	s->info.stable_steps += r.stable;
	s->info.implausible += !plausible(&r);
	s->info.cycles += r.step == BME690_PROFILE_LEN - 1;
	s->info.last = r;
	s->info.have_last = true;
	xSemaphoreGive(lock);

	if (sink) {
		sink(&r);
	}
}

/* A sensor that stops answering reads back 0xFF (or 0x00) from every
 * register, so its mode register stops saying "parallel". */
static bool still_there(struct slot *s)
{
	uint8_t mode = 0xFF;

	return bme690_get_op_mode(&s->dev, &mode) == 0 &&
	       mode == BME690_PARALLEL_MODE;
}

static void mark_lost(int i)
{
	struct slot *s = &slots[i];

	ESP_LOGW(TAG, "sensor %d (%s) stopped answering", i, sensor_slots[i].part);
	xSemaphoreTake(lock, portMAX_DELAY);
	s->info.lost_count++;
	xSemaphoreGive(lock);
	set_state(s, SENSOR_LOST);
	s->next_check_us = esp_timer_get_time() + RETRY_LOST_US;
}

static void try_recover(int i)
{
	struct slot *s = &slots[i];

	if (probe(s) == PROBE_OK && s->dev.calib.par_t1 == s->info.par_t1 &&
	    configure(i) == 0) {
		ESP_LOGI(TAG, "sensor %d (%s) is back", i, sensor_slots[i].part);
		set_state(s, SENSOR_OK);
	} else {
		s->next_check_us = esp_timer_get_time() + RETRY_LOST_US;
	}
}

static void poll(int i, int64_t now)
{
	struct slot *s = &slots[i];
	const struct duty_cycle_profile *dc = duty_of(i);
	struct bme690_data got[3];
	uint8_t n = 0;

	if (bme690_get_data(&s->dev, BME690_PARALLEL_MODE, got, &n) != 0) {
		n = 0;
	}
	for (int j = 0; j < n; j++) {
		/* A sensor dropping off the bus reads back all ones, whose
		 * step index is out of range; the health check names it. */
		if (got[j].gas_index >= BME690_PROFILE_LEN ||
		    (s->have_last_meas && got[j].meas_index == s->last_meas)) {
			continue;
		}
		s->last_meas = got[j].meas_index;
		s->have_last_meas = true;
		s->last_new_us = now;

		/* One point per heater step: a step lasting N time bases
		 * yields N readings with the same index. Keep the last -- the
		 * heater has then been longest at that temperature. */
		if (s->have_pending && s->pending.gas_index != got[j].gas_index) {
			emit(i, &s->pending);

			/* Step 0 arriving closes a cycle. After the configured
			 * number of scanning cycles, rest. */
			if (got[j].gas_index == 0 && dc->sleeping_cycles > 0 &&
			    --s->scans_left == 0) {
				bme690_set_op_mode(&s->dev, BME690_SLEEP_MODE);
				s->have_pending = false;
				s->sleep_until_us = now + (int64_t)dc->sleeping_cycles *
					config_cycle_ms(profile_of(i)) * 1000;
				set_state(s, SENSOR_SLEEPING);
				return;
			}
		}
		s->pending = got[j];
		s->have_pending = true;
	}

	if (now >= s->next_check_us) {
		s->next_check_us = now + HEALTH_CHECK_US;
		if (!still_there(s) || now - s->last_new_us > s->stale_us) {
			mark_lost(i);
		}
	}
}

static void sensor_task(void *arg)
{
	/* The task watchdog restarts the board if this loop ever stops -- a
	 * frozen board that keeps its sensors silent helps nobody. */
	esp_task_wdt_add(NULL);
	bring_up();

	for (;;) {
		int64_t now;

		if (rescan_requested) {
			rescan_requested = false;
			if (cfg_pending) {
				cfg = pending_cfg;
				cfg_pending = false;
				printf("\nheater configuration: %s\n", cfg.name);
			}
			printf("\n--- re-checking sensors ---\n");
			bring_up();
			rescans_done++;
		}

		now = esp_timer_get_time();
		for (int i = 0; i < NUM_SENSORS; i++) {
			struct slot *s = &slots[i];

			switch (s->info.state) {
			case SENSOR_OK:
				poll(i, now);
				break;
			case SENSOR_SLEEPING:
				if (now >= s->sleep_until_us) {
					if (configure(i) == 0) {
						set_state(s, SENSOR_OK);
					} else {
						mark_lost(i);
					}
				}
				break;
			case SENSOR_LOST:
				if (now >= s->next_check_us) {
					try_recover(i);
				}
				break;
			default:
				break;
			}
		}
		esp_task_wdt_reset();
		vTaskDelay(pdMS_TO_TICKS(POLL_MS));
	}
}

void sensors_start(const struct board_config *config, reading_sink s)
{
	spi_bus_config_t bus = {
		.sclk_io_num = PIN_SCK,
		.mosi_io_num = PIN_MOSI,
		.miso_io_num = PIN_MISO,
		.quadwp_io_num = -1,
		.quadhd_io_num = -1,
		.max_transfer_sz = 128,
	};

	cfg = *config;
	sink = s;
	lock = xSemaphoreCreateMutex();
	ESP_ERROR_CHECK(spi_bus_initialize(SENSOR_SPI_HOST, &bus, SPI_DMA_CH_AUTO));
	/* With SDO disconnected, MISO floats and reads random bytes; the
	 * pull-up turns that into a clean 0xFF the diagnosis can name. */
	gpio_pullup_en(PIN_MISO);

	xTaskCreate(sensor_task, "sensors", 6144, NULL, 5, NULL);
}

void sensors_request_rescan(void)
{
	rescan_requested = true;
}

int sensors_set_config(const struct board_config *c)
{
	uint32_t before = rescans_done;

	pending_cfg = *c;
	cfg_pending = true;
	rescan_requested = true;
	/* Bring-up of eight sensors takes well under a second. */
	for (int i = 0; i < 50 && rescans_done == before; i++) {
		vTaskDelay(pdMS_TO_TICKS(100));
	}
	return rescans_done == before ? -1 : 0;
}

void sensors_get(int idx, struct sensor_info *out)
{
	xSemaphoreTake(lock, portMAX_DELAY);
	*out = slots[idx].info;
	xSemaphoreGive(lock);
}

uint32_t sensors_generation(void)
{
	return generation;
}

const struct board_config *sensors_config(void)
{
	return &cfg;
}
