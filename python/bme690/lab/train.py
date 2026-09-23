"""Training, prediction, evaluation and cross-validation for the lab's models.

    from bme690.lab import models, train
    m = models.MLP.for_samples(tr)
    hist = train.fit(m, tr, val=te, epochs=200)
    train.evaluate(m, te)                     # accuracy, confusion, recall, precision
    train.cross_validate(lambda: models.MLP.for_samples(s), s, folds=lab.group_kfold(s))

Standardisation constants are fitted on the training samples only. Runs are
repeatable for a given ``seed`` on the same device (GPU and CPU results
differ in the last digits); a model's initial weights come from torch's
global generator, so call :func:`seed_everything` before building it
(:func:`cross_validate` does this for every fold).
"""

from __future__ import annotations

import copy
import inspect
import random
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple, Union

import numpy as np
import torch
from torch import nn

from .prep import Samples, group_kfold

_announced: set = set()


def device_of(device: Union[str, torch.device] = "auto", quiet: bool = False) -> torch.device:
    """"auto" = the first CUDA GPU if there is one, else the CPU."""
    if str(device) == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    d = torch.device(device)
    if d.type == "cuda" and d.index is None:
        d = torch.device("cuda", torch.cuda.current_device())
    if not quiet and str(d) not in _announced:
        _announced.add(str(d))
        if d.type == "cuda":
            print(f"training on {torch.cuda.get_device_name(d)} ({d})")
        else:
            why = "" if torch.cuda.is_available() else " (no CUDA GPU found)"
            print(f"training on the CPU{why}")
    return d


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False


def _xy(s: Union[Samples, np.ndarray], device) -> Tuple[torch.Tensor, Optional[torch.Tensor]]:
    if isinstance(s, Samples):
        return (torch.tensor(s.X, dtype=torch.float32, device=device),
                torch.tensor(s.y, dtype=torch.long, device=device))
    return torch.tensor(np.asarray(s), dtype=torch.float32, device=device), None


def class_weights(y: np.ndarray, n_classes: int) -> np.ndarray:
    """'balanced': n / (classes * count), and 0 for a class absent from training."""
    counts = np.bincount(y[y >= 0], minlength=n_classes).astype(float)
    present = counts > 0
    w = np.zeros(n_classes)
    w[present] = counts.sum() / (present.sum() * counts[present])
    return w


class History(dict):
    """Per-epoch loss / accuracy lists plus ``best_epoch``, ``seconds`` and
    ``device``; a dict so it prints and pickles plainly."""

    def __getattr__(self, k):
        try:
            return self[k]
        except KeyError:
            raise AttributeError(k) from None


