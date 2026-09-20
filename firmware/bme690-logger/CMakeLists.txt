cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(bme690_logger)

target_sources(app PRIVATE src/main.c src/bme690_zephyr.c ../common/bme690.c)
target_include_directories(app PRIVATE src ../common)
