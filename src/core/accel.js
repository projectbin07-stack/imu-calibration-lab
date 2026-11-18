// Accelerometer calibration from static poses. Model (docs/methods.md
// section 2):
//
//   a_cal = M (a_raw - b)
//
// with b the bias (g) and M a 3x3 matrix that holds the scale factors and the
// axis misalignment. Three ways to estimate it:
//
//   six     classic six-position test: bias and scale per axis from the +1 g
//           and -1 g pose of each axis (M diagonal, 6 parameters).
//   twelve  linear least squares of [a_raw 1] against the known reference
//           vector of each axis-aligned pose (M full, 12 parameters). The
//           body frame is the frame the poses were aligned to.
//   nine    Levenberg-Marquardt on |M (a_raw - b)| = 1 g over any number of
//           poses in any orientation (M lower triangular, 9 parameters: the
//           rotation of the body frame is not observable from |a| alone, so
//           the calibrated x axis is the sensor's x axis and y lies in the
//           sensor's x-y plane). Needs at least 9 well-spread poses.

import { inverse, matVec, norm, solve, SingularMatrixError, symEigen } from "./linalg.js";
import { levenbergMarquardt } from "./lm.js";
import { DEFAULT_STATIC, detectStatic, segmentStats } from "./static.js";

/** @typedef {import("./csv.js").Dataset} Dataset */
/** @typedef {import("./static.js").Segment} Segment */
/** @typedef {import("./static.js").StaticOptions} StaticOptions */
/** @typedef {"auto" | "six" | "twelve" | "nine"} AccelModel */

export class CalibrationError extends Error {}

const AXES = ["X", "Y", "Z"];

/**
 * @typedef {object} Pose
 * @property {number} t0
 * @property {number} t1
 * @property {number} n samples
 * @property {number[]} mean raw mean, g
 * @property {number[]} std
 * @property {string} label "+Z up", "-X up" or "tilted"
 * @property {number[] | null} ref reference vector in g when axis-aligned
 * @property {number} start sample index
 * @property {number} end sample index (exclusive)
 */

/**
 * Nearest axis label of a static mean. A pose counts as axis-aligned when
 * the measured gravity is within `maxDeg` of a sensor axis. The axis that
 * reads about +1 g is the one pointing up (an accelerometer at rest measures
 * the reaction to gravity).
 * @param {number[]} v
 * @param {number} [maxDeg]
 * @returns {{label: string, ref: number[] | null}}
 */
export function axisLabel(v, maxDeg = 10) {
  const n = norm(v);
  let best = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(v[i]) > Math.abs(v[best])) best = i;
  const cos = Math.abs(v[best]) / (n || 1);
  if (cos < Math.cos((maxDeg * Math.PI) / 180)) return { label: "tilted", ref: null };
  const sign = v[best] >= 0 ? 1 : -1;
  const ref = [0, 0, 0];
  ref[best] = sign;
  return { label: `${sign > 0 ? "+" : "-"}${AXES[best]} up`, ref };
}

/**
 * Turn static segments into poses, merging neighbours whose mean directions
 * differ by less than `mergeDeg` (a pose interrupted by a small bump).
 * @param {Float64Array} t
 * @param {import("./csv.js").Series3} acc
 * @param {Segment[]} segments
 * @param {number} [mergeDeg]
 * @returns {Pose[]}
 */
