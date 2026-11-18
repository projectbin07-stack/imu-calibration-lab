// Seeded synthetic IMU logs with known errors, so every calibration method
// can be checked for parameter recovery. Everything here is simulated; no
// sample in this repository comes from a physical sensor.
//
// Frames: the earth frame is x north, y west, z up. R maps body to earth.
// At rest the accelerometer measures the specific force R^T [0 0 1] g; the
// earth field is [Bh 0 -Bv] (dip below the horizon, northern hemisphere).
// Sensor error models (docs/methods.md):
//   accel  raw = D f + b + noise                  (D = M^-1 of the calibration)
//   gyro   raw = diag(s) w + b0 + k (T - 25) + RRW + noise
//   mag    raw = S m + c + noise                  (S soft iron, c hard iron)

import { createRng } from "./rng.js";
import { inverse, matMul, matVec } from "./linalg.js";
import { MPU6050_ACCEL_LSB_PER_G, MPU6050_GYRO_LSB_PER_DPS } from "./units.js";

/** @typedef {import("./csv.js").Dataset} Dataset */
/** @typedef {import("./csv.js").Series3} Series3 */

/**
 * One step of a motion script: hold still, or rotate about a body axis by
 * an angle with a smooth (1 - cos) rate profile that integrates exactly to it.
 * @typedef {{hold: number} | {rotate: number[], deg: number, seconds: number}} MotionStep
 */

/**
 * Rotation matrix for a rotation of `angle` rad about the unit axis k
 * (Rodrigues).
 * @param {number[]} k
 * @param {number} angle
 * @returns {number[][]}
 */
export function axisAngle(k, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const v = 1 - c;
  const [x, y, z] = k;
  return [
    [c + x * x * v, x * y * v - z * s, x * z * v + y * s],
    [y * x * v + z * s, c + y * y * v, y * z * v - x * s],
    [z * x * v - y * s, z * y * v + x * s, c + z * z * v],
  ];
}

/**
 * Re-orthonormalise a rotation matrix (Gram-Schmidt on the rows).
 * @param {number[][]} r
 * @returns {number[][]}
 */
function orthonormalize(r) {
  const a = r[0];
  const na = Math.hypot(...a);
  const x = a.map((v) => v / na);
  const d = r[1].reduce((s, v, i) => s + v * x[i], 0);
  const b = r[1].map((v, i) => v - d * x[i]);
  const nb = Math.hypot(...b);
  const y = b.map((v) => v / nb);
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [x, y, z];
}

/**
 * Run a motion script. Returns body-to-earth rotations and true body rates.
 * @param {MotionStep[]} script
 * @param {number} fs
 * @param {number[][]} [r0] initial attitude
 * @returns {{R: number[][][], w: number[][]}} w in deg/s
 */
