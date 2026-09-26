# Board API

The logger answers the same requests over WiFi (HTTP + WebSocket) and over the
USB serial console, so the dashboard, the `bme690` Python tool and a person
typing into a serial monitor all see one interface.

## Connecting

The board starts a WiFi access point called **`BME690-XXXX`** (last four hex
digits of its MAC), open, no password. Join it and any page you open lands on
the dashboard at **http://192.168.4.1/** — the board answers every DNS lookup
with its own address, so phones show a "sign in to network" prompt that opens
the dashboard directly.

## Status object

`GET /api/status` returns, and the serial `status` command prints on one line
prefixed `S,`:

```json
{
  "fw": "2.0.0",
  "board": "BME690-3F2A",
  "uptime_ms": 123456,
  "time_set": true,
  "unix": 1790000000,
  "recording": true,
  "session": "s0007",
  "file": "s0007_0002.bmerawdata",
  "rows_written": 51234,
  "label": { "tag": 2, "name": "coffee" },
  "labels": [ { "tag": 1, "name": "air", "desc": "" }, { "tag": 2, "name": "coffee", "desc": "" } ],
  "card": { "present": true, "total_mb": 14893, "free_mb": 13859, "error": null },
  "config": { "source": "default", "name": "HP-354 continuous" },
  "wifi": { "ssid": "BME690-3F2A", "clients": 1 },
  "sensors": [
    {
      "index": 0, "part": "U1", "shuttle_pin": "P1-4", "gpio": 1,
      "state": "ok",
      "chip_id": 97, "par_t1": 22571,
      "heater_profile": "heater_354", "cycle_ms": 10780,
      "cycles": 120, "heat_stable_pct": 99.2,
      "last": { "ms": 123000, "temp": 31.2, "press": 1012.6, "hum": 35.6, "gas": 71628.4, "step": 0, "stable": true }
    }
  ],
  "problems": [
    { "level": "error", "sensor": 6, "text": "Sensor 6 (U7) is not answering. Check the wire from shuttle P2-7 to GPIO15." }
  ]
}
```

- `state` is one of `ok`, `missing` (never answered), `lost` (answered, then
  stopped; it resumes by itself when the connection returns), `sleeping` (a
  duty-cycle rest between scans) or `inactive` (switched off in the board
  configuration). Implausible readings are reported in `problems`.
- `probe` is what the bring-up check saw: `ok`, `no answer`, `stuck low`,
  `garbled`, `wrong part` (a BME680/688), `duplicate` (two chip-select wires
  on one shuttle pin) or `config failed`.
- `problems` is the plain-English diagnosis list. `level` is `error`, `warn`
  or `info`. An empty list means everything checks out.
- `last` is `null` until the sensor has produced a reading.

## Live data

`WS /ws` pushes one JSON object per text frame:

```json
{"t":"d","s":0,"ms":123000,"temp":31.2,"press":1012.6,"hum":35.6,"gas":71628.4,"step":0,"stable":true,"tag":2}
{"t":"status", ...status object...}
```

`d` frames arrive once per heater step per sensor (about 7 per second with
eight sensors on HP-354). A `status` frame is pushed every 2 s and whenever
recording, label or sensor state changes.

On serial the same data appears as the original line format, which the
`bme690 ingest` tool parses:

```
D,<sensor>,<ms>,<temp_C>,<press_hPa>,<hum_pct>,<gas_ohm>,<step>,<stable>
```

## Commands

| HTTP | serial | effect |
|---|---|---|
| `POST /api/record` `{"on":true}` | `rec start` / `rec stop` | start or stop writing to the card |
| `POST /api/label` `{"tag":3,"name":"coffee","desc":""}` | `label 3 coffee` | switch the current label; names it too |
| `POST /api/label` `{"next":true}` | `label next` | next label tag (what the BOOT button does) |
| `POST /api/time` `{"unix":1790000000}` | `time 1790000000` | set the clock (the dashboard does this automatically) |
| `GET /api/config` | `config` | the running `configHeader` + `configBody`, exactly as they will appear in a `.bmerawdata` file |
| `PUT /api/config?name=<file>` body: a `.bmeconfig` | — | switch heater profiles; saved to the card as `bme690.bmeconfig`. A recording in progress ends and a new session starts |
| `DELETE /api/config` | — | back to the factory default HP-354 (removes `.bmeconfig` files from the card) |
| `POST /api/burnin` `{"on":true,"hours":12}` | `burnin 12` / `burnin stop` | stabilise new sensors: Bosch HP-001 (320 C) on all eight, recorded under the label "burn-in", then back to the previous configuration. `status.burnin` is `{"hours":12,"remaining_s":…}` while it runs, else `null` |
| `POST /api/ota` body: `bme690-logger-app.bin` | — | install a firmware update over WiFi. The file is checked (ESP32-S3, this project) before anything is written; the board restarts on success and rolls back by itself if the new version fails to start. `status.fw_build` is the running build |
| `POST /api/chips` `{"remember":true}` / `{"forget":true}` | `chips remember` / `chips forget` | remember which chip (by `par_t1`) is in each slot, after the wiring has been checked; from then on swapped chip-select wires are reported in `problems`. `status.chips` is `{"remembered": bool, "saved": unix|null}`, each sensor has `expected_par_t1` |
| `GET /api/crash` / `DELETE /api/crash` | — | download or delete the crash report (core dump) saved by the last crash. `status.restart` is `{"reason", "text", "crash", "boots", "crashes", "report": {"task", "pc"} or null}` |
| `POST /api/rescan` | `rescan` | re-probe all eight sensors and restart scanning |
| `GET /api/files` | `files` | list recordings: `[{"name":"s0007_0000.bmerawdata","size":123456}]` |
| `GET /api/files/<name>` | — | download one file |
| `DELETE /api/files/<name>` | — | delete one file |
| — | `help` | list commands |

Every POST answers with the new status object, or `{"error":"text"}` with
HTTP 400.

## Files on the card

```
/bme690/
  s0007_0000.bmerawdata      15-minute chunks, each a complete file
  s0007_0000.bmelabelinfo    label names, one beside every chunk
  s0007_0001.bmerawdata
  ...
/bme690.bmeconfig            optional: heater profiles exported from AI-Studio
```

Import any one chunk of a session into AI-Studio and it picks up the rest.
