// Overlapping Allan variance of a rate signal and the read-off of the noise
// terms (docs/methods.md section 5; IEEE Std 952-1997 Annex C, El-Sheimy et
// al. 2008).
//
// With theta_k the integrated signal (cumulative sum times tau0) and
// tau = m tau0:
//
//   AVAR(tau) = 1 / (2 tau^2 (N - 2m)) * sum_{k=1}^{N-2m} (theta_{k+2m} - 2 theta_{k+m} + theta_k)^2
//
// Slopes on the log-log Allan deviation plot: -1/2 white noise (angle or
// velocity random walk, N = sigma(1 s)), 0 bias instability (B = sigma_min /
// sqrt(2 ln 2 / pi)), +1/2 rate random walk (K = sigma(3 s)).

/**
 * @typedef {object} AllanCurve
 * @property {number[]} tau s
 * @property {number[]} adev signal units
 * @property {number[]} clusters m for each tau
 * @property {number[]} relError 1 / sqrt(2 (N/m - 1)), fractional 1-sigma error of adev
 */

/**
 * Log-spaced cluster sizes from 1 to floor((N - 1) / 2).
 * @param {number} n samples
 * @param {number} perDecade
 * @returns {number[]}
 */
export function clusterSizes(n, perDecade = 10) {
  const maxM = Math.floor((n - 1) / 2);
  /** @type {number[]} */
  const out = [];
  if (maxM < 1) return out;
  const decades = Math.log10(maxM);
  const count = Math.max(1, Math.ceil(decades * perDecade));
  for (let i = 0; i <= count; i++) {
    const m = Math.round(10 ** ((decades * i) / count));
    if (m >= 1 && m <= maxM && m !== out[out.length - 1]) out.push(m);
  }
  return out;
}

/**
 * Overlapping Allan deviation of a uniformly sampled signal.
 * @param {ArrayLike<number>} x rate samples
 * @param {number} tau0 sample period, s
 * @param {{perDecade?: number}} [opts]
 * @returns {AllanCurve}
 */
export function allanDeviation(x, tau0, opts = {}) {
  const n = x.length;
  if (n < 3) throw new RangeError("Allan variance needs at least 3 samples");
  // theta_0 = 0, theta_k = tau0 * sum_{i<k} x_i (k = 0..N). The mean is
  // removed first so the cumulative sum stays small; AVAR is unaffected.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  const theta = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) theta[i + 1] = theta[i] + (x[i] - mean) * tau0;
  const N = n + 1;
  /** @type {AllanCurve} */
  const out = { tau: [], adev: [], clusters: [], relError: [] };
  for (const m of clusterSizes(n, opts.perDecade ?? 10)) {
    const terms = N - 2 * m;
    if (terms < 1) break;
    let s = 0;
    for (let k = 0; k < terms; k++) {
      const d = theta[k + 2 * m] - 2 * theta[k + m] + theta[k];
      s += d * d;
    }
    const tau = m * tau0;
    out.tau.push(tau);
    out.adev.push(Math.sqrt(s / (2 * tau * tau * terms)));
    out.clusters.push(m);
    out.relError.push(1 / Math.sqrt(2 * Math.max(n / m - 1, 1)));
  }
  return out;
}

/**
 * Local log-log slope at each point (central difference, one-sided at ends).
 * @param {AllanCurve} c
 * @returns {number[]}
 */
export function slopes(c) {
  const lt = c.tau.map(Math.log);
  const la = c.adev.map(Math.log);
  return lt.map((_, i) => {
    const a = Math.max(0, i - 1);
    const b = Math.min(lt.length - 1, i + 1);
    return b > a ? (la[b] - la[a]) / (lt[b] - lt[a]) : 0;
  });
}

/**
 * @typedef {object} LineFit
 * @property {number} value coefficient (N for -1/2, K for +1/2)
 * @property {number} slope
 * @property {number} tauMin s
 * @property {number} tauMax s
 * @property {number} points
 * @property {number} relError fractional 1-sigma error of the longest-tau point used
 */

/**
 * Fit a line of fixed slope through the longest run of points whose local
 * slope is within `tol` of it. The coefficient is the line's value at
 * tauRef: log sigma = log C + s (log tau - log tauRef), averaged over the run.
 * @param {AllanCurve} c
 * @param {number} slope -0.5 or +0.5
 * @param {number} tauRef 1 for N, 3 for K
 * @param {{tol?: number, from?: number, maxRelError?: number, minPoints?: number}} [opts]
 *   from: first index searched; points less certain than maxRelError are
 *   ignored; minPoints: shortest run accepted
 * @returns {LineFit | null}
 */
export function fitSlope(c, slope, tauRef, opts = {}) {
  const tol = opts.tol ?? 0.08;
  const from = opts.from ?? 0;
  const maxRel = opts.maxRelError ?? MAX_REL_ERROR;
  const s = slopes(c);
  let best = { a: -1, b: -1 };
  let a = -1;
  for (let i = from; i <= s.length; i++) {
    const ok = i < s.length && Math.abs(s[i] - slope) <= tol && c.relError[i] <= maxRel;
    if (ok && a < 0) a = i;
    if (!ok && a >= 0) {
      if (i - a > best.b - best.a) best = { a, b: i };
      a = -1;
    }
  }
  if (best.a < 0 || best.b - best.a < (opts.minPoints ?? 3)) return null;
  let sum = 0;
  for (let i = best.a; i < best.b; i++)
    sum += Math.log(c.adev[i]) - slope * (Math.log(c.tau[i]) - Math.log(tauRef));
  const pts = best.b - best.a;
  // Conservative: the error of the least certain (longest tau) point used.
  const relError = c.relError[best.b - 1];
  return {
    value: Math.exp(sum / pts),
    slope,
    tauMin: c.tau[best.a],
    tauMax: c.tau[best.b - 1],
    points: pts,
    relError,
  };
}