export function posesFromSegments(t, acc, segments, mergeDeg = 3) {
  /** @type {Array<Segment & {sampleCount: number}>} */
  const merged = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (last) {
      const c =
        (last.mean[0] * s.mean[0] + last.mean[1] * s.mean[1] + last.mean[2] * s.mean[2]) /
        (norm(last.mean) * norm(s.mean));
      if (c > Math.cos((mergeDeg * Math.PI) / 180)) {
        // Merge by recomputing over the union of samples, not the gap.
        const a = segmentStats(t, acc, last.start, last.end);
        const b = segmentStats(t, acc, s.start, s.end);
        const na = last.end - last.start;
        const nb = s.end - s.start;
        merged[merged.length - 1] = {
          ...last,
          end: s.end,
          t1: s.t1,
          mean: a.mean.map((v, i) => (v * na + b.mean[i] * nb) / (na + nb)),
          std: a.std.map((v, i) => Math.sqrt((v * v * na + b.std[i] ** 2 * nb) / (na + nb))),
          // `start..end` now spans the gap too; sampleCount keeps the true count
          sampleCount: na + nb,
        };
        continue;
      }
    }
    merged.push({ ...s, sampleCount: s.end - s.start });
  }
  return merged.map((s) => {
    const { label, ref } = axisLabel(s.mean);
    return {
      t0: s.t0,
      t1: s.t1,
      n: s.sampleCount,
      mean: s.mean,
      std: s.std,
      label,
      ref,
      start: s.start,
      end: s.end,
    };
  });
}

/**
 * @typedef {object} AccelCalibration
 * @property {"six" | "twelve" | "nine"} model
 * @property {number[][]} M
 * @property {number[]} b g
 */

/**
 * Classic six-position bias and scale: for each axis, the average of the
 * +1 g and -1 g readings is the bias and half their difference the scale.
 * @param {Pose[]} poses
 * @returns {AccelCalibration}
 */
export function calibrateSix(poses) {
  const b = [0, 0, 0];
  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    const up = poses.filter((p) => p.ref && p.ref[i] === 1);
    const down = poses.filter((p) => p.ref && p.ref[i] === -1);
    if (up.length === 0 || down.length === 0)
      throw new CalibrationError(
        `six-position calibration needs a +${AXES[i]} up and a -${AXES[i]} up pose`,
      );
    const avg = (/** @type {Pose[]} */ ps) => ps.reduce((s, p) => s + p.mean[i], 0) / ps.length;
    const u = avg(up);
    const d = avg(down);
    b[i] = (u + d) / 2;
    M[i][i] = 2 / (u - d);
  }
  return { model: "six", M, b };
}

/**
 * Twelve-parameter linear least squares over the axis-aligned poses:
 * ref_k = M a_k + c for every pose k, solved row by row, then b = -M^-1 c.
 * @param {Pose[]} poses
 * @returns {AccelCalibration}
 */
export function calibrateTwelve(poses) {
  const used = poses.filter((p) => p.ref);
  if (used.length < 4)
    throw new CalibrationError("twelve-parameter calibration needs at least 4 axis-aligned poses");
  const A = used.map((p) => [...p.mean, 1]);
  const ata = [0, 1, 2, 3].map((i) =>
    [0, 1, 2, 3].map((j) => A.reduce((s, r) => s + r[i] * r[j], 0)),
  );
  /** @type {number[][]} */
  const rows = [];
  try {
    for (let i = 0; i < 3; i++) {
      const atb = [0, 1, 2, 3].map((j) =>
        used.reduce((s, p, k) => s + A[k][j] * /** @type {number[]} */ (p.ref)[i], 0),
      );
      rows.push(solve(ata, atb));
    }
  } catch (e) {
    if (e instanceof SingularMatrixError)
      throw new CalibrationError(
        "the axis-aligned poses do not span three dimensions; add poses on more axes",
      );
    throw e;
  }
  const M = rows.map((r) => r.slice(0, 3));
  const c = rows.map((r) => r[3]);
  const b = matVec(inverse(M), c).map((v) => -v);
  return { model: "twelve", M, b };
}

/**
 * Nine-parameter fit of |M (a - b)| = 1 with M lower triangular.
 * Parameters: [m00, m10, m11, m20, m21, m22, b0, b1, b2].
 * @param {Pose[]} poses
 * @returns {AccelCalibration & {iterations: number, condition: number, converged: boolean}}
 */
