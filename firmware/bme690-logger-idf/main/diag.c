/* Why did the board last restart. See diag.h.
 * SPDX-License-Identifier: MIT */
#include "diag.h"
#include "esp_core_dump.h"
#include "esp_log.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "nvs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *TAG = "diag";

static esp_reset_reason_t reason;
static uint32_t boots, crashes;
static bool report;
static char report_task[16];
static uint32_t report_pc;
static char problem[300];

struct why {
	esp_reset_reason_t r;
	const char *id;
	bool crash;
	const char *text;
};

static const struct why whys[] = {
	{ ESP_RST_POWERON,  "power-on",  false, "It was switched on." },
	{ ESP_RST_EXT,      "reset-pin", false, "Its RST button was pressed." },
	{ ESP_RST_SW,       "software",  false, "It restarted itself on purpose (an update or a command)." },
	{ ESP_RST_USB,      "usb",       false, "A program on the computer restarted it over USB." },
	{ ESP_RST_DEEPSLEEP,"wake",      false, "It woke from deep sleep." },
	{ ESP_RST_PANIC,    "crash",     true,  "The firmware crashed and the board restarted itself." },
	{ ESP_RST_INT_WDT,  "watchdog",  true,  "The firmware froze (interrupt watchdog) and the board restarted itself." },
	{ ESP_RST_TASK_WDT, "watchdog",  true,  "The firmware stopped responding (task watchdog) and the board restarted itself." },
	{ ESP_RST_WDT,      "watchdog",  true,  "A watchdog restarted the board." },
	{ ESP_RST_BROWNOUT, "brownout",  true,  "Its supply voltage dipped too low (a brownout) and it restarted." },
	{ ESP_RST_SDIO,     "sdio",      false, "It was reset over SDIO." },
};

static const struct why *lookup(esp_reset_reason_t r)
{
	for (size_t i = 0; i < sizeof(whys) / sizeof(whys[0]); i++) {
		if (whys[i].r == r) {
			return &whys[i];
		}
	}
	return NULL;
}

void diag_boot(void)
{
	const struct why *w;
	nvs_handle_t h;

	reason = esp_reset_reason();
	w = lookup(reason);

	if (nvs_open("bme690", NVS_READWRITE, &h) == ESP_OK) {
		nvs_get_u32(h, "boots", &boots);
		nvs_get_u32(h, "crashes", &crashes);
		boots++;
		if (w && w->crash) {
			crashes++;
		}
		nvs_set_u32(h, "boots", boots);
		nvs_set_u32(h, "crashes", crashes);
		nvs_commit(h);
		nvs_close(h);
	}

#if CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH && CONFIG_ESP_COREDUMP_DATA_FORMAT_ELF
	{
		esp_core_dump_summary_t *s = calloc(1, sizeof(*s));

		if (s && esp_core_dump_image_check() == ESP_OK && esp_core_dump_get_summary(s) == ESP_OK) {
			report = true;
			memcpy(report_task, s->exc_task, sizeof(report_task) - 1);
			report_pc = s->exc_pc;
		}
		free(s);
	}
#endif

	ESP_LOGI(TAG, "restart reason: %s (boot %lu, %lu crashes so far)%s",
		 w ? w->id : "unknown", (unsigned long)boots, (unsigned long)crashes,
		 report ? "; a crash report is saved" : "");

	if (w && w->crash) {
		if (reason == ESP_RST_BROWNOUT) {
			snprintf(problem, sizeof(problem),
				 "The board restarted because its supply voltage dipped too low. Use a shorter "
				 "or better USB cable, or a charger rated for at least 1 A. It has recovered and "
				 "carries on.");
		} else {
			snprintf(problem, sizeof(problem),
				 "%s It has recovered and carries on. %s",
				 w->text,
				 report ? "A crash report was saved: download it from Files -> Firmware and share "
					  "it so the cause can be found."
					: "If this keeps happening, note when and what the board was doing.");
		}
	}
}

const char *diag_problem(void)
{
	return problem[0] ? problem : NULL;
}

void diag_add_status(cJSON *root)
{
	const struct why *w = lookup(reason);
	cJSON *o = cJSON_AddObjectToObject(root, "restart");

	cJSON_AddStringToObject(o, "reason", w ? w->id : "unknown");
	cJSON_AddStringToObject(o, "text", w ? w->text : "The reason isn't known.");
	cJSON_AddBoolToObject(o, "crash", w && w->crash);
	cJSON_AddNumberToObject(o, "boots", boots);
	cJSON_AddNumberToObject(o, "crashes", crashes);
	if (report) {
		cJSON *r = cJSON_AddObjectToObject(o, "report");
		char pc[16];

		snprintf(pc, sizeof(pc), "0x%08lx", (unsigned long)report_pc);
		cJSON_AddStringToObject(r, "task", report_task);
		cJSON_AddStringToObject(r, "pc", pc);
	} else {
		cJSON_AddNullToObject(o, "report");
	}
}

esp_err_t diag_crash_get(httpd_req_t *req)
{
	size_t addr = 0, size = 0;
	const esp_partition_t *p = esp_partition_find_first(ESP_PARTITION_TYPE_DATA,
							    ESP_PARTITION_SUBTYPE_DATA_COREDUMP, NULL);
	char *buf;

	if (!p || esp_core_dump_image_get(&addr, &size) != ESP_OK || size == 0) {
		httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "No crash report is saved.");
		return ESP_FAIL;
	}
	buf = malloc(4096);
	if (!buf) {
		return httpd_resp_send_500(req);
	}
	httpd_resp_set_type(req, "application/octet-stream");
	httpd_resp_set_hdr(req, "Content-Disposition", "attachment; filename=\"bme690-crash-report.bin\"");
	for (size_t off = 0; off < size; off += 4096) {
		size_t n = size - off < 4096 ? size - off : 4096;

		if (esp_partition_read(p, addr - p->address + off, buf, n) != ESP_OK ||
		    httpd_resp_send_chunk(req, buf, n) != ESP_OK) {
			break;
		}
	}
	free(buf);
	return httpd_resp_send_chunk(req, NULL, 0);
}

esp_err_t diag_crash_delete(httpd_req_t *req)
{
	esp_core_dump_image_erase();
	report = false;
	httpd_resp_set_type(req, "application/json");
	return httpd_resp_sendstr(req, "{\"ok\":true}");
}
