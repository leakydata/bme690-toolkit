"""BME690 register map and constants.

Ported from Bosch Sensortec's BME690_SensorAPI (bme69x_defs.h), BSD-3-Clause.
"""

CHIP_ID = 0x61

# --- registers ---
REG_COEFF3 = 0x00
REG_FIELD0 = 0x1D
REG_IDAC_HEAT0 = 0x50
REG_RES_HEAT0 = 0x5A
REG_GAS_WAIT0 = 0x64
REG_SHD_HEATR_DUR = 0x6E
REG_CTRL_GAS_0 = 0x70
REG_CTRL_GAS_1 = 0x71
REG_CTRL_HUM = 0x72
REG_CTRL_MEAS = 0x74
REG_CONFIG = 0x75
REG_MEM_PAGE = 0xF3
REG_UNIQUE_ID = 0x83
REG_COEFF1 = 0x8A
REG_CHIP_ID = 0xD0
REG_SOFT_RESET = 0xE0
REG_COEFF2 = 0xE1
REG_VARIANT_ID = 0xF0

SOFT_RESET_CMD = 0xB6

# --- lengths ---
LEN_COEFF1 = 23
LEN_COEFF2 = 14
LEN_COEFF3 = 5
LEN_COEFF_ALL = 42
LEN_FIELD = 17
LEN_FIELD_OFFSET = 17
LEN_CONFIG = 5

# --- operating modes ---
SLEEP_MODE = 0
FORCED_MODE = 1
PARALLEL_MODE = 2
SEQUENTIAL_MODE = 3

# --- oversampling ---
OS_NONE, OS_1X, OS_2X, OS_4X, OS_8X, OS_16X = 0, 1, 2, 3, 4, 5

# --- IIR filter ---
FILTER_OFF = 0
FILTER_SIZE_1, FILTER_SIZE_3, FILTER_SIZE_7 = 1, 2, 3
FILTER_SIZE_15, FILTER_SIZE_31, FILTER_SIZE_63, FILTER_SIZE_127 = 4, 5, 6, 7

# --- output data rate ---
ODR_0_59_MS, ODR_62_5_MS, ODR_125_MS, ODR_250_MS = 0, 1, 2, 3
ODR_500_MS, ODR_1000_MS, ODR_10_MS, ODR_20_MS, ODR_NONE = 4, 5, 6, 7, 8

# --- memory pages (SPI) ---
MEM_PAGE0 = 0x10
MEM_PAGE1 = 0x00
MEM_PAGE_MSK = 0x10

SPI_RD_MSK = 0x80
SPI_WR_MSK = 0x7F

# --- bit masks / positions ---
NBCONV_MSK = 0x0F
FILTER_MSK, FILTER_POS = 0x1C, 2
ODR3_MSK, ODR3_POS = 0x80, 7
ODR20_MSK, ODR20_POS = 0xE0, 5
OST_MSK, OST_POS = 0xE0, 5
OSP_MSK, OSP_POS = 0x1C, 2
OSH_MSK = 0x07
HCTRL_MSK, HCTRL_POS = 0x08, 3
RUN_GAS_MSK, RUN_GAS_POS = 0x30, 5
MODE_MSK = 0x03
RHRANGE_MSK = 0x30
RSERROR_MSK = 0xF0
NEW_DATA_MSK = 0x80
GAS_INDEX_MSK = 0x0F
GAS_RANGE_MSK = 0x0F
GASM_VALID_MSK = 0x20
HEAT_STAB_MSK = 0x10

ENABLE_HEATER = 0x00
DISABLE_HEATER = 0x01
ENABLE_GAS_MEAS = 0x01
DISABLE_GAS_MEAS = 0x00

# --- calibration coefficient byte offsets within the 42-byte block ---
IDX_DTK1_C_LSB = 0
IDX_DTK1_C_MSB = 1
IDX_DTK2_C = 2
IDX_S_C_LSB = 4
IDX_S_C_MSB = 5
IDX_TK1S_C_LSB = 6
IDX_TK1S_C_MSB = 7
IDX_TK2S_C = 8
IDX_TK3S_C = 9
IDX_O_C_LSB = 10
IDX_O_C_MSB = 11
IDX_TK10_C_LSB = 12
IDX_TK10_C_MSB = 13
IDX_TK20_C = 14
IDX_TK30_C = 15
IDX_NLS_C_LSB = 18
IDX_NLS_C_MSB = 19
IDX_TKNLS_C = 20
IDX_NLS3_C = 21
IDX_S_H_MSB = 23
IDX_S_H_LSB = 24
IDX_O_H_LSB = 24
IDX_O_H_MSB = 25
IDX_TK10H_C = 26
IDX_PAR_H4 = 27
IDX_PAR_H3 = 28
IDX_HLIN2_C = 29
IDX_TKHLIN2_C = 30
IDX_DO_C_LSB = 31
IDX_DO_C_MSB = 32
IDX_TKR_C_LSB = 33
IDX_TKR_C_MSB = 34
IDX_RO_C = 35
IDX_T_AMB_COMP = 36
IDX_RES_HEAT_VAL = 37
IDX_RES_HEAT_RANGE = 39
IDX_RANGE_SW_ERR = 41


def set_bits(reg_data, mask, pos, data):
    return (reg_data & ~mask) | ((data << pos) & mask)


def set_bits_pos_0(reg_data, mask, data):
    return (reg_data & ~mask) | (data & mask)


def u8_to_s8(v):
    return v - 256 if v > 127 else v


def concat(msb, lsb):
    return (msb << 8) | lsb


def u16_to_s16(v):
    return v - 65536 if v > 32767 else v
