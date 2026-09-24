/* Board state and the commands every interface shares.
 *
 * Readings arrive from the sensor task and are handed to a sink task, which
 * prints them, writes them to the card and pushes them to the dashboard, so
 * a slow card write never delays a sensor poll.
 *
 * Everything a person might need to act on is turned into a plain-English
 * "problem" here, in one place, so the dashboard and the serial console
 * report the same diagnosis in the same words.
 *
 * SPDX-License-Identifier: MIT */
#include "app.h"
#include "board.h"
#include "net.h"
#include "ota.h"
#include "storage.h"
#include "ui.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#define QUEUE_LEN       128
#define MAX_LABELS      64
#define LABEL_NAME_LEN  48
#define LABEL_DESC_LEN  96
#define STATUS_EVERY_MS 2000
#define CLOCK_VALID     1700000000LL   /* anything earlier was never set */

static const char *TAG = "app";

struct label {
	uint16_t tag;
	char     name[LABEL_NAME_LEN];
	char     desc[LABEL_DESC_LEN];
};

static QueueHandle_t queue;
static SemaphoreHandle_t lock;
static struct label labels[MAX_LABELS];
static int n_labels;
static uint16_t cur_tag = 1;
static uint32_t dropped;
static char config_error[600];
static volatile bool notify_pending;

/* Burn-in borrows the sensors for some hours, then hands them back to the
 * configuration that was running before. */
static struct board_config before_burnin;
static bool burnin_on;
static int64_t burnin_end_ms;
static float burnin_hours;

static const char *const probe_names[] = {
	"ok", "no answer", "stuck low", "garbled", "wrong part", "duplicate",
	"config failed",
};

/* ------------------------------------------------------------ clock */

static bool clock_set(void)
{
	return time(NULL) > CLOCK_VALID;
}

static void iso_now(char *buf, size_t len)
{
	time_t now = time(NULL);
	struct tm tm;

	gmtime_r(&now, &tm);
	strftime(buf, len, "%Y-%m-%dT%H:%M:%S.000Z", &tm);
}

int app_set_time(int64_t unix)
{
	struct timeval tv = { .tv_sec = unix };

	if (unix < CLOCK_VALID) {
		return -1;
	}
	settimeofday(&tv, NULL);
	ESP_LOGI(TAG, "clock set to %lld", (long long)unix);
	app_notify();
	return 0;
}

/* ------------------------------------------------------------ labels */

static struct label *find_label(int tag)
{
	for (int i = 0; i < n_labels; i++) {
		if (labels[i].tag == tag) {
			return &labels[i];
		}
	}
	return NULL;
}

static struct label *ensure_label(int tag)
{
	struct label *l = find_label(tag);

	if (!l && n_labels < MAX_LABELS) {
		l = &labels[n_labels++];
		l->tag = tag;
		snprintf(l->name, sizeof(l->name), "sample %d", tag);
		l->desc[0] = '\0';
	}
	return l;
}

/* The .bmelabelinfo that sits beside every chunk. */
static void publish_labels(void)
{
	cJSON *root = cJSON_CreateObject();
	cJSON *arr = cJSON_AddArrayToObject(root, "labelInformation");
	char *txt;

	for (int i = 0; i < n_labels; i++) {
		cJSON *o = cJSON_CreateObject();

		cJSON_AddNumberToObject(o, "labelTag", labels[i].tag);
		cJSON_AddStringToObject(o, "labelName", labels[i].name);
		cJSON_AddStringToObject(o, "labelDescription", labels[i].desc);
		cJSON_AddItemToArray(arr, o);
	}
	txt = cJSON_Print(root);
	if (txt) {
		storage_set_labels(txt);
		cJSON_free(txt);
	}
	cJSON_Delete(root);
}