/**
 * Points whose single-point error 1/sqrt(2 (N/m - 1)) exceeds this (fewer
 * than about three independent clusters) are plotted but not used for the
 * read-offs.
 */
export const MAX_REL_ERROR = 0.5;

/**
 * The bias-instability minimum is only searched where at least about six
 * independent clusters remain: one random-walk realisation can dip far
 * below the trend at the longest cluster times.
 */
export const MAX_BI_REL_ERROR = 0.3;

/** sqrt(2 ln 2 / pi): Allan deviation of flicker (bias-instability) noise per unit B. */
export const BI_FACTOR = Math.sqrt((2 * Math.LN2) / Math.PI);

/**
 * @typedef {object} NoiseTerms
 * @property {LineFit | null} whiteNoise N, units * sqrt(s) = units / sqrt(Hz)
 * @property {{value: number, tau: number, adevMin: number, relError: number, atEnd: boolean} | null} biasInstability B, units
 * @property {LineFit | null} rateRandomWalk K, units / sqrt(s)
 */

/**
 * Read the three classic terms off a curve.
 * @param {AllanCurve} c
 * @returns {NoiseTerms}
 */
export function readOff(c) {
  if (c.tau.length === 0) return { whiteNoise: null, biasInstability: null, rateRandomWalk: null };
  let last = 0;
  while (last + 1 < c.tau.length && c.relError[last + 1] <= MAX_BI_REL_ERROR) last++;
  let iMin = 0;
  for (let i = 1; i <= last; i++) if (c.adev[i] < c.adev[iMin]) iMin = i;
  const whiteNoise = fitSlope(c, -0.5, 1);
  const atEnd = iMin === last;
  const biasInstability = {
    value: c.adev[iMin] / BI_FACTOR,
    tau: c.tau[iMin],
    adevMin: c.adev[iMin],
    relError: c.relError[iMin],
    atEnd,
  };
  // The +1/2 region sits at long tau where few clusters remain, so its
  // local slope scatters more: a wider tolerance, at least two points.
  const rateRandomWalk = atEnd ? null : fitSlope(c, 0.5, 3, { from: iMin, tol: 0.2, minPoints: 2 });
  return { whiteNoise, biasInstability, rateRandomWalk };
}

/**
 * @typedef {object} AllanAxis
 * @property {string} axis
 * @property {AllanCurve} curve
 * @property {NoiseTerms} terms
 */

/**
 * @typedef {object} AllanResult
 * @property {"gyro" | "accel"} sensor
 * @property {number} fs Hz
 * @property {number} duration s
 * @property {number} samples
 * @property {AllanAxis[]} axes
 * @property {Record<string, string>} units unit of each term
 * @property {Array<Record<string, number | null>>} converted terms per axis in
 *   the customary units (deg/sqrt(h), deg/h, deg/h/sqrt(h) or ug/sqrt(Hz), ug, ug/sqrt(s))
 * @property {string[]} warnings
 */

/**
 * Allan deviation of each axis of the gyroscope (deg/s) or accelerometer (g)
 * of a dataset, assuming uniform sampling at the median rate.
 * @param {import("./csv.js").Dataset} data
 * @param {{sensor?: "gyro" | "accel", perDecade?: number}} [opts]
 * @returns {AllanResult}
 */
export function allanForDataset(data, opts = {}) {
  const sensor = opts.sensor ?? (data.gyro ? "gyro" : "accel");
  const s = sensor === "gyro" ? data.gyro : data.acc;
  if (!s)
    throw new RangeError(
      `the data has no ${sensor === "gyro" ? "gyroscope" : "accelerometer"} columns`,
    );
  const tau0 = 1 / data.fs;
  /** @type {string[]} */
  const warnings = [...data.warnings.filter((w) => w.includes("gap"))];
  const duration = data.t[data.t.length - 1] - data.t[0];
  if (duration < 600)
    warnings.push(
      `the log is ${duration.toFixed(0)} s long; bias instability needs tens of minutes and rate random walk hours`,
    );
  const axes = s.map((x, i) => {
    const curve = allanDeviation(x, tau0, { perDecade: opts.perDecade });
    return { axis: "XYZ"[i], curve, terms: readOff(curve) };
  });
  const g = sensor === "gyro";
  const converted = axes.map(({ terms }) => ({
    // gyro: deg/s*sqrt(s) -> deg/sqrt(h) (x60); deg/s -> deg/h (x3600);
    // deg/s/sqrt(s) -> deg/h/sqrt(h) (x3600*60). accel: g -> ug (x1e6).
    whiteNoise: terms.whiteNoise ? terms.whiteNoise.value * (g ? 60 : 1e6) : null,
    noiseDensity: terms.whiteNoise ? terms.whiteNoise.value : null,
    biasInstability: terms.biasInstability ? terms.biasInstability.value * (g ? 3600 : 1e6) : null,
    rateRandomWalk: terms.rateRandomWalk ? terms.rateRandomWalk.value * (g ? 216000 : 1e6) : null,
  }));
  return {
    sensor,
    fs: data.fs,
    duration,
    samples: data.t.length,
    axes,
    units: g
      ? {
          whiteNoise: "deg/sqrt(h)",
          noiseDensity: "deg/s/sqrt(Hz)",
          biasInstability: "deg/h",
          rateRandomWalk: "deg/h/sqrt(h)",
        }
      : {
          whiteNoise: "ug/sqrt(Hz)",
          noiseDensity: "g/sqrt(Hz)",
          biasInstability: "ug",
          rateRandomWalk: "ug/sqrt(s)",
        },
    converted,
    warnings,
  };
}
