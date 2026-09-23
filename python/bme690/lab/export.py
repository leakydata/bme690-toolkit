"""Taking models out of the lab.

  to_studio / save_studio_json   an MLP as a BME Studio model record
                                 (.bmemodel.json): Train -> Saved models ->
                                 Import model, then run it on recordings or
                                 live, or export it as a C header for the ESP32.
  to_onnx                        any lab model (deep ones included) as ONNX,
                                 outputting class probabilities.

The Studio record's ``state`` is exactly what studio/src/ml/models/mlp.ts
loads: standardisation constants and dense layers with row-major
[inputs][units] kernels, softmax on the last layer. Its predictions match
PyTorch's to ~1e-6 (tests/test_lab_models.py checks this through Node).
"""

from __future__ import annotations

import json
import logging
import math
import secrets
import time
import warnings
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Union

import numpy as np
import torch
from torch import nn

from .models import MLP, LabModel
from .prep import Samples


def feature_names(feature_set: str = "shape", environment: bool = False,
                  mode: str = "per-sensor", sensors: Sequence[int] = ()) -> List[str]:
    """The names BME Studio gives each feature (studio/src/ml/features.ts)."""
    steps = lambda p: [f"{p}{i + 1}" for i in range(10)]  # noqa: E731
    if feature_set == "aistudio":
        names = steps("gas step ")
    elif feature_set == "log":
        names = steps("log gas step ")
    elif feature_set == "shape":
        names = steps("shape step ") + ["level"]
    else:
        raise ValueError(f"unknown feature set {feature_set!r}")
    if environment:
        names += ["temperature", "humidity", "pressure"]
    if mode == "fused":
        return [f"sensor {s} {n}" for s in sorted(sensors) for n in names]
    return names


