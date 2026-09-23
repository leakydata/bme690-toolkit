# bme690.lab: the Python lab

For researchers who want more than BME AI-Studio or BME Studio offer:
fingerprinting that tells close look-alikes apart, models that read all eight
sensors and follow the signal over time, pre-training on unlabelled hours of
data, and proper honest evaluation, on your own GPU.

It reads exactly what the other tools read, and gives the same cycles:

| source | how |
|---|---|
| the ESP32-S3 logger's SD card | `lab.load("/media/you/SDCARD/bme690")` |
| any `.bmerawdata` (+ `.bmelabelinfo`) | `lab.load(["run_0000.bmerawdata", ...])` |
| a BME AI-Studio project | `lab.load_aistudio("MyProject.bmeproject")` |
| BME Studio | Data page → Export on a recording, then `lab.load(...)` |

Models trained here can go back to BME Studio (Train → Saved models → Import
model) and run live on the board from its Live page.

## Install

```bash
cd bme690-toolkit
python3.12 -m venv .labvenv && . .labvenv/bin/activate
pip install -e "python/[notebooks]"
```

This installs PyTorch from PyPI, which on Linux includes CUDA. Check the GPU
is seen:

```bash
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

A GPU speeds up the deep models (notebooks 02 and 03) once batches or
models are large; the small AI-Studio-style network is actually faster on the
CPU. Loading, exploring and the classic models in notebook 01 run on any
laptop.

## What the demo shows so far

On BME AI-Studio's coffee demo (one 2.5-hour session), the deep models beat
the AI-Studio-style network on the hard task: Espresso vs Filter Coffee vs Air,
96 % against 91 % on held-out data -- though the demo has only one specimen of
each coffee, so that test is optimistic. Self-supervised pre-training does *not* help
yet. On a single session it learns when a moment was recorded (drift) rather
than what was in the air. It needs many hours of unlabelled logging across
sessions to be tested properly. Notebook 03 explains this in full.

## Start here

```bash
jupyter lab python/notebooks
```

| notebook | what it shows |
|---|---|
| `01_data_and_honest_testing` | loading data, looking at it, confounding checks, and why random splits flatter a model |
| `02_deep_models` | networks that read all sensors at once and follow cycles over time, on the GPU, with honest cross-validation |
| `03_self_supervised` | pre-training on unlabelled data, then learning a new smell from a handful of examples |

## In code

```python
from bme690 import lab

recs = lab.load_aistudio("/opt/bme-ai-studio/app/src/config/demo.bmeproject")
df = lab.cycles_table(recs)          # one row per sensor-cycle, with class and specimen

# Group classes for a task: Espresso and Filter Coffee both count as "Coffee".
task = {"Air": "Air", "Espresso": "Coffee", "Filter Coffee": "Coffee"}

s = lab.per_sensor(df, kind="shape", classes=task)   # X (N, 11): like AI-Studio
f = lab.fused(df, kind="shape", classes=task)        # X (N, sensors, 11): all sensors at once
q = lab.sequences(f, length=6)                       # X (N, 6, sensors, 11): six cycles in a row
a = lab.fused_all(df, classes=task)                  # all 8 sensors even when they run different
                                                     # heater profiles; missing sensors are masked

train, test = lab.split_by_specimen(s)               # honest: no specimen on both sides
for train, test in lab.group_kfold(s, k=5):          # every specimen tested once
    ...
```

### Rules the lab follows

- **Cycles and specimens match AI-Studio's importer** (tested against AI-Studio
  3.1.0's own counts), so numbers line up across all the tools.
- **Splits keep specimens whole.** Neighbouring cycles of one specimen are near
  copies, so a random split reports accuracy the model won't reach on a new
  sample. `random_split` exists only to compare with AI-Studio.
- **Specimen classes:** from the label file's class name when BME Studio wrote
  it, otherwise from the specimen name with any round number removed ("Coffee
  3" → Coffee), and no class for "settling". Change them with
  `rec.assign_classes({...})`.
