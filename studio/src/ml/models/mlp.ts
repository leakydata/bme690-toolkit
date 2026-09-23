/**
 * "Neural network (AI-Studio style)": a small dense network like the one BME
 * AI-Studio trains -- standardised inputs, a few hidden layers of ten units,
 * softmax output, Adam, cross-entropy, batch 32, 256 epochs.
 *
 * For regression the output is one linear unit and the loss mean squared or
 * mean absolute error (AI-Studio's choice). Targets are standardised with the
 * training values' mean and spread, which are saved with the model and
 * undone on every prediction.
 *
 * TensorFlow.js is only used to train. The saved state is plain arrays
 * (weights, biases, standardisation constants), and predict() runs the
 * network in plain JavaScript -- the same arithmetic the exported C header
 * does -- so running a saved model needs no TensorFlow at all.
 */
import { registerModelKind, type ParamValue, type Predictor, type TrainProgress } from '../models.ts';
import { shuffled } from '../dataset.ts';
import { abortError, fitScaler, scaleRow, seeded, yieldToUi, type Scaler } from './scale.ts';

export type Activation = 'relu' | 'tanh' | 'sigmoid' | 'elu';

export interface DenseLayer {
  inputs: number;
  units: number;
  /** 'softmax' (classification) or 'linear' (regression) only on the last layer */
  activation: Activation | 'softmax' | 'linear';
  /** kernel, row-major [inputs][units]: w[i * units + o] */
  w: number[];
  b: number[];
}

export interface MlpState {
  version: 1;
  /** 'regress': one linear output, un-standardised with `target`; absent = classify */
  task?: 'regress';
  inputs: number;
  /** 0 for regression */
  classes: number;
  scaler: Scaler;
  layers: DenseLayer[];
  /** regression: value = output * std + mean */
  target?: { mean: number; std: number };
}

export function activate(a: DenseLayer['activation'], v: number): number {
  switch (a) {
    case 'relu': return v > 0 ? v : 0;
    case 'tanh': return Math.tanh(v);
    case 'sigmoid': return 1 / (1 + Math.exp(-v));
    case 'elu': return v > 0 ? v : Math.exp(v) - 1;
    default: return v;
  }
}

/** One forward pass; returns class probabilities, or for regression the
 *  standardised output (see predictValue). */
export function forward(state: MlpState, x: number[]): number[] {
  let a = scaleRow(state.scaler, x);
  for (const L of state.layers) {
    const z = L.b.slice();
    for (let i = 0; i < L.inputs; i++) {
      const ai = a[i];
      if (ai === 0) continue;
      const row = i * L.units;
      for (let o = 0; o < L.units; o++) z[o] += ai * L.w[row + o];
    }
    if (L.activation === 'softmax') {
      const m = Math.max(...z);
      let sum = 0;
      for (let o = 0; o < z.length; o++) { z[o] = Math.exp(z[o] - m); sum += z[o]; }
      for (let o = 0; o < z.length; o++) z[o] /= sum;
    } else {
      for (let o = 0; o < z.length; o++) z[o] = activate(L.activation, z[o]);
    }
    a = z;
  }
  return a;
}

/** Regression: the estimated value for one input row. */
export function predictValue(state: MlpState, x: number[]): number {
  const t = state.target ?? { mean: 0, std: 1 };
  return forward(state, x)[0] * t.std + t.mean;
}

function predictorOf(state: MlpState): Predictor {
  return {
    predict: state.task === 'regress'
      ? (x) => x.map((row) => [predictValue(state, row)])
      : (x) => x.map((row) => forward(state, row)),
    save: () => state,
    importance: () => null,
  };
}

function checkState(s: unknown): MlpState {
  const st = s as MlpState;
  if (!st || st.version !== 1 || !Array.isArray(st.layers) || !st.scaler) {
    throw new Error('This saved neural network is damaged or from a newer version of BME Studio.');
  }
  return st;
}

