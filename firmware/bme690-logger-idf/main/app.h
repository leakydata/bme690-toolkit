/* Board state and the commands every interface shares.
 * SPDX-License-Identifier: MIT */
#ifndef APP_H_
#define APP_H_

#include "cJSON.h"
#include "sensors.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum level { LEVEL_INFO, LEVEL_WARN, LEVEL_ERROR };

/* config_error is the reason a .bmeconfig on the card was rejected, or
 * empty. */
void app_start(const char *config_error);

/* Called from the sensor task for every heater step. */
void app_on_reading(const struct reading *r);

/* Commands. Each returns 0, or -1 with a sentence in err. */
int app_record(bool on, char *err, size_t errlen);
int app_label_set(int tag, const char *name, const char *desc, char *err, size_t errlen);
int app_label_next(void);
int app_set_time(int64_t unix);
void app_rescan(void);
/* Replace the heater configuration with the text of a .bmeconfig, or go
 * back to the factory default. Saved to the card when there is one. */
int app_apply_config(const char *text, const char *name, char *err, size_t errlen);
int app_reset_config(char *err, size_t errlen);
/* Hold all sensors at Bosch's stabilization profile for some hours,
 * recording, then return to the previous configuration. */
int app_burnin(bool on, float hours, char *err, size_t errlen);
/* Remember the chip answering in every slot, once the user has checked the
 * wiring (remember = true), or forget them. See chips.h. */
int app_chips(bool remember, char *err, size_t errlen);

/* Status object as documented in API.md. Caller frees. */
cJSON *app_status_json(void);
/* configHeader + configBody. Caller frees. */
cJSON *app_config_json(void);

/* Worst problem currently reported, for the LED. -1 when there are none. */
int app_worst_level(void);
bool app_recording(void);

/* Something changed that viewers should see now. */
void app_notify(void);

#endif /* APP_H_ */