int app_label_set(int tag, const char *name, const char *desc, char *err, size_t errlen)
{
	struct label *l;

	if (tag < 1 || tag > 65535) {
		snprintf(err, errlen, "Label numbers run from 1 to 65535.");
		return -1;
	}
	xSemaphoreTake(lock, portMAX_DELAY);
	l = ensure_label(tag);
	if (!l) {
		xSemaphoreGive(lock);
		snprintf(err, errlen, "There are already %d labels; reuse one.", MAX_LABELS);
		return -1;
	}
	if (name && name[0]) {
		snprintf(l->name, sizeof(l->name), "%s", name);
	}
	if (desc) {
		snprintf(l->desc, sizeof(l->desc), "%s", desc);
	}
	cur_tag = tag;
	publish_labels();
	xSemaphoreGive(lock);
	ui_flash();
	app_notify();
	return 0;
}

int app_label_next(void)
{
	char err[64];
	int next = 0;

	xSemaphoreTake(lock, portMAX_DELAY);
	for (int i = 0; i < n_labels; i++) {
		next = labels[i].tag > next ? labels[i].tag : next;
	}
	xSemaphoreGive(lock);
	return app_label_set(next + 1, NULL, NULL, err, sizeof(err));
}

/* ------------------------------------------------------------ recording */

static const char *const column_keys[][4] = {
	/* name, unit, format, key -- the order storage_write prints */
	{ "Sensor Index", "", "integer", "sensor_index" },
	{ "Sensor ID", "", "integer", "sensor_id" },
	{ "Time Since PowerOn", "Milliseconds", "integer", "timestamp_since_poweron" },
	{ "Real time clock", "Unix Timestamp: seconds since Jan 01 1970. (UTC)", "integer",
	  "real_time_clock" },
	{ "Temperature", "DegreesCelcius", "float", "temperature" },
	{ "Pressure", "Hectopascals", "float", "pressure" },
	{ "Relative Humidity", "Percent", "float", "relative_humidity" },
	{ "Resistance Gassensor", "Ohms", "float", "resistance_gassensor" },
	{ "Heater Profile Step Index", "", "integer", "heater_profile_step_index" },
	{ "Scanning Mode Enabled", "", "boolean", "scanning_mode_enabled" },
	{ "Label Tag", "", "integer", "label_tag" },
	{ "Error Code", "", "integer", "error_code" },
};

cJSON *app_config_json(void)
{
	char iso[32];

	iso_now(iso, sizeof(iso));
	return config_to_json(sensors_config(), iso);
}

static char *recording_header(void)
{
	cJSON *root = app_config_json();
	cJSON *rh = cJSON_AddObjectToObject(root, "rawDataHeader");
	cJSON *body = cJSON_AddObjectToObject(root, "rawDataBody");
	cJSON *cols = cJSON_AddArrayToObject(body, "dataColumns");
	char iso[32];
	char *txt;

	iso_now(iso, sizeof(iso));
	cJSON_AddNumberToObject(rh, "counterPowerOnOff", 1);
	cJSON_AddStringToObject(rh, "seedPowerOnOff", "");
	cJSON_AddNumberToObject(rh, "counterFileLimit", 1);
	cJSON_AddStringToObject(rh, "dateCreated", iso);
	cJSON_AddStringToObject(rh, "firmwareVersion", "bme690-logger-idf " FW_VERSION);
	cJSON_AddStringToObject(rh, "boardId", net_board_name());

	for (size_t i = 0; i < sizeof(column_keys) / sizeof(column_keys[0]); i++) {
		cJSON *c = cJSON_CreateObject();

		cJSON_AddStringToObject(c, "name", column_keys[i][0]);
		cJSON_AddStringToObject(c, "unit", column_keys[i][1]);
		cJSON_AddStringToObject(c, "format", column_keys[i][2]);
		cJSON_AddStringToObject(c, "key", column_keys[i][3]);
		cJSON_AddItemToArray(cols, c);
	}
	/* Last, so storage can split the text around it. */
	cJSON_AddArrayToObject(body, "dataBlock");
	txt = cJSON_PrintUnformatted(root);
	cJSON_Delete(root);
	return txt;
}

