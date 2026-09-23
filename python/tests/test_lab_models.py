"""The lab's PyTorch models, training, augmentation, pre-training and export.

Fast CPU tests on tiny synthetic data; a GPU smoke test runs when CUDA is
available, the Studio round trip when Node is, the demo-project checks when
BME AI-Studio's demo is installed."""
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

torch = pytest.importorskip("torch")

from bme690 import lab  # noqa: E402
from bme690.lab import augment, export, models, pretrain, train  # noqa: E402
from bme690.lab.fusion import fused_all  # noqa: E402

HERE = Path(__file__).resolve().parent
STUDIO = HERE.parents[1] / "studio"
DEMO = Path("/opt/bme-ai-studio/app/src/config/demo.bmeproject")


def toy(n=240, S=3, seed=0, sep=0.25):
    """Two 'gases' that change the pattern across heater steps, on S sensors
    with their own baselines, in 8 specimens. Features are the 'shape' set."""
    r = np.random.default_rng(seed)
    y = np.arange(n) % 2
    steps = np.linspace(0, 1, 10)
    base = 4.5 + r.normal(0, 0.3, (S, 1)) - 0.8 * steps           # (S, 10)
    bump = sep * np.sin(np.pi * steps) * np.linspace(1, 2, S)[:, None]
    l = base[None] + y[:, None, None] * bump[None] + r.normal(0, 0.03, (n, S, 10))
    l += r.normal(0, 0.05, (n, S, 1))                               # level jitter
    m = l.mean(-1, keepdims=True)
    X = np.concatenate([l - m, m], -1).astype(np.float32)          # (n, S, 11)
    groups = np.array([f"rec:{i % 8}" for i in range(n)])
    return lab.Samples(X, y, ["A", "B"], groups, np.array(["rec"] * n), np.arange(n) * 1000.0,
                       list(range(S)))


def flat(s, sensor=0):
    return lab.Samples(s.X[:, sensor], s.y, s.labels, s.groups, s.recordings, s.t)


def seqs(s, L=4):
    q = lab.sequences(s, length=L)
    return q


FIT = dict(device="cpu", progress=False)


def test_mlp_learns_toy_problem():
    s = flat(toy())
    tr, te = lab.split_by_specimen(s)
    m = models.MLP.for_samples(s)
    assert [l.out_features for l in m.dense_layers()] == [10, 10, 2]
    h = train.fit(m, s.subset(tr), s.subset(te), epochs=60, **FIT)
    assert h["loss"][-1] < h["loss"][0]
    r = train.evaluate(m, s.subset(te))
    assert r["accuracy"] > 0.95
    assert r["confusion"].sum() == r["n"] == len(te)
    assert set(r["recall"]) == {"A", "B"}


def test_scaler_is_fitted_on_training_data_only():
    s = flat(toy())
    tr, te = lab.split_by_specimen(s)
    m = models.MLP.for_samples(s)
    train.fit(m, s.subset(tr), epochs=1, **FIT)
    assert np.allclose(m.scaler.mean.numpy(), s.X[tr].mean(0), atol=1e-5)
    assert not np.allclose(m.scaler.mean.numpy(), s.X.mean(0), atol=1e-5)


def test_sensor_set_net_learns_and_survives_a_missing_sensor():
    s = toy()
    tr, te = lab.split_by_specimen(s)
    m = models.SensorSetNet.for_samples(s, dim=16)
    aug = augment.Augment("shape", drift=0.02, noise=0.005, dropout=0.3)
    train.fit(m, s.subset(tr), epochs=40, batch_size=32, augment=aug, **FIT)
    test = s.subset(te)
    assert train.evaluate(m, test)["accuracy"] > 0.95
    w = m.attention()
    assert w.shape == (len(test), 3) and torch.allclose(w.sum(1), torch.ones(len(test)))
    test.X = test.X.copy()
    test.X[:, 2] = np.nan                                        # sensor 2 died
    assert train.evaluate(m, test)["accuracy"] > 0.9
    assert float(m.attention()[:, 2].max()) == 0.0
    test.X[:, :] = np.nan                                        # nothing at all: no NaN out
    assert np.isfinite(train.predict_proba(m, test)).all()


def test_temporal_net_learns():
    s = seqs(toy())
    assert s.X.ndim == 4
    tr, te = lab.split_by_specimen(s)
    m = models.TemporalNet.for_samples(s, dim=16, hidden=16)
    aug = augment.Augment("shape", drift=0.02, jitter=0.2)
    train.fit(m, s.subset(tr), epochs=30, augment=aug, **FIT)
    assert train.evaluate(m, s.subset(te))["accuracy"] > 0.95


