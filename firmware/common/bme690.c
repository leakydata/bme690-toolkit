/*
 * BME690 gas sensor driver -- portable core.
 *
 * Ported from Bosch Sensortec's BME690_SensorAPI (BSD-3-Clause), float
 * compensation path. Verified against a working Python port that produced
 * plausible readings from eight sensors simultaneously.
 *
 * Depends on nothing but the C library; the application supplies read, write
 * and delay callbacks.
 *
 * SPDX-License-Identifier: MIT
 */
#include "bme690.h"
#include <string.h>

/* registers */
#define REG_COEFF3        0x00
#define REG_FIELD0        0x1D
#define REG_IDAC_HEAT0    0x50
#define REG_RES_HEAT0     0x5A
#define REG_GAS_WAIT0     0x64
#define REG_SHD_HEATR_DUR 0x6E
#define REG_CTRL_GAS_0    0x70
#define REG_CTRL_GAS_1    0x71
#define REG_CTRL_MEAS     0x74
#define REG_MEM_PAGE      0xF3
#define REG_COEFF1        0x8A
#define REG_CHIP_ID       0xD0
#define REG_SOFT_RESET    0xE0
#define REG_COEFF2        0xE1
#define REG_VARIANT_ID    0xF0

#define SOFT_RESET_CMD    0xB6
#define LEN_COEFF1        23
#define LEN_COEFF2        14
#define LEN_COEFF3        5
#define LEN_COEFF_ALL     42
#define LEN_FIELD         17

#define MEM_PAGE0         0x10
#define MEM_PAGE1         0x00
#define MEM_PAGE_MSK      0x10
#define SPI_RD_MSK        0x80
#define SPI_WR_MSK        0x7F

#define NBCONV_MSK        0x0F
#define FILTER_MSK        0x1C
#define FILTER_POS        2
#define ODR3_MSK          0x80
#define ODR3_POS          7
#define ODR20_MSK         0xE0
#define ODR20_POS         5
#define OST_MSK           0xE0
#define OST_POS           5
#define OSP_MSK           0x1C
#define OSP_POS           2
#define OSH_MSK           0x07
#define HCTRL_MSK         0x08
#define HCTRL_POS         3
#define RUN_GAS_MSK       0x30
#define RUN_GAS_POS       5
#define MODE_MSK          0x03
#define RHRANGE_MSK       0x30
#define RSERROR_MSK       0xF0
#define GAS_INDEX_MSK     0x0F
#define GAS_RANGE_MSK     0x0F

/* calibration byte offsets within the 42-byte block */
#define IDX_DTK1_C_LSB 0
#define IDX_DTK1_C_MSB 1
#define IDX_DTK2_C     2
#define IDX_S_C_LSB    4
#define IDX_S_C_MSB    5
#define IDX_TK1S_C_LSB 6
#define IDX_TK1S_C_MSB 7
#define IDX_TK2S_C     8
#define IDX_TK3S_C     9
#define IDX_O_C_LSB    10
#define IDX_O_C_MSB    11
#define IDX_TK10_C_LSB 12
#define IDX_TK10_C_MSB 13
#define IDX_TK20_C     14
#define IDX_TK30_C     15
#define IDX_NLS_C_LSB  18
#define IDX_NLS_C_MSB  19
#define IDX_TKNLS_C    20
#define IDX_NLS3_C     21
#define IDX_S_H_MSB    23
#define IDX_S_H_LSB    24
#define IDX_O_H_LSB    24
#define IDX_O_H_MSB    25
#define IDX_TK10H_C    26
#define IDX_PAR_H4     27
#define IDX_PAR_H3     28
#define IDX_HLIN2_C    29
#define IDX_DO_C_LSB   31
#define IDX_DO_C_MSB   32
#define IDX_TKR_C_LSB  33
#define IDX_TKR_C_MSB  34
#define IDX_RO_C       35
#define IDX_T_AMB_COMP 36
#define IDX_RES_HEAT_VAL   37
#define IDX_RES_HEAT_RANGE 39
#define IDX_RANGE_SW_ERR   41

