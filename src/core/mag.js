// Magnetometer hard- and soft-iron calibration by ellipsoid fitting
// (docs/methods.md section 4). Samples of a constant field taken in many
// orientations lie on an ellipsoid
//
//   (m - c)^T A (m - c) = 1
//
// c is the hard-iron offset. The soft-iron correction W = R sqrtm(A) maps the
// ellipsoid onto a sphere of radius R (R = geometric mean of the semi-axes,
// so the corrected field keeps the measured magnitude):
//
//   m_cal = W (m_raw - c)
//
// The quadric is fitted with the least-squares ellipsoid-specific method of
// Li and Griffiths (2004), constraint 4J - I^2 = 1, solved as a generalised
// eigenproblem.

import {
  cholesky,
  inverse,
  matMul,
  matVec,
  norm,
  SingularMatrixError,
  sqrtmSym,
  symEigen,
  transpose,
} from "./linalg.js";
import { CalibrationError } from "./accel.js";

/** @typedef {import("./csv.js").Dataset} Dataset */
/** @typedef {import("./csv.js").Series3} Series3 */

/**
 * @typedef {object} Ellipsoid
 * @property {number[]} center
 * @property {number[][]} A shape matrix, (m-c)^T A (m-c) = 1
 * @property {number[]} radii semi-axes, ascending
 * @property {number[]} coefficients [a b c f g h p q r d] of the fitted quadric
 *   a x^2 + b y^2 + c z^2 + 2f yz + 2g xz + 2h xy + 2p x + 2q y + 2r z + d = 0,
 *   in the normalised coordinates used for the fit
 */

/**
 * Li-Griffiths ellipsoid-specific least-squares fit.
 *
 * With D the n x 10 design matrix, S = D^T D is partitioned into S11 (6x6),
 * S12 (6x4) and S22 (4x4). Eliminating the linear part gives
 * (S11 - S12 S22^-1 S21) v1 = lambda C1 v1, v2 = -S22^-1 S21 v1, where C1 is the
 * constraint matrix for k = 4. The solution is the eigenvector of the one
 * positive eigenvalue. It is computed as a symmetric problem through the
 * Cholesky factor of the reduced scatter matrix. Points are centred and scaled
 * to unit RMS radius before the fit and the result mapped back.
 * @param {ArrayLike<number>[]} pts three coordinate arrays
 * @returns {Ellipsoid}
 */
export function fitEllipsoid(pts) {
  const [X, Y, Z] = pts;
  const n = X.length;
  if (n < 10) throw new CalibrationError("an ellipsoid fit needs at least 10 samples");
  const mean = [X, Y, Z].map((c) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += c[i];
    return s / n;
  });
  let ss = 0;
  for (let i = 0; i < n; i++)
    ss += (X[i] - mean[0]) ** 2 + (Y[i] - mean[1]) ** 2 + (Z[i] - mean[2]) ** 2;
  const scale = Math.sqrt(ss / n);
  if (!(scale > 0)) throw new CalibrationError("all samples are identical");

  const S = Array.from({ length: 10 }, () => new Array(10).fill(0));
  const row = new Array(10);
  for (let i = 0; i < n; i++) {
    const x = (X[i] - mean[0]) / scale;
    const y = (Y[i] - mean[1]) / scale;
    const z = (Z[i] - mean[2]) / scale;
    row[0] = x * x;
    row[1] = y * y;
    row[2] = z * z;
    row[3] = 2 * y * z;
    row[4] = 2 * x * z;
    row[5] = 2 * x * y;
    row[6] = 2 * x;
    row[7] = 2 * y;
    row[8] = 2 * z;
    row[9] = 1;
    for (let a = 0; a < 10; a++) for (let b = a; b < 10; b++) S[a][b] += row[a] * row[b];
  }
  for (let a = 0; a < 10; a++) for (let b = 0; b < a; b++) S[a][b] = S[b][a];
  const S11 = S.slice(0, 6).map((r) => r.slice(0, 6));
  const S12 = S.slice(0, 6).map((r) => r.slice(6));
  const S22 = S.slice(6).map((r) => r.slice(6));
  /** @type {number[][]} */
  let S22inv;
  try {
    S22inv = inverse(S22);
  } catch (e) {
    if (e instanceof SingularMatrixError)
      throw new CalibrationError("the samples are degenerate (all in one plane or a line)");
    throw e;
  }
  const T = matMul(S22inv, transpose(S12)); // 4x6, v2 = -T v1
  const Mred = S11.map((r, i) =>
    r.map((v, j) => v - S12[i].reduce((s, x, k) => s + x * T[k][j], 0)),
  );
  // Exact data make Mred singular (its null vector is the answer); a tiny
  // ridge keeps the Cholesky factor defined and does not move the solution.
  const tr = Mred.reduce((s, r, i) => s + r[i], 0);
  for (let i = 0; i < 6; i++) Mred[i][i] += 1e-12 * tr + 1e-300;
  const C1 = [
    [-1, 1, 1, 0, 0, 0],
    [1, -1, 1, 0, 0, 0],
    [1, 1, -1, 0, 0, 0],
    [0, 0, 0, -4, 0, 0],
    [0, 0, 0, 0, -4, 0],
    [0, 0, 0, 0, 0, -4],
  ];
  /** @type {number[][]} */
  let L;
  try {
    L = cholesky(Mred);
  } catch {
    throw new CalibrationError("the ellipsoid fit is numerically degenerate");
  }
  const Li = inverse(L);
  const K = matMul(matMul(Li, C1), transpose(Li));
  const sym = K.map((r, i) => r.map((v, j) => (v + K[j][i]) / 2));
  const { values, vectors } = symEigen(sym);
  const top = values.length - 1;
  if (!(values[top] > 0)) throw new CalibrationError("no ellipsoid solution");
  const w = vectors.map((r) => r[top]);
  const v1 = matVec(transpose(Li), w);
  const v2 = matVec(T, v1).map((v) => -v);
  const [a, b, c, f, g, h] = v1;
  const [p, q, r, d] = v2;
  const A = [
    [a, h, g],
    [h, b, f],
    [g, f, c],
  ];
  /** @type {number[]} */
  let c0;
  try {
    c0 = matVec(inverse(A), [p, q, r]).map((v) => -v);
  } catch {
    throw new CalibrationError("the fitted quadric has no centre");
  }
  const k =
    c0.reduce((s, ci, i) => s + ci * (A[i][0] * c0[0] + A[i][1] * c0[1] + A[i][2] * c0[2]), 0) - d;
  const An = A.map((rw) => rw.map((v) => v / k / (scale * scale)));
  const ev = symEigen(An).values;
  if (!ev.every((x) => x > 0)) throw new CalibrationError("the fitted surface is not an ellipsoid");
  return {
    center: c0.map((v, i) => v * scale + mean[i]),
    A: An,
    radii: ev.map((x) => 1 / Math.sqrt(x)).sort((x, y) => x - y),
    coefficients: [...v1, ...v2],
  };
}

