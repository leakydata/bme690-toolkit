"""bme690.lab -- machine learning on BME690/BME688 gas-sensor data.

Loads the board's .bmerawdata files and BME AI-Studio projects into pandas
with the same cycles, specimens and features as BME Studio, splits them
honestly, and trains models on the GPU (needs torch):

  bme690.lab.models    MLP (AI-Studio's network), SensorSetNet, TemporalNet
  bme690.lab.train     fit, predict_proba, evaluate, cross_validate
  bme690.lab.augment   sensor-physics augmentations
  bme690.lab.pretrain  self-supervised pre-training on unlabelled cycles
  bme690.lab.export    to BME Studio (.bmemodel.json) and ONNX

    from bme690 import lab
    recs = lab.load("path/to/sd-card/bme690")        # or lab.load_aistudio(".../demo.bmeproject")
    df = lab.cycles_table(recs)
    s = lab.fused(df, classes={"Air": "Air", "Coffee": "Coffee"})
    train, test = lab.split_by_specimen(s)

Install with:  pip install -e "python/[lab]"
"""

from .data import (GAS, STEPS, Recording, cycles_table, default_class, load, load_aistudio,
                   read_session, session_key)
from .fusion import fused_all
from .prep import (FEATURE_SETS, Samples, features, fused, group_kfold, leave_one_recording_out,
                   per_sensor, random_split, sequences, split_by_specimen, split_warning)

__all__ = [
    "GAS", "STEPS", "Recording", "cycles_table", "default_class", "load", "load_aistudio",
    "read_session", "session_key", "FEATURE_SETS", "Samples", "features", "fused", "fused_all",
    "group_kfold", "leave_one_recording_out", "per_sensor", "random_split", "sequences",
    "split_by_specimen", "split_warning",
]
