/*
 * BME690 8x shuttle board logger -- ESP32-S3 / ESP-IDF.
 *
 * Power it on and it checks the wiring, starts all eight sensors, records to
 * the SD card as ready-to-import AI-Studio files, and serves a dashboard on
 * its own WiFi network. See README.md.
 *
 * SPDX-License-Identifier: MIT
 */
#include "app.h"
#include "board.h"
#include "config.h"
#include "diag.h"
#include "console.h"
#include "net.h"
#include "ota.h"
#include "sensors.h"
#include "storage.h"
#include "ui.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdio.h>

static struct board_config cfg;

void app_main(void)
{
	char path[300], why[160], cfg_err[600] = "";
	esp_err_t e = nvs_flash_init();

	if (e == ESP_ERR_NVS_NO_FREE_PAGES || e == ESP_ERR_NVS_NEW_VERSION_FOUND) {
		nvs_flash_erase();
		nvs_flash_init();
	}
	diag_boot();   /* why did we restart? before anything else can go wrong */
	vTaskDelay(pdMS_TO_TICKS(1000));   /* let a serial monitor attach */

	printf("\n=== BME690 8x shuttle logger %s, build %s (%s) ===\n", FW_VERSION, ota_build(), net_board_name());

	storage_mount();

	/* A .bmeconfig saved from AI-Studio onto the card replaces the default
	 * heater profile. A bad one is reported and ignored, never fatal. */
	config_default(&cfg);
	if (storage_find_config(path, sizeof(path))) {
		if (config_load_file(path, &cfg, why, sizeof(why)) != 0) {
			snprintf(cfg_err, sizeof(cfg_err),
				 "The board configuration %s on the SD card could not be used: "
				 "%s. Running the factory default HP-354 instead.",
				 path + sizeof(STORAGE_ROOT), why);
			printf("%s\n", cfg_err);
		}
	}
	printf("heater configuration: %s\n\n--- sensor check ---\n", cfg.name);

	sensors_start(&cfg, app_on_reading);
	net_start();
	app_start(cfg_err);
	ui_start();
	console_start();
	ota_confirm_later();
}