int app_record(bool on, char *err, size_t errlen)
{
	struct storage_status st;
	char *hdr;
	int rc = 0;

	if (!on) {
		storage_stop();
		app_notify();
		return 0;
	}
	xSemaphoreTake(lock, portMAX_DELAY);
	publish_labels();
	xSemaphoreGive(lock);
	hdr = recording_header();
	if (!hdr || storage_start(hdr) != 0) {
		storage_get_status(&st);
		snprintf(err, errlen, "%s", st.error[0] ? st.error :
			 "Could not start recording.");
		rc = -1;
	}
	cJSON_free(hdr);
	ui_flash();
	app_notify();
	return rc;
}

bool app_recording(void)
{
	struct storage_status st;

	storage_get_status(&st);
	return st.recording;
}

/* Switch heater configuration, keeping it on the card so it survives a
 * restart. A recording in progress ends and a new session starts, because a
 * .bmerawdata carries exactly one configuration. */
static int switch_config(const struct board_config *c, char *err, size_t errlen)
{
	bool was_recording = app_recording();

	if (was_recording) {
		storage_stop();
	}
	if (sensors_set_config(c) != 0) {
		snprintf(err, errlen, "The sensors did not restart in time; press "
			 "\"Re-check sensors\".");
		return -1;
	}
	config_error[0] = '\0';
	if (was_recording && app_record(true, err, errlen) != 0) {
		return -1;
	}
	app_notify();
	return 0;
}

int app_apply_config(const char *text, const char *name, char *err, size_t errlen)
{
	struct board_config c;
	struct storage_status st;
	char why[160];
	FILE *f;

	if (burnin_on) {
		snprintf(err, errlen, "A burn-in is running. Stop it first, or wait for it to finish.");
		return -1;
	}
	if (config_parse(text, name, &c, why, sizeof(why)) != 0) {
		snprintf(err, errlen, "This heater configuration cannot be used: %s.", why);
		return -1;
	}
	storage_get_status(&st);
	if (st.present) {
		f = fopen(STORAGE_ROOT "/bme690.bmeconfig", "w");
		if (!f || fputs(text, f) < 0) {
			snprintf(err, errlen, "Could not save the configuration to the SD card.");
			if (f) {
				fclose(f);
			}
			return -1;
		}
		fclose(f);
	}
	return switch_config(&c, err, errlen);
}

int app_reset_config(char *err, size_t errlen)
{
	struct board_config c;
	char path[300];

	if (burnin_on) {
		snprintf(err, errlen, "A burn-in is running. Stop it first, or wait for it to finish.");
		return -1;
	}
	/* Every .bmeconfig in the card's root would be picked up again at the
	 * next boot, so remove them all. */
	while (storage_find_config(path, sizeof(path))) {
		if (unlink(path) != 0) {
			snprintf(err, errlen, "Could not remove %s from the SD card.", path);
			return -1;
		}
	}
	config_default(&c);
	return switch_config(&c, err, errlen);
}

static int64_t now_ms(void)
{
	return esp_timer_get_time() / 1000;
}

int app_burnin(bool on, float hours, char *err, size_t errlen)
{
	struct board_config c;
	struct storage_status st;
	int next = 0;

	if (!on) {
		if (!burnin_on) {
			return 0;
		}
		burnin_on = false;
		ESP_LOGI(TAG, "burn-in finished");
		if (switch_config(&before_burnin, err, errlen) != 0) {
			return -1;
		}
		return app_label_next();
	}
	if (burnin_on) {
		snprintf(err, errlen, "A burn-in is already running.");
		return -1;
	}
	if (hours < 0.1f || hours > 168.0f) {
		snprintf(err, errlen, "Choose between 0.1 and 168 hours; Bosch recommend at least 12.");
		return -1;
	}

	before_burnin = *sensors_config();
	config_stabilization(&c);
	xSemaphoreTake(lock, portMAX_DELAY);
	for (int i = 0; i < n_labels; i++) {
		next = labels[i].tag > next ? labels[i].tag : next;
	}
	xSemaphoreGive(lock);
	if (app_label_set(next + 1, "burn-in", "Sensor stabilization, Bosch HP-001 at 320 C",
			  err, errlen) != 0 ||
	    switch_config(&c, err, errlen) != 0) {
		return -1;
	}
	storage_get_status(&st);
	if (st.present && !st.recording) {
		app_record(true, err, errlen);
	}
	burnin_on = true;
	burnin_hours = hours;
	burnin_end_ms = now_ms() + (int64_t)(hours * 3600000.0f);
	ESP_LOGI(TAG, "burn-in started for %.1f h", hours);
	app_notify();
	return 0;
}

