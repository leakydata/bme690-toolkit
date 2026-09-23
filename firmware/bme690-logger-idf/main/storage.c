/* SD card: recordings as ready-to-import AI-Studio files.
 *
 * A session is written as fifteen-minute chunks, s0007_0000.bmerawdata,
 * s0007_0001.bmerawdata and so on. AI-Studio imports every file sharing the
 * stem as one session, sorting names as plain strings, hence the zero
 * padding. Each chunk is a complete file once closed, so a power cut costs at
 * most the unfinished chunk's tail, and the next boot closes that one too.
 *
 * SPDX-License-Identifier: MIT */
#include "storage.h"
#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "sdmmc_cmd.h"
#include "driver/sdspi_host.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include <dirent.h>
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define CHUNK_MS       (15 * 60 * 1000)
#define SYNC_MS        5000
#define ROW_END        "],\n"
#define FILE_END       "]}}\n"
#define TAIL_SCAN      8192
#define WRITE_BUF      8192
#define SPACE_POLL_MS  10000

static const char *TAG = "storage";

static SemaphoreHandle_t lock;
static sdmmc_card_t *card;
static struct storage_status st;

static FILE    *chunk;
static char    *head, *labels_json;
static char    *iobuf;
static uint32_t chunk_no, chunk_rows, chunk_start_ms, last_sync_ms;
static uint32_t last_space_ms;
static bool     space_known;

static void set_error(const char *fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vsnprintf(st.error, sizeof(st.error), fmt, ap);
	va_end(ap);
	ESP_LOGE(TAG, "%s", st.error);
}

static void refresh_space(void)
{
	uint64_t total = 0, free_b = 0;

	if (esp_vfs_fat_info(STORAGE_ROOT, &total, &free_b) == ESP_OK) {
		st.total_mb = total >> 20;
		st.free_mb = free_b >> 20;
		space_known = true;
	}
}

static bool is_chunk_name(const char *name, unsigned *session, unsigned *part)
{
	char tail[24];

	return sscanf(name, "s%4u_%4u.%23s", session, part, tail) == 3 &&
	       strcmp(tail, "bmerawdata") == 0;
}

static void chunk_path(char *buf, size_t len, unsigned no, const char *ext)
{
	snprintf(buf, len, STORAGE_DIR "/%s_%04u.%s", st.session, no, ext);
}

/* ------------------------------------------------------------ repair */

static void remove_pair(const char *path)
{
	char lab[300];

	unlink(path);
	snprintf(lab, sizeof(lab), "%.*s.bmelabelinfo",
		 (int)(strlen(path) - strlen(".bmerawdata")), path);
	unlink(lab);
}

/* Close a chunk that lost power mid-write: cut it after the last complete
 * row and add the closing brackets. A chunk with no rows is removed, since
 * AI-Studio refuses an empty dataBlock. */
static bool repair(const char *path)
{
	FILE *f = fopen(path, "r+");
	char *buf = NULL;
	long size, from, cut = -1;
	size_t n;
	bool fixed = false;

	if (!f) {
		return false;
	}
	fseek(f, 0, SEEK_END);
	size = ftell(f);
	if (size >= (long)strlen(FILE_END)) {
		char end[8] = { 0 };

		fseek(f, size - strlen(FILE_END), SEEK_SET);
		fread(end, 1, strlen(FILE_END), f);
		if (strcmp(end, FILE_END) == 0) {
			fclose(f);
			return false;            /* closed properly */
		}
	}

	from = size > TAIL_SCAN ? size - TAIL_SCAN : 0;
	buf = malloc(TAIL_SCAN + 1);
	if (!buf) {
		fclose(f);
		return false;
	}
	fseek(f, from, SEEK_SET);
	n = fread(buf, 1, TAIL_SCAN, f);
	buf[n] = '\0';
	for (long i = (long)n - (long)strlen(ROW_END); i >= 0; i--) {
		if (memcmp(buf + i, ROW_END, strlen(ROW_END)) == 0) {
			cut = from + i + 1;      /* keep the "]" */
			break;
		}
	}
	free(buf);

	if (cut < 0) {
		fclose(f);
		ESP_LOGW(TAG, "%s has no complete rows; removing it", path);
		remove_pair(path);
		return true;
	}
	fflush(f);
	if (ftruncate(fileno(f), cut) == 0) {
		fseek(f, cut, SEEK_SET);
		fputs("\n" FILE_END, f);
		fixed = true;
	}
	fclose(f);
	ESP_LOGW(TAG, "closed %s after an interrupted recording", path);
	return fixed;
}