#define SET_BITS(reg, msk, pos, val) (((reg) & ~(msk)) | (((val) << (pos)) & (msk)))
#define SET_BITS_POS_0(reg, msk, val) (((reg) & ~(msk)) | ((val) & (msk)))
#define CONCAT(msb, lsb) (((uint16_t)(msb) << 8) | (lsb))

/* ---------------------------------------------------------------- transport */

static int xfer_read(struct bme690_dev *dev, uint8_t reg, uint8_t *buf, size_t len)
{
	return dev->read(dev->ctx, reg, buf, len) ? BME690_E_COM : BME690_OK;
}

static int xfer_write(struct bme690_dev *dev, uint8_t reg, const uint8_t *buf,
		      size_t len)
{
	return dev->write(dev->ctx, reg, buf, len) ? BME690_E_COM : BME690_OK;
}

/* The BME690 keeps registers in two SPI memory pages selected by bit 4 of
 * 0xF3. Registers above 0x7F live in page 1, the rest in page 0. */
static int set_mem_page(struct bme690_dev *dev, uint8_t reg)
{
	uint8_t page = (reg > 0x7F) ? MEM_PAGE1 : MEM_PAGE0;
	uint8_t val;
	int rc;

	if (page == dev->mem_page) {
		return 0;
	}
	rc = xfer_read(dev, REG_MEM_PAGE | SPI_RD_MSK, &val, 1);
	if (rc) {
		return rc;
	}
	val = (val & ~MEM_PAGE_MSK) | (page & MEM_PAGE_MSK);
	rc = xfer_write(dev, REG_MEM_PAGE & SPI_WR_MSK, &val, 1);
	if (rc == 0) {
		dev->mem_page = page;
	}
	return rc;
}

static int get_regs(struct bme690_dev *dev, uint8_t reg, uint8_t *buf, size_t len)
{
	int rc = set_mem_page(dev, reg);

	return rc ? rc : xfer_read(dev, reg | SPI_RD_MSK, buf, len);
}

static int set_reg(struct bme690_dev *dev, uint8_t reg, uint8_t val)
{
	int rc = set_mem_page(dev, reg);

	return rc ? rc : xfer_write(dev, reg & SPI_WR_MSK, &val, 1);
}

/* ------------------------------------------------------------ compensation */

static float calc_temperature(struct bme690_dev *dev, uint32_t adc)
{
	const struct bme690_calib *k = &dev->calib;
	int32_t do1 = (int32_t)k->par_t1 << 8;
	double dtk1 = (double)k->par_t2 / (double)(1ULL << 30);
	double dtk2 = (double)k->par_t3 / (double)(1ULL << 48);
	int32_t cf = (int32_t)adc - do1;

	return (float)((double)cf * dtk1 + (double)cf * (double)cf * dtk2);
}

static float calc_pressure(struct bme690_dev *dev, uint32_t adc, float t)
{
	const struct bme690_calib *k = &dev->calib;
	uint32_t o = (uint32_t)k->par_p1 * (uint32_t)(1ULL << 3);
	double tk10 = (double)k->par_p2 / (double)(1ULL << 6);
	double tk20 = (double)k->par_p3 / (double)(1ULL << 8);
	double tk30 = (double)k->par_p4 / (double)(1ULL << 15);
	double s    = ((double)k->par_p5 - (double)(1ULL << 14)) / (double)(1ULL << 20);
	double tk1s = ((double)k->par_p6 - (double)(1ULL << 14)) / (double)(1ULL << 29);
	double tk2s = (double)k->par_p7 / (double)(1ULL << 32);
	double tk3s = (double)k->par_p8 / (double)(1ULL << 37);
	double nls  = (double)k->par_p9 / (double)(1ULL << 48);
	double tknls = (double)k->par_p10 / (double)(1ULL << 48);
	/* 2^65 exceeds double's exponent handling in the reference code, so it
	 * is split the same way there: A^(x+y) = A^x * A^y */
	double nls3 = (double)k->par_p11 / ((double)(1ULL << 35) * (double)(1ULL << 30));
	double t2 = (double)t * t, t3 = t2 * t;

	double tmp1 = (double)o + tk10 * t + tk20 * t2 + tk30 * t3;
	double tmp2 = (double)adc * (s + tk1s * t + tk2s * t2 + tk3s * t3);
	double tmp3 = (double)adc * (double)adc * (nls + tknls * t);
	double tmp4 = (double)adc * (double)adc * (double)adc * nls3;

	return (float)(tmp1 + tmp2 + tmp3 + tmp4);
}

