"""Tooling for Bosch BME690/BME688 gas sensors: the Application Board 3.1
driver and CLI, file formats, and (with the ``lab`` extra) machine learning
in ``bme690.lab``."""

from .device import BME690, BME690Error, HeaterConf, Reading, TPHConf
from . import registers

__all__ = [
    "AppBoard31", "BME690", "BME690Error", "HeaterConf", "Reading", "TPHConf",
    "CS_PINS", "SHUTTLE_ID_BME690_8X", "registers",
]
__version__ = "0.2.0"

_BOARD = {"AppBoard31", "CS_PINS", "SHUTTLE_ID_BME690_8X"}


def __getattr__(name):
    # The board driver needs Bosch's coinespy; load it only when used, so the
    # file tools and bme690.lab work without it.
    if name in _BOARD:
        from . import board
        return getattr(board, name)
    raise AttributeError(f"module 'bme690' has no attribute {name!r}")