export function calibrateNine(poses) {
  if (poses.length < 9)
    throw new CalibrationError(
      `the nine-parameter fit needs at least 9 poses in different orientations (found ${poses.length})`,
    );
  const obs = poses.map((p) => p.mean);
  const meanNorm = obs.reduce((s, v) => s + norm(v), 0) / obs.length;
  const s0 = 1 / meanNorm;
  /** @param {number[]} p */
  const unpack = (p) => ({
    M: [
      [p[0], 0, 0],
      [p[1], p[2], 0],
      [p[3], p[4], p[5]],
    ],
    b: [p[6], p[7], p[8]],
  });
  /** @type {import("./lm.js").ResidualFn} */
  const fn = (p) => {
    const { M, b } = unpack(p);
    /** @type {number[]} */
    const r = [];
    /** @type {number[][]} */
    const J = [];
    for (const a of obs) {
      const u = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      const v = matVec(M, u);
      const n = norm(v) || 1e-12;
      r.push(n - 1);
      // d|v|/dM_ij = v_i u_j / |v|; d|v|/db = -(M^T v) / |v|
      const mtv = [0, 1, 2].map((j) => M[0][j] * v[0] + M[1][j] * v[1] + M[2][j] * v[2]);
      J.push([
        (v[0] * u[0]) / n,
        (v[1] * u[0]) / n,
        (v[1] * u[1]) / n,
        (v[2] * u[0]) / n,
        (v[2] * u[1]) / n,
        (v[2] * u[2]) / n,
        -mtv[0] / n,
        -mtv[1] / n,
        -mtv[2] / n,
      ]);
    }
    return { r, J };
  };
  const res = levenbergMarquardt(fn, [s0, 0, s0, 0, 0, s0, 0, 0, 0]);
  const { M, b } = unpack(res.p);
  const ev = symEigen(res.jtj).values;
  const condition = ev[0] > 0 ? ev[ev.length - 1] / ev[0] : Infinity;
  return {
    model: "nine",
    M,
    b,
    iterations: res.iterations,
    condition,
    converged: res.converged,
  };
}

/**
 * Apply a calibration to one reading.
 * @param {{M: number[][], b: number[]}} cal
 * @param {number[]} a
 * @returns {number[]}
 */
export function applyAccel(cal, a) {
  return matVec(cal.M, [a[0] - cal.b[0], a[1] - cal.b[1], a[2] - cal.b[2]]);
}

/**
 * Scale factor of each sensor axis (raw g per true g) and the
 * non-orthogonality between axis pairs (deg), from D = M^-1: row i of D is
 * the sensitive direction of raw axis i, its length the scale factor.
 * @param {number[][]} M
 * @returns {{scale: number[], nonOrthogonalityDeg: {xy: number, xz: number, yz: number}}}
 */