void app_rescan(void)
{
	sensors_request_rescan();
	app_notify();
}

/* ------------------------------------------------------------ readings */

void app_on_reading(const struct reading *r)
{
	if (xQueueSend(queue, r, 0) != pdTRUE) {
		dropped++;
	}
}

static void sink_task(void *arg)
{
	struct reading r;
	char line[200];

	for (;;) {
		uint16_t tag;
		int64_t unix;
		int n;

		if (xQueueReceive(queue, &r, portMAX_DELAY) != pdTRUE) {
			continue;
		}
		tag = cur_tag;
		unix = clock_set() ? (int64_t)time(NULL) : r.ms / 1000;

		/* The original line format, which `bme690 ingest` parses. */
		printf("D,%u,%lu,%.4f,%.4f,%.4f,%.2f,%u,%u\n",
		       r.sensor, (unsigned long)r.ms, r.temp, r.press, r.hum,
		       r.gas, r.step, r.stable);

		storage_write(&r, tag, unix);

		n = snprintf(line, sizeof(line),
			     "{\"t\":\"d\",\"s\":%u,\"ms\":%lu,\"temp\":%.3f,\"press\":%.3f,"
			     "\"hum\":%.3f,\"gas\":%.1f,\"step\":%u,\"stable\":%s,\"tag\":%u}",
			     r.sensor, (unsigned long)r.ms, r.temp, r.press, r.hum,
			     r.gas, r.step, r.stable ? "true" : "false", tag);
		net_broadcast(line, n);
	}
}

/* ------------------------------------------------------------ diagnosis */

struct problems {
	cJSON *arr;
	int    worst;
};

static void add_problem(struct problems *p, enum level lv, int sensor, const char *fmt, ...)
{
	static const char *const names[] = { "info", "warn", "error" };
	cJSON *o = cJSON_CreateObject();
	char text[400];
	va_list ap;

	va_start(ap, fmt);
	vsnprintf(text, sizeof(text), fmt, ap);
	va_end(ap);
	cJSON_AddStringToObject(o, "level", names[lv]);
	if (sensor >= 0) {
		cJSON_AddNumberToObject(o, "sensor", sensor);
	} else {
		cJSON_AddNullToObject(o, "sensor");
	}
	cJSON_AddStringToObject(o, "text", text);
	cJSON_AddItemToArray(p->arr, o);
	p->worst = (int)lv > p->worst ? (int)lv : p->worst;
}

#define SLOT(i) (i), sensor_slots[i].part, sensor_slots[i].shuttle_pin, sensor_slots[i].cs
#define SHARED_WIRES \
	"power (3V3 to P1-1 and P1-2, GND to P1-3) and the three shared SPI wires " \
	"(P2-2 SCK to GPIO12, P2-3 SDO to GPIO13, P2-4 SDI to GPIO11)"

static float median(float *v, int n)
{
	for (int i = 1; i < n; i++) {
		for (int j = i; j > 0 && v[j] < v[j - 1]; j--) {
			float t = v[j];

			v[j] = v[j - 1];
			v[j - 1] = t;
		}
	}
	return n ? v[n / 2] : NAN;
}

