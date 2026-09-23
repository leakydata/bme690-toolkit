/* Heater and duty-cycle configuration, in AI-Studio's own terms.
 * SPDX-License-Identifier: MIT */
#ifndef CONFIG_H_
#define CONFIG_H_

#include "board.h"
#include "bme690.h"
#include "cJSON.h"
#include <stdbool.h>
#include <stdint.h>

#define CFG_MAX_PROFILES 8
#define CFG_ID_LEN       40
#define CONFIG_MAX_BYTES (32 * 1024)

struct heater_profile {
	char     id[CFG_ID_LEN];
	uint16_t time_base_ms;
	uint16_t temp[BME690_PROFILE_LEN];   /* degC */
	uint16_t dur[BME690_PROFILE_LEN];    /* multiples of time_base_ms */
};

struct duty_cycle_profile {
	char     id[CFG_ID_LEN];
	uint16_t scanning_cycles;
	uint16_t sleeping_cycles;
};

struct sensor_config {
	bool    active;
	uint8_t heater;   /* index into heater[] */
	uint8_t duty;     /* index into duty[] */
};

struct board_config {
	char   name[64];      /* what the dashboard shows */
	char   source[64];    /* "default" or the file it came from */
	char   board_mode[40];
	int    n_heater, n_duty;
	struct heater_profile     heater[CFG_MAX_PROFILES];
	struct duty_cycle_profile duty[CFG_MAX_PROFILES];
	struct sensor_config      sensor[NUM_SENSORS];
};

/* HP-354 with continuous scanning on all eight sensors: the shuttle board's
 * factory default, and what AI-Studio calls "Sensorboard Default HP". */
void config_default(struct board_config *cfg);

/* Bosch's stabilization profile for factory-new sensors, on all eight. */
void config_stabilization(struct board_config *cfg);

/* Parse the text of an AI-Studio .bmeconfig; name is what to call it. On
 * failure cfg is untouched and err holds a sentence a novice can act on. */
int config_parse(const char *text, const char *name, struct board_config *cfg,
		 char *err, size_t errlen);

/* Load an AI-Studio .bmeconfig. On failure cfg is untouched and err holds a
 * sentence a novice can act on. */
int config_load_file(const char *path, struct board_config *cfg,
		     char *err, size_t errlen);

/* Milliseconds per full heater cycle for one profile. */
uint32_t config_cycle_ms(const struct heater_profile *hp);

/* {"configHeader":...,"configBody":...} exactly as a .bmerawdata carries
 * them. Caller frees. */
cJSON *config_to_json(const struct board_config *cfg, const char *date_iso);

#endif /* CONFIG_H_ */
