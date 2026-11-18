// Gyroscope calibration (docs/methods.md section 3):
//
//   w_cal = (w_raw - b(T)) / s
//
// b: bias from the static segments, optionally a linear function of
// temperature fitted to temperature bins; s: scale factor per axis from a
// rotation through a known angle, s = (integral of (w - b) dt) / angle.

import { CalibrationError } from "./accel.js";
import { DEFAULT_STATIC, detectStatic, pooledStats } from "./static.js";

/** @typedef {import("./csv.js").Dataset} Dataset */
/** @typedef {import("./static.js").Segment} Segment */

/**
 * @typedef {object} TempBin
 * @property {number} temp mean temperature in the bin, degC
 * @property {number} n samples
 * @property {number[]} bias mean rate, deg/s
 */

/**
 * @typedef {object} TempModel
 * @property {number} refTemp degC
 * @property {number[]} bias bias at refTemp, deg/s
 * @property {number[]} slope deg/s per degC
 * @property {TempBin[]} bins
 */

/**
 * @typedef {object} Rotation
 * @property {number} axis 0, 1, 2
 * @property {number} t0
 * @property {number} t1
 * @property {number[]} integrated angle per axis after bias removal, deg
 * @property {number} known deg, signed like the measured rotation
 * @property {number} scale measured / known
 */

/**
 * @typedef {object} GyroOptions
 * @property {Partial<import("./static.js").StaticOptions>} static
 * @property {boolean} wholeFileStatic use every sample for the bias
 * @property {number} knownAngle deg, magnitude of the reference rotations
 * @property {number} tempBin bin width, degC
 * @property {number} minBinSamples
 * @property {{t0: number, t1: number, axis: number} | null} rotation a
 *   manually chosen rotation window; otherwise found automatically
 */

/** @type {GyroOptions} */
export const DEFAULT_GYRO = {
  static: {},
  wholeFileStatic: false,
  knownAngle: 360,
  tempBin: 1,
  minBinSamples: 50,
  rotation: null,
};

/**
 * @typedef {object} GyroResult
 * @property {number[]} bias deg/s
 * @property {number[]} noiseStd deg/s, static samples about the bias (model)
 * @property {number} staticSamples
 * @property {number[]} scale per axis; 1 where no rotation was found
 * @property {Rotation[]} rotations
 * @property {TempModel | null} temperature
 * @property {Array<{start: number, end: number}>} segments
 * @property {string[]} warnings
 */

/**
 * Linear least-squares line y = a + b (x - x0), weighted.
 * @param {number[]} x
 * @param {number[]} y
 * @param {number[]} w
 * @param {number} x0
 * @returns {{a: number, b: number}}
 */
export function weightedLine(x, y, w, x0) {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < x.length; i++) {
    const u = x[i] - x0;
    sw += w[i];
    sx += w[i] * u;
    sy += w[i] * y[i];
    sxx += w[i] * u * u;
    sxy += w[i] * u * y[i];
  }
  const d = sw * sxx - sx * sx;
  if (!(Math.abs(d) > 1e-12 * sw * sw)) return { a: sy / sw, b: 0 };
  const b = (sw * sxy - sx * sy) / d;
  return { a: (sy - b * sx) / sw, b };
}

/**
 * Bias per temperature bin over the static samples and a linear fit.
 * @param {Dataset} data
 * @param {Segment[]} segments
 * @param {GyroOptions} o
 * @returns {TempModel | null}
 */
export function temperatureModel(data, segments, o) {
  const temp = data.temp;
  const gyro = data.gyro;
  if (!temp || !gyro) return null;
  /** @type {Map<number, {n: number, t: number, s: number[]}>} */
  const bins = new Map();
  for (const g of segments)
    for (let i = g.start; i < g.end; i++) {
      const key = Math.floor(temp[i] / o.tempBin);
      let b = bins.get(key);
      if (!b) {
        b = { n: 0, t: 0, s: [0, 0, 0] };
        bins.set(key, b);
      }
      b.n++;
      b.t += temp[i];
      for (let a = 0; a < 3; a++) b.s[a] += gyro[a][i];
    }
  const list = [...bins.entries()]
    .sort((p, q) => p[0] - q[0])
    .map(([, b]) => b)
    .filter((b) => b.n >= o.minBinSamples)
    .map((b) => ({ temp: b.t / b.n, n: b.n, bias: b.s.map((v) => v / b.n) }));
  if (list.length < 2) return null;
  const x = list.map((b) => b.temp);
  const w = list.map((b) => b.n);
  const refTemp = x.reduce((s, v, i) => s + v * w[i], 0) / w.reduce((s, v) => s + v, 0);
  const fits = [0, 1, 2].map((a) =>
    weightedLine(
      x,
      list.map((b) => b.bias[a]),
      w,
      refTemp,
    ),
  );
  return {
    refTemp,
    bias: fits.map((f) => f.a),
    slope: fits.map((f) => f.b),
    bins: list,
  };
}

/**
 * Bias at a temperature from the model.
 * @param {TempModel} m
 * @param {number} temp
 * @returns {number[]}
 */
export function biasAt(m, temp) {
  return m.bias.map((b, a) => b + m.slope[a] * (temp - m.refTemp));
}

/**
 * Integrate (w - bias) over [start, end) with the trapezoid rule.
 * @param {Dataset} data
 * @param {number} start
 * @param {number} end exclusive
 * @param {(i: number) => number[]} bias
 * @returns {number[]} deg
 */