static float calc_humidity(struct bme690_dev *dev, uint16_t adc, float t)
{
	const struct bme690_calib *k = &dev->calib;
	double tc = (double)t * 5120.0 - 76800.0;
	double oh    = (double)k->par_h1 * (double)(1ULL << 6);
	double sh    = (double)k->par_h5 / (double)(1ULL << 16);
	double tk10h = (double)k->par_h2 / (double)(1ULL << 14);
	double tk1sh = (double)k->par_h4 / (double)(1ULL << 26);
	double tk2sh = (double)k->par_h3 / (double)(1ULL << 26);
	double hlin2 = (double)k->par_h6 / (double)(1ULL << 19);
	double hoff  = (double)adc - (oh + tk10h * tc);
	double hsens = hoff * sh * (1.0 + tk1sh * tc + tk1sh * tk2sh * tc * tc);
	double hum   = hsens * (1.0 - hlin2 * hsens);
	int32_t scaled = (int32_t)(hum * 1000.0);

	if (scaled >= 100000) {
		return 100.0f;
	}
	if (scaled < 0) {
		return 0.0f;
	}
	return (float)hum;
}

static float calc_gas_resistance(uint16_t adc, uint8_t range)
{
	uint32_t var1 = UINT32_C(262144) >> range;
	int32_t var2 = 4096 + ((int32_t)adc - 512) * 3;

	return 1000000.0f * (float)var1 / (float)var2;
}

static uint8_t calc_res_heat(struct bme690_dev *dev, uint16_t temp)
{
	const struct bme690_calib *k = &dev->calib;
	float v1, v2, v3, v4, v5;

	if (temp > 400) {
		temp = 400;
	}
	v1 = ((float)k->par_g1 / 16.0f) + 49.0f;
	v2 = (((float)k->par_g2 / 32768.0f) * 0.0005f) + 0.00235f;
	v3 = (float)k->par_g3 / 1024.0f;
	v4 = v1 * (1.0f + v2 * (float)temp);
	v5 = v4 + v3 * (float)dev->amb_temp;
	return (uint8_t)(3.4f * ((v5 * (4.0f / (4.0f + (float)k->res_heat_range)) *
				  (1.0f / (1.0f + (float)k->res_heat_val * 0.002f))) - 25.0f));
}

static uint8_t calc_heatr_dur_shared(uint16_t dur)
{
	uint8_t factor = 0;

	if (dur >= 0x783) {
		return 0xFF;
	}
	dur = (uint16_t)(((uint32_t)dur * 1000) / 477);  /* 0.477 ms steps */
	while (dur > 0x3F) {
		dur >>= 2;
		factor++;
	}
	return (uint8_t)(dur + factor * 64);
}

/* ------------------------------------------------------------------- calib */

