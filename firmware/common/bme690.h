/*
 * BME690 gas sensor driver -- portable core.
 *
 * Register layout and compensation are ported from Bosch Sensortec's
 * BME690_SensorAPI (bme69x.c / bme69x_defs.h), BSD-3-Clause, using the
 * floating-point compensation path.
 *
 * No RTOS or HAL dependencies: supply read/write/delay callbacks and this
 * builds anywhere. Transport shims for Zephyr and ESP-IDF live beside the
 * applications that use them.
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef BME690_H_
#define BME690_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define BME690_CHIP_ID            0x61

/* operating modes */
#define BME690_SLEEP_MODE         0
#define BME690_FORCED_MODE        1
#define BME690_PARALLEL_MODE      2
#define BME690_SEQUENTIAL_MODE    3

/* oversampling */
#define BME690_OS_NONE            0
#define BME690_OS_1X              1
#define BME690_OS_2X              2
#define BME690_OS_4X              3
#define BME690_OS_8X              4
#define BME690_OS_16X             5

/* IIR filter */
#define BME690_FILTER_OFF         0

/* output data rate */
#define BME690_ODR_NONE           8

/* A heater profile is always ten steps: that is what BME AI-Studio's
 * importer requires, and what the hardware's gas_wait_0..9 registers hold. */
#define BME690_PROFILE_LEN        10

struct bme690_calib {
	uint16_t par_t1, par_t2;
	int8_t   par_t3;
	int16_t  par_p1, par_p5, par_p6, par_p9;
	uint16_t par_p2;
	int8_t   par_p3, par_p4, par_p7, par_p8, par_p10, par_p11;
	int16_t  par_h1, par_h5;
	int8_t   par_h2, par_h4;
	uint8_t  par_h3, par_h6;
	int8_t   par_g1, par_g3;
	int16_t  par_g2;
	uint8_t  res_heat_range;
	int8_t   res_heat_val;
	int8_t   range_sw_err;
};

struct bme690_conf {
	uint8_t os_hum, os_temp, os_pres;
	uint8_t filter;
	uint8_t odr;
};

struct bme690_heatr_conf {
	bool     enable;
	uint16_t temp_prof[BME690_PROFILE_LEN];   /* degC */
	uint16_t dur_prof[BME690_PROFILE_LEN];    /* multiples of the shared duration, 0..255 */
	uint16_t shared_heatr_dur;                /* ms */
};

struct bme690_data {
	uint8_t  status;
	uint8_t  gas_index;     /* heater profile step, 0..9 */
	uint8_t  meas_index;
	float    temperature;   /* degC */
	float    pressure;      /* Pa -- divide by 100 for the hPa AI-Studio wants */
	float    humidity;      /* %RH */
	float    gas_resistance;/* ohm */
	uint8_t  idac, res_heat, gas_wait;
};

/*
 * One sensor. The transport owns chip-select and the SPI peripheral; the core
 * only asks it to move bytes. reg already carries the read/write bit.
 */
struct bme690_dev {
	int  (*read)(void *ctx, uint8_t reg, uint8_t *buf, size_t len);
	int  (*write)(void *ctx, uint8_t reg, const uint8_t *buf, size_t len);
	void (*delay_ms)(uint32_t ms);
	void                    *ctx;
	struct bme690_calib      calib;
	uint8_t                  chip_id;
	uint8_t                  variant_id;
	int8_t                   mem_page;
	int8_t                   amb_temp;
	uint8_t                  index;
};

/* Errors are plain negative ints so the core stays free of platform headers. */
#define BME690_OK            0
#define BME690_E_COM        -1
#define BME690_E_NOT_FOUND  -2
#define BME690_E_INVAL      -3

#define BME690_STATUS_NEW_DATA    0x80
#define BME690_STATUS_GAS_VALID   0x20
#define BME690_STATUS_HEAT_STAB   0x10

int bme690_init(struct bme690_dev *dev);
int bme690_soft_reset(struct bme690_dev *dev);
int bme690_set_conf(struct bme690_dev *dev, const struct bme690_conf *conf);
int bme690_set_heatr_conf(struct bme690_dev *dev, uint8_t op_mode,
			  const struct bme690_heatr_conf *conf);
int bme690_set_op_mode(struct bme690_dev *dev, uint8_t op_mode);
int bme690_get_op_mode(struct bme690_dev *dev, uint8_t *op_mode);
uint32_t bme690_get_meas_dur_us(const struct bme690_conf *conf, uint8_t op_mode);

/* Reads the three field registers; returns how many carried new data,
 * ordered by measurement index. out must hold at least 3 entries. */
int bme690_get_data(struct bme690_dev *dev, uint8_t op_mode,
		    struct bme690_data *out, uint8_t *n_out);

#endif /* BME690_H_ */