/**
 * @typedef {object} MagOptions
 * @property {number | null} dipDeg magnetic inclination for the heading
 *   estimate; null estimates it from the accelerometer, or uses 45 deg
 * @property {number} maxPlotSamples
 */

/**
 * @typedef {object} MagResult
 * @property {number[]} hardIron offset c in the data units
 * @property {number[][]} softIron W
 * @property {number} fieldStrength R
 * @property {number[]} radii fitted semi-axes, ascending
 * @property {{before: number, after: number}} sphericity min/max semi-axis ratio of a fit to the raw and to the corrected samples
 * @property {{before: {mean: number, std: number, cv: number}, after: {mean: number, std: number, cv: number}}} magnitude |m| statistics
 * @property {number} coverage 3 x smallest eigenvalue of the direction covariance (1 = whole sphere)
 * @property {{dipDeg: number, dipSource: "accelerometer" | "option" | "default", beforeDeg: number, afterDeg: number}} heading
 * @property {{before: number[], after: number[]}} radialResiduals |m| - mean, data units
 * @property {{raw: number[][], cal: number[][]}} plot subsampled points
 * @property {string[]} warnings
 */

/**
 * @param {number[]} v
 * @returns {{mean: number, std: number, cv: number}}
 */
function spread(v) {
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const std = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, v.length - 1));
  return { mean, std, cv: std / mean };
}

/**
 * @param {number} x
 * @returns {number}
 */
const wrapDeg = (x) => ((((x + 180) % 360) + 360) % 360) - 180;

/**
 * Heading error a level compass would see with the fitted distortion left
 * uncorrected: rotate a field of strength R and inclination I through 360
 * deg of heading, distort it with the inverse calibration and compare the
 * heading atan2(-y, x) with the truth. Returns the largest error, deg.
 * @param {number[]} c hard iron
 * @param {number[][]} W soft iron
 * @param {number} R
 * @param {number} dipDeg
 * @returns {number}
 */
export function headingErrorUncorrected(c, W, R, dipDeg) {
  const Winv = inverse(W);
  const I = (dipDeg * Math.PI) / 180;
  const bh = R * Math.cos(I);
  const bv = R * Math.sin(I);
  let worst = 0;
  for (let deg = 0; deg < 360; deg++) {
    const psi = (deg * Math.PI) / 180;
    const m = [bh * Math.cos(psi), -bh * Math.sin(psi), bv];
    const raw = matVec(Winv, m).map((v, i) => v + c[i]);
    const est = (Math.atan2(-raw[1], raw[0]) * 180) / Math.PI;
    worst = Math.max(worst, Math.abs(wrapDeg(est - deg)));
  }
  return worst;
}

