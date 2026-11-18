// Static-segment detection: find the stretches of a log where the sensor was
// held still, from the moving variance of the accelerometer (and of the
// gyroscope when there is one). Used to find the poses of a multi-position
// accelerometer log and the rest periods of a gyroscope log.
// Method: docs/methods.md section 1 (after Tedaldi et al. 2014).

/** @typedef {import("./csv.js").Series3} Series3 */

/**
 * @typedef {object} StaticOptions
 * @property {number} windowSeconds length of the centred moving window
 * @property {number} thresholdK multiplier on the noise variance (auto threshold)
 * @property {number | null} accelThreshold fixed threshold on the summed
 *   accelerometer variance, g^2; null for automatic
 * @property {number} minSeconds shortest segment kept
 */

/** @type {StaticOptions} */
export const DEFAULT_STATIC = {
  windowSeconds: 0.5,
  thresholdK: 10,
  accelThreshold: null,
  minSeconds: 1.5,
};

/**
 * @typedef {object} Segment
 * @property {number} start first sample index
 * @property {number} end one past the last sample index
 * @property {number} t0 seconds
 * @property {number} t1 seconds
 * @property {number[]} mean mean of the detection series (accelerometer, g)
 * @property {number[]} std standard deviation of each axis
 */

/**
 * @typedef {object} StaticResult
 * @property {Segment[]} segments
 * @property {number} threshold summed accelerometer variance threshold used, g^2
 * @property {number} gyroThreshold summed gyroscope variance threshold, (deg/s)^2, or 0
 * @property {number} window samples in the moving window
 * @property {Uint8Array} flags 1 where the sample is static
 */

/**
 * Centred moving variance summed over three axes, from prefix sums.
 * @param {Series3} s
 * @param {number} half half window in samples
 * @returns {Float64Array}
 */
export function movingVariance(s, half) {
  const n = s[0].length;
  const out = new Float64Array(n);
  for (const x of s) {
    // Subtract the first value so the prefix sums stay small.
    const x0 = x[0];
    const c1 = new Float64Array(n + 1);
    const c2 = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const v = x[i] - x0;
      c1[i + 1] = c1[i] + v;
      c2[i + 1] = c2[i] + v * v;
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half);
      const b = Math.min(n, i + half + 1);
      const m = b - a;
      const mean = (c1[b] - c1[a]) / m;
      out[i] += Math.max(0, (c2[b] - c2[a]) / m - mean * mean);
    }
  }
  return out;
}

/**
 * q-quantile (0..1) of an array, by sorting a copy.
 * @param {ArrayLike<number>} v
 * @param {number} q
 * @returns {number}
 */
export function quantile(v, q) {
  const s = Float64Array.from(v).sort();
  if (s.length === 0) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Find static segments. The automatic threshold is `thresholdK` times the
 * 20th percentile of the moving variance: in a calibration log the sensor is
 * still for most of the time, so that percentile is a noise-only window,
 * and motion by hand raises the variance by orders of magnitude. A floor of
 * (1e-4 g)^2 keeps quantised noise-free data from getting a zero threshold.
 * @param {Float64Array} t
 * @param {Series3} acc g
 * @param {Series3 | null} gyro deg/s
 * @param {Partial<StaticOptions>} [options]
 * @returns {StaticResult}
 */
export function detectStatic(t, acc, gyro, options = {}) {
  const o = { ...DEFAULT_STATIC, ...options };
  const n = t.length;
  const dt = n > 1 ? (t[n - 1] - t[0]) / (n - 1) : 1;
  const half = Math.max(1, Math.round(o.windowSeconds / dt / 2));
  const va = movingVariance(acc, half);
  const threshold = o.accelThreshold ?? Math.max(o.thresholdK * quantile(va, 0.2), 1e-8);
  let gyroThreshold = 0;
  /** @type {Float64Array | null} */
  let vg = null;
  if (gyro) {
    vg = movingVariance(gyro, half);
    gyroThreshold = Math.max(o.thresholdK * quantile(vg, 0.2), 1e-6);
  }
  const flags = new Uint8Array(n);
  for (let i = 0; i < n; i++)
    flags[i] = va[i] <= threshold && (vg === null || vg[i] <= gyroThreshold) ? 1 : 0;

  const minSamples = Math.max(2, Math.round(o.minSeconds / dt));
  /** @type {Segment[]} */
  const segments = [];
  let i = 0;
  while (i < n) {
    if (!flags[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && flags[j]) j++;
    if (j - i >= minSamples) segments.push(segmentStats(t, acc, i, j));
    else for (let k = i; k < j; k++) flags[k] = 0;
    i = j;
  }
  return { segments, threshold, gyroThreshold, window: 2 * half + 1, flags };
}

/**
 * @param {Float64Array} t
 * @param {Series3} s
 * @param {number} start
 * @param {number} end
 * @returns {Segment}
 */
export function segmentStats(t, s, start, end) {
  const m = end - start;
  const mean = s.map((x) => {
    let a = 0;
    for (let k = start; k < end; k++) a += x[k];
    return a / m;
  });
  const std = s.map((x, ax) => {
    let a = 0;
    for (let k = start; k < end; k++) a += (x[k] - mean[ax]) ** 2;
    return Math.sqrt(a / Math.max(1, m - 1));
  });
  return { start, end, t0: t[start], t1: t[end - 1], mean, std };
}

/**
 * Mean of a series over the segments, and the static samples' count.
 * @param {Series3} s
 * @param {Segment[]} segments
 * @returns {{mean: number[], std: number[], count: number}}
 */
export function pooledStats(s, segments) {
  let count = 0;
  const sum = [0, 0, 0];
  for (const g of segments)
    for (let k = g.start; k < g.end; k++) {
      count++;
      for (let a = 0; a < 3; a++) sum[a] += s[a][k];
    }
  const mean = sum.map((v) => v / Math.max(1, count));
  const ss = [0, 0, 0];
  for (const g of segments)
    for (let k = g.start; k < g.end; k++)
      for (let a = 0; a < 3; a++) ss[a] += (s[a][k] - mean[a]) ** 2;
  return { mean, std: ss.map((v) => Math.sqrt(v / Math.max(1, count - 1))), count };
}