static void diagnose(struct problems *p, const struct sensor_info *info,
		     const struct storage_status *st)
{
	const struct board_config *cfg = sensors_config();
	int active = 0, no_answer = 0, stuck = 0, working = 0;
	float temps[NUM_SENSORS], med;
	int nt = 0;

	for (int i = 0; i < NUM_SENSORS; i++) {
		if (info[i].state == SENSOR_INACTIVE) {
			continue;
		}
		active++;
		no_answer += info[i].state == SENSOR_MISSING && info[i].probe == PROBE_NO_ANSWER;
		stuck += info[i].state == SENSOR_MISSING && info[i].probe == PROBE_STUCK_LOW;
		working += info[i].state == SENSOR_OK || info[i].state == SENSOR_SLEEPING;
		if (info[i].state == SENSOR_OK && info[i].have_last) {
			temps[nt++] = info[i].last.temp;
		}
	}

	/* When every sensor fails the same way, the fault is in the wires they
	 * share, not in eight chip selects at once. */
	if (active > 1 && no_answer == active) {
		add_problem(p, LEVEL_ERROR, -1,
			    "No sensor is answering, so the problem is in the wires all sensors "
			    "share. Check " SHARED_WIRES ". Also check the shuttle board is "
			    "plugged in the right way round: P1 is the 7-pin row, P2 the 9-pin row.");
	} else if (active > 1 && stuck == active) {
		add_problem(p, LEVEL_ERROR, -1,
			    "Every sensor reads back zeros: the data line from the sensors "
			    "(P2-3 SDO to GPIO13) is being held low. Check that wire is not "
			    "touching GND, and that the shuttle has 3V3 on P1-1 and P1-2.");
	}

	for (int i = 0; i < NUM_SENSORS; i++) {
		const struct sensor_info *s = &info[i];
		bool shared_fault = (no_answer == active || stuck == active) && active > 1;

		if (s->state == SENSOR_INACTIVE) {
			add_problem(p, LEVEL_INFO, i,
				    "Sensor %d (%s) is switched off in the board configuration (%s).",
				    i, sensor_slots[i].part, cfg->source);
			continue;
		}
		if (s->state == SENSOR_MISSING && !shared_fault) {
			switch (s->probe) {
			case PROBE_NO_ANSWER:
			case PROBE_STUCK_LOW:
				add_problem(p, LEVEL_ERROR, i,
					    "Sensor %d (%s) is not answering. Check its chip-select "
					    "wire from shuttle %s to GPIO%d.", SLOT(i));
				break;
			case PROBE_GARBLED:
				add_problem(p, LEVEL_ERROR, i,
					    "Sensor %d (%s) gives scrambled answers (chip id 0x%02X). "
					    "This is usually a loose or long SPI wire: reseat " SHARED_WIRES
					    ", and keep wires under 20 cm. Also check %s to GPIO%d.",
					    i, sensor_slots[i].part, s->chip_id,
					    sensor_slots[i].shuttle_pin, sensor_slots[i].cs);
				break;
			case PROBE_WRONG_PART:
				add_problem(p, LEVEL_ERROR, i,
					    "Sensor %d (%s) is a %s, not a BME690 (variant %u). This "
					    "firmware only supports BME690 shuttle boards.",
					    i, sensor_slots[i].part,
					    s->variant_id == 1 ? "BME688" : "BME680", s->variant_id);
				break;
			case PROBE_DUPLICATE:
				add_problem(p, LEVEL_ERROR, i,
					    "Sensor %d answers as the same chip as sensor %d, so two "
					    "chip-select wires reach the same shuttle pin. GPIO%d should "
					    "go to %s and GPIO%d to %s.",
					    i, s->duplicate_of, sensor_slots[i].cs,
					    sensor_slots[i].shuttle_pin,
					    sensor_slots[s->duplicate_of].cs,
					    sensor_slots[s->duplicate_of].shuttle_pin);
				break;
			case PROBE_CONFIG_FAILED:
				add_problem(p, LEVEL_ERROR, i,
					    "Sensor %d (%s) answered but would not start its heater "
					    "profile. Press \"Re-check sensors\"; if it keeps happening "
					    "the sensor may be damaged.", i, sensor_slots[i].part);
				break;
			default:
				break;
			}
			continue;
		}
		if (s->state == SENSOR_LOST) {
			add_problem(p, LEVEL_ERROR, i,
				    "Sensor %d (%s) was working and stopped answering. A wire has "
				    "probably come loose: check %s to GPIO%d, then " SHARED_WIRES
				    ". It resumes by itself when the connection is back.", SLOT(i));
			continue;
		}
		if (s->lost_count > 0) {
			add_problem(p, LEVEL_WARN, i,
				    "Sensor %d (%s) dropped out %lu time(s) and recovered. Its wires "
				    "may be loose: check %s to GPIO%d.",
				    i, sensor_slots[i].part, (unsigned long)s->lost_count,
				    sensor_slots[i].shuttle_pin, sensor_slots[i].cs);
		}
		if (s->steps >= 30 && s->stable_steps * 100 < s->steps * 80) {
			add_problem(p, LEVEL_WARN, i,
				    "Sensor %d (%s) often fails to reach its heater temperature "
				    "(%lu%% of steps). The sensor may be damaged, or the 3.3 V "
				    "supply is weak.", i, sensor_slots[i].part,
				    (unsigned long)(s->stable_steps * 100 / s->steps));
		}
		if (s->steps >= 30 && s->implausible * 20 > s->steps) {
			add_problem(p, LEVEL_WARN, i,
				    "Sensor %d (%s) gives readings outside physical limits. It may "
				    "be damaged, or a wire is intermittent.", i, sensor_slots[i].part);
		}
	}

	/* One sensor far from the others' temperature is heating itself or
	 * miscalibrated; the shuttle is small enough that all should agree. */
	if (nt >= 3) {
		float sorted[NUM_SENSORS];

		memcpy(sorted, temps, sizeof(float) * nt);
		med = median(sorted, nt);
		for (int i = 0; i < NUM_SENSORS; i++) {
			if (info[i].state == SENSOR_OK && info[i].have_last &&
			    fabsf(info[i].last.temp - med) > 5.0f) {
				add_problem(p, LEVEL_WARN, i,
					    "Sensor %d (%s) reads %.1f C while the others read about "
					    "%.1f C.", i, sensor_slots[i].part, info[i].last.temp, med);
			}
		}
	}

	if (burnin_on) {
		int64_t left = (burnin_end_ms - now_ms()) / 60000;

		add_problem(p, LEVEL_INFO, -1,
			    "Burn-in running: %lld h %02lld min left. The sensors are held at "
			    "320 C (Bosch HP-001) to settle them. Data recorded now is for "
			    "watching the drift, not for training.",
			    (long long)(left / 60), (long long)(left % 60));
	}
	if (config_error[0]) {
		add_problem(p, LEVEL_ERROR, -1, "%s", config_error);
	}
	if (!st->present) {
		add_problem(p, LEVEL_WARN, -1, "%s Readings still stream live to this "
			    "dashboard and over USB.", st->error);
	} else if (st->error[0]) {
		add_problem(p, LEVEL_ERROR, -1, "%s", st->error);
	}
	if (st->repaired) {
		add_problem(p, LEVEL_INFO, -1,
			    "%lu recording file(s) were cut short by a power loss and have been "
			    "closed so AI-Studio can import them.", (unsigned long)st->repaired);
	}
	if (dropped) {
		add_problem(p, LEVEL_WARN, -1,
			    "%lu readings were dropped because the board fell behind. This "
			    "usually means the SD card is slow.", (unsigned long)dropped);
	}
	if (working > 0 && working < active && p->worst < LEVEL_ERROR) {
		p->worst = LEVEL_WARN;
	}
}