static int read_calib(struct bme690_dev *dev)
{
	uint8_t c[LEN_COEFF_ALL];
	struct bme690_calib *k = &dev->calib;
	int rc;
	int16_t h;

	rc = get_regs(dev, REG_COEFF1, c, LEN_COEFF1);
	if (rc == 0) {
		rc = get_regs(dev, REG_COEFF2, &c[LEN_COEFF1], LEN_COEFF2);
	}
	if (rc == 0) {
		rc = get_regs(dev, REG_COEFF3, &c[LEN_COEFF1 + LEN_COEFF2], LEN_COEFF3);
	}
	if (rc) {
		return rc;
	}

	k->par_t1 = CONCAT(c[IDX_DO_C_MSB], c[IDX_DO_C_LSB]);
	k->par_t2 = CONCAT(c[IDX_DTK1_C_MSB], c[IDX_DTK1_C_LSB]);
	k->par_t3 = (int8_t)c[IDX_DTK2_C];

	k->par_p5 = (int16_t)CONCAT(c[IDX_S_C_MSB], c[IDX_S_C_LSB]);
	k->par_p6 = (int16_t)CONCAT(c[IDX_TK1S_C_MSB], c[IDX_TK1S_C_LSB]);
	k->par_p7 = (int8_t)c[IDX_TK2S_C];
	k->par_p8 = (int8_t)c[IDX_TK3S_C];
	k->par_p1 = (int16_t)CONCAT(c[IDX_O_C_MSB], c[IDX_O_C_LSB]);
	k->par_p2 = CONCAT(c[IDX_TK10_C_MSB], c[IDX_TK10_C_LSB]);
	k->par_p3 = (int8_t)c[IDX_TK20_C];
	k->par_p4 = (int8_t)c[IDX_TK30_C];
	k->par_p9 = (int16_t)CONCAT(c[IDX_NLS_C_MSB], c[IDX_NLS_C_LSB]);
	k->par_p10 = (int8_t)c[IDX_TKNLS_C];
	k->par_p11 = (int8_t)c[IDX_NLS3_C];

	h = (int16_t)(((int16_t)c[IDX_S_H_MSB] << 4) | (c[IDX_S_H_LSB] >> 4));
	k->par_h5 = (h > 2047) ? (int16_t)(h - 4096) : h;
	h = (int16_t)(((int16_t)c[IDX_O_H_MSB] << 4) | (c[IDX_O_H_LSB] & 0x0F));
	k->par_h1 = (h > 2047) ? (int16_t)(h - 4096) : h;
	k->par_h2 = (int8_t)c[IDX_TK10H_C];
	k->par_h4 = (int8_t)c[IDX_PAR_H4];
	k->par_h3 = c[IDX_PAR_H3];
	k->par_h6 = c[IDX_HLIN2_C];

	k->par_g1 = (int8_t)c[IDX_RO_C];
	k->par_g2 = (int16_t)CONCAT(c[IDX_TKR_C_MSB], c[IDX_TKR_C_LSB]);
	k->par_g3 = (int8_t)c[IDX_T_AMB_COMP];

	k->res_heat_range = (c[IDX_RES_HEAT_RANGE] & RHRANGE_MSK) >> 4;
	k->res_heat_val = (int8_t)c[IDX_RES_HEAT_VAL];
	k->range_sw_err = (int8_t)((int8_t)(c[IDX_RANGE_SW_ERR] & RSERROR_MSK) / 16);
	return 0;
}

/* --------------------------------------------------------------- public API */

int bme690_soft_reset(struct bme690_dev *dev)
{
	int rc;

	dev->mem_page = -1;
	rc = set_reg(dev, REG_SOFT_RESET, SOFT_RESET_CMD);
	dev->delay_ms(10);
	dev->mem_page = -1;
	return rc;
}

int bme690_init(struct bme690_dev *dev)
{
	int rc;

	if (!dev->read || !dev->write || !dev->delay_ms) {
		return BME690_E_INVAL;
	}
	dev->mem_page = -1;

	rc = bme690_soft_reset(dev);
	if (rc) {
		return rc;
	}
	rc = get_regs(dev, REG_CHIP_ID, &dev->chip_id, 1);
	if (rc) {
		return rc;
	}
	if (dev->chip_id != BME690_CHIP_ID) {
		return BME690_E_NOT_FOUND;   /* caller reports; core stays silent */
	}
	rc = get_regs(dev, REG_VARIANT_ID, &dev->variant_id, 1);
	if (rc) {
		return rc;
	}
	return read_calib(dev);
}

int bme690_get_op_mode(struct bme690_dev *dev, uint8_t *op_mode)
{
	uint8_t v;
	int rc = get_regs(dev, REG_CTRL_MEAS, &v, 1);

	if (rc == 0) {
		*op_mode = v & MODE_MSK;
	}
	return rc;
}

