"""BME690 sensor driver.

A Python port of Bosch Sensortec's BME690_SensorAPI (bme69x.c, BSD-3-Clause),
using the floating-point (BME69X_USE_FPU) compensation path.

The driver is transport-agnostic: it talks to an object exposing
``read(reg, length) -> bytes`` and ``write(reg, data: bytes)``.
"""

import time
from dataclasses import dataclass, field
from typing import List, Optional, Sequence

from . import registers as R


def _u32(x: int) -> int:
    """Emulate C uint32_t truncation."""
    return x & 0xFFFFFFFF


class BME690Error(Exception):
    pass


@dataclass
class Calib:
    par_t1: int = 0
    par_t2: int = 0
    par_t3: int = 0
    par_p1: int = 0
    par_p2: int = 0
    par_p3: int = 0
    par_p4: int = 0
    par_p5: int = 0
    par_p6: int = 0
    par_p7: int = 0
    par_p8: int = 0
    par_p9: int = 0
    par_p10: int = 0
    par_p11: int = 0
    par_h1: int = 0
    par_h2: int = 0
    par_h3: int = 0
    par_h4: int = 0
    par_h5: int = 0
    par_h6: int = 0
    par_g1: int = 0
    par_g2: int = 0
    par_g3: int = 0
    res_heat_range: int = 0
    res_heat_val: int = 0
    range_sw_err: int = 0


@dataclass
class Reading:
    """One compensated measurement from one heater profile step."""
    status: int = 0
    gas_index: int = 0
    meas_index: int = 0
    temperature: float = 0.0     # degC
    pressure: float = 0.0        # Pa
    humidity: float = 0.0        # %RH
    gas_resistance: float = 0.0  # Ohm
    idac: int = 0
    res_heat: int = 0
    gas_wait: int = 0

    @property
    def new_data(self) -> bool:
        return bool(self.status & R.NEW_DATA_MSK)

    @property
    def gas_valid(self) -> bool:
        return bool(self.status & R.GASM_VALID_MSK)

    @property
    def heat_stable(self) -> bool:
        return bool(self.status & R.HEAT_STAB_MSK)


@dataclass
class TPHConf:
    os_hum: int = R.OS_1X
    os_temp: int = R.OS_2X
    os_pres: int = R.OS_16X
    filter: int = R.FILTER_OFF
    odr: int = R.ODR_NONE


@dataclass
class HeaterConf:
    enable: bool = True
    heatr_temp: int = 300              # forced mode
    heatr_dur: int = 100               # forced mode, ms
    heatr_temp_prof: Sequence[int] = field(default_factory=list)
    heatr_dur_prof: Sequence[int] = field(default_factory=list)
    shared_heatr_dur: int = 0          # parallel mode, ms


