/* Heater and duty-cycle configuration.
 *
 * AI-Studio's "Save board configuration" writes a .bmeconfig whose
 * configHeader/configBody are the same objects a .bmerawdata carries, so one
 * parser and one renderer cover both.
 *
 * SPDX-License-Identifier: MIT */
#include "config.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_HEATER_TEMP 400

static const uint16_t hp354_temp[BME690_PROFILE_LEN] = {
	320, 100, 100, 100, 200, 200, 200, 320, 320, 320,
};
static const uint16_t hp354_dur[BME690_PROFILE_LEN] = {
	5, 2, 10, 30, 5, 5, 5, 5, 5, 5,
};

void config_default(struct board_config *cfg)
{
	memset(cfg, 0, sizeof(*cfg));
	strcpy(cfg->name, "HP-354, continuous (factory default)");
	strcpy(cfg->source, "default");
	strcpy(cfg->board_mode, "burn_in");   /* AI-Studio's name for this default */

	cfg->n_heater = 1;
	strcpy(cfg->heater[0].id, "heater_354");
	cfg->heater[0].time_base_ms = 140;
	memcpy(cfg->heater[0].temp, hp354_temp, sizeof(hp354_temp));
	memcpy(cfg->heater[0].dur, hp354_dur, sizeof(hp354_dur));

	cfg->n_duty = 1;
	strcpy(cfg->duty[0].id, "duty_1");
	cfg->duty[0].scanning_cycles = 1;
	cfg->duty[0].sleeping_cycles = 0;

	for (int i = 0; i < NUM_SENSORS; i++) {
		cfg->sensor[i] = (struct sensor_config){ .active = true };
	}
}

void config_stabilization(struct board_config *cfg)
{
	/* Bosch's HP-001 is ten steps of 320 C lasting 429 time bases each. A
	 * step's duration register is one byte, so each step is capped at 255;
	 * every step is the same temperature, so the heater still sits at
	 * 320 C throughout -- only the nominal cycle length changes. */
	config_default(cfg);
	strcpy(cfg->name, "Burn-in: HP-001, 320 C constant");
	strcpy(cfg->source, "burn-in");
	strcpy(cfg->board_mode, "sensor_stabilization");
	strcpy(cfg->heater[0].id, "heater_stab");
	for (int i = 0; i < BME690_PROFILE_LEN; i++) {
		cfg->heater[0].temp[i] = 320;
		cfg->heater[0].dur[i] = 255;
	}
}

uint32_t config_cycle_ms(const struct heater_profile *hp)
{
	uint32_t units = 0;

	for (int i = 0; i < BME690_PROFILE_LEN; i++) {
		units += hp->dur[i];
	}
	return units * hp->time_base_ms;
}

static int find_heater(const struct board_config *cfg, const char *id)
{
	for (int i = 0; i < cfg->n_heater; i++) {
		if (strcmp(cfg->heater[i].id, id) == 0) {
			return i;
		}
	}
	return -1;
}

static int find_duty(const struct board_config *cfg, const char *id)
{
	for (int i = 0; i < cfg->n_duty; i++) {
		if (strcmp(cfg->duty[i].id, id) == 0) {
			return i;
		}
	}
	return -1;
}

#define FAIL(...) do { snprintf(err, errlen, __VA_ARGS__); goto out; } while (0)

