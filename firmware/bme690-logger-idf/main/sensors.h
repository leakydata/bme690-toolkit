/* The eight sensors: bring-up, diagnosis and scanning.
 * SPDX-License-Identifier: MIT */
#ifndef SENSORS_H_
#define SENSORS_H_

#include "config.h"
#include <stdbool.h>
#include <stdint.h>

struct reading {
	uint8_t  sensor;
	uint8_t  step;       /* heater profile step, 0..9 */
	bool     stable;     /* heater reached its target */
	uint32_t ms;         /* since power-on */
	float    temp;       /* degC */
	float    press;      /* hPa */
	float    hum;        /* %RH */
	float    gas;        /* ohm */
};

/* What the chip-id probe saw on one chip select. */
enum probe_result {
	PROBE_OK,
	PROBE_NO_ANSWER,     /* 0xFF: nothing drove SDO */
	PROBE_STUCK_LOW,     /* 0x00: SDO held low */
	PROBE_GARBLED,       /* some other byte */
	PROBE_WRONG_PART,    /* chip id 0x61 but a BME680/688, not a BME690 */
	PROBE_DUPLICATE,     /* same chip as another slot: two CS wires on one pin */
	PROBE_CONFIG_FAILED, /* answered, but would not take the heater profile */
};

enum sensor_state {
	SENSOR_INACTIVE,     /* switched off in the board configuration */
	SENSOR_MISSING,      /* did not answer at bring-up */
	SENSOR_OK,
	SENSOR_SLEEPING,     /* duty cycle rest period */
	SENSOR_LOST,         /* answered, then stopped */
};

struct sensor_info {
	enum sensor_state state;
	enum probe_result probe;
	uint8_t  chip_id, variant_id;
	uint16_t par_t1;          /* factory calibration: identifies the chip */
	int      duplicate_of;    /* for PROBE_DUPLICATE */
	uint32_t cycles;          /* complete heater cycles */
	uint32_t steps, stable_steps;
	uint32_t implausible;     /* readings outside physical limits */
	uint32_t lost_count;      /* times it dropped out and came back */
	bool     have_last;
	struct reading last;
};

typedef void (*reading_sink)(const struct reading *r);

/* Probe, configure and start scanning in a task of its own. Readings go to
 * sink one per heater step, from the sensor task. */
void sensors_start(const struct board_config *cfg, reading_sink sink);

/* Re-probe everything and restart scanning, from the sensor task. */
void sensors_request_rescan(void);

/* Switch heater configuration: the sensor task re-probes everything with
 * it. Blocks until that is done. */
int sensors_set_config(const struct board_config *cfg);

void sensors_get(int idx, struct sensor_info *out);

/* Bumps whenever any sensor changes state, so status pushes can be cheap. */
uint32_t sensors_generation(void);

const struct board_config *sensors_config(void);

#endif /* SENSORS_H_ */