class BME690:
    def __init__(self, transport, amb_temp: int = 25, name: str = "bme690"):
        self.t = transport
        self.amb_temp = amb_temp
        self.name = name
        self.calib = Calib()
        self.variant_id = 0
        self.chip_id = 0
        self._mem_page: Optional[int] = None

    # ------------------------------------------------------------------ bus

    def _set_mem_page(self, reg_addr: int) -> None:
        page = R.MEM_PAGE1 if reg_addr > 0x7F else R.MEM_PAGE0
        if page == self._mem_page:
            return
        self._mem_page = page
        reg = self.t.read(R.REG_MEM_PAGE | R.SPI_RD_MSK, 1)[0]
        reg = (reg & ~R.MEM_PAGE_MSK) | (page & R.MEM_PAGE_MSK)
        self.t.write(R.REG_MEM_PAGE & R.SPI_WR_MSK, bytes([reg]))

    def get_regs(self, reg_addr: int, length: int = 1) -> bytes:
        self._set_mem_page(reg_addr)
        return self.t.read(reg_addr | R.SPI_RD_MSK, length)

    def set_regs(self, pairs: Sequence[tuple]) -> None:
        """pairs: sequence of (reg_addr, value)."""
        for reg_addr, value in pairs:
            self._set_mem_page(reg_addr)
            self.t.write(reg_addr & R.SPI_WR_MSK, bytes([value]))

    # ------------------------------------------------------------------ init

    def init(self) -> None:
        self.soft_reset()
        self.chip_id = self.get_regs(R.REG_CHIP_ID, 1)[0]
        if self.chip_id != R.CHIP_ID:
            raise BME690Error(
                f"{self.name}: device not found (chip id 0x{self.chip_id:02x}, "
                f"expected 0x{R.CHIP_ID:02x})"
            )
        self.variant_id = self.get_regs(R.REG_VARIANT_ID, 1)[0]
        self._read_calib()

    def soft_reset(self) -> None:
        self._mem_page = None
        self._set_mem_page(R.REG_SOFT_RESET)
        self.t.write(R.REG_SOFT_RESET & R.SPI_WR_MSK, bytes([R.SOFT_RESET_CMD]))
        time.sleep(0.01)
        self._mem_page = None

    def unique_id(self) -> int:
        b = self.get_regs(R.REG_UNIQUE_ID, 4)
        return int.from_bytes(bytes(b), "little")

    def _read_calib(self) -> None:
        c = bytearray(R.LEN_COEFF_ALL)
        c[0:R.LEN_COEFF1] = self.get_regs(R.REG_COEFF1, R.LEN_COEFF1)
        c[R.LEN_COEFF1:R.LEN_COEFF1 + R.LEN_COEFF2] = self.get_regs(R.REG_COEFF2, R.LEN_COEFF2)
        off = R.LEN_COEFF1 + R.LEN_COEFF2
        c[off:off + R.LEN_COEFF3] = self.get_regs(R.REG_COEFF3, R.LEN_COEFF3)

        k = self.calib
        s8, s16, cat = R.u8_to_s8, R.u16_to_s16, R.concat

        # temperature
        k.par_t1 = cat(c[R.IDX_DO_C_MSB], c[R.IDX_DO_C_LSB])                      # uint16
        k.par_t2 = cat(c[R.IDX_DTK1_C_MSB], c[R.IDX_DTK1_C_LSB])                  # uint16
        k.par_t3 = s8(c[R.IDX_DTK2_C])

        # pressure
        k.par_p5 = s16(cat(c[R.IDX_S_C_MSB], c[R.IDX_S_C_LSB]))
        k.par_p6 = s16(cat(c[R.IDX_TK1S_C_MSB], c[R.IDX_TK1S_C_LSB]))
        k.par_p7 = s8(c[R.IDX_TK2S_C])
        k.par_p8 = s8(c[R.IDX_TK3S_C])
        k.par_p1 = s16(cat(c[R.IDX_O_C_MSB], c[R.IDX_O_C_LSB]))
        k.par_p2 = cat(c[R.IDX_TK10_C_MSB], c[R.IDX_TK10_C_LSB])                  # uint16
        k.par_p3 = s8(c[R.IDX_TK20_C])
        k.par_p4 = s8(c[R.IDX_TK30_C])
        k.par_p9 = s16(cat(c[R.IDX_NLS_C_MSB], c[R.IDX_NLS_C_LSB]))
        k.par_p10 = s8(c[R.IDX_TKNLS_C])
        k.par_p11 = s8(c[R.IDX_NLS3_C])

        # humidity
        h5 = (c[R.IDX_S_H_MSB] << 4) | (c[R.IDX_S_H_LSB] >> 4)
        k.par_h5 = h5 - 4096 if h5 > 2047 else h5
        h1 = (c[R.IDX_O_H_MSB] << 4) | (c[R.IDX_O_H_LSB] & 0x0F)
        k.par_h1 = h1 - 4096 if h1 > 2047 else h1
        k.par_h2 = s8(c[R.IDX_TK10H_C])
        k.par_h4 = s8(c[R.IDX_PAR_H4])
        k.par_h3 = c[R.IDX_PAR_H3]                                                # uint8
        k.par_h6 = c[R.IDX_HLIN2_C]                                               # uint8

        # gas heater
        k.par_g1 = s8(c[R.IDX_RO_C])
        k.par_g2 = s16(cat(c[R.IDX_TKR_C_MSB], c[R.IDX_TKR_C_LSB]))
        k.par_g3 = s8(c[R.IDX_T_AMB_COMP])

        k.res_heat_range = (c[R.IDX_RES_HEAT_RANGE] & R.RHRANGE_MSK) >> 4
        k.res_heat_val = s8(c[R.IDX_RES_HEAT_VAL])
        # C: ((int8_t)(coeff & 0xf0)) / 16  -- signed division truncates toward zero
        rse = s8(c[R.IDX_RANGE_SW_ERR] & R.RSERROR_MSK)
        k.range_sw_err = int(rse / 16)

    # --------------------------------------------------------- compensation

    def _calc_temperature(self, temp_adc: int) -> float:
        k = self.calib
        do1 = k.par_t1 << 8
        dtk1 = k.par_t2 / float(1 << 30)
        dtk2 = k.par_t3 / float(1 << 48)
        cf = temp_adc - do1
        return float(cf * dtk1 + cf * cf * dtk2)

    def _calc_pressure(self, pres_adc: int, temp: float) -> float:
        k = self.calib
        o = _u32(_u32(k.par_p1) * 8)
        tk10 = k.par_p2 / float(1 << 6)
        tk20 = k.par_p3 / float(1 << 8)
        tk30 = k.par_p4 / float(1 << 15)
        s = (k.par_p5 - float(1 << 14)) / float(1 << 20)
        tk1s = (k.par_p6 - float(1 << 14)) / float(1 << 29)
        tk2s = k.par_p7 / float(1 << 32)
        tk3s = k.par_p8 / float(1 << 37)
        nls = k.par_p9 / float(1 << 48)
        tknls = k.par_p10 / float(1 << 48)
        nls3 = k.par_p11 / (float(1 << 35) * float(1 << 30))

        t2 = temp * temp
        t3 = t2 * temp
        tmp1 = o + tk10 * temp + tk20 * t2 + tk30 * t3
        tmp2 = pres_adc * (s + tk1s * temp + tk2s * t2 + tk3s * t3)
        tmp3 = pres_adc * pres_adc * (nls + tknls * temp)
        tmp4 = pres_adc * pres_adc * pres_adc * nls3
        return float(tmp1 + tmp2 + tmp3 + tmp4)

    def _calc_humidity(self, hum_adc: int, temp: float) -> float:
        k = self.calib
        temp_comp = temp * 5120 - 76800
        oh = k.par_h1 * float(1 << 6)
        sh = k.par_h5 / float(1 << 16)
        tk10h = k.par_h2 / float(1 << 14)
        tk1sh = k.par_h4 / float(1 << 26)
        tk2sh = k.par_h3 / float(1 << 26)
        hlin2 = k.par_h6 / float(1 << 19)

        hoff = hum_adc - (oh + tk10h * temp_comp)
        hsens = hoff * sh * (1 + tk1sh * temp_comp + tk1sh * tk2sh * temp_comp * temp_comp)
        hum = hsens * (1 - hlin2 * hsens)

        hum_int = int(hum * 1000.0)
        if hum_int >= 100000:
            return 100.0
        if hum_int < 0:
            return 0.0
        return float(hum)

    @staticmethod
    def _calc_gas_resistance(gas_res_adc: int, gas_range: int) -> float:
        var1 = 262144 >> gas_range
        var2 = 4096 + (gas_res_adc - 512) * 3
        return 1000000.0 * var1 / var2

    def _calc_res_heat(self, temp: int) -> int:
        k = self.calib
        temp = min(temp, 400)
        var1 = (k.par_g1 / 16.0) + 49.0
        var2 = ((k.par_g2 / 32768.0) * 0.0005) + 0.00235
        var3 = k.par_g3 / 1024.0
        var4 = var1 * (1.0 + var2 * temp)
        var5 = var4 + var3 * self.amb_temp
        res = int(3.4 * ((var5 * (4 / (4 + k.res_heat_range)) *
                          (1 / (1 + k.res_heat_val * 0.002))) - 25))
        return res & 0xFF

    @staticmethod
    def _calc_gas_wait(dur: int) -> int:
        if dur >= 0xFC0:
            return 0xFF
        factor = 0
        while dur > 0x3F:
            dur //= 4
            factor += 1
        return (dur + factor * 64) & 0xFF

    @staticmethod
    def _calc_heatr_dur_shared(dur: int) -> int:
        if dur >= 0x783:
            return 0xFF
        factor = 0
        dur = (dur * 1000) // 477
        while dur > 0x3F:
            dur >>= 2
            factor += 1
        return (dur + factor * 64) & 0xFF

    # ------------------------------------------------------------ operation

    def get_op_mode(self) -> int:
        return self.get_regs(R.REG_CTRL_MEAS, 1)[0] & R.MODE_MSK

    def set_op_mode(self, op_mode: int) -> None:
        # Always return to sleep before switching modes.
        while True:
            tmp = self.get_regs(R.REG_CTRL_MEAS, 1)[0]
            pow_mode = tmp & R.MODE_MSK
            if pow_mode == R.SLEEP_MODE:
                break
            self.set_regs([(R.REG_CTRL_MEAS, tmp & ~R.MODE_MSK)])
            time.sleep(0.01)
        if op_mode != R.SLEEP_MODE:
            self.set_regs([(R.REG_CTRL_MEAS, (tmp & ~R.MODE_MSK) | (op_mode & R.MODE_MSK))])

    def set_conf(self, conf: TPHConf) -> None:
        current = self.get_op_mode()
        self.set_op_mode(R.SLEEP_MODE)

        data = bytearray(self.get_regs(R.REG_CTRL_GAS_1, R.LEN_CONFIG))  # 0x71..0x75
        odr20, odr3 = 0, 1
        if conf.odr != R.ODR_NONE:
            odr20, odr3 = conf.odr, 0

        data[4] = R.set_bits(data[4], R.FILTER_MSK, R.FILTER_POS, conf.filter)
        data[3] = R.set_bits(data[3], R.OST_MSK, R.OST_POS, conf.os_temp)
        data[3] = R.set_bits(data[3], R.OSP_MSK, R.OSP_POS, conf.os_pres)
        data[1] = R.set_bits_pos_0(data[1], R.OSH_MSK, conf.os_hum)
        data[4] = R.set_bits(data[4], R.ODR20_MSK, R.ODR20_POS, odr20)
        data[0] = R.set_bits(data[0], R.ODR3_MSK, R.ODR3_POS, odr3)

        self.set_regs([(0x71 + i, data[i]) for i in range(R.LEN_CONFIG)])
        self.conf = conf
        if current != R.SLEEP_MODE:
            self.set_op_mode(current)

    def get_meas_dur(self, op_mode: int, conf: TPHConf) -> int:
        """Measurement duration in microseconds."""
        cycles_for = (0, 1, 2, 4, 8, 16)
        meas_cycles = cycles_for[conf.os_temp] + cycles_for[conf.os_pres] + cycles_for[conf.os_hum]
        dur = meas_cycles * 1963
        dur += 477 * 4   # TPH switching
        dur += 477 * 5   # gas measurement
        if op_mode != R.PARALLEL_MODE:
            dur += 1000  # wake-up
        return dur

    def set_heatr_conf(self, op_mode: int, conf: HeaterConf) -> None:
        self.set_op_mode(R.SLEEP_MODE)
        nb_conv = self._write_heater_profile(conf, op_mode)

        gas = bytearray(self.get_regs(R.REG_CTRL_GAS_0, 2))
        if conf.enable:
            hctrl, run_gas = R.ENABLE_HEATER, R.ENABLE_GAS_MEAS
        else:
            hctrl, run_gas = R.DISABLE_HEATER, R.DISABLE_GAS_MEAS
        gas[0] = R.set_bits(gas[0], R.HCTRL_MSK, R.HCTRL_POS, hctrl)
        gas[1] = R.set_bits_pos_0(gas[1], R.NBCONV_MSK, nb_conv)
        gas[1] = R.set_bits(gas[1], R.RUN_GAS_MSK, R.RUN_GAS_POS, run_gas)
        self.set_regs([(R.REG_CTRL_GAS_0, gas[0]), (R.REG_CTRL_GAS_1, gas[1])])

    def _write_heater_profile(self, conf: HeaterConf, op_mode: int) -> int:
        rh, gw = [], []
        if op_mode == R.FORCED_MODE:
            rh.append((R.REG_RES_HEAT0, self._calc_res_heat(conf.heatr_temp)))
            gw.append((R.REG_GAS_WAIT0, self._calc_gas_wait(conf.heatr_dur)))
            nb_conv = 0
        elif op_mode == R.SEQUENTIAL_MODE:
            for i, (t, d) in enumerate(zip(conf.heatr_temp_prof, conf.heatr_dur_prof)):
                rh.append((R.REG_RES_HEAT0 + i, self._calc_res_heat(t)))
                gw.append((R.REG_GAS_WAIT0 + i, self._calc_gas_wait(d)))
            nb_conv = len(conf.heatr_temp_prof)
        elif op_mode == R.PARALLEL_MODE:
            if not conf.shared_heatr_dur:
                raise BME690Error("parallel mode requires shared_heatr_dur")
            for i, (t, d) in enumerate(zip(conf.heatr_temp_prof, conf.heatr_dur_prof)):
                rh.append((R.REG_RES_HEAT0 + i, self._calc_res_heat(t)))
                # In parallel mode gas_wait_x is a plain multiplier of the
                # shared duration, held in one byte -- so it cannot exceed 255.
                # Truncating here would silently shorten the step.
                if not 0 <= d <= 255:
                    raise BME690Error(
                        f"heater step {i} has duration {d}; in parallel mode the "
                        "gas_wait multiplier is a single byte and must be 0..255. "
                        "Split the step into several shorter ones of the same "
                        "temperature."
                    )
                gw.append((R.REG_GAS_WAIT0 + i, d))
            nb_conv = len(conf.heatr_temp_prof)
            shared = self._calc_heatr_dur_shared(conf.shared_heatr_dur)
            self.set_regs([(R.REG_SHD_HEATR_DUR, shared)])
        else:
            raise BME690Error(f"unsupported op mode {op_mode}")

        self.set_regs(rh)
        self.set_regs(gw)
        return nb_conv

    # ----------------------------------------------------------------- data

    def _parse_field(self, buf: memoryview, off: int, set_val: Optional[bytes]) -> Reading:
        r = Reading()
        r.status = buf[off] & R.NEW_DATA_MSK
        r.gas_index = buf[off] & R.GAS_INDEX_MSK
        r.meas_index = buf[off + 1]

        adc_pres = (buf[off + 2] << 16) | (buf[off + 3] << 8) | buf[off + 4]
        adc_temp = (buf[off + 5] << 16) | (buf[off + 6] << 8) | buf[off + 7]
        adc_hum = (buf[off + 8] << 8) | buf[off + 9]
        adc_gas = (buf[off + 15] << 2) | (buf[off + 16] >> 6)
        gas_range = buf[off + 16] & R.GAS_RANGE_MSK

        r.status |= buf[off + 16] & R.GASM_VALID_MSK
        r.status |= buf[off + 16] & R.HEAT_STAB_MSK

        if set_val is not None:
            r.idac = set_val[r.gas_index]
            r.res_heat = set_val[10 + r.gas_index]
            r.gas_wait = set_val[20 + r.gas_index]

        r.temperature = self._calc_temperature(adc_temp)
        r.pressure = self._calc_pressure(adc_pres, r.temperature)
        r.humidity = self._calc_humidity(adc_hum, r.temperature)
        r.gas_resistance = self._calc_gas_resistance(adc_gas, gas_range)
        return r

    def get_data(self, op_mode: int) -> List[Reading]:
        """Read and compensate all available fields.

        Forced mode returns at most one reading; parallel/sequential mode
        returns the new readings among the three field registers, ordered by
        measurement index.
        """
        if op_mode == R.FORCED_MODE:
            buf = memoryview(self.get_regs(R.REG_FIELD0, R.LEN_FIELD))
            r = self._parse_field(buf, 0, None)
            if not r.new_data:
                return []
            r.res_heat = self.get_regs(R.REG_RES_HEAT0 + r.gas_index, 1)[0]
            r.idac = self.get_regs(R.REG_IDAC_HEAT0 + r.gas_index, 1)[0]
            r.gas_wait = self.get_regs(R.REG_GAS_WAIT0 + r.gas_index, 1)[0]
            return [r]

        buf = memoryview(self.get_regs(R.REG_FIELD0, R.LEN_FIELD * 3))
        set_val = self.get_regs(R.REG_IDAC_HEAT0, 30)
        fields = [self._parse_field(buf, i * R.LEN_FIELD, set_val) for i in range(3)]
        fields.sort(key=lambda f: f.meas_index)
        return [f for f in fields if f.new_data]
