/* WiFi access point, dashboard and HTTP/WebSocket API.
 *
 * The board is its own open WiFi network. A tiny DNS server answers every
 * lookup with the board's address, so phones treat it as a captive portal
 * and open the dashboard as soon as they join -- nobody has to know an IP
 * address.
 *
 * SPDX-License-Identifier: MIT */
#include "net.h"
#include "app.h"
#include "ota.h"
#include "storage.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define AP_CHANNEL   6
#define AP_MAX_CONN  4
#define MAX_BODY     1024
#define MAX_FILES    200
#define AP_IP        "192.168.4.1"

static const char *TAG = "net";

extern const uint8_t dashboard_gz_start[] asm("_binary_dashboard_html_gz_start");
extern const uint8_t dashboard_gz_end[]   asm("_binary_dashboard_html_gz_end");

static httpd_handle_t server;
static char board_name[16];
static volatile int ws_clients;

const char *net_board_name(void)
{
	if (!board_name[0]) {
		uint8_t mac[6];

		esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
		snprintf(board_name, sizeof(board_name), "BME690-%02X%02X", mac[4], mac[5]);
	}
	return board_name;
}

/* ------------------------------------------------------------ helpers */

static esp_err_t send_json(httpd_req_t *req, cJSON *obj)
{
	char *txt = cJSON_PrintUnformatted(obj);
	esp_err_t e;

	cJSON_Delete(obj);
	if (!txt) {
		return httpd_resp_send_500(req);
	}
	httpd_resp_set_type(req, "application/json");
	httpd_resp_set_hdr(req, "Cache-Control", "no-store");
	e = httpd_resp_sendstr(req, txt);
	cJSON_free(txt);
	return e;
}

static esp_err_t send_error(httpd_req_t *req, const char *msg)
{
	cJSON *o = cJSON_CreateObject();

	cJSON_AddStringToObject(o, "error", msg);
	httpd_resp_set_status(req, "400 Bad Request");
	return send_json(req, o);
}

static cJSON *read_body(httpd_req_t *req)
{
	char buf[MAX_BODY + 1];
	int got = 0, n;

	if (req->content_len > MAX_BODY) {
		return NULL;
	}
	while (got < (int)req->content_len) {
		n = httpd_req_recv(req, buf + got, req->content_len - got);
		if (n <= 0) {
			return NULL;
		}
		got += n;
	}
	buf[got] = '\0';
	return got ? cJSON_Parse(buf) : cJSON_CreateObject();
}

/* The file name at the end of /api/files/<name>, URL-decoded. */
static bool file_name(httpd_req_t *req, char *out, size_t len)
{
	const char *p = req->uri + strlen("/api/files/");
	size_t o = 0;

	for (; *p && *p != '?' && o + 1 < len; p++) {
		if (*p == '%' && p[1] && p[2]) {
			char hex[3] = { p[1], p[2], 0 };

			out[o++] = (char)strtol(hex, NULL, 16);
			p += 2;
		} else {
			out[o++] = *p;
		}
	}
	out[o] = '\0';
	return o > 0;
}

/* ------------------------------------------------------------ pages */

static esp_err_t h_dashboard(httpd_req_t *req)
{
	httpd_resp_set_type(req, "text/html; charset=utf-8");
	httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
	httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
	return httpd_resp_send(req, (const char *)dashboard_gz_start,
			       dashboard_gz_end - dashboard_gz_start);
}

/* Anything unknown -- including the probe URLs phones use to detect a
 * captive portal -- goes to the dashboard. */
static esp_err_t h_not_found(httpd_req_t *req, httpd_err_code_t err)
{
	if (strncmp(req->uri, "/api/", 5) == 0) {
		httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "No such API endpoint");
		return ESP_FAIL;
	}
	httpd_resp_set_status(req, "302 Found");
	httpd_resp_set_hdr(req, "Location", "http://" AP_IP "/");
	return httpd_resp_send(req, NULL, 0);
}

