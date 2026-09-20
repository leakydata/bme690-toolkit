#!/usr/bin/env bash
# Fetch the Bosch COINES SDK and the BME690 SensorAPI into third_party/.
#
# These are not vendored into this repository (see THIRD_PARTY.md); this script
# gets them from Bosch's own GitHub so you always build against an official
# copy and can pick your own version.
set -euo pipefail

COINES_TAG="${COINES_TAG:-COINES_SDK_v2.12.3}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/third_party"
mkdir -p "$DEST"

fetch() {  # repo tag dir
  local repo="$1" tag="$2" dir="$3"
  if [ -d "$DEST/$dir/.git" ]; then
    echo "==> $dir already present, skipping"
    return
  fi
  echo "==> cloning $repo@$tag"
  git clone --depth 1 --branch "$tag" "https://github.com/$repo.git" "$DEST/$dir"
}

fetch boschsensortec/COINES_SDK       "$COINES_TAG" coines-sdk
fetch boschsensortec/BME690_SensorAPI master        bme690-sensorapi

cat <<MSG

Done.

  COINES SDK      $DEST/coines-sdk        ($COINES_TAG)
  BME690 SensorAPI $DEST/bme690-sensorapi

The Python tool does not need the SDK -- it uses the coinespy package from
PyPI. The SDK is required to build the standalone firmware.

  pip install -e python/

MSG