export function runScript(script, fs, r0) {
  /** @type {number[][][]} */
  const R = [];
  /** @type {number[][]} */
  const w = [];
  let cur = r0 ?? [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const dt = 1 / fs;
  for (const step of script) {
    if ("hold" in step) {
      const n = Math.round(step.hold * fs);
      for (let i = 0; i < n; i++) {
        R.push(cur);
        w.push([0, 0, 0]);
      }
      continue;
    }
    const n = Math.round(step.seconds * fs);
    const T = n * dt;
    const total = (step.deg * Math.PI) / 180;
    const k = step.rotate;
    const kn = Math.hypot(...k);
    const axis = k.map((v) => v / kn);
    for (let i = 0; i < n; i++) {
      // rate(t) = total (1 - cos(2 pi t / T)) / T; exact angle over each step
      const t0 = i * dt;
      const t1 = t0 + dt;
      const ang = (/** @type {number} */ tt) =>
        (total * (tt - (T / (2 * Math.PI)) * Math.sin((2 * Math.PI * tt) / T))) / T;
      const dTheta = ang(t1) - ang(t0);
      const rate = (total * (1 - Math.cos((2 * Math.PI * t0) / T))) / T;
      R.push(cur);
      w.push(axis.map((v) => (v * rate * 180) / Math.PI));
      // body-frame rotation: R <- R exp(dTheta k)
      cur = orthonormalize(matMul(cur, axisAngle(axis, dTheta)));
    }
  }
  return { R, w };
}

/**
 * @param {number} n
 * @returns {Series3}
 */
const series = (n) => /** @type {Series3} */ ([0, 1, 2].map(() => new Float64Array(n)));

/**
 * @typedef {object} AccelTruth
 * @property {number[][]} M calibration matrix that undoes D
 * @property {number[][]} D sensor matrix (scale and misalignment)
 * @property {number[]} b bias, g
 */

/**
 * @typedef {object} AccelSynthOptions
 * @property {number} seed
 * @property {number} fs Hz
 * @property {number} holdSeconds
 * @property {number[]} scale per-axis scale factor (raw g per true g)
 * @property {number[]} bias g
 * @property {{xy: number, xz: number, yx: number, yz: number, zx: number, zy: number}} misalign
 *   off-diagonal coupling of D, rad
 * @property {number} noiseDensity g/sqrt(Hz)
 * @property {"axis" | "many"} poses six axis-aligned poses, or 15 poses incl. tilted ones
 * @property {number} placementDeg random error of each hand-held pose, deg
 */

/** @type {AccelSynthOptions} */
export const ACCEL_SYNTH_DEFAULT = {
  seed: 1,
  fs: 100,
  holdSeconds: 4,
  scale: [1.012, 0.991, 1.023],
  bias: [0.031, -0.024, 0.052],
  misalign: { xy: 0.006, xz: -0.004, yx: 0.003, yz: 0.008, zx: -0.005, zy: 0.002 },
  // MPU6050 product specification, typical noise power spectral density
  noiseDensity: 400e-6,
  poses: "many",
  placementDeg: 0,
};

/**
 * Sensor matrix D from scale and coupling.
 * @param {AccelSynthOptions} o
 * @returns {number[][]}
 */
export function accelSensorMatrix(o) {
  const m = o.misalign;
  const [sx, sy, sz] = o.scale;
  return [
    [sx, sx * m.xy, sx * m.xz],
    [sy * m.yx, sy, sy * m.yz],
    [sz * m.zx, sz * m.zy, sz],
  ];
}

/**
 * Multi-position accelerometer log (with a gyroscope that sees the turns).
 * @param {Partial<AccelSynthOptions>} [options]
 * @returns {{data: Dataset, truth: AccelTruth}}
 */
export function synthAccel(options = {}) {
  const o = { ...ACCEL_SYNTH_DEFAULT, ...options };
  const rng = createRng(o.seed);
  const h = o.holdSeconds;
  const turn = 1.5;
  /** @type {MotionStep[]} */
  const axisScript = [
    { hold: h },
    { rotate: [1, 0, 0], deg: 90, seconds: turn },
    { hold: h },
    { rotate: [1, 0, 0], deg: 90, seconds: turn },
    { hold: h },
    { rotate: [1, 0, 0], deg: 90, seconds: turn },
    { hold: h },
    { rotate: [1, 0, 0], deg: 90, seconds: turn },
    { rotate: [0, 1, 0], deg: 90, seconds: turn },
    { hold: h },
    { rotate: [0, 1, 0], deg: 180, seconds: 2 * turn },
    { hold: h },
  ];
  /** @type {MotionStep[]} */
  const extra = [
    { rotate: [1, 1, 0], deg: 50, seconds: turn },
    { hold: h },
    { rotate: [0, 1, 1], deg: 70, seconds: turn },
    { hold: h },
    { rotate: [1, 0, 1], deg: 80, seconds: turn },
    { hold: h },
    { rotate: [1, -1, 0], deg: 100, seconds: turn },
    { hold: h },
    { rotate: [0, 1, -1], deg: 60, seconds: turn },
    { hold: h },
    { rotate: [1, 1, 1], deg: 120, seconds: turn },
    { hold: h },
    { rotate: [-1, 0, 1], deg: 75, seconds: turn },
    { hold: h },
    { rotate: [1, 0, 0], deg: 140, seconds: turn },
    { hold: h },
    { rotate: [0, 0, 1], deg: 90, seconds: turn },
    { rotate: [0, 1, 0], deg: 55, seconds: turn },
    { hold: h },
  ];
  const script = o.poses === "axis" ? axisScript : [...axisScript, ...extra];
  // Placement error: each hold is perturbed by a small random tilt.
  const { R, w } = runScript(script, o.fs);
  const n = R.length;
  const D = accelSensorMatrix(o);
  const sigma = o.noiseDensity * Math.sqrt(o.fs);
  const acc = series(n);
  const gyro = series(n);
  /** @type {number[][] | null} */
  let tilt = null;
  let prevStill = false;
  for (let i = 0; i < n; i++) {
    const still = w[i][0] === 0 && w[i][1] === 0 && w[i][2] === 0;
    if (still && !prevStill && o.placementDeg > 0) {
      const k = [rng.gaussian(), rng.gaussian(), rng.gaussian()];
      tilt = axisAngle(
        k.map((v) => v / Math.hypot(...k)),
        (o.placementDeg * Math.PI) / 180,
      );
    }
    if (!still) tilt = null;
    prevStill = still;
    const Rb = tilt ? matMul(R[i], tilt) : R[i];
    // specific force in body frame: R^T [0 0 1], plus hand jitter while moving
    const f = [Rb[2][0], Rb[2][1], Rb[2][2]];
    if (!still) for (let a = 0; a < 3; a++) f[a] += 0.05 * rng.gaussian();
    const raw = matVec(D, f);
    for (let a = 0; a < 3; a++) {
      acc[a][i] = raw[a] + o.bias[a] + sigma * rng.gaussian();
      gyro[a][i] = w[i][a] + 0.005 * Math.sqrt(o.fs) * rng.gaussian();
    }
  }
  return {
    data: makeDataset(n, o.fs, { acc, gyro }),
    truth: { D, M: inverse(D), b: o.bias },
  };
}

/**
 * @param {number} n
 * @param {number} fs
 * @param {{acc?: Series3, gyro?: Series3, mag?: Series3, temp?: Float64Array}} s
 * @returns {Dataset}
 */
function makeDataset(n, fs, s) {
  return {
    t: Float64Array.from({ length: n }, (_, i) => i / fs),
    acc: s.acc ?? null,
    gyro: s.gyro ?? null,
    mag: s.mag ?? null,
    temp: s.temp ?? null,
    fs,
    skipped: 0,
    warnings: [],
  };
}

/**
 * @typedef {object} GyroSynthOptions
 * @property {number} seed
 * @property {number} fs
 * @property {number[]} scale
 * @property {number[]} bias deg/s at 25 degC
 * @property {number[]} tempSlope deg/s per degC
 * @property {number} tempStart degC
 * @property {number} tempEnd degC, approached exponentially (self-heating)
 * @property {number} tempTau s
 * @property {number} noiseDensity deg/s/sqrt(Hz)
 * @property {number} holdSeconds
 * @property {number} turnSeconds duration of each 360 deg rotation
 */

/** @type {GyroSynthOptions} */
export const GYRO_SYNTH_DEFAULT = {
  seed: 2,
  fs: 100,
  scale: [1.021, 0.987, 1.034],
  bias: [-1.8, 0.9, 0.35],
  tempSlope: [0.021, -0.012, 0.03],
  tempStart: 24,
  tempEnd: 34,
  tempTau: 60,
  // MPU6050 product specification, typical rate noise spectral density
  noiseDensity: 0.005,
  holdSeconds: 30,
  turnSeconds: 4,
};

/**
 * Gyroscope log: a long warm-up hold, then a 360 deg turn about each axis
 * with holds in between, with a temperature-dependent bias.
 * @param {Partial<GyroSynthOptions>} [options]
 * @returns {{data: Dataset, truth: GyroSynthOptions}}
 */
export function synthGyro(options = {}) {
  const o = { ...GYRO_SYNTH_DEFAULT, ...options };
  const rng = createRng(o.seed);
  const h = o.holdSeconds;
  /** @type {MotionStep[]} */
  const script = [
    { hold: 4 * h },
    { rotate: [0, 0, 1], deg: 360, seconds: o.turnSeconds },
    { hold: h },
    { rotate: [1, 0, 0], deg: 360, seconds: o.turnSeconds },
    { hold: h },
    { rotate: [0, 1, 0], deg: -360, seconds: o.turnSeconds },
    { hold: h },
  ];
  const { R, w } = runScript(script, o.fs);
  const n = R.length;
  const acc = series(n);
  const gyro = series(n);
  const temp = new Float64Array(n);
  const sigma = o.noiseDensity * Math.sqrt(o.fs);
  for (let i = 0; i < n; i++) {
    const t = i / o.fs;
    const T = o.tempEnd + (o.tempStart - o.tempEnd) * Math.exp(-t / o.tempTau);
    temp[i] = Math.round((T + 0.02 * rng.gaussian()) * 100) / 100;
    for (let a = 0; a < 3; a++) {
      gyro[a][i] =
        o.scale[a] * w[i][a] + o.bias[a] + o.tempSlope[a] * (T - 25) + sigma * rng.gaussian();
      acc[a][i] = R[i][2][a] + 400e-6 * Math.sqrt(o.fs) * rng.gaussian();
    }
  }
  return { data: makeDataset(n, o.fs, { acc, gyro, temp }), truth: o };
}

/**
 * @typedef {object} MagSynthOptions
 * @property {number} seed
 * @property {number} fs
 * @property {number} seconds
 * @property {number} field total field, uT
 * @property {number} dipDeg inclination
 * @property {number[]} hardIron uT
 * @property {number[][]} softIron S, symmetric positive definite here
 * @property {number} noise uT per sample (1 sigma)
 */

/** @type {MagSynthOptions} */
export const MAG_SYNTH_DEFAULT = {
  seed: 3,
  fs: 50,
  seconds: 90,
  field: 42,
  dipDeg: 25,
  hardIron: [18.5, -7.2, 31.0],
  softIron: [
    [1.08, 0.04, -0.03],
    [0.04, 0.93, 0.05],
    [-0.03, 0.05, 1.01],
  ],
  noise: 0.4,
};

/**
 * Magnetometer (and accelerometer) log while the sensor tumbles slowly
 * through all orientations: the body rate is a seeded, smoothed random
 * process of about 70 deg/s.
 * @param {Partial<MagSynthOptions>} [options]
 * @returns {{data: Dataset, truth: MagSynthOptions}}
 */
export function synthMag(options = {}) {
  const o = { ...MAG_SYNTH_DEFAULT, ...options };
  const rng = createRng(o.seed);
  const n = Math.round(o.seconds * o.fs);
  const dt = 1 / o.fs;
  const I = (o.dipDeg * Math.PI) / 180;
  const mEarth = [o.field * Math.cos(I), 0, -o.field * Math.sin(I)];
  const mag = series(n);
  const acc = series(n);
  const gyro = series(n);
  let R = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  let w = [40, -30, 50];
  const alpha = Math.exp(-dt / 2);
  for (let i = 0; i < n; i++) {
    w = w.map((v) => alpha * v + Math.sqrt(1 - alpha * alpha) * 70 * rng.gaussian());
    const mb = [0, 1, 2].map(
      (a) => R[0][a] * mEarth[0] + R[1][a] * mEarth[1] + R[2][a] * mEarth[2],
    );
    const raw = matVec(o.softIron, mb);
    for (let a = 0; a < 3; a++) {
      mag[a][i] = raw[a] + o.hardIron[a] + o.noise * rng.gaussian();
      acc[a][i] = R[2][a] + 0.004 * rng.gaussian();
      gyro[a][i] = w[a] + 0.05 * rng.gaussian();
    }
    const wn = Math.hypot(...w);
    if (wn > 0)
      R = orthonormalize(
        matMul(
          R,
          axisAngle(
            w.map((v) => v / wn),
            (wn * Math.PI * dt) / 180,
          ),
        ),
      );
  }
  return { data: makeDataset(n, o.fs, { acc, gyro, mag }), truth: o };
}

/**
 * @typedef {object} NoiseSynthOptions
 * @property {number} seed
 * @property {number} fs
 * @property {number} seconds
 * @property {number[]} gyroWhite deg/s/sqrt(Hz) per axis
 * @property {number[]} gyroRrw rate random walk K, deg/s/sqrt(s)
 * @property {number[]} gyroGm Gauss-Markov bias std, deg/s
 * @property {number} gmTau Gauss-Markov correlation time, s
 * @property {number} accelWhite g/sqrt(Hz)
 */

/** @type {NoiseSynthOptions} */
export const NOISE_SYNTH_DEFAULT = {
  seed: 4,
  fs: 100,
  seconds: 3600,
  gyroWhite: [0.005, 0.006, 0.0055],
  gyroRrw: [2e-4, 2.5e-4, 1.5e-4],
  gyroGm: [0.0015, 0.001, 0.002],
  gmTau: 60,
  accelWhite: 400e-6,
};

/**
 * Stationary noise log for Allan variance: white noise, a first-order
 * Gauss-Markov bias (a bump near tau = gmTau standing in for bias
 * instability) and a rate random walk, on top of constant biases.
 * @param {Partial<NoiseSynthOptions>} [options]
 * @returns {{data: Dataset, truth: NoiseSynthOptions}}
 */
export function synthNoise(options = {}) {
  const o = { ...NOISE_SYNTH_DEFAULT, ...options };
  const rng = createRng(o.seed);
  const n = Math.round(o.seconds * o.fs);
  const dt = 1 / o.fs;
  const gyro = series(n);
  const acc = series(n);
  const phi = Math.exp(-dt / o.gmTau);
  const gm = [0, 0, 0];
  const rw = [0, 0, 0];
  const base = [0.8, -0.4, 0.2];
  const sigA = o.accelWhite * Math.sqrt(o.fs);
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) {
      gm[a] = phi * gm[a] + o.gyroGm[a] * Math.sqrt(1 - phi * phi) * rng.gaussian();
      rw[a] += o.gyroRrw[a] * Math.sqrt(dt) * rng.gaussian();
      gyro[a][i] = base[a] + gm[a] + rw[a] + o.gyroWhite[a] * Math.sqrt(o.fs) * rng.gaussian();
      acc[a][i] = (a === 2 ? 1 : 0) + sigA * rng.gaussian();
    }
  return { data: makeDataset(n, o.fs, { acc, gyro }), truth: o };
}

