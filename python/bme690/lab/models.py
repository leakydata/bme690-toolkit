"""PyTorch models for gas-sensor cycles.

Every model takes *raw* features (what :func:`bme690.lab.features` gives) and
standardises them itself with constants fitted on the training data only
(:meth:`fit_scaler`, called by :func:`bme690.lab.train.fit`) and saved with
the weights -- so a saved model is complete, and test data never leaks into
the scaling.

  MLP           X (N, F)        BME AI-Studio's network: dense 10 -> dense 10 ->
                                softmax, ReLU. Exports to BME Studio.
  SensorSetNet  X (N, S, F)     one shared encoder per sensor cycle + a learned
                                sensor embedding, attention-pooled across
                                sensors. A sensor whose row is NaN is missing
                                and is masked out.
  TemporalNet   X (N, L, S, F)  SensorSetNet's per-moment encoding for each of L
                                consecutive moments, then a GRU over time.

Models return logits; use :func:`bme690.lab.train.predict_proba` for
probabilities.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Union

import numpy as np
import torch
from torch import nn

STEPS = 10

_ACT = {"relu": nn.ReLU, "tanh": nn.Tanh, "sigmoid": nn.Sigmoid, "elu": nn.ELU}


class Standardizer(nn.Module):
    """z-score with training-set constants, the same rule as BME Studio's
    scaler (population std; a constant feature gets std 1). NaN (missing) is
    ignored when fitting and passes through."""

    def __init__(self, shape: Sequence[int]):
        super().__init__()
        self.register_buffer("mean", torch.zeros(*shape))
        self.register_buffer("std", torch.ones(*shape))
        self.register_buffer("fitted", torch.zeros((), dtype=torch.bool))

    @torch.no_grad()
    def fit(self, x: Union[np.ndarray, torch.Tensor]) -> "Standardizer":
        x = torch.as_tensor(np.asarray(x) if not torch.is_tensor(x) else x, dtype=torch.float64)
        x = x.reshape(-1, *self.mean.shape)
        ok = ~torch.isnan(x)
        n = ok.sum(0).clamp(min=1)
        m = torch.where(ok, x, 0).sum(0) / n
        v = (torch.where(ok, x - m, 0) ** 2).sum(0) / n
        s = v.sqrt()
        s = torch.where(s > 1e-12, s, torch.ones_like(s))
        self.mean.copy_(m.to(self.mean))
        self.std.copy_(s.to(self.std))
        self.fitted.fill_(True)
        return self

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return (x - self.mean) / self.std


class LabModel(nn.Module):
    """Base: remembers its constructor arguments (for save/load) and labels."""

    def __init__(self, config: Dict[str, Any]):
        super().__init__()
        self.config = dict(config)
        self.labels: List[str] = [str(i) for i in range(config["n_classes"])]
        self.meta: Dict[str, Any] = {}

    def fit_scaler(self, x) -> None:
        self.scaler.fit(x)

    def attention(self) -> Optional[torch.Tensor]:
        return None


# ------------------------------------------------------------------ MLP

class MLP(LabModel):
    """BME AI-Studio's classifier: standardised inputs, ``depth`` dense layers
    of ``width`` units (2 x 10, ReLU, by default), softmax output."""

    def __init__(self, n_features: int, n_classes: int, width: Union[int, Sequence[int]] = 10,
                 depth: int = 2, activation: str = "relu", dropout: float = 0.0):
        widths = [width] * depth if isinstance(width, int) else list(width)
        super().__init__(dict(n_features=n_features, n_classes=n_classes, width=widths,
                              depth=len(widths), activation=activation, dropout=dropout))
        self.activation = activation
        self.scaler = Standardizer([n_features])
        layers: List[nn.Module] = []
        prev = n_features
        for w in widths:
            layers += [nn.Linear(prev, w), _ACT[activation]()]
            if dropout:
                layers.append(nn.Dropout(dropout))
            prev = w
        layers.append(nn.Linear(prev, n_classes))
        self.net = nn.Sequential(*layers)
        # AI-Studio / TF.js use Glorot-uniform kernels and zero biases.
        for m in self.net:
            if isinstance(m, nn.Linear):
                nn.init.xavier_uniform_(m.weight)
                nn.init.zeros_(m.bias)

    @classmethod
    def for_samples(cls, s, **kw) -> "MLP":
        m = cls(s.X.shape[1], len(s.labels), **kw)
        m.labels = list(s.labels)
        return m

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(self.scaler(x))

    def dense_layers(self) -> List[nn.Linear]:
        return [m for m in self.net if isinstance(m, nn.Linear)]


# ------------------------------------------------------------------ sensor sets

class CycleEncoder(nn.Module):
    """One sensor cycle -> a vector. A small 1-D conv over the heater steps
    (the first ``steps`` features); the remaining features (level,
    environment) join after the convolution. ``kind="mlp"`` uses a plain
    two-layer network over all features instead."""

    def __init__(self, n_features: int, dim: int = 32, kind: str = "conv", steps: int = STEPS,
                 channels: int = 16):
        super().__init__()
        self.kind, self.steps = kind, min(steps, n_features)
        extra = n_features - self.steps
        if kind == "conv":
            self.conv = nn.Sequential(
                nn.Conv1d(1, channels, 3, padding=1), nn.GELU(),
                nn.Conv1d(channels, channels, 3, padding=1), nn.GELU(),
            )
            flat = channels * self.steps + extra
        elif kind == "mlp":
            flat = n_features
        else:
            raise ValueError("encoder kind must be 'conv' or 'mlp'")
        self.out = nn.Sequential(nn.Linear(flat, dim), nn.GELU(), nn.Linear(dim, dim))

    def forward(self, x: torch.Tensor) -> torch.Tensor:   # (..., F) -> (..., dim)
        lead = x.shape[:-1]
        x = x.reshape(-1, x.shape[-1])
        if self.kind == "conv":
            h = self.conv(x[:, None, :self.steps]).flatten(1)
            x = torch.cat([h, x[:, self.steps:]], dim=1)
        return self.out(x).reshape(*lead, -1)


class SetBody(nn.Module):
    """(N, S, F) with NaN rows for missing sensors -> (N, dim) and the
    attention weight of each sensor (N, S)."""

    def __init__(self, n_sensors: int, n_features: int, dim: int = 32, encoder: str = "conv",
                 pooling: str = "attention"):
        super().__init__()
        self.scaler = Standardizer([n_sensors, n_features])
        self.encoder = CycleEncoder(n_features, dim, encoder)
        self.sensor_embedding = nn.Parameter(torch.randn(n_sensors, dim) * 0.1)
        self.pooling = pooling
        self.score = nn.Sequential(nn.Linear(dim, dim), nn.Tanh(), nn.Linear(dim, 1))
        self.norm = nn.LayerNorm(dim)

    def forward(self, x: torch.Tensor):
        mask = ~torch.isnan(x).any(-1)                        # (N, S) present
        z = torch.nan_to_num(self.scaler(x), nan=0.0)
        h = self.encoder(z) + self.sensor_embedding           # (N, S, dim)
        if self.pooling == "attention":
            a = self.score(h).squeeze(-1)
        else:
            a = torch.zeros(h.shape[:2], device=h.device, dtype=h.dtype)
        # Finite fill + renormalise (not -inf): a moment with no sensor at all
        # gets zero weights instead of NaN, in the forward and backward pass.
        w = torch.softmax(a.masked_fill(~mask, -1e4), dim=-1) * mask
        w = w / w.sum(-1, keepdim=True).clamp(min=1e-6)
        return self.norm((w.unsqueeze(-1) * h).sum(1)), w


class SensorSetNet(LabModel):
    """Several sensors' simultaneous cycles, X (N, S, F) -> class logits.

    A shared encoder reads each sensor's cycle, a learned embedding says which
    sensor (and so which heater profile) it came from, and attention decides
    how much each sensor counts; ``attention()`` returns the last batch's
    weights -- a per-sensor importance view. Missing sensors (NaN rows) are
    masked out, so the model keeps working if one fails."""

    def __init__(self, n_sensors: int, n_features: int, n_classes: int, dim: int = 32,
                 encoder: str = "conv", pooling: str = "attention", dropout: float = 0.1):
        super().__init__(dict(n_sensors=n_sensors, n_features=n_features, n_classes=n_classes,
                              dim=dim, encoder=encoder, pooling=pooling, dropout=dropout))
        self.body = SetBody(n_sensors, n_features, dim, encoder, pooling)
        self.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(dim, n_classes))
        self._attn: Optional[torch.Tensor] = None

    @classmethod
    def for_samples(cls, s, **kw) -> "SensorSetNet":
        m = cls(s.X.shape[1], s.X.shape[2], len(s.labels), **kw)
        m.labels = list(s.labels)
        return m

    @property
    def scaler(self) -> Standardizer:
        return self.body.scaler

    def encode(self, x: torch.Tensor) -> torch.Tensor:
        h, w = self.body(x)
        if not torch.compiler.is_compiling():
            self._attn = w.detach()
        return h

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.encode(x))

    def attention(self) -> Optional[torch.Tensor]:
        return self._attn

    def new_head(self, n_classes: int, labels: Optional[List[str]] = None) -> "SensorSetNet":
        """Replace the classifier head (for fine-tuning a pre-trained encoder)."""
        dim = self.config["dim"]
        self.head = nn.Sequential(nn.Dropout(self.config["dropout"]), nn.Linear(dim, n_classes))
        self.config["n_classes"] = n_classes
        self.labels = list(labels) if labels else [str(i) for i in range(n_classes)]
        return self


class TemporalNet(LabModel):
    """L consecutive moments, X (N, L, S, F) -> class logits: SensorSetNet's
    per-moment encoding, then a GRU over time. Sees how the response
    develops (a rising or falling resistance), not just one snapshot."""

    def __init__(self, n_sensors: int, n_features: int, n_classes: int, dim: int = 32,
                 hidden: int = 32, encoder: str = "conv", pooling: str = "attention",
                 dropout: float = 0.1):
        super().__init__(dict(n_sensors=n_sensors, n_features=n_features, n_classes=n_classes,
                              dim=dim, hidden=hidden, encoder=encoder, pooling=pooling,
                              dropout=dropout))
        self.body = SetBody(n_sensors, n_features, dim, encoder, pooling)
        self.rnn = nn.GRU(dim, hidden, batch_first=True)
        self.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(hidden, n_classes))
        self._attn: Optional[torch.Tensor] = None

    @classmethod
    def for_samples(cls, s, **kw) -> "TemporalNet":
        m = cls(s.X.shape[2], s.X.shape[3], len(s.labels), **kw)
        m.labels = list(s.labels)
        return m

    @property
    def scaler(self) -> Standardizer:
        return self.body.scaler

    def load_encoder(self, net: SensorSetNet) -> "TemporalNet":
        """Start from a (pre-trained) SensorSetNet's per-moment encoder."""
        self.body.load_state_dict(net.body.state_dict())
        return self

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        n, L = x.shape[:2]
        h, w = self.body(x.reshape(n * L, *x.shape[2:]))
        if not torch.compiler.is_compiling():
            self._attn = w.reshape(n, L, -1).mean(1).detach()
        out, _ = self.rnn(h.reshape(n, L, -1))
        return self.head(out[:, -1])

    def attention(self) -> Optional[torch.Tensor]:
        return self._attn


# ------------------------------------------------------------------ save / load

MODELS = {c.__name__: c for c in (MLP, SensorSetNet, TemporalNet)}


def save(model: LabModel, path: Union[str, Path]) -> None:
    """Weights, standardisation constants, constructor arguments and labels in
    one file; :func:`load` rebuilds the model."""
    torch.save({"class": type(model).__name__, "config": model.config, "labels": model.labels,
                "meta": model.meta, "state": {k: v.cpu() for k, v in model.state_dict().items()}},
               str(path))


def load(path: Union[str, Path], map_location: str = "cpu") -> LabModel:
    d = torch.load(str(path), map_location=map_location, weights_only=False)
    cfg = dict(d["config"])
    cls = MODELS[d["class"]]
    if cls is MLP:
        cfg.pop("depth", None)
    m = cls(**cfg)
    m.load_state_dict(d["state"])
    m.labels, m.meta = list(d["labels"]), dict(d.get("meta", {}))
    return m.eval()
