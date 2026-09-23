/* WiFi access point, dashboard and HTTP/WebSocket API.
 * SPDX-License-Identifier: MIT */
#ifndef NET_H_
#define NET_H_

#include <stddef.h>

void net_start(void);

/* "BME690-3F2A": the WiFi network name and the board id in recordings. */
const char *net_board_name(void);

/* Send a text frame to every open dashboard. Never blocks. */
void net_broadcast(const char *text, size_t len);

int net_client_count(void);

#endif /* NET_H_ */