@pytest.mark.parametrize("make", [
    lambda s: models.MLP.for_samples(flat(s), width=[8, 6]),
    lambda s: models.SensorSetNet.for_samples(s, dim=8, pooling="mean"),
    lambda s: models.TemporalNet.for_samples(seqs(s), dim=8, hidden=8),
])
def test_save_load_round_trip(make, tmp_path):
    s = toy(n=64)
    m = make(s)
    data = flat(s) if isinstance(m, models.MLP) else seqs(s) if isinstance(m, models.TemporalNet) else s
    train.fit(m, data, epochs=2, **FIT)
    models.save(m, tmp_path / "m.pt")
    m2 = models.load(tmp_path / "m.pt")
    assert type(m2) is type(m) and m2.labels == ["A", "B"]
    assert np.allclose(train.predict_proba(m, data), train.predict_proba(m2, data), atol=1e-6)


def test_training_is_repeatable_with_a_seed():
    s = flat(toy(n=80))
    ps = []
    for _ in range(2):
        train.seed_everything(3)                 # the initial weights too
        m = models.MLP.for_samples(s)
        train.fit(m, s, epochs=5, seed=3, augment=augment.Augment("shape"), **FIT)
        ps.append(train.predict_proba(m, s))
    assert np.array_equal(ps[0], ps[1])


def test_augment_respects_the_physics():
    s = toy(n=64)
    x = torch.as_tensor(s.X)
    torch.manual_seed(0)
    a = augment.Augment("shape", drift=0.1, noise=0.0)(x)
    assert torch.allclose(a[..., :10], x[..., :10], atol=1e-5)   # pattern unchanged
    assert not torch.allclose(a[..., 10], x[..., 10])            # level moved
    lg = augment.Augment("log", drift=0.1, noise=0.0)(x[..., :10])
    d = lg - x[..., :10]
    assert torch.allclose(d, d[..., :1].expand_as(d), atol=1e-5)  # one offset per sensor cycle
    x2 = x.clone()
    x2[0, 1] = float("nan")
    for _ in range(20):
        dr = augment.Augment("shape", dropout=0.9)(x2)
        present = ~torch.isnan(dr[..., 0])
        assert present.any(1).all()                              # never every sensor
        assert not present[0, 1]                                 # missing stays missing
    q = torch.as_tensor(seqs(s).X)
    assert augment.Augment("shape", jitter=0.5, dropout=0.3)(q).shape == q.shape


def test_cross_validate_over_specimens():
    s = flat(toy(n=160))
    cv = train.cross_validate(lambda: models.MLP.for_samples(s), s, lab.group_kfold(s, k=4),
                              epochs=30, progress=False, device="cpu")
    assert len(cv["folds"]) == 4 and cv["mean"] > 0.9
    assert cv["confusion"].sum() == len(s)
    tested = sorted(g for f in cv["folds"] for g in f["test_groups"])
    assert tested == sorted(set(s.groups))


def test_pretrain_then_fine_tune():
    s = toy(n=256)
    net = models.SensorSetNet.for_samples(s, dim=16)
    unl = lab.Samples(s.X, np.full(len(s), -1), [], s.groups, s.recordings, s.t, s.sensors)
    h = pretrain.pretrain(net, unl, epochs=15, batch_size=64, progress=False, device="cpu")
    assert h["loss"][-1] < h["loss"][0]
    few = s.subset(np.r_[np.flatnonzero(s.y == 0)[:5], np.flatnonzero(s.y == 1)[:5]])
    for mode in ("linear", "full"):
        clf, _ = pretrain.fine_tune(net, few, mode=mode, epochs=60, **FIT)
        assert train.evaluate(clf, s)["accuracy"] > 0.8
    # the pre-trained encoder is left untouched and linear mode froze it
    assert net.config["n_classes"] == 2 and all(p.requires_grad for p in net.parameters())


def _studio_cycles(X_log, sensor=0, hp="heater_x"):
    return [{"sensor": sensor, "start": i * 1000.0, "end": i * 1000.0 + 900, "heaterProfile": hp,
             "gas": (10 ** l).tolist(), "temp": 25.0, "hum": 40.0, "press": 1000.0, "specimen": 0}
            for i, l in enumerate(X_log)]


