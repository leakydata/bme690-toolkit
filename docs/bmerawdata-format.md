# The `.bmerawdata` format

BME AI-Studio imports sensor recordings as `.bmerawdata` files, optionally
paired with a `.bmelabelinfo` file. Bosch does not publish the schema, which
is the main thing stopping people feeding their own captures into AI-Studio.

This specification was derived by reading AI-Studio 3.1.0's own importer
(`src/server/services/import/raw_data/parser/`) and validated by writing files
from scratch and importing them successfully. It describes the importer's
actual requirements, not a guess.

Both files are UTF-8 JSON.

---

## Top level

```json
{
  "configHeader": { ... },
  "configBody":   { ... },
  "rawDataHeader":{ ... },
  "rawDataBody":  { ... }
}
```

All four keys are required. The importer rejects the file otherwise, naming
the missing one.

## `configHeader`

| field | notes |
|---|---|
| `boardType` | **required.** `"board_8"` (BME688 Development Kit) or `"board_690"` (BME690 8x Shuttle board) |
| `boardMode` | free text; AI-Studio writes `burn_in`, `heater_profile_exploration` or `duty_cycle_profile_exploration` |
| `dateCreated` | ISO 8601 string |

`boardMode: "burn_in"` does **not** mean sensor stabilisation. AI-Studio's UI
calls that mode "Sensorboard Default HP/RDC" — the factory default HP-354 +
RDC-5-10. It is an unfortunate internal name.

## `configBody`

```json
{
  "heaterProfiles": [
    { "id": "heater_354", "timeBase": 140,
      "temperatureTimeVectors": [[320,5],[100,2],[100,10],[100,30],
                                 [200,5],[200,5],[200,5],
                                 [320,5],[320,5],[320,5]] }
  ],
  "dutyCycleProfiles": [
    { "id": "duty_1", "numberScanningCycles": 1, "numberSleepingCycles": 0 }
  ],
  "sensorConfigurations": [
    { "sensorIndex": 0, "active": true,
      "heaterProfile": "heater_354", "dutyCycleProfile": "duty_1" }
  ]
}
```

- `temperatureTimeVectors` is `[[temperature_degC, duration], ...]`, exactly
  **ten** entries. `duration` is in multiples of `timeBase` milliseconds, so
  the scan cycle is `sum(durations) * timeBase`. HP-354 is `77 * 140 ms =
  10.78 s`.
- `sensorConfigurations` needs one entry per sensor you recorded.
  `"active": false` entries are skipped. Files written before BST format 1.1
  have no `active` key; the importer treats those as active.
- `heaterProfile` and `dutyCycleProfile` are ids that must resolve within this
  same file.

## `rawDataHeader`

Free-form metadata; `firmwareVersion` and `boardId` are carried into the
measurement session. Nothing here is validated.

## `rawDataBody`

```json
{
  "dataColumns": [ { "name": "...", "unit": "...", "format": "...", "key": "..." } ],
  "dataBlock":   [ [ ...row... ], [ ...row... ] ]
}
```

`dataBlock` rows are positional — column *i* of every row corresponds to
`dataColumns[i]`. Only the `key` matters to the importer; `name`, `unit` and
`format` are documentation. Column **order is yours to choose**.

### Required columns

Omit any of these and the import fails:

| key | meaning |
|---|---|
| `sensor_index` | 0-based sensor number, must match a `sensorIndex` above |
| `resistance_gassensor` | gas resistance, **ohms** |
| `temperature` | **degrees Celsius** |
| `pressure` | **hectopascals** — not pascals |
| `relative_humidity` | percent |
| `timestamp_since_poweron` | **milliseconds** |
| `real_time_clock` | **Unix seconds** (UTC) |
| `heater_profile_step_index` | 0..9 |
| `error_code` | 0 means good; non-zero drops the cycle |

### Optional columns

| key | meaning |
|---|---|
| `label_tag` | integer joining a row to `.bmelabelinfo` |
| `sensor_id` | free integer, e.g. the sensor's unique id |
| `scanning_mode_enabled` | boolean |

`pressure` in hPa is the easiest thing to get wrong. Bosch's own reference
data sits around 984–986; a sensor API returning pascals must be divided by
100.

---

## The cycle rule — the part that actually bites

**A cycle is exactly ten data points, one per heater profile step, with
`heater_profile_step_index` 0 through 9.**

The importer assembles cycles per sensor as it streams rows. It starts a new
cycle when it sees step index 0, when the current cycle already holds that
step, or when a higher index is already present. A cycle is emitted once all
ten slots are filled. Anything that ends up with fewer than ten points, or any
point with a non-zero `error_code`, is marked `dropped` and never reaches
training or the graphs.

This matters because **in parallel mode the sensor measures once per heater
time base**, so a step lasting N time bases produces N readings all carrying
the same step index. Writing all of them out produces a long run of
step-index-0 rows, each starting a new one-point cycle, and every cycle is
dropped. The file imports "successfully" and yields nothing.

Emit **one point per step per cycle**. Taking the last reading before the step
index changes is the natural choice — the heater has then been longest at that
temperature.

A couple of partial cycles at the start and end of a recording are normal and
get dropped; Bosch's own data behaves the same way.

---

## Multi-file recordings

Files whose names end `_<number>` before the extension are treated as one
session and imported together in sorted order — `run_0.bmerawdata`,
`run_1.bmerawdata`, and so on. A cycle split across two files is stitched
back together. Name a file without that suffix and it imports alone.

---

## `.bmelabelinfo`

Sits beside the `.bmerawdata` with the same stem. Optional.

```json
{
  "labelInformation": [
    { "labelTag": 1, "labelName": "coffee",  "labelDescription": "..." },
    { "labelTag": 2, "labelName": "air",     "labelDescription": "..." }
  ]
}
```

Each run of rows sharing a `label_tag` becomes one **specimen** in AI-Studio,
named from the matching `labelName`. A tag with no entry becomes an unnamed
specimen. Changing `label_tag` mid-recording closes the current specimen and
opens a new one, which is how one recording carries several samples.

---

## Session times

Session start and end come from the first and last `real_time_clock` values,
except for `board_690`, where the session is reported as starting at 0 and
ending at the latest specimen end time.

---

## Minimal working example

`python/bme690/rawdata.py` in this repository writes this format and is the
reference implementation. A file it produced imported into AI-Studio 3.1.0
as: board type recognised, 8 sensor configs, both labelled specimens, 220 of
227 cycles complete — the 7 dropped being the partial cycles at each end.
