cmake_minimum_required(VERSION 3.16)

# Two boards, two firmware images (see main/board.h):
#   idf.py build                                  ESP32-S3 DevKitC-1
#   idf.py -B build-xiao -DBME690_BOARD=xiao build   XIAO ESP32-S3 on Board B
# Each image has its own project name, so a board's WiFi updater only
# accepts firmware made for it.
if(BME690_BOARD STREQUAL "xiao")
    set(SDKCONFIG_DEFAULTS "sdkconfig.defaults;sdkconfig.defaults.xiao")
    set(SDKCONFIG "${CMAKE_BINARY_DIR}/sdkconfig")
    set(BME690_PROJECT bme690_logger_xiao)
else()
    set(BME690_PROJECT bme690_logger_idf)
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(${BME690_PROJECT})