static void repair_all(void)
{
	DIR *d = opendir(STORAGE_DIR);
	struct dirent *e;
	unsigned s, p;

	if (!d) {
		return;
	}
	while ((e = readdir(d)) != NULL) {
		char path[300];

		if (!is_chunk_name(e->d_name, &s, &p)) {
			continue;
		}
		snprintf(path, sizeof(path), STORAGE_DIR "/%s", e->d_name);
		st.repaired += repair(path);
	}
	closedir(d);
}

/* ------------------------------------------------------------ mount */

int storage_mount(void)
{
	sdmmc_host_t host = SDSPI_HOST_DEFAULT();
	sdspi_device_config_t slot = SDSPI_DEVICE_CONFIG_DEFAULT();
	esp_vfs_fat_sdmmc_mount_config_t mc = {
		.format_if_mount_failed = false,
		.max_files = 4,
		.allocation_unit_size = 16 * 1024,
	};
	static bool bus_up;
	esp_err_t e;

	if (!lock) {
		lock = xSemaphoreCreateMutex();
	}
	if (st.present) {
		return 0;
	}
	if (!bus_up) {
		spi_bus_config_t bus = {
			.sclk_io_num = PIN_SD_SCK,
			.mosi_io_num = PIN_SD_MOSI,
			.miso_io_num = PIN_SD_MISO,
			.quadwp_io_num = -1,
			.quadhd_io_num = -1,
			.max_transfer_sz = 4000,
		};

		if (spi_bus_initialize(SD_SPI_HOST, &bus, SPI_DMA_CH_AUTO) != ESP_OK) {
			set_error("The SD card bus would not start.");
			return -1;
		}
		/* Cards need pull-ups on these; many cheap modules omit them. */
		gpio_pullup_en(PIN_SD_MISO);
		gpio_pullup_en(PIN_SD_CS);
		bus_up = true;
	}

	host.slot = SD_SPI_HOST;
	host.max_freq_khz = 10000;
	slot.gpio_cs = PIN_SD_CS;
	slot.host_id = SD_SPI_HOST;

	e = esp_vfs_fat_sdspi_mount(STORAGE_ROOT, &host, &slot, &mc, &card);
	if (e == ESP_FAIL) {
		set_error("The SD card answered but has no FAT32 filesystem. "
			  "Format it as FAT32 on a computer, then press RST.");
		return -1;
	}
	if (e != ESP_OK) {
		set_error("No SD card found. Insert one (FAT32) and press RST, or "
			  "check the card wiring: CS GPIO10, SCK GPIO18, MOSI GPIO17, "
			  "MISO GPIO8, and power.");
		return -1;
	}

	st.present = true;
	st.error[0] = '\0';
	mkdir(STORAGE_DIR, 0775);
	repair_all();
	refresh_space();
	ESP_LOGI(TAG, "card mounted: %lu MB free of %lu MB",
		 (unsigned long)st.free_mb, (unsigned long)st.total_mb);
	return 0;
}

bool storage_find_config(char *path, size_t len)
{
	DIR *d;
	struct dirent *e;
	bool found = false;

	if (!st.present) {
		return false;
	}
	snprintf(path, len, STORAGE_ROOT "/bme690.bmeconfig");
	if (access(path, R_OK) == 0) {
		return true;
	}
	d = opendir(STORAGE_ROOT);
	while (d && (e = readdir(d)) != NULL) {
		const char *dot = strrchr(e->d_name, '.');

		if (dot && strcasecmp(dot, ".bmeconfig") == 0) {
			snprintf(path, len, STORAGE_ROOT "/%s", e->d_name);
			found = true;
			break;
		}
	}
	if (d) {
		closedir(d);
	}
	return found;
}