int bme690_set_op_mode(struct bme690_dev *dev, uint8_t op_mode)
{
	uint8_t tmp, pow;
	int rc;

	/* always drop to sleep before switching */
	do {
		rc = get_regs(dev, REG_CTRL_MEAS, &tmp, 1);
		if (rc) {
			return rc;
		}
		pow = tmp & MODE_MSK;
		if (pow != BME690_SLEEP_MODE) {
			rc = set_reg(dev, REG_CTRL_MEAS, tmp & ~MODE_MSK);
			if (rc) {
				return rc;
			}
			dev->delay_ms(10);
		}
	} while (pow != BME690_SLEEP_MODE);

	if (op_mode != BME690_SLEEP_MODE) {
		return set_reg(dev, REG_CTRL_MEAS,
			       (tmp & ~MODE_MSK) | (op_mode & MODE_MSK));
	}
	return 0;
}

int bme690_set_conf(struct bme690_dev *dev, const struct bme690_conf *conf)
{
	uint8_t d[5];
	uint8_t odr20 = 0, odr3 = 1;
	uint8_t current;
	int rc;

	rc = bme690_get_op_mode(dev, &current);
	if (rc == 0) {
		rc = bme690_set_op_mode(dev, BME690_SLEEP_MODE);
	}
	if (rc == 0) {
		rc = get_regs(dev, REG_CTRL_GAS_1, d, 5);   /* 0x71..0x75 */
	}
	if (rc) {
		return rc;
	}

	if (conf->odr != BME690_ODR_NONE) {
		odr20 = conf->odr;
		odr3 = 0;
	}
	d[4] = SET_BITS(d[4], FILTER_MSK, FILTER_POS, conf->filter);
	d[3] = SET_BITS(d[3], OST_MSK, OST_POS, conf->os_temp);
	d[3] = SET_BITS(d[3], OSP_MSK, OSP_POS, conf->os_pres);
	d[1] = SET_BITS_POS_0(d[1], OSH_MSK, conf->os_hum);
	d[4] = SET_BITS(d[4], ODR20_MSK, ODR20_POS, odr20);
	d[0] = SET_BITS(d[0], ODR3_MSK, ODR3_POS, odr3);

	for (int i = 0; i < 5 && rc == 0; i++) {
		rc = set_reg(dev, 0x71 + i, d[i]);
	}
	if (rc == 0 && current != BME690_SLEEP_MODE) {
		rc = bme690_set_op_mode(dev, current);
	}
	return rc;
}

uint32_t bme690_get_meas_dur_us(const struct bme690_conf *conf, uint8_t op_mode)
{
	static const uint8_t cycles[6] = { 0, 1, 2, 4, 8, 16 };
	uint32_t n = cycles[conf->os_temp] + cycles[conf->os_pres] + cycles[conf->os_hum];
	uint32_t dur = n * 1963U + 477U * 4U + 477U * 5U;

	if (op_mode != BME690_PARALLEL_MODE) {
		dur += 1000U;   /* wake-up */
	}
	return dur;
}

