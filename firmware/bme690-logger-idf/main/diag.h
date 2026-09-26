/* Why did the board last restart, and did it crash?
 *
 * At every start the reset reason is read, counted in NVS, and turned into a
 * sentence for the dashboard. A crash also leaves a core dump in its own
 * flash partition (when the partition table has one), which the dashboard
 * offers as a download so the fault can be traced to a line of code.
 *
 * SPDX-License-Identifier: MIT */
#ifndef DIAG_H_
#define DIAG_H_

#include "cJSON.h"
#include "esp_http_server.h"
#include <stdbool.h>

/* Call first thing in app_main. */
void diag_boot(void);

/* {"reason", "text", "crash", "boots", "crashes", "report"} for the status. */
void diag_add_status(cJSON *root);

/* The last restart was a crash, watchdog or power dip: a sentence for the
 * problem list, or NULL. */
const char *diag_problem(void);

/* GET /api/crash: the saved crash report (core dump), DELETE clears it. */
esp_err_t diag_crash_get(httpd_req_t *req);
esp_err_t diag_crash_delete(httpd_req_t *req);

#endif /* DIAG_H_ */
