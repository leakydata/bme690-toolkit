# Contributing to BME Studio

BME Studio is a browser app for BME690/BME688 gas-sensor data. It runs
entirely in the browser: data lives in IndexedDB on the user's computer and
nothing is sent anywhere. It installs as a desktop app (PWA) and works offline.

The people using it know gas sensors but are often new to electronics and
machine learning. Write every message, label and hint for them: plain English,
say what to do next, never a bare error code.

## Running it

```bash
cd studio
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests (Node's built-in runner)
npm run typecheck
npm run build        # production build into dist/
```

## How it's put together

```
src/
  core/        data model and file formats; no UI
    types.ts           Recording, Specimen, Cycle, Project, ModelRecord ...
    bmerawdata.ts      read/write AI-Studio .bmerawdata + .bmelabelinfo
    aistudio-project.ts  open an AI-Studio project.db
    assemble.ts        points -> cycles and specimens (AI-Studio's rules)
    store.ts           IndexedDB persistence
  ml/          machine learning, no UI
    features.ts        feature sets (registerFeatureSet)
    dataset.ts         build datasets, honest (by-specimen) and random splits
    models.ts          model kinds (registerModelKind)
  app/         shell and app-wide state (useStudio)
  ui/          shared stylesheet and helpers
  plugins/     every page of the app, one folder each
    registry.ts        registerView
    index.ts           imports every plugin
```

### Adding a feature

Most features are one of these, and none needs changes elsewhere:

| you want to add | do this |
|---|---|
| a page | a folder in `src/plugins/`, calling `registerView()`; import it in `plugins/index.ts` |
| a guided experiment template | add it to `TEMPLATES` in `plugins/quick/plan.ts` |
| a way to turn cycles into features | call `registerFeatureSet()` (see `ml/features.ts`) |
| a model type | call `registerModelKind()` (see `ml/models.ts`) |

Pages read and change data only through `useStudio()` from `app/state.tsx`, so
everything is saved and every page stays in sync.

### Conventions

- **Imports carry the `.ts`/`.tsx` extension** (`import { x } from './y.ts'`),
  so the same files run under Vite and under Node's test runner.
- **Style with the classes in `ui/styles.css`** (`card`, `btn`, `btn primary`,
  `grid`, `row`, `notice`, `pill`, `table.data`, `muted`, `small`, `num` ...).
  Styles only one page needs go in a CSS file in that page's folder, imported
  by its view, with class names prefixed for the page (`q-`, `ex-` ...).
  Colours come from CSS variables, so light and dark mode work for free.
  Sensor colours are `--s0` … `--s7` (`sensorColor(i)` in `ui/format.ts`).
- **No network requests** to anything but the user's own board. The app must
  work offline.
- **Charts use uPlot**, which is fast enough for a twelve-hour recording.
- **Heavy work goes off the main thread** or yields often, so the page never
  freezes.
- **Terms follow BME AI-Studio**: recording, specimen, class, cycle, heater
  profile, duty cycle.

## Where the data comes from

- **.bmerawdata files** from the ESP32-S3 logger's SD card, from BME AI-Studio,
  or from Bosch's BME688 development kit. The format is specified in
  [`docs/bmerawdata-format.md`](../docs/bmerawdata-format.md).
- **AI-Studio projects** (`project.db`).
- **The board, live over USB**, using the serial protocol in
  [`firmware/bme690-logger-idf/API.md`](../firmware/bme690-logger-idf/API.md).
