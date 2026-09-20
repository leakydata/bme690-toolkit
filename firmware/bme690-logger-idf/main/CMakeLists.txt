idf_component_register(
    SRCS "main.c" "bme690_idf.c" "../../common/bme690.c"
    INCLUDE_DIRS "." "../../common"
    REQUIRES esp_driver_spi esp_driver_gpio esp_timer
)