/* ------------------------------------------------------------ API */

static esp_err_t h_status(httpd_req_t *req)
{
	return send_json(req, app_status_json());
}

static esp_err_t h_config(httpd_req_t *req)
{
	return send_json(req, app_config_json());
}

/* PUT /api/config?name=<file name>: the text of a .bmeconfig. */
static esp_err_t h_config_put(httpd_req_t *req)
{
	char name[64] = "uploaded.bmeconfig", q[96], err[300];
	char *buf;
	int got = 0, n, rc;

	if (req->content_len == 0 || req->content_len > CONFIG_MAX_BYTES) {
		return send_error(req, "That is not a board configuration file (.bmeconfig).");
	}
	if (httpd_req_get_url_query_str(req, q, sizeof(q)) == ESP_OK) {
		httpd_query_key_value(q, "name", name, sizeof(name));
	}
	buf = malloc(req->content_len + 1);
	if (!buf) {
		return httpd_resp_send_500(req);
	}
	while (got < (int)req->content_len) {
		n = httpd_req_recv(req, buf + got, req->content_len - got);
		if (n <= 0) {
			free(buf);
			return ESP_FAIL;
		}
		got += n;
	}
	buf[got] = '\0';
	rc = app_apply_config(buf, name, err, sizeof(err));
	free(buf);
	return rc == 0 ? send_json(req, app_status_json()) : send_error(req, err);
}

static esp_err_t h_config_delete(httpd_req_t *req)
{
	char err[300];

	if (app_reset_config(err, sizeof(err)) != 0) {
		return send_error(req, err);
	}
	return send_json(req, app_status_json());
}

static esp_err_t reply_status_or_error(httpd_req_t *req, int rc, const char *err)
{
	return rc == 0 ? send_json(req, app_status_json()) : send_error(req, err);
}

static esp_err_t h_record(httpd_req_t *req)
{
	cJSON *body = read_body(req);
	cJSON *on = body ? cJSON_GetObjectItem(body, "on") : NULL;
	char err[200] = "Send {\"on\": true} or {\"on\": false}.";
	int rc = -1;

	if (cJSON_IsBool(on)) {
		rc = app_record(cJSON_IsTrue(on), err, sizeof(err));
	}
	cJSON_Delete(body);
	return reply_status_or_error(req, rc, err);
}

static esp_err_t h_label(httpd_req_t *req)
{
	cJSON *body = read_body(req);
	char err[200] = "Send {\"next\": true} or {\"tag\": 2, \"name\": \"coffee\"}.";
	int rc = -1;

	if (body && cJSON_IsTrue(cJSON_GetObjectItem(body, "next"))) {
		rc = app_label_next();
	} else if (body && cJSON_IsNumber(cJSON_GetObjectItem(body, "tag"))) {
		cJSON *name = cJSON_GetObjectItem(body, "name");
		cJSON *desc = cJSON_GetObjectItem(body, "desc");

		rc = app_label_set(cJSON_GetObjectItem(body, "tag")->valueint,
				   cJSON_IsString(name) ? name->valuestring : NULL,
				   cJSON_IsString(desc) ? desc->valuestring : NULL,
				   err, sizeof(err));
	}
	cJSON_Delete(body);
	return reply_status_or_error(req, rc, err);
}

static esp_err_t h_burnin(httpd_req_t *req)
{
	cJSON *body = read_body(req);
	cJSON *on = body ? cJSON_GetObjectItem(body, "on") : NULL;
	cJSON *hours = body ? cJSON_GetObjectItem(body, "hours") : NULL;
	char err[200] = "Send {\"on\": true, \"hours\": 12} or {\"on\": false}.";
	int rc = -1;

	if (cJSON_IsBool(on)) {
		rc = app_burnin(cJSON_IsTrue(on),
				cJSON_IsNumber(hours) ? (float)hours->valuedouble : 12.0f,
				err, sizeof(err));
	}
	cJSON_Delete(body);
	return reply_status_or_error(req, rc, err);
}

