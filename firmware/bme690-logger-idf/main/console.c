/* Line commands over USB serial, mirroring the HTTP API for the `bme690`
 * tool and for anyone typing into a serial monitor.
 *
 * Replies start with "S," (a status object), "F," (a file list), "C," (the
 * configuration), "OK" or "ERR", so they never mix with the "D," data lines.
 *
 * SPDX-License-Identifier: MIT */
#include "console.h"
#include "app.h"
#include "storage.h"
#include "driver/uart.h"
#include "driver/uart_vfs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LINE_LEN 160

static const char help[] =
	"commands:\n"
	"  status             board, sensor and card status as JSON\n"
	"  rec start|stop     start or stop recording to the SD card\n"
	"  label next         start the next sample label (same as the BOOT button)\n"
	"  label <n> [name]   switch to label n, optionally naming it\n"
	"  time <unix>        set the clock (seconds since 1970, UTC)\n"
	"  files              list recordings on the card\n"
	"  config             the heater configuration in use\n"
	"  rescan             re-check all eight sensors\n"
	"  burnin <hours>     stabilise new sensors (Bosch HP-001), recording\n"
	"  burnin stop        end a burn-in early\n"
	"  chips remember     remember which chip is in each slot (after checking the wiring)\n"
	"  chips forget       stop checking chips against the remembered ones\n";

static void print_json(char prefix, cJSON *obj)
{
	char *txt = cJSON_PrintUnformatted(obj);

	if (txt) {
		printf("%c,%s\n", prefix, txt);
		cJSON_free(txt);
	}
	cJSON_Delete(obj);
}

static void reply(int rc, const char *err)
{
	if (rc == 0) {
		printf("OK\n");
	} else {
		printf("ERR %s\n", err);
	}
}

static void list_files(void)
{
	struct storage_file *files = calloc(200, sizeof(*files));
	cJSON *arr = cJSON_CreateArray();
	int n = files ? storage_list(files, 200) : 0;

	for (int i = 0; i < n; i++) {
		cJSON *o = cJSON_CreateObject();

		cJSON_AddStringToObject(o, "name", files[i].name);
		cJSON_AddNumberToObject(o, "size", files[i].size);
		cJSON_AddItemToArray(arr, o);
	}
	free(files);
	print_json('F', arr);
}

static void run(char *line)
{
	char err[200] = "";
	char *cmd = strtok(line, " \t");
	char *arg = strtok(NULL, " \t");

	if (!cmd) {
		return;
	}
	if (strcmp(cmd, "status") == 0) {
		print_json('S', app_status_json());
	} else if (strcmp(cmd, "config") == 0) {
		print_json('C', app_config_json());
	} else if (strcmp(cmd, "files") == 0) {
		list_files();
	} else if (strcmp(cmd, "rescan") == 0) {
		app_rescan();
		reply(0, NULL);
	} else if (strcmp(cmd, "rec") == 0 && arg &&
		   (strcmp(arg, "start") == 0 || strcmp(arg, "stop") == 0)) {
		reply(app_record(strcmp(arg, "start") == 0, err, sizeof(err)), err);
	} else if (strcmp(cmd, "label") == 0 && arg && strcmp(arg, "next") == 0) {
		reply(app_label_next(), "could not switch label");
	} else if (strcmp(cmd, "label") == 0 && arg) {
		char *name = strtok(NULL, "");

		reply(app_label_set(atoi(arg), name, NULL, err, sizeof(err)), err);
	} else if (strcmp(cmd, "burnin") == 0 && arg) {
		bool stop = strcmp(arg, "stop") == 0;

		reply(app_burnin(!stop, stop ? 0 : strtof(arg, NULL), err, sizeof(err)), err);
	} else if (strcmp(cmd, "chips") == 0 && arg &&
		   (strcmp(arg, "remember") == 0 || strcmp(arg, "forget") == 0)) {
		reply(app_chips(strcmp(arg, "remember") == 0, err, sizeof(err)), err);
	} else if (strcmp(cmd, "time") == 0 && arg) {
		reply(app_set_time(atoll(arg)), "expected seconds since 1970");
	} else {
		printf("%s", help);
	}
}

static void console_task(void *arg)
{
	char line[LINE_LEN];

	for (;;) {
		if (fgets(line, sizeof(line), stdin)) {
			line[strcspn(line, "\r\n")] = '\0';
			run(line);
		}
	}
}

void console_start(void)
{
	/* Blocking, line-buffered reads on the UART console. */
	uart_driver_install(CONFIG_ESP_CONSOLE_UART_NUM, 512, 0, 0, NULL, 0);
	uart_vfs_dev_use_driver(CONFIG_ESP_CONSOLE_UART_NUM);
	uart_vfs_dev_port_set_rx_line_endings(CONFIG_ESP_CONSOLE_UART_NUM, ESP_LINE_ENDINGS_CR);
	setvbuf(stdin, NULL, _IONBF, 0);
	xTaskCreate(console_task, "console", 6144, NULL, 2, NULL);
}
