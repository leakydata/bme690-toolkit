idf_component_register(
    SRCS "main.c" "app.c" "config.c" "console.c" "net.c" "sensors.c"
         "storage.c" "ui.c" "ota.c" "bme690_idf.c" "../../common/bme690.c"
    INCLUDE_DIRS "." "../../common"
    REQUIRES esp_driver_spi esp_driver_gpio esp_driver_sdspi esp_driver_uart
             esp_timer esp_wifi esp_netif esp_event esp_http_server nvs_flash
             fatfs json app_update esp_app_format
    EMBED_FILES "${CMAKE_CURRENT_BINARY_DIR}/dashboard.html.gz"
)

# The dashboard is served gzipped straight from flash.
set(DASHBOARD "${CMAKE_CURRENT_SOURCE_DIR}/../dashboard/index.html")
add_custom_command(
    OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/dashboard.html.gz"
    COMMAND ${PYTHON} -c "import gzip,sys; open(sys.argv[2],'wb').write(gzip.compress(open(sys.argv[1],'rb').read(), 9, mtime=0))" "${DASHBOARD}" "${CMAKE_CURRENT_BINARY_DIR}/dashboard.html.gz"
    DEPENDS "${DASHBOARD}"
    VERBATIM)
add_custom_target(dashboard_gz DEPENDS "${CMAKE_CURRENT_BINARY_DIR}/dashboard.html.gz")
add_dependencies(${COMPONENT_LIB} dashboard_gz)