static int parse(cJSON *root, struct board_config *out, char *err, size_t errlen)
{
	cJSON *hdr = cJSON_GetObjectItem(root, "configHeader");
	cJSON *body = cJSON_GetObjectItem(root, "configBody");
	cJSON *hps, *dcs, *scs, *it;
	int rc = -1;

	if (!cJSON_IsObject(body)) {
		FAIL("it has no configBody; save it again from AI-Studio's board configuration page");
	}
	if (cJSON_IsObject(hdr)) {
		cJSON *bt = cJSON_GetObjectItem(hdr, "boardType");
		cJSON *bm = cJSON_GetObjectItem(hdr, "boardMode");

		if (cJSON_IsString(bt) && strcmp(bt->valuestring, "board_690") != 0) {
			FAIL("it was made for board type \"%s\"; choose \"BME690 8x Shuttle board\" in AI-Studio",
			     bt->valuestring);
		}
		if (cJSON_IsString(bm)) {
			snprintf(out->board_mode, sizeof(out->board_mode), "%s", bm->valuestring);
		}
	}

	hps = cJSON_GetObjectItem(body, "heaterProfiles");
	cJSON_ArrayForEach(it, hps) {
		struct heater_profile *hp;
		cJSON *id = cJSON_GetObjectItem(it, "id");
		cJSON *tb = cJSON_GetObjectItem(it, "timeBase");
		cJSON *vec = cJSON_GetObjectItem(it, "temperatureTimeVectors");

		if (out->n_heater == CFG_MAX_PROFILES) {
			FAIL("it has more than %d heater profiles", CFG_MAX_PROFILES);
		}
		hp = &out->heater[out->n_heater];
		if (!cJSON_IsString(id) || !cJSON_IsNumber(tb) || !cJSON_IsArray(vec)) {
			FAIL("heater profile %d is incomplete", out->n_heater + 1);
		}
		snprintf(hp->id, sizeof(hp->id), "%s", id->valuestring);
		if (tb->valueint < 1 || tb->valueint > 5000) {
			FAIL("heater profile \"%s\" has a time base of %d ms", hp->id, tb->valueint);
		}
		hp->time_base_ms = tb->valueint;
		if (cJSON_GetArraySize(vec) != BME690_PROFILE_LEN) {
			FAIL("heater profile \"%s\" has %d steps; AI-Studio needs exactly %d",
			     hp->id, cJSON_GetArraySize(vec), BME690_PROFILE_LEN);
		}
		for (int s = 0; s < BME690_PROFILE_LEN; s++) {
			cJSON *pair = cJSON_GetArrayItem(vec, s);
			cJSON *t = cJSON_GetArrayItem(pair, 0);
			cJSON *d = cJSON_GetArrayItem(pair, 1);

			if (!cJSON_IsNumber(t) || !cJSON_IsNumber(d)) {
				FAIL("step %d of heater profile \"%s\" is not [temperature, duration]",
				     s + 1, hp->id);
			}
			if (t->valueint < 0 || t->valueint > MAX_HEATER_TEMP) {
				FAIL("step %d of heater profile \"%s\" asks for %d C; the limit is %d C",
				     s + 1, hp->id, t->valueint, MAX_HEATER_TEMP);
			}
			if (d->valueint < 1 || d->valueint > 255) {
				FAIL("step %d of heater profile \"%s\" lasts %d time bases; use 1 to 255",
				     s + 1, hp->id, d->valueint);
			}
			hp->temp[s] = t->valueint;
			hp->dur[s] = d->valueint;
		}
		out->n_heater++;
	}
	if (out->n_heater == 0) {
		FAIL("it has no heater profiles");
	}

	dcs = cJSON_GetObjectItem(body, "dutyCycleProfiles");
	cJSON_ArrayForEach(it, dcs) {
		struct duty_cycle_profile *dc;
		cJSON *id = cJSON_GetObjectItem(it, "id");
		cJSON *sc = cJSON_GetObjectItem(it, "numberScanningCycles");
		cJSON *sl = cJSON_GetObjectItem(it, "numberSleepingCycles");

		if (out->n_duty == CFG_MAX_PROFILES) {
			FAIL("it has more than %d duty cycle profiles", CFG_MAX_PROFILES);
		}
		dc = &out->duty[out->n_duty];
		if (!cJSON_IsString(id) || !cJSON_IsNumber(sc) || !cJSON_IsNumber(sl) ||
		    sc->valueint < 1 || sl->valueint < 0) {
			FAIL("duty cycle profile %d is incomplete", out->n_duty + 1);
		}
		snprintf(dc->id, sizeof(dc->id), "%s", id->valuestring);
		dc->scanning_cycles = sc->valueint;
		dc->sleeping_cycles = sl->valueint;
		out->n_duty++;
	}
	if (out->n_duty == 0) {
		FAIL("it has no duty cycle profiles");
	}

	scs = cJSON_GetObjectItem(body, "sensorConfigurations");
	cJSON_ArrayForEach(it, scs) {
		cJSON *idx = cJSON_GetObjectItem(it, "sensorIndex");
		cJSON *act = cJSON_GetObjectItem(it, "active");
		cJSON *hp = cJSON_GetObjectItem(it, "heaterProfile");
		cJSON *dc = cJSON_GetObjectItem(it, "dutyCycleProfile");
		struct sensor_config *s;
		int h, d;

		if (!cJSON_IsNumber(idx) || idx->valueint < 0 || idx->valueint >= NUM_SENSORS) {
			FAIL("a sensor configuration has no valid sensorIndex (0 to 7)");
		}
		s = &out->sensor[idx->valueint];
		if (!cJSON_IsString(hp) || !cJSON_IsString(dc)) {
			FAIL("sensor %d has no heater or duty cycle profile", idx->valueint);
		}
		h = find_heater(out, hp->valuestring);
		d = find_duty(out, dc->valuestring);
		if (h < 0) {
			FAIL("sensor %d uses heater profile \"%s\", which the file does not define",
			     idx->valueint, hp->valuestring);
		}
		if (d < 0) {
			FAIL("sensor %d uses duty cycle \"%s\", which the file does not define",
			     idx->valueint, dc->valuestring);
		}
		/* Files older than BST format 1.1 have no "active"; AI-Studio
		 * treats those as active and so do we. */
		s->active = !cJSON_IsFalse(act);
		s->heater = h;
		s->duty = d;
	}
	rc = 0;
out:
	return rc;
}