export function integrate(data, start, end, bias) {
  const g = /** @type {import("./csv.js").Series3} */ (data.gyro);
  const out = [0, 0, 0];
  for (let i = start + 1; i < end; i++) {
    const dt = data.t[i] - data.t[i - 1];
    const b0 = bias(i - 1);
    const b1 = bias(i);
    for (let a = 0; a < 3; a++) out[a] += 0.5 * dt * (g[a][i - 1] - b0[a] + g[a][i] - b1[a]);
  }
  return out;
}

/**
 * Calibrate a gyroscope log: bias (and temperature model) from static
 * samples; scale from the motion between static segments. For each axis the
 * rotation used is the moving interval whose integrated angle is largest on
 * that axis, at least 80 % of the total angle (a rotation about that axis
 * alone) and at least 75 % of the known angle. The interval runs from the
 * end of one static segment to the start of the next, so it contains the
 * whole rotation.
 * @param {Dataset} data
 * @param {Partial<GyroOptions>} [options]
 * @returns {GyroResult}
 */
export function calibrateGyro(data, options = {}) {
  const o = { ...DEFAULT_GYRO, ...options };
  const gyro = data.gyro;
  if (!gyro) throw new CalibrationError("the data has no gyroscope columns");
  /** @type {string[]} */
  const warnings = [];
  const n = data.t.length;
  /** @type {Segment[]} */
  let segments;
  if (o.wholeFileStatic)
    segments = [{ start: 0, end: n, t0: 0, t1: data.t[n - 1], mean: [], std: [] }];
  else {
    // Accelerometer and gyroscope variance together when both exist; the
    // gyroscope alone otherwise (it is then treated as the detection series).
    const det = detectStatic(data.t, data.acc ?? gyro, data.acc ? gyro : null, {
      ...DEFAULT_STATIC,
      ...o.static,
      ...(data.acc ? {} : { accelThreshold: null }),
    });
    segments = det.segments;
    if (segments.length === 0) {
      warnings.push("no static segments found: the whole file was used for the bias");
      segments = [{ start: 0, end: n, t0: 0, t1: data.t[n - 1], mean: [], std: [] }];
    }
  }
  const pooled = pooledStats(gyro, segments);
  const temperature = o.tempBin > 0 ? temperatureModel(data, segments, o) : null;
  if (data.temp && !temperature)
    warnings.push("temperature range too small for a temperature model (needs two filled bins)");
  /** @param {number} i */
  const biasFn = (i) =>
    temperature && data.temp ? biasAt(temperature, data.temp[i]) : pooled.mean;

  /** @type {Array<{start: number, end: number, t0: number, t1: number}>} */
  const moving = [];
  if (o.rotation) {
    const r = o.rotation;
    let s = 0;
    while (s < n && data.t[s] < r.t0) s++;
    let e = s;
    while (e < n && data.t[e] <= r.t1) e++;
    if (e - s < 2) throw new CalibrationError("the rotation window holds fewer than two samples");
    moving.push({ start: s, end: e, t0: data.t[s], t1: data.t[e - 1] });
  } else
    for (let k = 0; k + 1 < segments.length; k++) {
      const s = segments[k].end - 1;
      const e = segments[k + 1].start + 1;
      if (e - s >= 2) moving.push({ start: s, end: e, t0: data.t[s], t1: data.t[e - 1] });
    }

  /** @type {Rotation[]} */
  const rotations = [];
  const scale = [1, 1, 1];
  const ints = moving.map((m) => ({ ...m, integrated: integrate(data, m.start, m.end, biasFn) }));
  for (let axis = 0; axis < 3; axis++) {
    if (o.rotation && o.rotation.axis !== axis) continue;
    let best = null;
    for (const m of ints) {
      const total = Math.hypot(...m.integrated);
      const on = Math.abs(m.integrated[axis]);
      if (!o.rotation && (on < 0.8 * total || on < 0.75 * o.knownAngle)) continue;
      if (!best || on > Math.abs(best.integrated[axis])) best = m;
    }
    if (!best) continue;
    const known = Math.sign(best.integrated[axis] || 1) * o.knownAngle;
    const s = best.integrated[axis] / known;
    scale[axis] = s;
    rotations.push({
      axis,
      t0: best.t0,
      t1: best.t1,
      integrated: best.integrated,
      known,
      scale: s,
    });
    if (Math.abs(s - 1) > 0.1)
      warnings.push(
        `axis ${"XYZ"[axis]} scale ${s.toFixed(3)} is more than 10 % from 1: was the rotation ${o.knownAngle} deg?`,
      );
  }
  if (rotations.length === 0)
    warnings.push(`no rotation of about ${o.knownAngle} deg found: scale factors left at 1`);
  // Noise: spread of the static samples about the bias model, so a
  // temperature drift is not counted as noise.
  const ss = [0, 0, 0];
  for (const g of segments)
    for (let i = g.start; i < g.end; i++) {
      const b = biasFn(i);
      for (let a = 0; a < 3; a++) ss[a] += (gyro[a][i] - b[a]) ** 2;
    }
  return {
    bias: pooled.mean,
    noiseStd: ss.map((v) => Math.sqrt(v / Math.max(1, pooled.count - 1))),
    staticSamples: pooled.count,
    scale,
    rotations,
    temperature,
    segments: segments.map((g) => ({ start: g.start, end: g.end })),
    warnings,
  };
}