/* ------------------------------------------------------------ status */

static const char *state_name(enum sensor_state s)
{
	switch (s) {
	case SENSOR_OK:       return "ok";
	case SENSOR_SLEEPING: return "sleeping";
	case SENSOR_LOST:     return "lost";
	case SENSOR_INACTIVE: return "inactive";
	default:              return "missing";
	}
}

/* cJSON prints floats to 17 significant digits; readings do not have them. */
static void add_num(cJSON *o, const char *key, double v, int decimals)
{
	char buf[32];

	if (!isfinite(v)) {
		cJSON_AddNullToObject(o, key);
		return;
	}
	snprintf(buf, sizeof(buf), "%.*f", decimals, v);
	cJSON_AddRawToObject(o, key, buf);
}

static int last_worst = -1;

cJSON *app_status_json(void)
{
	const struct board_config *cfg = sensors_config();
	struct sensor_info info[NUM_SENSORS];
	struct storage_status st;
	struct problems p;
	cJSON *root = cJSON_CreateObject();
	cJSON *o, *arr;
	struct label *cur;

	for (int i = 0; i < NUM_SENSORS; i++) {
		sensors_get(i, &info[i]);
	}
	storage_get_status(&st);

	cJSON_AddStringToObject(root, "fw", FW_VERSION);
	cJSON_AddStringToObject(root, "fw_build", ota_build());
	cJSON_AddStringToObject(root, "board", net_board_name());
	cJSON_AddNumberToObject(root, "uptime_ms", (double)(esp_timer_get_time() / 1000));
	cJSON_AddBoolToObject(root, "time_set", clock_set());
	cJSON_AddNumberToObject(root, "unix", (double)time(NULL));
	cJSON_AddBoolToObject(root, "recording", st.recording);
	cJSON_AddStringToObject(root, "session", st.session);
	cJSON_AddStringToObject(root, "file", st.file);
	cJSON_AddNumberToObject(root, "rows_written", st.rows);

	xSemaphoreTake(lock, portMAX_DELAY);
	cur = find_label(cur_tag);
	o = cJSON_AddObjectToObject(root, "label");
	cJSON_AddNumberToObject(o, "tag", cur_tag);
	cJSON_AddStringToObject(o, "name", cur ? cur->name : "");
	arr = cJSON_AddArrayToObject(root, "labels");
	for (int i = 0; i < n_labels; i++) {
		cJSON *l = cJSON_CreateObject();

		cJSON_AddNumberToObject(l, "tag", labels[i].tag);
		cJSON_AddStringToObject(l, "name", labels[i].name);
		cJSON_AddStringToObject(l, "desc", labels[i].desc);
		cJSON_AddItemToArray(arr, l);
	}
	xSemaphoreGive(lock);

	o = cJSON_AddObjectToObject(root, "card");
	cJSON_AddBoolToObject(o, "present", st.present);
	cJSON_AddNumberToObject(o, "total_mb", st.total_mb);
	cJSON_AddNumberToObject(o, "free_mb", st.free_mb);
	if (st.error[0]) {
		cJSON_AddStringToObject(o, "error", st.error);
	} else {
		cJSON_AddNullToObject(o, "error");
	}

	o = cJSON_AddObjectToObject(root, "config");
	cJSON_AddStringToObject(o, "source", cfg->source);
	cJSON_AddStringToObject(o, "name", cfg->name);

	if (burnin_on) {
		o = cJSON_AddObjectToObject(root, "burnin");
		add_num(o, "hours", burnin_hours, 1);
		cJSON_AddNumberToObject(o, "remaining_s",
					(double)((burnin_end_ms - now_ms()) / 1000));
	} else {
		cJSON_AddNullToObject(root, "burnin");
	}

	o = cJSON_AddObjectToObject(root, "wifi");
	cJSON_AddStringToObject(o, "ssid", net_board_name());
	cJSON_AddNumberToObject(o, "clients", net_client_count());

	arr = cJSON_AddArrayToObject(root, "sensors");
	for (int i = 0; i < NUM_SENSORS; i++) {
		const struct sensor_info *s = &info[i];
		const struct heater_profile *hp = &cfg->heater[cfg->sensor[i].heater];
		cJSON *so = cJSON_CreateObject();

		cJSON_AddNumberToObject(so, "index", i);
		cJSON_AddStringToObject(so, "part", sensor_slots[i].part);
		cJSON_AddStringToObject(so, "shuttle_pin", sensor_slots[i].shuttle_pin);
		cJSON_AddNumberToObject(so, "gpio", sensor_slots[i].cs);
		cJSON_AddStringToObject(so, "state", state_name(s->state));
		cJSON_AddStringToObject(so, "probe", probe_names[s->probe]);
		cJSON_AddNumberToObject(so, "chip_id", s->chip_id);
		cJSON_AddNumberToObject(so, "par_t1", s->par_t1);
		cJSON_AddStringToObject(so, "heater_profile", hp->id);
		cJSON_AddNumberToObject(so, "cycle_ms", config_cycle_ms(hp));
		cJSON_AddNumberToObject(so, "cycles", s->cycles);
		add_num(so, "heat_stable_pct",
			s->steps ? 100.0 * s->stable_steps / s->steps : 0, 1);
		if (s->have_last) {
			cJSON *l = cJSON_AddObjectToObject(so, "last");

			cJSON_AddNumberToObject(l, "ms", s->last.ms);
			add_num(l, "temp", s->last.temp, 2);
			add_num(l, "press", s->last.press, 2);
			add_num(l, "hum", s->last.hum, 2);
			add_num(l, "gas", s->last.gas, 1);
			cJSON_AddNumberToObject(l, "step", s->last.step);
			cJSON_AddBoolToObject(l, "stable", s->last.stable);
		} else {
			cJSON_AddNullToObject(so, "last");
		}
		cJSON_AddItemToArray(arr, so);
	}

	p.arr = cJSON_AddArrayToObject(root, "problems");
	p.worst = -1;
	diagnose(&p, info, &st);
	last_worst = p.worst;
	return root;
}