registerModelKind({
  id: 'mlp',
  name: 'Neural network (AI-Studio style)',
  description:
    'A small neural network, the same kind BME AI-Studio trains (two layers of ten units by default). Good with plenty of data; ' +
    'on a few specimens it can overfit. It can be exported as C code for the ESP32 board, and can also estimate amounts.',
  params: [
    { key: 'hiddenLayers', label: 'Hidden layers', type: 'number', default: 2, min: 1, max: 4, step: 1,
      help: 'How many layers of units sit between input and answer. AI-Studio uses 2.' },
    { key: 'units', label: 'Units per layer', type: 'number', default: 10, min: 2, max: 128, step: 1,
      help: 'The size of each layer. More units can learn more, but also memorise more. AI-Studio uses 10.' },
    { key: 'epochs', label: 'Training passes (epochs)', type: 'number', default: 256, min: 1, max: 5000, step: 1,
      help: 'How many times the network sees all the training data. AI-Studio uses 256.' },
    { key: 'activation', label: 'Activation', type: 'select', default: 'relu',
      options: [{ value: 'relu', label: 'ReLU (AI-Studio default)' }, { value: 'tanh', label: 'tanh' }, { value: 'sigmoid', label: 'sigmoid' }, { value: 'elu', label: 'ELU' }],
      help: 'The bend each unit applies to its sum. ReLU is the usual choice.' },
    { key: 'batchSize', label: 'Batch size', type: 'number', default: 32, min: 1, max: 1024, step: 1,
      help: 'How many samples it looks at before each small adjustment. AI-Studio uses 32.' },
    { key: 'learningRate', label: 'Learning rate', type: 'number', default: 0.001, min: 0.00001, max: 1, step: 0.0001,
      help: 'How big each adjustment is. Too high and training jumps around; too low and it learns slowly.' },
    { key: 'loss', label: 'What to minimise', type: 'select', default: 'mse', task: 'regress',
      options: [{ value: 'mse', label: 'Squared error (usual)' }, { value: 'mae', label: 'Absolute error (AI-Studio)' }],
      help: 'Squared error punishes big misses hard; absolute error treats every mg of error the same and minds odd specimens less.' },
    { key: 'earlyStopping', label: 'Stop early when it stops improving', type: 'boolean', default: false,
      help: 'Holds back 15% of the training data and stops when the network no longer gets better on it, keeping the best version. Off in AI-Studio.' },
    { key: 'patience', label: 'Patience (epochs)', type: 'number', default: 20, min: 1, max: 500, step: 1,
      help: 'With early stopping: how many passes without improvement before it stops.' },
  ],

  async train(x, y, nClasses, params, progress, signal) {
    const p = (k: string, d: ParamValue) => (params[k] ?? d);
    const hidden = Math.max(1, Math.round(Number(p('hiddenLayers', 2))));
    const units = Math.max(1, Math.round(Number(p('units', 10))));
    const epochs = Math.max(1, Math.round(Number(p('epochs', 256))));
    const batchSize = Math.max(1, Math.round(Number(p('batchSize', 32))));
    const lr = Number(p('learningRate', 0.001));
    const activation = String(p('activation', 'relu')) as Activation;
    const early = Boolean(p('earlyStopping', false));
    const patience = Math.max(1, Math.round(Number(p('patience', 20))));
    const regress = nClasses === 0;
    const loss = String(p('loss', 'mse')) === 'mae' ? 'meanAbsoluteError' : 'meanSquaredError';
    if (x.length === 0) throw new Error('There is nothing to train on.');
    if (signal.aborted) throw abortError();

    const tf = await import('@tensorflow/tfjs');
    // A network this small trains faster on the CPU backend than on the GPU,
    // and gives the same numbers on every computer.
    if (tf.getBackend() !== 'cpu') await tf.setBackend('cpu');
    await tf.ready();

    const scaler = fitScaler(x);
    const xs = x.map((r) => scaleRow(scaler, r));
    // Regression targets, standardised like the inputs.
    const target = regress ? fitScaler(y.map((v) => [v])) : null;
    const ys = target ? y.map((v) => (v - target.mean[0]) / target.std[0]) : [];
    // Hold back a random validation slice when stopping early.
    let trainIdx = xs.map((_, i) => i);
    let valIdx: number[] = [];
    if (early && xs.length >= 20) {
      const r = seeded(7);
      const order = shuffled(trainIdx, r);
      const nVal = Math.max(1, Math.round(xs.length * 0.15));
      valIdx = order.slice(0, nVal);
      trainIdx = order.slice(nVal);
    }
    const inputs = x[0].length;

    const model = tf.sequential();
    let seed = 42;
    for (let i = 0; i < hidden; i++) {
      model.add(tf.layers.dense({
        units, activation, ...(i === 0 ? { inputShape: [inputs] } : {}),
        kernelInitializer: tf.initializers.glorotUniform({ seed: seed++ }),
      }));
    }
    model.add(tf.layers.dense({
      units: regress ? 1 : nClasses, activation: regress ? 'linear' : 'softmax',
      kernelInitializer: tf.initializers.glorotUniform({ seed: seed++ }),
    }));
    const optimizer = tf.train.adam(lr);
    model.compile({ optimizer, loss: regress ? loss : 'categoricalCrossentropy' });

    const toTensors = (idx: number[]) => tf.tidy(() => [
      tf.tensor2d(idx.map((i) => xs[i]), [idx.length, inputs]),
      regress
        ? tf.tensor2d(idx.map((i) => [ys[i]]), [idx.length, 1])
        : tf.oneHot(tf.tensor1d(idx.map((i) => y[i]), 'int32'), nClasses),
    ] as const);
    const [trX, trY] = toTensors(trainIdx);
    const val = valIdx.length ? toTensors(valIdx) : null;

    const snapshot = () => model.getWeights().map((w) => Array.from(w.dataSync()));
    let best = Infinity;
    let bestWeights: number[][] | null = null;
    let sinceBest = 0;
    let aborted = false;
    let lastYield = performance.now();

    try {
      await model.fit(trX, trY, {
        epochs,
        batchSize,
        shuffle: true,
        verbose: 0,
        // We yield ourselves (below): TF's own yielding waits for animation
        // frames, which stop in a background tab.
        yieldEvery: 'never',
        ...(val ? { validationData: [val[0], val[1]] as [typeof trX, typeof trY] } : {}),
        callbacks: {
          onBatchEnd: async () => {
            if (signal.aborted) {
              aborted = true;
              model.stopTraining = true;
            }
            if (performance.now() - lastYield > 30) {
              await yieldToUi();
              lastYield = performance.now();
            }
          },
          onEpochEnd: async (epoch, logs) => {
            const loss = Number(logs?.loss);
            const valLoss = logs?.val_loss !== undefined ? Number(logs.val_loss) : undefined;
            const pr: TrainProgress = {
              fraction: (epoch + 1) / epochs,
              message: `Pass ${epoch + 1} of ${epochs}`,
              loss,
              ...(valLoss !== undefined ? { valLoss } : {}),
            };
            if (valLoss !== undefined) {
              if (valLoss < best - 1e-5) {
                best = valLoss;
                bestWeights = snapshot();
                sinceBest = 0;
              } else if (++sinceBest >= patience) {
                pr.message = `Stopped after ${epoch + 1} passes: no improvement for ${patience} passes.`;
                model.stopTraining = true;
              }
            }
            progress(pr);
            if (signal.aborted) {
              aborted = true;
              model.stopTraining = true;
            }
            await yieldToUi();
            lastYield = performance.now();
          },
        },
      });
      if (aborted || signal.aborted) throw abortError();

      // With early stopping, keep the best version rather than the last.
      const weights: number[][] = bestWeights ?? snapshot();
      const shapes = model.getWeights().map((w) => w.shape);
      const layers: DenseLayer[] = [];
      for (let i = 0; i < weights.length; i += 2) {
        const [nIn, nOut] = shapes[i] as [number, number];
        layers.push({
          inputs: nIn,
          units: nOut,
          activation: i + 2 >= weights.length ? (regress ? 'linear' : 'softmax') : activation,
          w: weights[i],
          b: weights[i + 1],
        });
      }
      return predictorOf({
        version: 1, ...(regress ? { task: 'regress' as const } : {}),
        inputs, classes: nClasses, scaler, layers,
        ...(target ? { target: { mean: target.mean[0], std: target.std[0] } } : {}),
      });
    } finally {
      tf.dispose([trX, trY, ...(val ? [val[0], val[1]] : [])]);
      model.dispose();
      optimizer.dispose();
    }
  },

  async load(state) {
    return predictorOf(checkState(state));
  },
});
