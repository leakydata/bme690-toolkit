/* Which chip belongs in which slot.
 *
 * Every BME690 carries its own factory calibration; its par_t1 value works as
 * a serial number. Once the user confirms the wiring is right, the board
 * remembers each slot's chip and from then on can say "the wires for U1 and
 * U2 look swapped" rather than just "sensor missing". It learns only when
 * told to -- never from whatever happens to be connected first.
 *
 * SPDX-License-Identifier: MIT */
#ifndef CHIPS_H_
#define CHIPS_H_

#include "sensors.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

void chips_load(void);
bool chips_known(void);
/* The chip remembered for a slot, or 0. */
uint16_t chips_expected(int slot);
/* When they were remembered: unix seconds, or 0 if the clock wasn't set. */
int64_t chips_saved_at(void);

/* Remember the chips answering now. Refuses (with a sentence in err) unless
 * every active sensor answers, so a half-wired board is never learned. */
int chips_remember(const struct sensor_info *info, char *err, size_t errlen);
int chips_forget(void);

#endif /* CHIPS_H_ */