static esp_err_t h_time(httpd_req_t *req)
{
	cJSON *body = read_body(req);
	cJSON *unix = body ? cJSON_GetObjectItem(body, "unix") : NULL;
	int rc = -1;

	if (cJSON_IsNumber(unix)) {
		rc = app_set_time((int64_t)unix->valuedouble);
	}
	cJSON_Delete(body);
	return reply_status_or_error(req, rc, "Send {\"unix\": <seconds since 1970>}.");
}

static esp_err_t h_rescan(httpd_req_t *req)
{
	app_rescan();
	return send_json(req, app_status_json());
}

static esp_err_t h_files(httpd_req_t *req)
{
	struct storage_file *files = calloc(MAX_FILES, sizeof(*files));
	cJSON *arr = cJSON_CreateArray();
	int n;

	if (!files) {
		cJSON_Delete(arr);
		return httpd_resp_send_500(req);
	}
	n = storage_list(files, MAX_FILES);
	for (int i = 0; i < n; i++) {
		cJSON *o = cJSON_CreateObject();

		cJSON_AddStringToObject(o, "name", files[i].name);
		cJSON_AddNumberToObject(o, "size", files[i].size);
		cJSON_AddItemToArray(arr, o);
	}
	free(files);
	return send_json(req, arr);
}

static esp_err_t h_file_get(httpd_req_t *req)
{
	char name[STORAGE_NAME_LEN], path[300], disp[STORAGE_NAME_LEN + 40];
	char *buf;
	FILE *f;
	size_t n;

	if (!file_name(req, name, sizeof(name)) || !storage_path(name, path, sizeof(path))) {
		return send_error(req, "Not a recording name.");
	}
	f = fopen(path, "r");
	if (!f) {
		httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "No such file on the card");
		return ESP_FAIL;
	}
	buf = malloc(4096);
	if (!buf) {
		fclose(f);
		return httpd_resp_send_500(req);
	}
	snprintf(disp, sizeof(disp), "attachment; filename=\"%s\"", name);
	httpd_resp_set_type(req, "application/octet-stream");
	httpd_resp_set_hdr(req, "Content-Disposition", disp);
	while ((n = fread(buf, 1, 4096, f)) > 0) {
		if (httpd_resp_send_chunk(req, buf, n) != ESP_OK) {
			break;
		}
	}
	fclose(f);
	free(buf);
	return httpd_resp_send_chunk(req, NULL, 0);
}

static esp_err_t h_file_delete(httpd_req_t *req)
{
	char name[STORAGE_NAME_LEN], err[160];

	if (!file_name(req, name, sizeof(name))) {
		return send_error(req, "Not a recording name.");
	}
	if (storage_delete(name, err, sizeof(err)) != 0) {
		return send_error(req, err);
	}
	return h_files(req);
}

/* ------------------------------------------------------------ WebSocket */

static esp_err_t h_ws(httpd_req_t *req)
{
	httpd_ws_frame_t frame = { .type = HTTPD_WS_TYPE_TEXT };
	uint8_t buf[128];
	esp_err_t e;

	if (req->method == HTTP_GET) {
		ESP_LOGI(TAG, "dashboard connected");
		app_notify();   /* a fresh status right away */
		return ESP_OK;
	}
	/* The dashboard sends nothing we act on. Any failure -- a phone that
	 * walked out of range, a frame we can't read whole -- must return an
	 * error: that is what makes the server close the socket. Returning OK
	 * leaves a dead socket that is retried forever and locks out every
	 * other visitor. */
	e = httpd_ws_recv_frame(req, &frame, 0);
	if (e != ESP_OK) {
		return e;
	}
	if (frame.len >= sizeof(buf)) {
		return ESP_FAIL;
	}
	if (frame.len > 0) {
		frame.payload = buf;
		return httpd_ws_recv_frame(req, &frame, frame.len);
	}
	return ESP_OK;
}