/**
 * Calibrate a magnetometer log.
 * @param {Dataset} data
 * @param {Partial<MagOptions>} [options]
 * @returns {MagResult}
 */
export function calibrateMag(data, options = {}) {
  const mag = data.mag;
  if (!mag) throw new CalibrationError("the data has no magnetometer columns");
  const n = mag[0].length;
  const fit = fitEllipsoid(mag);
  const c = fit.center;
  const R = Math.cbrt(fit.radii[0] * fit.radii[1] * fit.radii[2]);
  const W = sqrtmSym(fit.A).map((r) => r.map((v) => v * R));
  /** @type {string[]} */
  const warnings = [];

  const cal = /** @type {Series3} */ ([0, 1, 2].map(() => new Float64Array(n)));
  /** @type {number[]} */
  const before = [];
  /** @type {number[]} */
  const after = [];
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < n; i++) {
    const raw = [mag[0][i], mag[1][i], mag[2][i]];
    const u = [raw[0] - c[0], raw[1] - c[1], raw[2] - c[2]];
    const m = matVec(W, u);
    for (let a = 0; a < 3; a++) cal[a][i] = m[a];
    before.push(norm(raw));
    after.push(norm(m));
    const un = norm(m) || 1;
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < 3; b++) cov[a][b] += (m[a] * m[b]) / (un * un * n);
  }
  const coverage = 3 * symEigen(cov).values[0];
  if (coverage < 0.3)
    warnings.push(
      "the samples cover only part of the sphere of orientations; rotate the sensor through all directions (a slow figure-eight in every axis)",
    );
  const refit = fitEllipsoid(cal);
  const sb = spread(before);
  const sa = spread(after);

  /** @type {"accelerometer" | "option" | "default"} */
  let dipSource = "default";
  let dipDeg = 45;
  if (options.dipDeg !== undefined && options.dipDeg !== null) {
    dipDeg = options.dipDeg;
    dipSource = "option";
  } else if (data.acc) {
    // Static accelerometer points up; the field points down by the dip
    // angle in the northern hemisphere: angle(a, m) = 90 deg + dip.
    /** @type {number[]} */
    const dips = [];
    const step = Math.max(1, Math.floor(n / 5000));
    for (let i = 0; i < n; i += step) {
      const a = [data.acc[0][i], data.acc[1][i], data.acc[2][i]];
      const m = [cal[0][i], cal[1][i], cal[2][i]];
      const cosang = (a[0] * m[0] + a[1] * m[1] + a[2] * m[2]) / (norm(a) * norm(m) || 1);
      dips.push((Math.acos(Math.max(-1, Math.min(1, cosang))) * 180) / Math.PI - 90);
    }
    dips.sort((x, y) => x - y);
    dipDeg = Math.abs(dips[Math.floor(dips.length / 2)]);
    dipSource = "accelerometer";
  }
  const bh = R * Math.cos((dipDeg * Math.PI) / 180);
  const residualRms = Math.sqrt(after.reduce((s, x) => s + (x - R) ** 2, 0) / n);
  const step = Math.max(1, Math.ceil(n / (options.maxPlotSamples ?? 3000)));
  /** @type {number[][]} */
  const rawPts = [];
  /** @type {number[][]} */
  const calPts = [];
  for (let i = 0; i < n; i += step) {
    rawPts.push([mag[0][i], mag[1][i], mag[2][i]]);
    calPts.push([cal[0][i], cal[1][i], cal[2][i]]);
  }
  if (Math.abs(1 - fit.radii[0] / fit.radii[2]) > 0.5)
    warnings.push(
      "strong soft-iron distortion (axis ratio below 0.5): the Li-Griffiths constraint is only guaranteed for ratios above 0.5",
    );
  return {
    hardIron: c,
    softIron: W,
    fieldStrength: R,
    radii: fit.radii,
    sphericity: {
      before: fit.radii[0] / fit.radii[2],
      after: refit.radii[0] / refit.radii[2],
    },
    magnitude: { before: sb, after: sa },
    coverage,
    heading: {
      dipDeg,
      dipSource,
      beforeDeg: headingErrorUncorrected(c, W, R, dipDeg),
      afterDeg: bh > 0 ? (Math.atan(residualRms / bh) * 180) / Math.PI : 90,
    },
    radialResiduals: {
      before: before.filter((_, i) => i % step === 0).map((x) => x - sb.mean),
      after: after.filter((_, i) => i % step === 0).map((x) => x - R),
    },
    plot: { raw: rawPts, cal: calPts },
    warnings,
  };
}
