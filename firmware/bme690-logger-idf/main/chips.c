/* Which chip belongs in which slot. See chips.h.
 * SPDX-License-Identifier: MIT */
#include "chips.h"
#include "board.h"
#include "esp_log.h"
#include "nvs.h"
#include <stdio.h>
#include <string.h>
#include <time.h>

#define NS  "bme690"
#define KEY "chips"

static const char *TAG = "chips";

struct saved {
	uint16_t par_t1[NUM_SENSORS];
	int64_t  at;
};

static struct saved ref;
static bool known;

void chips_load(void)
{
	nvs_handle_t h;
	size_t len = sizeof(ref);

	known = false;
	if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) {
		return;
	}
	if (nvs_get_blob(h, KEY, &ref, &len) == ESP_OK && len == sizeof(ref)) {
		known = true;
	}
	nvs_close(h);
}

bool chips_known(void)
{
	return known;
}

uint16_t chips_expected(int slot)
{
	return known && slot >= 0 && slot < NUM_SENSORS ? ref.par_t1[slot] : 0;
}

int64_t chips_saved_at(void)
{
	return known ? ref.at : 0;
}

static int store(const struct saved *s)
{
	nvs_handle_t h;
	esp_err_t e = nvs_open(NS, NVS_READWRITE, &h);

	if (e != ESP_OK) {
		return -1;
	}
	e = s ? nvs_set_blob(h, KEY, s, sizeof(*s)) : nvs_erase_key(h, KEY);
	if (e == ESP_OK || e == ESP_ERR_NVS_NOT_FOUND) {
		e = nvs_commit(h);
	}
	nvs_close(h);
	return e == ESP_OK ? 0 : -1;
}

int chips_remember(const struct sensor_info *info, char *err, size_t errlen)
{
	struct saved s = { .at = time(NULL) > 1700000000 ? (int64_t)time(NULL) : 0 };

	for (int i = 0; i < NUM_SENSORS; i++) {
		if (info[i].state == SENSOR_INACTIVE) {
			continue;
		}
		if (info[i].probe != PROBE_OK || info[i].par_t1 == 0) {
			snprintf(err, errlen, "Sensor %d (%s) isn't answering, so there is nothing to remember for "
				 "it. Fix its wiring first, press Re-check sensors, then try again.",
				 i, sensor_slots[i].part);
			return -1;
		}
		s.par_t1[i] = info[i].par_t1;
	}
	if (store(&s) != 0) {
		snprintf(err, errlen, "Could not save to the board's settings memory.");
		return -1;
	}
	ref = s;
	known = true;
	ESP_LOGI(TAG, "remembered the chip in every slot");
	return 0;
}

int chips_forget(void)
{
	if (store(NULL) != 0) {
		return -1;
	}
	memset(&ref, 0, sizeof(ref));
	known = false;
	return 0;
}
