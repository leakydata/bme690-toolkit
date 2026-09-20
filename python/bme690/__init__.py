"""Linux tooling for the Bosch BME690 8x shuttle board on Application Board 3.1."""

from .board import AppBoard31, CS_PINS, SHUTTLE_ID_BME690_8X
from .device import BME690, BME690Error, HeaterConf, Reading, TPHConf
from . import registers

__all__ = [
    "AppBoard31", "BME690", "BME690Error", "HeaterConf", "Reading", "TPHConf",
    "CS_PINS", "SHUTTLE_ID_BME690_8X", "registers",
]
__version__ = "0.1.0"