struct bcast {
	size_t len;
	char   text[];
};

static void bcast_work(void *arg)
{
	struct bcast *b = arg;
	httpd_ws_frame_t frame = {
		.type = HTTPD_WS_TYPE_TEXT,
		.payload = (uint8_t *)b->text,
		.len = b->len,
		.final = true,
	};
	int fds[CONFIG_LWIP_MAX_SOCKETS];
	size_t n = CONFIG_LWIP_MAX_SOCKETS;
	int count = 0;

	if (httpd_get_client_list(server, &n, fds) == ESP_OK) {
		for (size_t i = 0; i < n; i++) {
			if (httpd_ws_get_fd_info(server, fds[i]) == HTTPD_WS_CLIENT_WEBSOCKET) {
				/* A client that can't take a frame is gone; close it
				 * rather than keep a dead socket. */
				if (httpd_ws_send_frame_async(server, fds[i], &frame) != ESP_OK) {
					httpd_sess_trigger_close(server, fds[i]);
					continue;
				}
				count++;
			}
		}
	}
	ws_clients = count;
	free(b);
}

void net_broadcast(const char *text, size_t len)
{
	struct bcast *b;

	if (!server || ws_clients == 0) {
		return;
	}
	b = malloc(sizeof(*b) + len);
	if (!b) {
		return;
	}
	b->len = len;
	memcpy(b->text, text, len);
	if (httpd_queue_work(server, bcast_work, b) != ESP_OK) {
		free(b);
	}
}

int net_client_count(void)
{
	int fds[CONFIG_LWIP_MAX_SOCKETS];
	size_t n = CONFIG_LWIP_MAX_SOCKETS;
	int count = 0;

	if (server && httpd_get_client_list(server, &n, fds) == ESP_OK) {
		for (size_t i = 0; i < n; i++) {
			count += httpd_ws_get_fd_info(server, fds[i]) == HTTPD_WS_CLIENT_WEBSOCKET;
		}
	}
	ws_clients = count;
	return count;
}

/* ------------------------------------------------------------ DNS */

/* Answers every A query with the board's address. Enough of RFC 1035 for a
 * captive portal and nothing more. */
static void dns_task(void *arg)
{
	struct sockaddr_in addr = {
		.sin_family = AF_INET,
		.sin_port = htons(53),
		.sin_addr.s_addr = htonl(INADDR_ANY),
	};
	uint8_t buf[512];
	int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);

	if (sock < 0 || bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		ESP_LOGE(TAG, "DNS server could not start");
		vTaskDelete(NULL);
		return;
	}
	for (;;) {
		struct sockaddr_in from;
		socklen_t flen = sizeof(from);
		int len = recvfrom(sock, buf, sizeof(buf) - 16, 0,
				   (struct sockaddr *)&from, &flen);
		int q = 12;

		if (len < 12 || (buf[2] & 0x80)) {
			continue;   /* too short, or a response */
		}
		/* Walk past the first question's name. */
		while (q < len && buf[q] != 0) {
			q += buf[q] + 1;
		}
		q += 5;         /* terminator, QTYPE, QCLASS */
		if (q > len) {
			continue;
		}
		buf[2] = 0x84;  /* response, authoritative */
		buf[3] = 0x00;
		buf[6] = 0; buf[7] = 1;                  /* one answer */
		buf[8] = buf[9] = buf[10] = buf[11] = 0;
		len = q;
		{
			const uint8_t ans[] = {
				0xC0, 0x0C,             /* name: pointer to the question */
				0x00, 0x01, 0x00, 0x01, /* A, IN */
				0x00, 0x00, 0x00, 0x3C, /* TTL 60 s */
				0x00, 0x04, 192, 168, 4, 1,
			};

			memcpy(buf + len, ans, sizeof(ans));
			len += sizeof(ans);
		}
		sendto(sock, buf, len, 0, (struct sockaddr *)&from, flen);
	}
}

