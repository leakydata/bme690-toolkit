"""Bosch Application Board 3.1 + BME690 8x shuttle board.

Wraps coinespy so each of the eight BME690 sensors on the shuttle board looks
like an ordinary register-level device.
"""

import time
from typing import List, Optional

import coinespy as cpy
from coinespy import ErrorCodes

from .device import BME690, BME690Error

# Shuttle EEPROM id of the BME690 8x shuttle board.
SHUTTLE_ID_BME690_8X = 0x57

# SPI chip-select pin per sensor index, discovered on the 8x shuttle board.
CS_PINS = [
    cpy.MultiIOPin.MINI_SHUTTLE_PIN_1_4,   # sensor 0
    cpy.MultiIOPin.MINI_SHUTTLE_PIN_1_5,   # sensor 1
    cpy.MultiIOPin.MINI_SHUTTLE_PIN_1_6,   # sensor 2
    cpy.MultiIOPin.MINI_SHUTTLE_PIN_1_7,   # sensor 3
    cpy.MultiIOPin.MINI_SHUTTLE_PIN_2_5,   # sensor 4
    cpy.MultiIOPin.MINI_SHUTTLE_PIN_2_6,   # sensor 5
    cpy.MultiIOPin.MINI_SHUTTLE_PIN_2_7,   # sensor 6
    cpy.MultiIOPin.MINI_SHUTTLE_PIN_2_8,   # sensor 7
]


class SpiTransport:
    """Register read/write for one sensor, over one SPI chip-select line."""

    def __init__(self, board: "AppBoard31", cs_pin):
        self.board = board
        self.cs = cs_pin.value if hasattr(cs_pin, "value") else cs_pin

    def read(self, reg: int, length: int) -> bytes:
        data = self.board.cb.read_spi(cpy.SPIBus.BUS_SPI_0, reg, length, self.cs)
        if data is None:
            raise BME690Error(f"SPI read failed (reg 0x{reg:02x}, cs 0x{self.cs:02x})")
        return bytes(data)

    def write(self, reg: int, data: bytes) -> None:
        for i, value in enumerate(data):
            rc = self.board.cb.write_spi(cpy.SPIBus.BUS_SPI_0, reg + i, value, self.cs)
            if rc != ErrorCodes.COINES_SUCCESS:
                raise BME690Error(
                    f"SPI write failed (reg 0x{reg + i:02x}, cs 0x{self.cs:02x}): {rc}"
                )


class AppBoard31:
    """Application Board 3.1 carrying a BME690 8x shuttle board."""

    def __init__(self, spi_speed=cpy.SPISpeed.SPI_5_MHZ, amb_temp: int = 25):
        self.cb = cpy.CoinesBoard()
        self.spi_speed = spi_speed
        self.amb_temp = amb_temp
        self.sensors: List[BME690] = []
        self.board_info = None
        self._open = False

    # ------------------------------------------------------------- lifecycle

    def _connect(self) -> None:
        self.cb.open_comm_interface(cpy.CommInterface.USB)
        if self.cb.error_code != ErrorCodes.COINES_SUCCESS:
            raise BME690Error(
                "Could not connect to the Application Board "
                f"({self.cb.error_code}). Check the USB cable, that the board is "
                "powered on, that no other program holds it, and that you are in "
                "the 'dialout' group."
            )
        self._open = True
        self.board_info = self.cb.get_board_info()

    def _power_up(self) -> None:
        """Bring the shuttle board up.

        Order matters: the SPI bus must be configured *before* the supply is
        switched on. The bus stays configured in the board's firmware across
        USB sessions, so an existing configuration is torn down first --
        otherwise config_spi_bus returns COINES_E_SPI_CONFIG_FAILED and the
        sensors never answer.
        """
        self.cb.deconfig_spi_bus(cpy.SPIBus.BUS_SPI_0)
        rc = self.cb.config_spi_bus(cpy.SPIBus.BUS_SPI_0, CS_PINS[0],
                                    self.spi_speed, cpy.SPIMode.MODE0)
        if rc != ErrorCodes.COINES_SUCCESS:
            raise BME690Error(f"SPI bus configuration failed: {rc}")
        # coinespy multiplies by 1000 into a uint16, so these are VOLTS.
        # Passing millivolts here silently overflows and latches a bad
        # setpoint that survives until the board is reset.
        self.cb.set_shuttleboard_vdd_vddio_config(3.3, 3.3)
        time.sleep(0.4)

    def reset_board(self, wait: float = 12.0) -> None:
        """Reset the Application Board and reconnect after it re-enumerates."""
        try:
            self.cb.soft_reset()
        except Exception:
            pass
        try:
            self.cb.close_comm_interface()
        except Exception:
            pass
        self._open = False
        time.sleep(wait)
        self.cb = cpy.CoinesBoard()
        self._connect()

    def open(self, recover: bool = True) -> "AppBoard31":
        self._connect()
        self._power_up()
        if not self.scan() and recover:
            # A stale supply setpoint from an earlier session keeps the
            # sensors dark; a board reset clears it.
            self.reset_board()
            self._power_up()
        return self

    def close(self) -> None:
        if not self._open:
            return
        try:
            for s in self.sensors:
                try:
                    s.set_op_mode(0)  # sleep
                except Exception:
                    pass
            self.cb.set_shuttleboard_vdd_vddio_config(0, 0)
        finally:
            self.cb.close_comm_interface()
            self._open = False

    def __enter__(self):
        return self.open()

    def __exit__(self, *exc):
        self.close()

    # --------------------------------------------------------------- sensors

    @property
    def shuttle_id(self) -> Optional[int]:
        return getattr(self.board_info, "ShuttleID", None)

    def scan(self) -> List[int]:
        """Return the indices of the sensor sockets that answer with a BME69x chip id."""
        found = []
        for idx, pin in enumerate(CS_PINS):
            t = SpiTransport(self, pin)
            try:
                if t.read(0xD0, 1)[0] == 0x61:
                    found.append(idx)
            except BME690Error:
                pass
        return found

    def init_sensors(self, indices: Optional[List[int]] = None) -> List[BME690]:
        if indices is None:
            indices = list(range(len(CS_PINS)))
        self.sensors = []
        for idx in indices:
            dev = BME690(SpiTransport(self, CS_PINS[idx]),
                         amb_temp=self.amb_temp, name=f"sensor{idx}")
            dev.init()
            dev.index = idx
            self.sensors.append(dev)
        return self.sensors

    def millis(self) -> int:
        return self.cb.get_millis()