int app_worst_level(void)
{
	return last_worst;
}

/* ------------------------------------------------------------ pushes */

void app_notify(void)
{
	notify_pending = true;
}

static void status_task(void *arg)
{
	uint32_t seen_gen = 0;
	int64_t next = 0;

	for (;;) {
		int64_t now = esp_timer_get_time() / 1000;
		uint32_t gen = sensors_generation();

		if (burnin_on && now >= burnin_end_ms) {
			char err[200];

			if (app_burnin(false, 0, err, sizeof(err)) != 0) {
				ESP_LOGE(TAG, "ending burn-in: %s", err);
			}
		}

		if (notify_pending || gen != seen_gen || now >= next) {
			cJSON *st = app_status_json();   /* also refreshes the LED level */
			char *txt;

			notify_pending = false;
			seen_gen = gen;
			next = now + STATUS_EVERY_MS;
			if (net_client_count() > 0) {
				cJSON_AddStringToObject(st, "t", "status");
				txt = cJSON_PrintUnformatted(st);
				if (txt) {
					net_broadcast(txt, strlen(txt));
					cJSON_free(txt);
				}
			}
			cJSON_Delete(st);
		}
		vTaskDelay(pdMS_TO_TICKS(100));
	}
}

void app_start(const char *cfg_err)
{
	char err[160];

	lock = xSemaphoreCreateMutex();
	queue = xQueueCreate(QUEUE_LEN, sizeof(struct reading));
	snprintf(config_error, sizeof(config_error), "%s", cfg_err ? cfg_err : "");
	ensure_label(cur_tag);

	xTaskCreate(sink_task, "sink", 6144, NULL, 4, NULL);
	xTaskCreate(status_task, "status", 6144, NULL, 3, NULL);

	/* Like Bosch's own boards: power on with a card inserted and it
	 * records, no app needed. */
	if (app_record(true, err, sizeof(err)) != 0) {
		ESP_LOGW(TAG, "not recording: %s", err);
	}
}
