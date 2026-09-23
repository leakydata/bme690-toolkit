/* SD card: recordings as ready-to-import AI-Studio files.
 * SPDX-License-Identifier: MIT */
#ifndef STORAGE_H_
#define STORAGE_H_

#include "config.h"
#include "sensors.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define STORAGE_ROOT   "/sd"
#define STORAGE_DIR    "/sd/bme690"
#define STORAGE_NAME_LEN 64

struct storage_status {
	bool     present;
	uint32_t total_mb, free_mb;
	char     error[160];                  /* empty when fine */
	bool     recording;
	char     session[16];                 /* "s0007" */
	char     file[STORAGE_NAME_LEN];      /* current chunk */
	uint32_t rows;                        /* written this session */
	uint32_t repaired;                    /* chunks closed after power loss */
};

/* Mount the card and close any chunk left open by a power cut. Safe to call
 * again to retry after the card is inserted. */
int storage_mount(void);

/* Path of a .bmeconfig on the card, if there is one. */
bool storage_find_config(char *path, size_t len);

/* Start a new session. header_json is the full .bmerawdata object with an
 * empty dataBlock, which is split around the rows. */
int storage_start(const char *header_json);
void storage_stop(void);

/* One row. tag is the current label; unix is the wall clock (or uptime
 * seconds when it has not been set). */
void storage_write(const struct reading *r, uint16_t tag, int64_t unix);

/* Label names for the current session; written beside every chunk. */
void storage_set_labels(const char *labelinfo_json);

void storage_get_status(struct storage_status *st);

/* Directory listing of recordings; returns entries written. */
struct storage_file {
	char     name[STORAGE_NAME_LEN];
	uint32_t size;
};
int storage_list(struct storage_file *out, int max);

/* Full path for a file name from a request, or false if the name is not a
 * plain file name. */
bool storage_path(const char *name, char *path, size_t len);
int storage_delete(const char *name, char *err, size_t errlen);

#endif /* STORAGE_H_ */
