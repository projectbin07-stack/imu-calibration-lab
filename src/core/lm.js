// Levenberg-Marquardt for small nonlinear least-squares problems
// (Levenberg 1944, Marquardt 1963; damping scaled by the diagonal of J^T J
// as in Marquardt's paper). Used for the accelerometer |a| = 1 g fit.

import { solve, SingularMatrixError } from "./linalg.js";

/**
 * @callback ResidualFn
 * @param {number[]} p parameters
 * @returns {{r: number[], J: number[][]}} residuals and Jacobian (rows x params)
 */

/**
 * @typedef {object} LmResult
 * @property {number[]} p
 * @property {number} cost 0.5 * sum r^2 at p
 * @property {number} iterations
 * @property {boolean} converged
 * @property {number[][]} jtj J^T J at the solution (for conditioning checks)
 */

/**
 * @param {number[][]} J
 * @param {number[]} r
 * @returns {{jtj: number[][], jtr: number[]}}
 */
function normal(J, r) {
  const n = J[0].length;
  const jtj = Array.from({ length: n }, () => new Array(n).fill(0));
  const jtr = new Array(n).fill(0);
  for (let k = 0; k < J.length; k++) {
    const row = J[k];
    for (let i = 0; i < n; i++) {
      jtr[i] += row[i] * r[k];
      for (let j = i; j < n; j++) jtj[i][j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) jtj[i][j] = jtj[j][i];
  return { jtj, jtr };
}

/**
 * @param {number[]} r
 * @returns {number}
 */
const half2 = (r) => 0.5 * r.reduce((s, v) => s + v * v, 0);

/**
 * @param {ResidualFn} fn
 * @param {number[]} p0
 * @param {{maxIterations?: number, tolerance?: number}} [opts]
 * @returns {LmResult}
 */
export function levenbergMarquardt(fn, p0, opts = {}) {
  const maxIterations = opts.maxIterations ?? 200;
  const tol = opts.tolerance ?? 1e-15;
  let p = [...p0];
  let { r, J } = fn(p);
  let cost = half2(r);
  let lambda = 1e-3;
  let converged = false;
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    const { jtj, jtr } = normal(J, r);
    let improved = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const a = jtj.map((row, i) => row.map((v, j) => (i === j ? v + lambda * (v || 1e-12) : v)));
      /** @type {number[]} */
      let step;
      try {
        step = solve(
          a,
          jtr.map((v) => -v),
        );
      } catch (e) {
        if (!(e instanceof SingularMatrixError)) throw e;
        lambda *= 10;
        continue;
      }
      const q = p.map((v, i) => v + step[i]);
      const next = fn(q);
      const c = half2(next.r);
      if (Number.isFinite(c) && c <= cost) {
        const rel = (cost - c) / Math.max(cost, 1e-300);
        const stepSize = Math.sqrt(step.reduce((s, v) => s + v * v, 0));
        const pSize = Math.sqrt(q.reduce((s, v) => s + v * v, 0));
        p = q;
        r = next.r;
        J = next.J;
        cost = c;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        if (rel < tol || stepSize < 1e-12 * (pSize + 1e-12)) converged = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) {
      converged = true; // no downhill step left: at a minimum to working precision
      break;
    }
    if (converged) {
      iterations++;
      break;
    }
  }
  return { p, cost, iterations, converged, jtj: normal(J, r).jtj };
}