def test_studio_record_format():
    s = flat(toy(n=64))
    m = models.MLP.for_samples(s)
    train.fit(m, s, epochs=3, **FIT)
    rec = export.to_studio(m, s, "toy", heater_profile="heater_x", label_of={"gas a": "A", "gas b": "B"})
    assert rec["kind"] == "mlp" and rec["labels"] == ["A", "B"]
    assert rec["featureNames"][-1] == "level" and len(rec["featureNames"]) == 11
    st = rec["state"]
    assert st["version"] == 1 and st["inputs"] == 11 and st["classes"] == 2
    assert [L["activation"] for L in st["layers"]] == ["relu", "relu", "softmax"]
    assert all(len(L["w"]) == L["inputs"] * L["units"] for L in st["layers"])
    json.dumps(rec, allow_nan=False)
    with pytest.raises(ValueError):
        export.to_studio(m, s, heater_profile="h", feature_set="log")


@pytest.mark.skipif(shutil.which("node") is None or not (STUDIO / "src" / "ml" / "run.ts").exists(),
                    reason="needs Node and the BME Studio source")
def test_studio_export_predicts_the_same_in_the_browser_code(tmp_path):
    s = flat(toy(n=120))
    m = models.MLP.for_samples(s)
    train.fit(m, s, epochs=30, **FIT)
    rec = export.to_studio(m, s, "toy", heater_profile="heater_x")
    # rebuild log resistances from the shape features: log = shape + level
    X_log = s.X[:, :10] + s.X[:, 10:11]
    cycles = _studio_cycles(X_log[:25])
    inp = tmp_path / "in.json"
    export.save_studio_json({"model": rec, "cycles": cycles}, inp)
    out = subprocess.run(["node", str(HERE / "studio_roundtrip.ts"), str(inp)], capture_output=True,
                         text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    got = np.array(json.loads(out.stdout)["probs"])
    feats = np.array([export_features(c) for c in cycles], dtype=np.float32)
    want = train.predict_proba(m, feats)
    assert got.shape == want.shape
    assert np.abs(got - want).max() < 1e-5
    # the wrong heater profile is refused, as in the Studio
    cycles[0]["heaterProfile"] = "other"
    export.save_studio_json({"model": rec, "cycles": cycles[:1]}, inp)
    out = subprocess.run(["node", str(HERE / "studio_roundtrip.ts"), str(inp)], capture_output=True,
                         text=True, timeout=120)
    assert json.loads(out.stdout)["probs"] == [None]


def export_features(c):
    import pandas as pd
    return lab.features(pd.DataFrame([{f"gas_{i}": g for i, g in enumerate(c["gas"])}]), "shape")[0]


@pytest.mark.parametrize("which", ["mlp", "set"])
def test_onnx_export(which, tmp_path):
    ort = pytest.importorskip("onnxruntime")
    pytest.importorskip("onnxscript")
    s = toy(n=64)
    if which == "mlp":
        s = flat(s)
        m = models.MLP.for_samples(s)
    else:
        m = models.SensorSetNet.for_samples(s, dim=8)
    train.fit(m, s, epochs=2, **FIT)
    X = s.X.copy()
    if which == "set":
        X[:5, 1] = np.nan
    export.to_onnx(m, X[:2], tmp_path / "m.onnx")
    got = ort.InferenceSession(str(tmp_path / "m.onnx")).run(None, {"features": X})[0]
    assert np.abs(got - train.predict_proba(m, X)).max() < 1e-5


@pytest.mark.skipif(not torch.cuda.is_available(), reason="no CUDA GPU")
def test_gpu_smoke():
    s = toy()
    m = models.SensorSetNet.for_samples(s)
    h = train.fit(m, s, epochs=5, device="cuda", progress=False,
                  augment=augment.Augment("shape", dropout=0.2))
    assert h["device"].startswith("cuda")
    assert next(m.parameters()).is_cuda
    assert train.predict_proba(m, s).shape == (len(s), 2)


@pytest.mark.skipif(not DEMO.exists(), reason="AI-Studio demo project not installed")
def test_fused_all_on_the_demo():
    df = lab.cycles_table(lab.load_aistudio(DEMO))
    s = fused_all(df, classes={"Air": "Air", "Espresso": "Coffee", "Filter Coffee": "Coffee"})
    assert s.X.shape[1:] == (8, 11) and s.labels == ["Air", "Coffee"]
    assert np.isnan(s.X).any() and (~np.isnan(s.X[:, :, 0])).mean() > 0.95
    u = fused_all(df, labelled_only=False)
    assert (u.y == -1).sum() > 0 and len(u) > len(s)