/* ------------------------------------------------------------ writing */

static void write_labels_for(unsigned no)
{
	char path[300];
	FILE *f;

	if (!labels_json) {
		return;
	}
	chunk_path(path, sizeof(path), no, "bmelabelinfo");
	f = fopen(path, "w");
	if (f) {
		fputs(labels_json, f);
		fclose(f);
	}
}

static int open_chunk(void)
{
	char path[300];

	chunk_path(path, sizeof(path), chunk_no, "bmerawdata");
	chunk = fopen(path, "w");
	if (!chunk) {
		set_error("Cannot create %s on the SD card (%s). The card may be "
			  "full or write-protected.", path + strlen(STORAGE_DIR) + 1,
			  strerror(errno));
		return -1;
	}
	setvbuf(chunk, iobuf, _IOFBF, WRITE_BUF);
	fputs(head, chunk);
	chunk_rows = 0;
	chunk_start_ms = 0;
	snprintf(st.file, sizeof(st.file), "%s_%04u.bmerawdata",
		 st.session, (unsigned)chunk_no);
	write_labels_for(chunk_no);
	return 0;
}

static void close_chunk(void)
{
	char path[300];

	if (!chunk) {
		return;
	}
	if (chunk_rows == 0) {
		fclose(chunk);
		chunk = NULL;
		chunk_path(path, sizeof(path), chunk_no, "bmerawdata");
		remove_pair(path);
		return;
	}
	/* Replace the last row's ",\n" with "\n" and close the arrays. */
	fflush(chunk);
	fseek(chunk, -2, SEEK_END);
	fputs("\n" FILE_END, chunk);
	fflush(chunk);
	fsync(fileno(chunk));
	fclose(chunk);
	chunk = NULL;
}

static unsigned next_session(void)
{
	DIR *d = opendir(STORAGE_DIR);
	struct dirent *e;
	unsigned s, p, max = 0;

	while (d && (e = readdir(d)) != NULL) {
		if (is_chunk_name(e->d_name, &s, &p) && s > max) {
			max = s;
		}
	}
	if (d) {
		closedir(d);
	}
	return max + 1;
}

int storage_start(const char *header_json)
{
	const char *split = strstr(header_json, "\"dataBlock\":[]");
	int rc = -1;

	if (!split) {
		return -1;
	}
	if (!st.present && storage_mount() != 0) {
		return -1;
	}

	xSemaphoreTake(lock, portMAX_DELAY);
	if (st.recording) {
		rc = 0;
		goto out;
	}
	free(head);
	head = strndup(header_json, split - header_json + strlen("\"dataBlock\":["));
	if (!iobuf) {
		iobuf = malloc(WRITE_BUF);
	}
	if (!head || !iobuf) {
		goto out;
	}
	snprintf(st.session, sizeof(st.session), "s%04u", next_session());
	chunk_no = 0;
	st.rows = 0;
	if (open_chunk() != 0) {
		goto out;
	}
	st.recording = true;
	st.error[0] = '\0';
	ESP_LOGI(TAG, "recording session %s", st.session);
	rc = 0;
out:
	xSemaphoreGive(lock);
	return rc;
}

void storage_stop(void)
{
	xSemaphoreTake(lock, portMAX_DELAY);
	close_chunk();
	st.recording = false;
	st.file[0] = '\0';
	refresh_space();
	xSemaphoreGive(lock);
}