export function decompose(M) {
  const D = inverse(M);
  const scale = D.map((r) => norm(r));
  /** @param {number} i @param {number} j */
  const ang = (i, j) => {
    const c = (D[i][0] * D[j][0] + D[i][1] * D[j][1] + D[i][2] * D[j][2]) / (scale[i] * scale[j]);
    return 90 - (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  };
  return { scale, nonOrthogonalityDeg: { xy: ang(0, 1), xz: ang(0, 2), yz: ang(1, 2) } };
}

/**
 * @typedef {object} AccelOptions
 * @property {AccelModel} model
 * @property {Partial<StaticOptions>} static
 * @property {number} maxResidualSamples samples kept for the residual histograms
 */

/**
 * @typedef {object} PoseReport
 * @property {number} t0
 * @property {number} t1
 * @property {number} n
 * @property {string} label
 * @property {number[]} mean
 * @property {number[]} std
 * @property {number} normBefore |a_raw|, g
 * @property {number} normAfter |a_cal|, g
 */

/**
 * @typedef {object} AccelResult
 * @property {"six" | "twelve" | "nine"} model
 * @property {number[][]} M
 * @property {number[]} b
 * @property {number[]} scale raw g per true g per axis
 * @property {{xy: number, xz: number, yz: number}} nonOrthogonalityDeg
 * @property {PoseReport[]} poses
 * @property {{rmsBefore: number, rmsAfter: number, maxBefore: number, maxAfter: number}} poseResiduals |a|-1 over the pose means, g
 * @property {{before: number[], after: number[]}} sampleResiduals |a|-1 over static samples, g
 * @property {{threshold: number, window: number, segments: number}} detection
 * @property {Array<{start: number, end: number}>} segments static sample ranges (indexes)
 * @property {{iterations: number, condition: number, converged: boolean} | null} fit
 * @property {string[]} warnings
 */

/**
 * Detect poses in a log and calibrate.
 * @param {Dataset} data
 * @param {Partial<AccelOptions>} [options]
 * @returns {AccelResult}
 */
export function calibrateAccel(data, options = {}) {
  if (!data.acc) throw new CalibrationError("the data has no accelerometer columns");
  const acc = data.acc;
  const model = options.model ?? "auto";
  const det = detectStatic(data.t, acc, data.gyro, { ...DEFAULT_STATIC, ...options.static });
  const poses = posesFromSegments(data.t, acc, det.segments);
  /** @type {string[]} */
  const warnings = [];
  if (poses.length === 0)
    throw new CalibrationError(
      "no static segments found; hold each pose still for a few seconds or raise the threshold",
    );
  const aligned = poses.filter((p) => p.ref);
  const hasSix = [0, 1, 2].every(
    (i) => aligned.some((p) => p.ref?.[i] === 1) && aligned.some((p) => p.ref?.[i] === -1),
  );
  /** @type {"six" | "twelve" | "nine"} */
  let chosen;
  if (model === "auto") chosen = poses.length >= 9 ? "nine" : hasSix ? "twelve" : "nine";
  else chosen = model;
  /** @type {AccelCalibration} */
  let cal;
  /** @type {AccelResult["fit"]} */
  let fit = null;
  if (chosen === "six") cal = calibrateSix(poses);
  else if (chosen === "twelve") cal = calibrateTwelve(poses);
  else {
    const r = calibrateNine(poses);
    cal = r;
    fit = { iterations: r.iterations, condition: r.condition, converged: r.converged };
    if (r.condition > 1e8)
      warnings.push(
        "the poses do not constrain all nine parameters well (ill-conditioned fit); add poses in more orientations",
      );
    if (!r.converged) warnings.push("the nine-parameter fit did not converge");
  }
  if (poses.length < 6) warnings.push(`only ${poses.length} poses found; 6 or more are needed`);

  const normsBefore = poses.map((p) => norm(p.mean));
  const normsAfter = poses.map((p) => norm(applyAccel(cal, p.mean)));
  const stats = (/** @type {number[]} */ v) => ({
    rms: Math.sqrt(v.reduce((s, x) => s + (x - 1) ** 2, 0) / v.length),
    max: v.reduce((m, x) => Math.max(m, Math.abs(x - 1)), 0),
  });
  const sb = stats(normsBefore);
  const sa = stats(normsAfter);

  const maxSamples = options.maxResidualSamples ?? 4000;
  const total = det.segments.reduce((s, g) => s + g.end - g.start, 0);
  const step = Math.max(1, Math.ceil(total / maxSamples));
  /** @type {number[]} */
  const before = [];
  /** @type {number[]} */
  const after = [];
  let k = 0;
  for (const g of det.segments)
    for (let i = g.start; i < g.end; i++, k++) {
      if (k % step) continue;
      const a = [acc[0][i], acc[1][i], acc[2][i]];
      before.push(norm(a) - 1);
      after.push(norm(applyAccel(cal, a)) - 1);
    }

  const { scale, nonOrthogonalityDeg } = decompose(cal.M);
  return {
    model: chosen,
    M: cal.M,
    b: cal.b,
    scale,
    nonOrthogonalityDeg,
    poses: poses.map((p, i) => ({
      t0: p.t0,
      t1: p.t1,
      n: p.n,
      label: p.label,
      mean: p.mean,
      std: p.std,
      normBefore: normsBefore[i],
      normAfter: normsAfter[i],
    })),
    poseResiduals: {
      rmsBefore: sb.rms,
      rmsAfter: sa.rms,
      maxBefore: sb.max,
      maxAfter: sa.max,
    },
    sampleResiduals: { before, after },
    detection: { threshold: det.threshold, window: det.window, segments: det.segments.length },
    segments: det.segments.map((g) => ({ start: g.start, end: g.end })),
    fit,
    warnings,
  };
}
