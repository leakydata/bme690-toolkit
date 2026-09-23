/**
 * Exporting a trained neural network ('mlp') as a single C header for the
 * ESP32-S3 firmware: standardisation constants, weights, and a small
 * inference function in plain C (only <math.h>), no ML library needed.
 */
import type { HeaterProfile, ModelRecord } from '../core/types.ts';
import type { MlpState } from './models/mlp.ts';

export interface CExportOptions {
  /** the heater profile the model was trained on, to document its steps */
  heaterProfile?: HeaterProfile;
  /** prefix for every symbol; default "bme_model" */
  prefix?: string;
}

const f32 = (v: number): string => {
  if (!Number.isFinite(v)) return '0.0f';
  const s = Math.fround(v).toPrecision(9);
  return /[.e]/.test(s) ? `${s}f` : `${s}.0f`;
};

function floats(values: number[], perLine = 8, indent = '    '): string {
  const lines: string[] = [];
  for (let i = 0; i < values.length; i += perLine) lines.push(indent + values.slice(i, i + perLine).map(f32).join(', '));
  return lines.join(',\n');
}

const cString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[^\x20-\x7e]/g, '?')}"`;
const comment = (s: string) => s.replace(/\*\//g, '* /').replace(/[^\x20-\x7e]/g, '?');

/** C code turning one cycle into this model's inputs, for the built-in feature sets. */
function featureCode(model: ModelRecord, P: string, U: string): string {
  const spec = model.dataset;
  const env = spec.environment;
  const perSensor = model.featureNames.length / (spec.mode === 'fused' ? Math.max(1, model.featureNames.filter((n) => /step 1$/.test(n)).length) : 1);
  const envLines = env ? `    x[k++] = temp;\n    x[k++] = hum;\n    x[k++] = press;\n` : `    (void)temp; (void)hum; (void)press;\n`;
  let body: string;
  switch (spec.featureSet) {
    case 'aistudio':
      body = `    for (int i = 0; i < 10; i++) x[k++] = gas[i];\n`;
      break;
    case 'log':
      body = `    for (int i = 0; i < 10; i++) x[k++] = log10f(gas[i] > 1.0f ? gas[i] : 1.0f);\n`;
      break;
    case 'shape':
      body =
        `    float l[10], mean = 0.0f;\n` +
        `    for (int i = 0; i < 10; i++) { l[i] = log10f(gas[i] > 1.0f ? gas[i] : 1.0f); mean += l[i]; }\n` +
        `    mean /= 10.0f;\n` +
        `    for (int i = 0; i < 10; i++) x[k++] = l[i] - mean;\n` +
        `    x[k++] = mean;\n`;
      break;
    default:
      return `/* Feature set "${comment(spec.featureSet)}" has no C version here: compute the inputs listed at the top yourself. */\n`;
  }
  const fusedNote = spec.mode === 'fused'
    ? ` * This model is FUSED: call it once per sensor, in ascending sensor order,\n * writing sensor number s at x + s_position * ${U}_INPUTS_PER_SENSOR.\n`
    : '';
  return `#define ${U}_INPUTS_PER_SENSOR ${perSensor}

/*
 * Turn one heater cycle into model inputs (${U}_INPUTS_PER_SENSOR values).
 *   gas[10] -- gas resistance in ohm at heater steps 1..10 of one cycle
 *   temp, hum, press -- degC, %RH, hPa at the cycle's first point
${fusedNote} */
static inline void ${P}_features(const float gas[10], float temp, float hum, float press, float *x)
{
    int k = 0;
${body}${envLines}}
`;
}

/** Build the header. Throws for model kinds other than 'mlp'. */
export function mlpToCHeader(model: ModelRecord, o: CExportOptions = {}): string {
  if (model.kind !== 'mlp') throw new Error('Only neural-network models can be exported as C code.');
  const s = model.state as MlpState;
  const P = (o.prefix ?? 'bme_model').replace(/[^A-Za-z0-9_]/g, '_');
  const U = P.toUpperCase();
  const nIn = s.inputs;
  const nOut = s.classes;
  const maxUnits = Math.max(nIn, ...s.layers.map((l) => l.units));
  const hp = o.heaterProfile;
  const spec = model.dataset;
  const metrics = model.metrics as { honestAccuracy?: number | null; randomAccuracy?: number | null };
  const pctOf = (v: number | null | undefined) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : 'n/a');

  const out: string[] = [];
  out.push(`/*
 * ${comment(model.name)} -- neural network exported from BME Studio
 * Created ${new Date(model.created).toISOString()}
 *
 * Tells apart: ${comment(model.labels.join(', '))}
 * Tested accuracy: ${pctOf(metrics.honestAccuracy)} on specimens it never saw, ${pctOf(metrics.randomAccuracy)} on random cycles.
 * Heater profile: ${comment(hp?.name ?? spec.heaterProfile)}${hp ? ` (id ${comment(hp.id)}, time base ${hp.timeBase} ms)` : ''}
${hp ? hp.steps.map(([t, d], i) => ` *   step ${i + 1}: ${t} degC for ${d} x ${hp.timeBase} ms`).join('\n') + '\n' : ''} * Samples: ${spec.mode === 'fused' ? 'all sensors at once (fused), ascending sensor number' : 'one sensor, one heater cycle'}
 * Feature set: ${comment(spec.featureSet)}${spec.environment ? ' + temperature, humidity, pressure' : ''}
 *
 * INPUT ORDER (${nIn} floats, x[0] first):
${model.featureNames.map((n, i) => ` *   x[${i}] ${comment(n)}`).join('\n')}
 *
 * Usage:
 *   float x[${U}_N_INPUTS];
 *   ${P}_features(gas, temp, hum, press, x);      // or fill x yourself
 *   float p[${U}_N_CLASSES];
 *   int label = ${P}_predict(x, p);               // p[i]: probability of ${P}_labels[i]
 *
 * Plain C99, needs only <math.h>. Uses ${maxUnits * 2} floats of stack.
 */
#ifndef ${U}_H
#define ${U}_H

#include <math.h>

#define ${U}_N_INPUTS ${nIn}
#define ${U}_N_CLASSES ${nOut}
#define ${U}_N_LAYERS ${s.layers.length}
#define ${U}_MAX_UNITS ${maxUnits}

static const char *const ${P}_labels[${U}_N_CLASSES] = { ${model.labels.map(cString).join(', ')} };

/* Standardisation from the training data: x' = (x - mean) / std */
static const float ${P}_mean[${U}_N_INPUTS] = {
${floats(s.scaler.mean)}
};
static const float ${P}_std[${U}_N_INPUTS] = {
${floats(s.scaler.std)}
};
`);
  s.layers.forEach((l, i) => {
    out.push(`/* Layer ${i + 1}: ${l.inputs} -> ${l.units}, ${l.activation}. Weights row-major [input][unit]. */
static const float ${P}_w${i}[${l.inputs * l.units}] = {
${floats(l.w, l.units > 12 ? 8 : l.units)}
};
static const float ${P}_b${i}[${l.units}] = {
${floats(l.b)}
};
`);
  });
  out.push(featureCode(model, P, U));
  out.push(`
/* in[n_in] -> out[n_out] = act(in . w + b); act 0 = none, 1 = relu, 2 = tanh, 3 = sigmoid, 4 = elu */
static inline void ${P}_dense(const float *in, int n_in, const float *w, const float *b, int n_out, float *out, int act)
{
    for (int o = 0; o < n_out; o++) {
        float z = b[o];
        for (int i = 0; i < n_in; i++) z += in[i] * w[i * n_out + o];
        switch (act) {
        case 1: z = z > 0.0f ? z : 0.0f; break;
        case 2: z = tanhf(z); break;
        case 3: z = 1.0f / (1.0f + expf(-z)); break;
        case 4: z = z > 0.0f ? z : expf(z) - 1.0f; break;
        default: break;
        }
        out[o] = z;
    }
}

/*
 * Run the network on one input vector (order at the top of this file).
 * Writes class probabilities to probs (may be NULL) and returns the index
 * of the most likely label in ${P}_labels. If the highest probability is
 * low (say below 0.8) treat the answer as "not sure".
 */
static inline int ${P}_predict(const float x[${U}_N_INPUTS], float probs[${U}_N_CLASSES])
{
    float a[${U}_MAX_UNITS], z[${U}_MAX_UNITS];
    for (int i = 0; i < ${U}_N_INPUTS; i++) a[i] = (x[i] - ${P}_mean[i]) / ${P}_std[i];
`);
  const actCode: Record<string, number> = { softmax: 0, relu: 1, tanh: 2, sigmoid: 3, elu: 4 };
  s.layers.forEach((l, i) => {
    const [src, dst] = i % 2 === 0 ? ['a', 'z'] : ['z', 'a'];
    out.push(`    ${P}_dense(${src}, ${l.inputs}, ${P}_w${i}, ${P}_b${i}, ${l.units}, ${dst}, ${actCode[l.activation]});\n`);
  });
  const last = s.layers.length % 2 === 1 ? 'z' : 'a';
  out.push(`
    /* softmax */
    float m = ${last}[0], sum = 0.0f;
    int best = 0;
    for (int o = 1; o < ${U}_N_CLASSES; o++) if (${last}[o] > m) { m = ${last}[o]; best = o; }
    for (int o = 0; o < ${U}_N_CLASSES; o++) { ${last}[o] = expf(${last}[o] - m); sum += ${last}[o]; }
    if (probs) for (int o = 0; o < ${U}_N_CLASSES; o++) probs[o] = ${last}[o] / sum;
    return best;
}

#endif /* ${U}_H */
`);
  return out.join('');
}