void storage_write(const struct reading *r, uint16_t tag, int64_t unix)
{
	xSemaphoreTake(lock, portMAX_DELAY);
	if (!st.recording || !chunk) {
		goto out;
	}
	if (chunk_rows == 0) {
		chunk_start_ms = r->ms;
		last_sync_ms = r->ms;
	} else if (r->ms - chunk_start_ms >= CHUNK_MS) {
		close_chunk();
		chunk_no++;
		if (open_chunk() != 0) {
			st.recording = false;
			goto out;
		}
		chunk_start_ms = r->ms;
	}

	/* Column order matches DATA_COLUMNS in the header. */
	if (fprintf(chunk, "[%u,%u,%lu,%lld,%.4f,%.4f,%.4f,%.2f,%u,true,%u,0" ROW_END,
		    r->sensor, r->sensor, (unsigned long)r->ms, (long long)unix,
		    r->temp, r->press, r->hum, r->gas, r->step, tag) < 0) {
		set_error("Writing to the SD card failed (%s). Recording stopped; "
			  "the card may be full or was removed.", strerror(errno));
		fclose(chunk);
		chunk = NULL;
		st.recording = false;
		st.present = false;
		goto out;
	}
	chunk_rows++;
	st.rows++;

	if (r->ms - last_sync_ms >= SYNC_MS) {
		fflush(chunk);
		fsync(fileno(chunk));
		last_sync_ms = r->ms;
	}
	if (r->ms - last_space_ms >= SPACE_POLL_MS || !space_known) {
		last_space_ms = r->ms;
		refresh_space();
		if (st.free_mb < 2) {
			set_error("The SD card is full. Recording stopped.");
			close_chunk();
			st.recording = false;
		}
	}
out:
	xSemaphoreGive(lock);
}

void storage_set_labels(const char *json)
{
	if (!lock) {
		return;
	}
	xSemaphoreTake(lock, portMAX_DELAY);
	free(labels_json);
	labels_json = strdup(json);
	if (st.recording) {
		for (unsigned i = 0; i <= chunk_no; i++) {
			write_labels_for(i);
		}
	}
	xSemaphoreGive(lock);
}

void storage_get_status(struct storage_status *out)
{
	if (!lock) {
		memset(out, 0, sizeof(*out));
		snprintf(out->error, sizeof(out->error), "Storage not started.");
		return;
	}
	xSemaphoreTake(lock, portMAX_DELAY);
	*out = st;
	xSemaphoreGive(lock);
}

/* ------------------------------------------------------------ files */

int storage_list(struct storage_file *out, int max)
{
	DIR *d;
	struct dirent *e;
	int n = 0;

	if (!st.present) {
		return 0;
	}
	d = opendir(STORAGE_DIR);
	while (d && n < max && (e = readdir(d)) != NULL) {
		struct stat sb;
		char path[300];

		if (e->d_type != DT_REG || strlen(e->d_name) >= STORAGE_NAME_LEN) {
			continue;
		}
		snprintf(path, sizeof(path), STORAGE_DIR "/%s", e->d_name);
		strcpy(out[n].name, e->d_name);
		out[n].size = stat(path, &sb) == 0 ? sb.st_size : 0;
		n++;
	}
	if (d) {
		closedir(d);
	}
	return n;
}

bool storage_path(const char *name, char *path, size_t len)
{
	if (!name[0] || name[0] == '.' || strchr(name, '/') || strchr(name, '\\') ||
	    strlen(name) >= STORAGE_NAME_LEN) {
		return false;
	}
	snprintf(path, len, STORAGE_DIR "/%s", name);
	return true;
}

int storage_delete(const char *name, char *err, size_t errlen)
{
	char path[300];
	int rc = -1;

	if (!storage_path(name, path, sizeof(path))) {
		snprintf(err, errlen, "Not a recording name.");
		return -1;
	}
	xSemaphoreTake(lock, portMAX_DELAY);
	if (st.recording && strncmp(name, st.session, strlen(st.session)) == 0) {
		snprintf(err, errlen, "That file belongs to the recording in progress. "
			 "Stop recording first.");
	} else if (unlink(path) != 0) {
		snprintf(err, errlen, "Could not delete it (%s).", strerror(errno));
	} else {
		rc = 0;
		refresh_space();
	}
	xSemaphoreGive(lock);
	return rc;
}