/* ------------------------------------------------------------ start */

static void start_wifi(void)
{
	wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
	wifi_config_t ap = {
		.ap = {
			.channel = AP_CHANNEL,
			.max_connection = AP_MAX_CONN,
			.authmode = WIFI_AUTH_OPEN,
		},
	};

	ESP_ERROR_CHECK(esp_netif_init());
	ESP_ERROR_CHECK(esp_event_loop_create_default());
	esp_netif_create_default_wifi_ap();
	ESP_ERROR_CHECK(esp_wifi_init(&init));

	snprintf((char *)ap.ap.ssid, sizeof(ap.ap.ssid), "%s", net_board_name());
	ap.ap.ssid_len = strlen((char *)ap.ap.ssid);
	ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
	ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
	ESP_ERROR_CHECK(esp_wifi_start());
	ESP_LOGI(TAG, "WiFi network \"%s\" is up; dashboard at http://" AP_IP "/",
		 net_board_name());
}

static void start_http(void)
{
	httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
	static const httpd_uri_t routes[] = {
		{ .uri = "/", .method = HTTP_GET, .handler = h_dashboard },
		{ .uri = "/index.html", .method = HTTP_GET, .handler = h_dashboard },
		{ .uri = "/api/status", .method = HTTP_GET, .handler = h_status },
		{ .uri = "/api/config", .method = HTTP_GET, .handler = h_config },
		{ .uri = "/api/config", .method = HTTP_PUT, .handler = h_config_put },
		{ .uri = "/api/config", .method = HTTP_DELETE, .handler = h_config_delete },
		{ .uri = "/api/record", .method = HTTP_POST, .handler = h_record },
		{ .uri = "/api/label", .method = HTTP_POST, .handler = h_label },
		{ .uri = "/api/time", .method = HTTP_POST, .handler = h_time },
		{ .uri = "/api/burnin", .method = HTTP_POST, .handler = h_burnin },
		{ .uri = "/api/ota", .method = HTTP_POST, .handler = ota_handler },
		{ .uri = "/api/rescan", .method = HTTP_POST, .handler = h_rescan },
		{ .uri = "/api/files", .method = HTTP_GET, .handler = h_files },
		{ .uri = "/api/files/*", .method = HTTP_GET, .handler = h_file_get },
		{ .uri = "/api/files/*", .method = HTTP_DELETE, .handler = h_file_delete },
	};
	httpd_uri_t ws = {
		.uri = "/ws", .method = HTTP_GET, .handler = h_ws,
		.is_websocket = true,
	};

	cfg.uri_match_fn = httpd_uri_match_wildcard;
	cfg.max_uri_handlers = 24;
	cfg.lru_purge_enable = true;
	/* Notice phones that leave without closing their connection. */
	cfg.keep_alive_enable = true;
	cfg.keep_alive_idle = 10;
	cfg.keep_alive_interval = 5;
	cfg.keep_alive_count = 3;
	cfg.stack_size = 8192;
	/* One dropped phone can make these log a warning per failed read; the
	 * console is also the data channel, so keep them to real errors. */
	esp_log_level_set("httpd_txrx", ESP_LOG_ERROR);
	esp_log_level_set("httpd_ws", ESP_LOG_ERROR);
	esp_log_level_set("httpd_parse", ESP_LOG_ERROR);

	if (httpd_start(&server, &cfg) != ESP_OK) {
		ESP_LOGE(TAG, "web server did not start");
		return;
	}
	for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
		httpd_register_uri_handler(server, &routes[i]);
	}
	httpd_register_uri_handler(server, &ws);
	httpd_register_err_handler(server, HTTPD_404_NOT_FOUND, h_not_found);
}

void net_start(void)
{
	start_wifi();
	start_http();
	xTaskCreate(dns_task, "dns", 3072, NULL, 3, NULL);
}
