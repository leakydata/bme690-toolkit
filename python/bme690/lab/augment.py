"""Augmentations that respect how metal-oxide gas sensors behave.

They work on the raw features of :func:`bme690.lab.features` ("shape", "log"
or "aistudio"), converting to log10 resistance, changing that, and
converting back -- so they mean the same thing whichever feature set a model
uses. Missing sensors (NaN rows) stay missing.

  level drift     each sensor's whole cycle shifts by one random offset in log
                  resistance: the baseline 'level' drifts with age, humidity
                  and temperature, while the pattern across steps holds.
  noise           small independent noise on each step's log resistance
                  (read-out noise, about 1 %).
  sensor dropout  a random sensor's row becomes missing (fused inputs), so a
                  model learns not to rely on any single sensor.
  cycle jitter    in sequences, each cycle gets its own small level wobble
                  and, now and then, repeats the previous one -- the timing
                  and cycle-to-cycle variation between consecutive moments.

    aug = Augment("shape", drift=0.05, noise=0.005, dropout=0.15)
    fit(model, train, augment=aug)
"""

from __future__ import annotations

from typing import Tuple

import torch

STEPS = 10


def to_log(x: torch.Tensor, kind: str) -> Tuple[torch.Tensor, torch.Tensor]:
    """Split features into log10 resistance (..., 10) and the rest
    (environment columns), whatever the feature set."""
    if kind == "shape":
        return x[..., :STEPS] + x[..., STEPS:STEPS + 1], x[..., STEPS + 1:]
    if kind == "log":
        return x[..., :STEPS], x[..., STEPS:]
    if kind == "aistudio":
        return torch.log10(x[..., :STEPS].clamp(min=1.0)), x[..., STEPS:]
    raise ValueError(f"unknown feature set {kind!r}")


def from_log(l: torch.Tensor, rest: torch.Tensor, kind: str) -> torch.Tensor:
    if kind == "shape":
        m = l.mean(-1, keepdim=True)
        return torch.cat([l - m, m, rest], -1)
    if kind == "log":
        return torch.cat([l, rest], -1)
    return torch.cat([torch.pow(10.0, l), rest], -1)


class Augment:
    """Random, physically plausible variations of a batch; call it on a tensor
    of shape (N, F), (N, S, F) or (N, L, S, F). Sizes are in log10
    resistance: 0.05 is about 12 %.

    kind     the feature set the inputs use
    drift    std of the per-sensor level offset
    noise    std of per-step noise
    dropout  probability that each sensor is missing (never all of them)
    jitter   probability, per cycle of a sequence, of repeating the previous
             cycle; each cycle also gets a level wobble of ``drift / 5``
    """

    def __init__(self, kind: str = "shape", drift: float = 0.05, noise: float = 0.005,
                 dropout: float = 0.0, jitter: float = 0.0):
        self.kind, self.drift, self.noise, self.dropout, self.jitter = kind, drift, noise, dropout, jitter

    def __repr__(self) -> str:
        return (f"Augment({self.kind!r}, drift={self.drift}, noise={self.noise}, "
                f"dropout={self.dropout}, jitter={self.jitter})")

    def __call__(self, x: torch.Tensor) -> torch.Tensor:
        l, rest = to_log(x, self.kind)
        lead = l.shape[:-1]                       # (N,) (N,S) or (N,L,S)
        dev, dt = l.device, l.dtype
        if self.drift:
            shape = (lead[0], 1, lead[2], 1) if len(lead) == 3 else (*lead, 1)
            l = l + torch.randn(shape, device=dev, dtype=dt) * self.drift
        if len(lead) == 3 and (self.jitter or self.drift):
            l = l + torch.randn((*lead, 1), device=dev, dtype=dt) * (self.drift / 5)
            if self.jitter:
                rep = torch.rand(lead[:2], device=dev) < self.jitter
                rep[:, 0] = False
                prev = torch.cat([l[:, :1], l[:, :-1]], 1)
                l = torch.where(rep[..., None, None], prev, l)
        if self.noise:
            l = l + torch.randn_like(l) * self.noise
        out = from_log(l, rest, self.kind)
        if self.dropout and len(lead) >= 2:
            n, s = lead[0], lead[-1]
            drop = torch.rand((n, s), device=dev) < self.dropout
            present = ~torch.isnan(x[..., 0])
            if len(lead) == 3:
                present = present.any(1)
            # never remove the last sensor still present
            keep_one = torch.rand((n, s), device=dev).masked_fill(~present, -1).argmax(-1)
            drop[torch.arange(n, device=dev), keep_one] = False
            m = drop[:, None, :, None] if len(lead) == 3 else drop[..., None]
            out = out.masked_fill(m, float("nan"))
        return out
