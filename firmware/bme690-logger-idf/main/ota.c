/* Firmware updates over WiFi.
 *
 * The dashboard uploads a firmware file (the app image the project's site
 * publishes); it is written to the app slot not running now, checked, and
 * booted. Rollback is enabled: the new firmware must confirm itself after a
 * healthy start (ota_confirm_later), or the next boot returns to the old one.
 *
 * SPDX-License-Identifier: MIT */
#include "ota.h"
#include "app.h"
#include "storage.h"
#include "esp_app_desc.h"
#include "esp_app_format.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>

#define PROJECT      "bme690_logger_idf"
#define CHUNK        4096
#define CONFIRM_MS   45000   /* a start this long without trouble counts as good */

static const char *TAG = "ota";
static volatile bool busy;

static esp_err_t fail(httpd_req_t *req, const char *msg)
{
	char body[300];

	ESP_LOGW(TAG, "%s", msg);
	snprintf(body, sizeof(body), "{\"error\":\"%s\"}", msg);
	httpd_resp_set_status(req, "400 Bad Request");
	httpd_resp_set_type(req, "application/json");
	httpd_resp_sendstr(req, body);
	return ESP_OK;
}

/* Receive exactly len bytes (or what is left of the body). */
static int recv_full(httpd_req_t *req, char *buf, int len)
{
	int got = 0;

	while (got < len) {
		int n = httpd_req_recv(req, buf + got, len - got);

		if (n == HTTPD_SOCK_ERR_TIMEOUT) {
			continue;
		}
		if (n <= 0) {
			return -1;
		}
		got += n;
	}
	return got;
}

/* Is this our firmware, for this chip? Checked on the first chunk, before
 * anything is written. */
static const char *check_image(const char *buf, int len)
{
	const esp_image_header_t *h = (const esp_image_header_t *)buf;
	const esp_app_desc_t *d;
	size_t off = sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t);

	if (len < (int)(off + sizeof(esp_app_desc_t)) || h->magic != ESP_IMAGE_HEADER_MAGIC) {
		return "That is not an ESP32 firmware file. Download bme690-logger-app.bin from the project's site.";
	}
	if (h->chip_id != ESP_CHIP_ID_ESP32S3) {
		return "That firmware is for a different kind of ESP32, not this ESP32-S3.";
	}
	d = (const esp_app_desc_t *)(buf + off);
	if (d->magic_word != ESP_APP_DESC_MAGIC_WORD || strncmp(d->project_name, PROJECT, sizeof(d->project_name)) != 0) {
		return "That firmware is not the BME690 logger. Download bme690-logger-app.bin from the project's site.";
	}
	return NULL;
}

static void restart_cb(void *arg)
{
	esp_restart();
}

esp_err_t ota_handler(httpd_req_t *req)
{
	const esp_partition_t *next = esp_ota_get_next_update_partition(NULL);
	esp_ota_handle_t h = 0;
	char *buf = NULL;
	int left = req->content_len, n, first = 1;
	const char *why = NULL;
	esp_err_t e;
	char reply[200];

	if (!next) {
		return fail(req, "This board has no room for an over-the-air update. Install this version once over USB with the browser installer.");
	}
	if (left <= 0 || (size_t)left > next->size) {
		return fail(req, "That file is empty or too big to be the logger's firmware.");
	}
	if (busy) {
		return fail(req, "An update is already being installed.");
	}
	busy = true;
	buf = malloc(CHUNK);
	if (!buf) {
		busy = false;
		return fail(req, "Not enough memory to install an update right now. Restart the board and try again.");
	}

	ESP_LOGI(TAG, "receiving %d bytes into %s", left, next->label);
	while (left > 0) {
		n = recv_full(req, buf, left < CHUNK ? left : CHUNK);
		if (n < 0) {
			why = "The upload was interrupted. Stay close to the board and try again.";
			goto out;
		}
		if (first) {
			first = 0;
			why = check_image(buf, n);
			if (why) {
				goto out;
			}
			e = esp_ota_begin(next, OTA_WITH_SEQUENTIAL_WRITES, &h);
			if (e != ESP_OK) {
				why = "Could not prepare the update slot.";
				h = 0;
				goto out;
			}
		}
		if (esp_ota_write(h, buf, n) != ESP_OK) {
			why = "Writing the update failed.";
			goto out;
		}
		left -= n;
	}

	e = esp_ota_end(h);
	h = 0;
	if (e == ESP_ERR_OTA_VALIDATE_FAILED) {
		why = "The file arrived damaged (its checksum is wrong). Download it again.";
		goto out;
	}
	if (e != ESP_OK || esp_ota_set_boot_partition(next) != ESP_OK) {
		why = "The update could not be completed.";
		goto out;
	}

	/* Close the recording cleanly before the restart. */
	storage_stop();
	snprintf(reply, sizeof(reply), "{\"ok\":true,\"message\":\"Installed. The board is restarting.\"}");
	httpd_resp_set_type(req, "application/json");
	httpd_resp_sendstr(req, reply);
	ESP_LOGI(TAG, "update installed in %s; restarting", next->label);
	{
		const esp_timer_create_args_t a = { .callback = restart_cb, .name = "ota-restart" };
		esp_timer_handle_t t;

		if (esp_timer_create(&a, &t) == ESP_OK) {
			esp_timer_start_once(t, 1500 * 1000);
		}
	}
out:
	if (h) {
		esp_ota_abort(h);
	}
	free(buf);
	busy = false;
	return why ? fail(req, why) : ESP_OK;
}

static void confirm_task(void *arg)
{
	esp_ota_img_states_t st;
	const esp_partition_t *run = esp_ota_get_running_partition();

	vTaskDelay(pdMS_TO_TICKS(CONFIRM_MS));
	if (esp_ota_get_state_partition(run, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY) {
		esp_ota_mark_app_valid_cancel_rollback();
		ESP_LOGI(TAG, "new firmware confirmed");
	}
	vTaskDelete(NULL);
}

void ota_confirm_later(void)
{
	xTaskCreate(confirm_task, "ota-confirm", 3072, NULL, 1, NULL);
}

const char *ota_build(void)
{
	return esp_app_get_description()->version;
}