int config_parse(const char *text, const char *name, struct board_config *cfg,
		 char *err, size_t errlen)
{
	struct board_config tmp;
	cJSON *root = cJSON_Parse(text);
	int rc = -1;

	if (!root) {
		snprintf(err, errlen, "it is not valid JSON");
		return -1;
	}
	memset(&tmp, 0, sizeof(tmp));
	strcpy(tmp.board_mode, "heater_profile_exploration");
	if (parse(root, &tmp, err, errlen) == 0) {
		snprintf(tmp.source, sizeof(tmp.source), "%s", name);
		snprintf(tmp.name, sizeof(tmp.name), "%s", name);
		*cfg = tmp;
		rc = 0;
	}
	cJSON_Delete(root);
	return rc;
}

int config_load_file(const char *path, struct board_config *cfg,
		     char *err, size_t errlen)
{
	const char *base = strrchr(path, '/');
	FILE *f = fopen(path, "r");
	char *buf = NULL;
	long len;
	int rc = -1;

	base = base ? base + 1 : path;
	if (!f) {
		snprintf(err, errlen, "cannot open it");
		return -1;
	}
	fseek(f, 0, SEEK_END);
	len = ftell(f);
	fseek(f, 0, SEEK_SET);
	if (len <= 0 || len > CONFIG_MAX_BYTES) {
		snprintf(err, errlen, "it is %ld bytes, which is not a board configuration", len);
		goto out;
	}
	buf = malloc(len + 1);
	if (!buf || fread(buf, 1, len, f) != (size_t)len) {
		snprintf(err, errlen, "cannot read it");
		goto out;
	}
	buf[len] = '\0';
	rc = config_parse(buf, base, cfg, err, errlen);
out:
	free(buf);
	fclose(f);
	return rc;
}

cJSON *config_to_json(const struct board_config *cfg, const char *date_iso)
{
	cJSON *root = cJSON_CreateObject();
	cJSON *hdr = cJSON_AddObjectToObject(root, "configHeader");
	cJSON *body = cJSON_AddObjectToObject(root, "configBody");
	cJSON *hps = cJSON_AddArrayToObject(body, "heaterProfiles");
	cJSON *dcs = cJSON_AddArrayToObject(body, "dutyCycleProfiles");
	cJSON *scs = cJSON_AddArrayToObject(body, "sensorConfigurations");

	cJSON_AddStringToObject(hdr, "dateCreated", date_iso);
	cJSON_AddStringToObject(hdr, "appVersion", "bme690-logger-idf " FW_VERSION);
	cJSON_AddStringToObject(hdr, "boardType", "board_690");
	cJSON_AddStringToObject(hdr, "boardMode", cfg->board_mode);
	cJSON_AddStringToObject(hdr, "boardLayout", "");

	for (int i = 0; i < cfg->n_heater; i++) {
		const struct heater_profile *hp = &cfg->heater[i];
		cJSON *o = cJSON_CreateObject();
		cJSON *vec = cJSON_AddArrayToObject(o, "temperatureTimeVectors");

		cJSON_AddStringToObject(o, "id", hp->id);
		cJSON_AddNumberToObject(o, "timeBase", hp->time_base_ms);
		for (int s = 0; s < BME690_PROFILE_LEN; s++) {
			int pair[2] = { hp->temp[s], hp->dur[s] };

			cJSON_AddItemToArray(vec, cJSON_CreateIntArray(pair, 2));
		}
		cJSON_AddItemToArray(hps, o);
	}
	for (int i = 0; i < cfg->n_duty; i++) {
		cJSON *o = cJSON_CreateObject();

		cJSON_AddStringToObject(o, "id", cfg->duty[i].id);
		cJSON_AddNumberToObject(o, "numberScanningCycles", cfg->duty[i].scanning_cycles);
		cJSON_AddNumberToObject(o, "numberSleepingCycles", cfg->duty[i].sleeping_cycles);
		cJSON_AddItemToArray(dcs, o);
	}
	for (int i = 0; i < NUM_SENSORS; i++) {
		const struct sensor_config *s = &cfg->sensor[i];
		cJSON *o = cJSON_CreateObject();

		cJSON_AddNumberToObject(o, "sensorIndex", i);
		cJSON_AddBoolToObject(o, "active", s->active);
		cJSON_AddStringToObject(o, "heaterProfile", cfg->heater[s->heater].id);
		cJSON_AddStringToObject(o, "dutyCycleProfile", cfg->duty[s->duty].id);
		cJSON_AddItemToArray(scs, o);
	}
	return root;
}
