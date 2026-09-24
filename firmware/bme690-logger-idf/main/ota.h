/* Firmware updates over WiFi.
 * SPDX-License-Identifier: MIT */
#ifndef OTA_H_
#define OTA_H_

#include "esp_http_server.h"

/* POST /api/ota: the body is the app image (bme690-logger-app.bin). */
esp_err_t ota_handler(httpd_req_t *req);

/* After a healthy start, confirm a freshly updated firmware so it isn't
 * rolled back. */
void ota_confirm_later(void);

/* Build id of the running firmware (the git commit it was built from). */
const char *ota_build(void);

#endif /* OTA_H_ */