/**
 * Write a dataset as CSV with the plain t,ax..mz,temp layout, or as MPU6050
 * raw counts (t in ms, rounded LSB, clipped to int16) for import tests.
 * @param {Dataset} d
 * @param {{raw?: boolean, accelRange?: number, gyroRange?: number, digits?: number}} [opts]
 * @returns {string}
 */
export function datasetToCsv(d, opts = {}) {
  const raw = opts.raw ?? false;
  const aScale = raw ? MPU6050_ACCEL_LSB_PER_G[opts.accelRange ?? 2] : 1;
  const gScale = raw ? MPU6050_GYRO_LSB_PER_DPS[opts.gyroRange ?? 250] : 1;
  const digits = opts.digits ?? 6;
  /** @type {string[]} */
  const head = [raw ? "t_ms" : "t"];
  /** @type {Array<(i: number) => string>} */
  const cols = [(i) => (raw ? String(Math.round(d.t[i] * 1000)) : d.t[i].toFixed(4))];
  /**
   * @param {number} v
   * @param {number} s
   */
  const fmt = (v, s) =>
    raw
      ? String(Math.max(-32768, Math.min(32767, Math.round(v * s))))
      : Number(v.toPrecision(digits)).toString();
  /**
   * @param {Series3 | null} s
   * @param {string[]} names
   * @param {number} scale
   */
  const add = (s, names, scale) => {
    if (!s) return;
    names.forEach((nm, a) => {
      head.push(nm);
      cols.push((i) => fmt(s[a][i], scale));
    });
  };
  add(d.acc, raw ? ["AcX", "AcY", "AcZ"] : ["ax", "ay", "az"], aScale);
  add(d.gyro, raw ? ["GyX", "GyY", "GyZ"] : ["gx", "gy", "gz"], gScale);
  add(d.mag, ["mx", "my", "mz"], 1);
  if (d.temp) {
    const temp = d.temp;
    head.push(raw ? "Tmp" : "temp");
    cols.push((i) => (raw ? String(Math.round((temp[i] - 36.53) * 340)) : temp[i].toFixed(2)));
  }
  const lines = [head.join(",")];
  for (let i = 0; i < d.t.length; i++) lines.push(cols.map((c) => c(i)).join(","));
  return lines.join("\n") + "\n";
}