int bme690_set_heatr_conf(struct bme690_dev *dev, uint8_t op_mode,
			  const struct bme690_heatr_conf *conf)
{
	uint8_t gas[2];
	uint8_t nb_conv = 0;
	int rc;

	rc = bme690_set_op_mode(dev, BME690_SLEEP_MODE);
	if (rc) {
		return rc;
	}

	if (op_mode == BME690_PARALLEL_MODE) {
		if (conf->shared_heatr_dur == 0) {
			return BME690_E_INVAL;
		}
		for (int i = 0; i < BME690_PROFILE_LEN; i++) {
			/* gas_wait_x is a single-byte multiplier of the shared
			 * duration. Truncating a larger value would silently
			 * shorten the step, so refuse instead. */
			/* gas_wait_x is a single byte; truncating would silently
			 * shorten the step, so refuse instead. */
			if (conf->dur_prof[i] > 255) {
				return BME690_E_INVAL;
			}
			rc = set_reg(dev, REG_RES_HEAT0 + i,
				     calc_res_heat(dev, conf->temp_prof[i]));
			if (rc == 0) {
				rc = set_reg(dev, REG_GAS_WAIT0 + i,
					     (uint8_t)conf->dur_prof[i]);
			}
			if (rc) {
				return rc;
			}
		}
		nb_conv = BME690_PROFILE_LEN;
		rc = set_reg(dev, REG_SHD_HEATR_DUR,
			     calc_heatr_dur_shared(conf->shared_heatr_dur));
		if (rc) {
			return rc;
		}
	} else {
		return BME690_E_INVAL;
	}

	rc = get_regs(dev, REG_CTRL_GAS_0, gas, 2);
	if (rc) {
		return rc;
	}
	gas[0] = SET_BITS(gas[0], HCTRL_MSK, HCTRL_POS, conf->enable ? 0 : 1);
	gas[1] = SET_BITS_POS_0(gas[1], NBCONV_MSK, nb_conv);
	gas[1] = SET_BITS(gas[1], RUN_GAS_MSK, RUN_GAS_POS, conf->enable ? 1 : 0);

	rc = set_reg(dev, REG_CTRL_GAS_0, gas[0]);
	return rc ? rc : set_reg(dev, REG_CTRL_GAS_1, gas[1]);
}

int bme690_get_data(struct bme690_dev *dev, uint8_t op_mode,
		    struct bme690_data *out, uint8_t *n_out)
{
	uint8_t buf[LEN_FIELD * 3];
	uint8_t set_val[30];
	struct bme690_data all[3];
	int rc;

	*n_out = 0;
	if (op_mode != BME690_PARALLEL_MODE) {
		return BME690_E_INVAL;
	}
	rc = get_regs(dev, REG_FIELD0, buf, sizeof(buf));
	if (rc == 0) {
		rc = get_regs(dev, REG_IDAC_HEAT0, set_val, sizeof(set_val));
	}
	if (rc) {
		return rc;
	}

	for (int i = 0; i < 3; i++) {
		const uint8_t *f = &buf[i * LEN_FIELD];
		struct bme690_data *d = &all[i];
		uint32_t adc_p, adc_t;
		uint16_t adc_h, adc_g;
		uint8_t range;

		d->status = f[0] & BME690_STATUS_NEW_DATA;
		d->gas_index = f[0] & GAS_INDEX_MSK;
		d->meas_index = f[1];

		adc_p = ((uint32_t)f[2] << 16) | ((uint32_t)f[3] << 8) | f[4];
		adc_t = ((uint32_t)f[5] << 16) | ((uint32_t)f[6] << 8) | f[7];
		adc_h = ((uint16_t)f[8] << 8) | f[9];
		adc_g = ((uint16_t)f[15] << 2) | (f[16] >> 6);
		range = f[16] & GAS_RANGE_MSK;

		d->status |= f[16] & BME690_STATUS_GAS_VALID;
		d->status |= f[16] & BME690_STATUS_HEAT_STAB;

		d->idac     = set_val[d->gas_index];
		d->res_heat = set_val[10 + d->gas_index];
		d->gas_wait = set_val[20 + d->gas_index];

		d->temperature = calc_temperature(dev, adc_t);
		d->pressure    = calc_pressure(dev, adc_p, d->temperature);
		d->humidity    = calc_humidity(dev, adc_h, d->temperature);
		d->gas_resistance = calc_gas_resistance(adc_g, range);
	}

	/* order by measurement index, then keep the ones carrying new data */
	for (int i = 0; i < 3; i++) {
		for (int j = i + 1; j < 3; j++) {
			if (all[j].meas_index < all[i].meas_index) {
				struct bme690_data t = all[i];

				all[i] = all[j];
				all[j] = t;
			}
		}
	}
	for (int i = 0; i < 3; i++) {
		if (all[i].status & BME690_STATUS_NEW_DATA) {
			out[(*n_out)++] = all[i];
		}
	}
	return 0;
}