def _clean(v):
    """JSON-safe: numpy -> python, NaN -> null."""
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, np.ndarray)):
        return [_clean(x) for x in (v.tolist() if isinstance(v, np.ndarray) else v)]
    if isinstance(v, (np.floating, float)):
        return None if math.isnan(float(v)) else float(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    return v


def _scores_block(r: Dict[str, Any], split: str) -> Dict[str, Any]:
    labels = r["labels"]
    return {"split": split, "accuracy": r["accuracy"], "confusion": r["confusion"],
            "precision": [r["precision"][l] for l in labels],
            "recall": [r["recall"][l] for l in labels],
            "support": [r["support"][l] for l in labels], "nTest": r["n"]}


def mlp_state(model: MLP) -> Dict[str, Any]:
    """The MlpState BME Studio's `mlp` model kind loads."""
    layers = []
    lin = model.dense_layers()
    for i, L in enumerate(lin):
        W = L.weight.detach().double().cpu().numpy()        # (out, in)
        layers.append({
            "inputs": int(W.shape[1]),
            "units": int(W.shape[0]),
            "activation": "softmax" if i == len(lin) - 1 else model.activation,
            "w": W.T.reshape(-1).tolist(),                    # row-major [inputs][units]
            "b": L.bias.detach().double().cpu().numpy().tolist(),
        })
    sc = model.scaler
    return {"version": 1, "inputs": int(model.config["n_features"]),
            "classes": int(model.config["n_classes"]),
            "scaler": {"mean": sc.mean.double().cpu().tolist(), "std": sc.std.double().cpu().tolist()},
            "layers": layers}


def to_studio(model: MLP, samples: Optional[Samples] = None, name: str = "lab model", *,
              heater_profile: str, feature_set: str = "shape", environment: bool = False,
              mode: str = "per-sensor", sensors: Sequence[int] = (),
              label_of: Optional[Dict[str, str]] = None,
              honest: Optional[Dict[str, Any]] = None, random: Optional[Dict[str, Any]] = None,
              train_params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """A BME Studio ModelRecord for a trained :class:`MLP`.

    heater_profile  the heater profile id exactly as in the recording
                    ("heater_354"); the Studio only feeds the model cycles of it
    feature_set, environment  how the inputs were built (lab.features)
    mode, sensors   "per-sensor" (one cycle per sample, sensors [] = any) or
                    "fused" (all ``sensors``' cycles side by side)
    label_of        class name -> output label, e.g. {"Espresso": "Coffee",
                    "Air": "Air"}; the Studio's import matches keys to the
                    project's classes by name. Default: each label to itself.
    honest, random  results of train.evaluate on a by-specimen and a random
                    split, shown in the Studio as "Honest score" and
                    "AI-Studio way"
    """
    if not isinstance(model, MLP):
        raise TypeError("BME Studio runs MLPs; export deep models with to_onnx")
    names = feature_names(feature_set, environment, mode, sensors)
    if len(names) != model.config["n_features"]:
        raise ValueError(f"the model takes {model.config['n_features']} features but "
                         f"{feature_set!r} (environment={environment}, mode={mode}) gives {len(names)}")
    if not bool(model.scaler.fitted):
        raise ValueError("the model has not been trained")
    labels = list(samples.labels) if samples is not None else list(model.labels)
    if len(labels) != model.config["n_classes"]:
        raise ValueError("labels do not match the model's outputs")
    state = mlp_state(model)
    main = honest or random
    metrics: Dict[str, Any] = {
        "split": "specimen" if honest else "random",
        "testFraction": 0.3,
        "accuracy": main["accuracy"] if main else None,
        "honestAccuracy": honest["accuracy"] if honest else None,
        "randomAccuracy": random["accuracy"] if random else None,
        "confusion": main["confusion"] if main else [],
        "main": _scores_block(main, "specimen" if honest else "random") if main else None,
        "other": _scores_block(random, "random") if (honest and random) else None,
        "importance": None,
        "samples": int(len(samples)) if samples is not None else None,
        "source": "bme690.lab",
    }
    widths = model.config["width"]
    params = {"hiddenLayers": len(widths), "units": widths[0], "activation": model.activation}
    params.update(train_params or {})
    rec = {
        "id": f"mdl_lab{secrets.token_hex(5)}",
        "name": name,
        "created": int(time.time() * 1000),
        "kind": "mlp",
        "dataset": {"featureSet": feature_set, "environment": bool(environment),
                    "heaterProfile": heater_profile, "sensors": sorted(int(s) for s in sensors),
                    "mode": mode, "labelOf": dict(label_of or {l: l for l in labels})},
        "labels": labels,
        "featureNames": names,
        "params": params,
        "metrics": metrics,
        "state": state,
    }
    return _clean(rec)


def save_studio_json(record: Dict[str, Any], path: Union[str, Path]) -> Path:
    """Write a record from :func:`to_studio`; use the .bmemodel.json
    extension, as the Studio's own JSON export does."""
    p = Path(path)
    p.write_text(json.dumps(record))
    return p


# ------------------------------------------------------------------ ONNX

class _Probabilities(nn.Module):
    def __init__(self, model: nn.Module):
        super().__init__()
        self.model = model

    def forward(self, x):
        return torch.softmax(self.model(x), dim=-1)


def to_onnx(model: LabModel, example_input: Union[np.ndarray, torch.Tensor], path: Union[str, Path],
            opset: int = 18) -> Path:
    """Export ``model`` (standardisation included) to ONNX with input
    "features" (batch dimension dynamic) and output "probabilities". Missing
    sensors are NaN rows, as in the lab. Needs the ``onnx`` and
    ``onnxscript`` packages (in the ``lab`` extra)."""
    model = model.cpu().eval()
    x = torch.as_tensor(np.asarray(example_input) if not torch.is_tensor(example_input) else example_input,
                        dtype=torch.float32).cpu()
    wrapped = _Probabilities(model).eval()
    batch = torch.export.Dim("batch", min=1)
    quiet = [logging.getLogger(n) for n in ("torch.onnx", "torch._dynamo", "torch.export")]
    levels = [l.level for l in quiet]
    try:
        for l in quiet:
            l.setLevel(logging.ERROR)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            torch.onnx.export(wrapped, (x,), str(path), input_names=["features"],
                              output_names=["probabilities"], dynamic_shapes={"x": {0: batch}},
                              opset_version=opset, dynamo=True, external_data=False, verbose=False)
    finally:
        for l, v in zip(quiet, levels):
            l.setLevel(v)
    return Path(path)