def fit(model: nn.Module, train: Samples, val: Optional[Samples] = None, epochs: int = 200,
        lr: float = 1e-3, batch_size: int = 32, weight_decay: float = 0.0,
        device: Union[str, torch.device] = "auto", early_stopping: Union[bool, int] = False,
        class_weight: Optional[str] = "balanced", augment: Optional[Callable] = None,
        progress: bool = True, seed: int = 0, fit_scaler: bool = True,
        params: Optional[Iterable[nn.Parameter]] = None) -> History:
    """Train ``model`` in place with Adam and cross-entropy; returns a History.

    val             scored every epoch (loss, accuracy); needed for early stopping
    early_stopping  True (patience 20) or a patience in epochs: stop when the
                    validation loss stops improving and keep the best weights.
                    Stopping on the *test* set makes its score optimistic --
                    pass a separate validation split.
    class_weight    "balanced" weighs each label equally however many samples
                    it has; None weighs every sample equally
    augment         called on each training batch (see bme690.lab.augment)
    fit_scaler      False keeps the model's standardisation (e.g. fitted on
                    unlabelled data during pre-training)
    params          train only these (e.g. a linear probe's head)
    """
    seed_everything(seed)
    dev = device_of(device, quiet=not progress)
    model.to(dev)
    labelled = train.y >= 0
    if not labelled.all():
        train = train.subset(np.flatnonzero(labelled))
    if fit_scaler:
        model.fit_scaler(train.X)
    X, y = _xy(train, dev)
    n_classes = model.config["n_classes"]
    w = None
    if class_weight == "balanced":
        w = torch.as_tensor(class_weights(train.y, n_classes), dtype=torch.float32, device=dev)
    elif class_weight is not None:
        raise ValueError("class_weight must be 'balanced' or None")
    loss_fn = nn.CrossEntropyLoss(weight=w)
    plain_loss = nn.CrossEntropyLoss()
    opt = torch.optim.Adam(list(params) if params is not None else model.parameters(),
                           lr=lr, weight_decay=weight_decay, fused=dev.type == "cuda")
    if val is not None:
        Xv, yv = _xy(val.subset(np.flatnonzero(val.y >= 0)), dev)
    patience = 20 if early_stopping is True else int(early_stopping or 0)
    if patience and val is None:
        print("early stopping needs a validation set; training all epochs")
        patience = 0

    g = torch.Generator(device="cpu").manual_seed(seed)
    hist = History(epoch=[], loss=[], acc=[], val_loss=[], val_acc=[], best_epoch=None,
                   seconds=0.0, device=str(dev))
    best, best_state, since = float("inf"), None, 0
    t0 = time.perf_counter()
    n = len(y)
    report_every = max(1, epochs // 5)
    for ep in range(1, epochs + 1):
        model.train()
        order = torch.randperm(n, generator=g).to(dev)
        tot = torch.zeros((), device=dev)
        correct = torch.zeros((), device=dev, dtype=torch.long)
        for i in range(0, n, batch_size):
            b = order[i:i + batch_size]
            xb, yb = X[b], y[b]
            if augment is not None:
                xb = augment(xb)
            out = model(xb)
            loss = loss_fn(out, yb)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            tot += loss.detach() * len(b)               # stays on the device: no sync per batch
            correct += (out.argmax(1) == yb).sum()
        hist["epoch"].append(ep)
        hist["loss"].append(float(tot) / n)
        hist["acc"].append(int(correct) / n)
        if val is not None:
            model.eval()
            with torch.no_grad():
                out = _batched(model, Xv)
                vl = float(plain_loss(out, yv))
                va = float((out.argmax(1) == yv).float().mean())
            hist["val_loss"].append(vl)
            hist["val_acc"].append(va)
            if patience:
                if vl < best - 1e-5:
                    best, best_state, since = vl, copy.deepcopy(model.state_dict()), 0
                    hist["best_epoch"] = ep
                else:
                    since += 1
                    if since >= patience:
                        if progress:
                            print(f"  stopped after {ep} epochs: no improvement for {patience}")
                        break
        if progress and (ep % report_every == 0 or ep == epochs):
            msg = f"  epoch {ep:4d}  loss {hist['loss'][-1]:.4f}  acc {hist['acc'][-1]:.3f}"
            if val is not None:
                msg += f"  val_loss {hist['val_loss'][-1]:.4f}  val_acc {hist['val_acc'][-1]:.3f}"
            print(msg)
    if best_state is not None:
        model.load_state_dict(best_state)
    if dev.type == "cuda":
        torch.cuda.synchronize(dev)
    hist["seconds"] = time.perf_counter() - t0
    model.eval()
    return hist


def _batched(model: nn.Module, X: torch.Tensor, batch: int = 4096) -> torch.Tensor:
    return torch.cat([model(X[i:i + batch]) for i in range(0, len(X), batch)]) if len(X) else \
        torch.zeros((0, model.config["n_classes"]), device=X.device)


def predict_proba(model: nn.Module, samples: Union[Samples, np.ndarray],
                  device: Union[str, torch.device, None] = None) -> np.ndarray:
    """Class probabilities (N, classes). Runs where the model is unless
    ``device`` is given."""
    dev = next(model.parameters()).device if device is None else device_of(device, quiet=True)
    model.to(dev).eval()
    X, _ = _xy(samples, dev)
    with torch.no_grad():
        return torch.softmax(_batched(model, X), dim=1).double().cpu().numpy()


def predict(model: nn.Module, samples) -> np.ndarray:
    return predict_proba(model, samples).argmax(1)


def scores(y: np.ndarray, pred: np.ndarray, labels: List[str]) -> Dict[str, Any]:
    k = len(labels)
    conf = np.zeros((k, k), dtype=int)
    for t, p in zip(y, pred):
        conf[t, p] += 1
    tp = np.diag(conf).astype(float)
    support, predicted = conf.sum(1), conf.sum(0)
    rec = np.divide(tp, support, out=np.full(k, np.nan), where=support > 0)
    prec = np.divide(tp, predicted, out=np.full(k, np.nan), where=predicted > 0)
    return {
        "accuracy": float(tp.sum() / max(len(y), 1)),
        "balanced_accuracy": float(np.nanmean(rec)) if (support > 0).any() else float("nan"),
        "confusion": conf,
        "recall": dict(zip(labels, rec.tolist())),
        "precision": dict(zip(labels, prec.tolist())),
        "support": dict(zip(labels, support.tolist())),
        "labels": list(labels),
        "n": int(len(y)),
    }


def evaluate(model: nn.Module, samples: Samples) -> Dict[str, Any]:
    """accuracy, balanced_accuracy, confusion (rows true, columns predicted),
    per-label recall and precision (NaN when undefined), support, n."""
    s = samples.subset(np.flatnonzero(samples.y >= 0))
    return scores(s.y, predict(model, s), s.labels)


def cross_validate(make_model: Callable, samples: Samples,
                   folds: Optional[Iterable[Tuple[np.ndarray, np.ndarray]]] = None,
                   progress: bool = True, **fit_kw) -> Dict[str, Any]:
    """Train a fresh model per fold and score it on the held-out part.

    make_model  () -> model, or (train_samples) -> model
    folds       (train_idx, test_idx) pairs; default group_kfold(samples, 5),
                which never tests on a specimen the model trained on
    Returns {"folds": [...], "mean", "std", "balanced_mean", "confusion" (summed
    over folds), "histories", "models"}.
    """
    folds = list(folds if folds is not None else group_kfold(samples, 5))
    one_arg = len(inspect.signature(make_model).parameters) >= 1
    rows, hists, models, conf = [], [], [], None
    fit_kw.setdefault("progress", False)
    for i, (tr, te) in enumerate(folds):
        a, b = samples.subset(tr), samples.subset(te)
        seed_everything(fit_kw.get("seed", 0) + i)          # repeatable initial weights
        m = make_model(a) if one_arg else make_model()
        h = fit(m, a, **fit_kw)
        r = evaluate(m, b)
        conf = r["confusion"] if conf is None else conf + r["confusion"]
        row = {"fold": i, "n_train": len(a), "n_test": r["n"], "accuracy": r["accuracy"],
               "balanced_accuracy": r["balanced_accuracy"], "recall": r["recall"],
               "test_groups": sorted(set(b.groups.tolist())), "seconds": h["seconds"]}
        rows.append(row)
        hists.append(h)
        models.append(m)
        if progress:
            print(f"  fold {i + 1}/{len(folds)}: {r['accuracy']:.3f} on {r['n']} samples "
                  f"({', '.join(row['test_groups'])})")
    acc = np.array([r["accuracy"] for r in rows])
    bal = np.array([r["balanced_accuracy"] for r in rows])
    out = {"folds": rows, "mean": float(acc.mean()), "std": float(acc.std()),
           "balanced_mean": float(np.nanmean(bal)), "confusion": conf,
           "histories": hists, "models": models,
           "pooled_accuracy": float(np.trace(conf) / max(conf.sum(), 1))}
    if progress:
        print(f"  mean {out['mean']:.3f} ± {out['std']:.3f}  (pooled {out['pooled_accuracy']:.3f})")
    return out
