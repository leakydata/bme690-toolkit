"""Self-supervised pre-training: learn how the sensors behave from unlabelled
hours, then learn a smell from a few labelled examples.

:func:`pretrain` trains a :class:`SensorSetNet`'s encoder with SimCLR's
contrastive loss (NT-Xent): two randomly augmented views of the same moment
(level drift, noise, a missing sensor -- :mod:`bme690.lab.augment`) should map
close together, and away from every other moment in the batch. No labels are
used, so every cycle ever logged -- warm-up, burn-in, overnight air -- is
training data. :func:`fine_tune` then fits a classifier head on a few
labelled samples, either on the frozen encoder (a linear probe) or updating
everything.

    net = models.SensorSetNet.for_samples(unlabelled_with_labels_ignored)
    pretrain(net, unlabelled)
    clf, hist = fine_tune(net, few_labelled, mode="linear")
"""

from __future__ import annotations

import copy
import time
from typing import Optional, Tuple, Union

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

from .augment import Augment
from .models import SensorSetNet
from .prep import Samples
from .train import History, device_of, fit, seed_everything


def nt_xent(z1: torch.Tensor, z2: torch.Tensor, temperature: float = 0.2) -> torch.Tensor:
    """SimCLR's normalised-temperature cross-entropy: each view must pick its
    partner out of the 2N - 1 other views in the batch."""
    z = F.normalize(torch.cat([z1, z2]), dim=1)
    n = len(z1)
    sim = z @ z.T / temperature
    sim.fill_diagonal_(float("-inf"))
    target = torch.cat([torch.arange(n, 2 * n), torch.arange(0, n)]).to(z.device)
    return F.cross_entropy(sim, target)


def pretrain(net: SensorSetNet, unlabelled: Union[Samples, np.ndarray],
             augment: Optional[Augment] = None, epochs: int = 200, batch_size: int = 256,
             lr: float = 1e-3, weight_decay: float = 1e-4, temperature: float = 0.2,
             proj_dim: int = 32, device: Union[str, torch.device] = "auto", seed: int = 0,
             progress: bool = True) -> History:
    """Contrastive pre-training of ``net``'s encoder, in place. ``unlabelled``
    is fused samples X (N, S, F); any labels are ignored. The
    standardisation is fitted on these samples. Returns the loss per epoch."""
    seed_everything(seed)
    dev = device_of(device, quiet=not progress)
    X = unlabelled.X if isinstance(unlabelled, Samples) else np.asarray(unlabelled)
    net.fit_scaler(X)
    net.to(dev)
    X = torch.as_tensor(X, dtype=torch.float32, device=dev)
    aug = augment or Augment("shape", drift=0.05, noise=0.01, dropout=0.25)
    dim = net.config["dim"]
    proj = nn.Sequential(nn.Linear(dim, dim), nn.ReLU(), nn.Linear(dim, proj_dim)).to(dev)
    opt = torch.optim.AdamW(list(net.body.parameters()) + list(proj.parameters()),
                            lr=lr, weight_decay=weight_decay)
    g = torch.Generator(device="cpu").manual_seed(seed)
    hist = History(epoch=[], loss=[], seconds=0.0, device=str(dev))
    n = len(X)
    bs = min(batch_size, n)
    t0 = time.perf_counter()
    net.train()
    for ep in range(1, epochs + 1):
        order = torch.randperm(n, generator=g).to(dev)
        tot, cnt = 0.0, 0
        for i in range(0, n - bs + 1, bs):          # full batches: NT-Xent wants many negatives
            xb = X[order[i:i + bs]]
            loss = nt_xent(proj(net.encode(aug(xb))), proj(net.encode(aug(xb))), temperature)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            tot += float(loss.detach())
            cnt += 1
        hist["epoch"].append(ep)
        hist["loss"].append(tot / max(cnt, 1))
        if progress and (ep % max(1, epochs // 5) == 0 or ep == epochs):
            print(f"  epoch {ep:4d}  contrastive loss {hist['loss'][-1]:.4f}")
    if dev.type == "cuda":
        torch.cuda.synchronize(dev)
    hist["seconds"] = time.perf_counter() - t0
    net.eval()
    return hist


def fine_tune(encoder: SensorSetNet, train: Samples, val: Optional[Samples] = None,
              mode: str = "linear", epochs: int = 200, lr: float = 3e-3,
              **fit_kw) -> Tuple[SensorSetNet, History]:
    """A classifier from a pre-trained encoder and a few labelled samples.

    mode "linear"  freeze the encoder, train only the head (a linear probe:
                   tests what pre-training alone learned)
         "full"    train everything, starting from the pre-trained weights
    The encoder is copied, never changed; its standardisation is kept.
    Returns (model, history)."""
    m = copy.deepcopy(encoder)
    m.new_head(len(train.labels), train.labels)
    if mode == "linear":
        for p in m.body.parameters():
            p.requires_grad_(False)
        params = m.head.parameters()
    elif mode == "full":
        params = None
    else:
        raise ValueError("mode must be 'linear' or 'full'")
    h = fit(m, train, val, epochs=epochs, lr=lr, fit_scaler=False, params=params, **fit_kw)
    return m, h
