/* BOOT button and the status LED.
 *
 * Button: a short press starts the next sample label; holding it for two
 * seconds starts or stops recording.
 *
 * DevKitC RGB LED, one pulse every two seconds:
 *   green  recording, all fine        blue   running, not recording
 *   amber  running, with a warning    red    a problem needs attention
 * A white blink acknowledges a button press or a command.
 *
 * XIAO orange LED, every two seconds: a long blink while recording, a
 * short blip while not, a double blink for a warning or a problem. It is
 * off whenever an SD card is mounted, because on the Sense its pin is the
 * card's chip select.
 *
 * SPDX-License-Identifier: MIT */
#include "ui.h"
#include "app.h"
#include "board.h"
#include "storage.h"
#include "led_strip.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define TICK_MS      20
#define LONG_MS      2000
#define PULSE_MS     2000
#define PULSE_ON_MS  250
#define FLASH_MS     150
#define BRIGHT       24     /* of 255: visible, not blinding */

static led_strip_handle_t leds[2];
#if LED_SIMPLE
static bool simple_led;
#endif
static volatile int64_t flash_until;

void ui_flash(void)
{
	flash_until = esp_timer_get_time() / 1000 + FLASH_MS;
}

static void set_led(uint8_t r, uint8_t g, uint8_t b)
{
#if LED_SIMPLE
	if (simple_led) {
		gpio_set_level(PIN_LED, (r | g | b) ? LED_ON_LEVEL : !LED_ON_LEVEL);
	}
	return;
#endif
	for (int i = 0; i < 2; i++) {
		if (leds[i]) {
			led_strip_set_pixel(leds[i], 0, r, g, b);
			led_strip_refresh(leds[i]);
		}
	}
}

static void led_init(void)
{
#if LED_SIMPLE
	struct storage_status st;

	storage_get_status(&st);
	if (LED_SHARES_SD_CS && st.present) {
		return;   /* the pin is the card's chip select */
	}
	gpio_config_t io = {
		.pin_bit_mask = 1ULL << PIN_LED,
		.mode = GPIO_MODE_OUTPUT,
	};
	gpio_set_level(PIN_LED, !LED_ON_LEVEL);
	if (gpio_config(&io) == ESP_OK) {
		simple_led = true;
	}
#else
	const gpio_num_t pins[2] = { PIN_LED_V10, PIN_LED_V11 };

	for (int i = 0; i < 2; i++) {
		led_strip_config_t cfg = {
			.strip_gpio_num = pins[i],
			.max_leds = 1,
			.led_model = LED_MODEL_WS2812,
			.color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
		};
		led_strip_rmt_config_t rmt = {
			.clk_src = RMT_CLK_SRC_DEFAULT,
			.resolution_hz = 10 * 1000 * 1000,
		};

		if (led_strip_new_rmt_device(&cfg, &rmt, &leds[i]) != ESP_OK) {
			leds[i] = NULL;
		}
	}
#endif
}

/* The one-colour LED's pattern within each two-second period. */
static bool simple_pattern(int64_t now)
{
	int64_t t = now % PULSE_MS;

	if (app_worst_level() >= LEVEL_WARN) {
		return t < 120 || (t >= 300 && t < 420);
	}
	return t < (app_recording() ? PULSE_ON_MS : 40);
}

static void ui_task(void *arg)
{
	int64_t pressed_at = -1;
	bool long_done = false;
	uint32_t last_rgb = ~0u;

	for (;;) {
		int64_t now = esp_timer_get_time() / 1000;
		bool down = gpio_get_level(PIN_BUTTON) == 0;
		uint8_t r = 0, g = 0, b = 0;
		uint32_t rgb;

		if (down && pressed_at < 0) {
			pressed_at = now;
			long_done = false;
		} else if (down && !long_done && now - pressed_at >= LONG_MS) {
			char err[160];

			long_done = true;
			app_record(!app_recording(), err, sizeof(err));
		} else if (!down && pressed_at >= 0) {
			if (!long_done && now - pressed_at >= 30) {   /* debounce */
				app_label_next();
			}
			pressed_at = -1;
		}

		if (now < flash_until || (down && now - pressed_at >= LONG_MS)) {
			r = g = b = BRIGHT;
		} else if (LED_SIMPLE) {
			r = simple_pattern(now) ? BRIGHT : 0;
		} else if (now % PULSE_MS < PULSE_ON_MS) {
			switch (app_worst_level()) {
			case LEVEL_ERROR: r = BRIGHT; break;
			case LEVEL_WARN:  r = BRIGHT; g = BRIGHT / 2; break;
			default:
				if (app_recording()) {
					g = BRIGHT;
				} else {
					b = BRIGHT;
				}
			}
		}

		rgb = (r << 16) | (g << 8) | b;
		if (rgb != last_rgb) {
			set_led(r, g, b);
			last_rgb = rgb;
		}
		vTaskDelay(pdMS_TO_TICKS(TICK_MS));
	}
}

void ui_start(void)
{
	gpio_config_t btn = {
		.pin_bit_mask = 1ULL << PIN_BUTTON,
		.mode = GPIO_MODE_INPUT,
		.pull_up_en = GPIO_PULLUP_ENABLE,
	};

	gpio_config(&btn);
	led_init();
	xTaskCreate(ui_task, "ui", 4096, NULL, 2, NULL);
}
