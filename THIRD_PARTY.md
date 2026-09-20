# Third-party software and licensing

This project is MIT licensed. It depends on Bosch software that is **not**,
so this file records what is bundled here, what is fetched, and why.

## What is in this repository

| Component | Licence |
|---|---|
| `python/bme690/` — the CLI and driver | MIT (this project) |
| `firmware/` | MIT (this project) |
| `scripts/`, `docs/` | MIT (this project) |

`python/bme690/device.py` and `registers.py` are a Python port of Bosch's
**BME690 SensorAPI**, which is BSD-3-Clause. The BSD-3 notice is retained in
those files. That licence permits redistribution, so the port is fine to ship.

## What is *not* in this repository

### COINES SDK — fetched, not vendored

Run `scripts/setup-coines.sh`; it clones from
[boschsensortec/COINES_SDK](https://github.com/boschsensortec/COINES_SDK).

The SDK's licence grants use, not redistribution:

> Subject to the compliance with these terms, the User may **use** COINES
> software development kit and any derivatives **exclusively with Bosch
> Sensortec GmbH hardware products.**

Compare Bosch's own SensorAPI licence, which says "**Redistribution** and use
in source and binary forms ... are permitted". Bosch clearly know how to grant
redistribution, and did not do so here. GitHub classifies the SDK's licence as
`NOASSERTION` — not a recognised open-source licence.

The exclusivity clause is no obstacle to *this* project: it is Bosch hardware.
That clause is about field of use, which is a separate question from whether
copies may be distributed.

There are practical reasons too. The SDK is **210 MB**, ships **333 prebuilt
binaries**, and vendors third-party code under a mix of licences — by its own
LICENSE file, 11 GPL and 5 LGPL components among others, plus Nordic's nRF5
SDK under Nordic's own restricted terms. Bundling all of that into an MIT
repository would make the licensing of the whole considerably harder to reason
about, for no gain: a one-line fetch script gives the same one-command setup
and lets users choose their SDK version.

**Firmware is therefore distributed as source** that builds against your own
SDK copy. A compiled binary is arguably a derivative of a non-redistributable
SDK; source plus a build script is unambiguous.

### coinespy — from PyPI

`pip install coinespy`. Never vendored.

### BSEC — never distributed

Bosch's gas-sensing algorithm library is proprietary with no redistribution
grant. Download it from Bosch if you need it.

### BME AI-Studio — never distributed

Proprietary Bosch software. `scripts/rebuild-aistudio-linux.sh` is **our**
script; it operates on a copy of Bosch's Windows release that you already
have, and contains no Bosch code. Heater profiles are read from your own
AI-Studio installation rather than copied here.

---

This is a good-faith reading of the licence texts by the authors, who are not
lawyers. If you plan to redistribute anything here commercially, read the
licences yourself.

**This project is not affiliated with, endorsed by, or supported by Bosch
Sensortec GmbH.** "BME688", "BME690" and "COINES" are used descriptively to
identify the hardware this software works with.
