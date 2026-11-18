// Small dense linear algebra on plain arrays: enough for 3x3 calibration
// matrices, the 9/12-parameter normal equations and the 10x10 ellipsoid fit.
// Matrices are arrays of rows. Nothing here allocates more than O(n^2).

/** @typedef {number[]} Vec */
/** @typedef {number[][]} Mat */

/**
 * @param {number} n
 * @param {number} [m]
 * @returns {Mat}
 */
export function zeros(n, m = n) {
  return Array.from({ length: n }, () => new Array(m).fill(0));
}

/**
 * @param {number} n
 * @returns {Mat}
 */
export function identity(n) {
  const a = zeros(n);
  for (let i = 0; i < n; i++) a[i][i] = 1;
  return a;
}

/**
 * @param {Vec} d
 * @returns {Mat}
 */
export function diag(d) {
  const a = zeros(d.length);
  d.forEach((v, i) => (a[i][i] = v));
  return a;
}

/**
 * @param {Mat} a
 * @returns {Mat}
 */
export function transpose(a) {
  return a[0].map((_, j) => a.map((row) => row[j]));
}

/**
 * @param {Mat} a
 * @param {Mat} b
 * @returns {Mat}
 */
export function matMul(a, b) {
  const n = a.length;
  const k = b.length;
  const m = b[0].length;
  const out = zeros(n, m);
  for (let i = 0; i < n; i++)
    for (let p = 0; p < k; p++) {
      const v = a[i][p];
      if (v === 0) continue;
      for (let j = 0; j < m; j++) out[i][j] += v * b[p][j];
    }
  return out;
}

/**
 * @param {Mat} a
 * @param {Vec} x
 * @returns {Vec}
 */
export function matVec(a, x) {
  return a.map((row) => row.reduce((s, v, j) => s + v * x[j], 0));
}

/**
 * @param {Mat} a
 * @param {Mat} b
 * @returns {Mat}
 */
export function matAdd(a, b) {
  return a.map((row, i) => row.map((v, j) => v + b[i][j]));
}

/**
 * @param {Mat} a
 * @param {number} s
 * @returns {Mat}
 */
export function matScale(a, s) {
  return a.map((row) => row.map((v) => v * s));
}

/**
 * @param {Vec} a
 * @param {Vec} b
 * @returns {number}
 */
export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * @param {Vec} a
 * @returns {number}
 */
export function norm(a) {
  return Math.sqrt(dot(a, a));
}

/**
 * Largest absolute element difference, for tests and convergence checks.
 * @param {Mat} a
 * @param {Mat} b
 * @returns {number}
 */
export function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < a[i].length; j++) m = Math.max(m, Math.abs(a[i][j] - b[i][j]));
  return m;
}

export class SingularMatrixError extends Error {}

/**
 * Solve A X = B by Gaussian elimination with partial pivoting.
 * B may be a vector or a matrix (several right-hand sides).
 * @template {Vec | Mat} T
 * @param {Mat} a square
 * @param {T} b
 * @returns {T}
 */
export function solve(a, b) {
  const n = a.length;
  const vector = !Array.isArray(b[0]);
  const rhs = vector ? /** @type {Vec} */ (b).map((v) => [v]) : /** @type {Mat} */ (b);
  const m = rhs[0].length;
  const aug = a.map((row, i) => [...row, ...rhs[i]]);
  let scale = 0;
  for (const row of a) for (const v of row) scale = Math.max(scale, Math.abs(v));
  const tiny = (scale || 1) * 1e-13;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(aug[r][c]) > Math.abs(aug[p][c])) p = r;
    if (Math.abs(aug[p][c]) <= tiny) throw new SingularMatrixError("matrix is singular");
    [aug[c], aug[p]] = [aug[p], aug[c]];
    for (let r = c + 1; r < n; r++) {
      const f = aug[r][c] / aug[c][c];
      if (f === 0) continue;
      for (let j = c; j < n + m; j++) aug[r][j] -= f * aug[c][j];
    }
  }
  const x = zeros(n, m);
  for (let r = n - 1; r >= 0; r--)
    for (let j = 0; j < m; j++) {
      let s = aug[r][n + j];
      for (let k = r + 1; k < n; k++) s -= aug[r][k] * x[k][j];
      x[r][j] = s / aug[r][r];
    }
  return /** @type {T} */ (vector ? x.map((row) => row[0]) : x);
}

/**
 * @param {Mat} a
 * @returns {Mat}
 */
export function inverse(a) {
  return solve(a, identity(a.length));
}

/**
 * @param {Mat} a 3x3
 * @returns {number}
 */
export function det3(a) {
  return (
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
  );
}

/**
 * Cholesky factor L (lower triangular, A = L L^T) of a symmetric positive
 * definite matrix.
 * @param {Mat} a
 * @returns {Mat}
 */
export function cholesky(a) {
  const n = a.length;
  const l = zeros(n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let s = a[i][j];
      for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k];
      if (i === j) {
        if (!(s > 0)) throw new SingularMatrixError("matrix is not positive definite");
        l[i][i] = Math.sqrt(s);
      } else l[i][j] = s / l[j][j];
    }
  return l;
}

/**
 * Eigen-decomposition of a symmetric matrix by cyclic Jacobi rotations.
 * Returns eigenvalues in ascending order and the matching unit eigenvectors
 * as the columns of `vectors`.
 * @param {Mat} input symmetric
 * @returns {{values: Vec, vectors: Mat}}
 */
export function symEigen(input) {
  const n = input.length;
  const a = input.map((row) => [...row]);
  const v = identity(n);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    let total = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        total += a[i][j] * a[i][j];
        if (i !== j) off += a[i][j] * a[i][j];
      }
    if (off <= 1e-30 * total || off === 0) break;
    for (let p = 0; p < n - 1; p++)
      for (let q = p + 1; q < n; q++) {
        if (a[p][q] === 0) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  const order = a.map((row, i) => [row[i], i]).sort((x, y) => x[0] - y[0]);
  return {
    values: order.map(([val]) => val),
    vectors: v.map((row) => order.map(([, i]) => row[i])),
  };
}

/**
 * Symmetric square root of a symmetric positive definite matrix.
 * @param {Mat} a
 * @returns {Mat}
 */
export function sqrtmSym(a) {
  const { values, vectors } = symEigen(a);
  if (values.some((v) => !(v > 0)))
    throw new SingularMatrixError("matrix is not positive definite");
  const d = diag(values.map(Math.sqrt));
  return symmetrize(matMul(matMul(vectors, d), transpose(vectors)));
}

/**
 * @param {Mat} a
 * @returns {Mat}
 */
export function symmetrize(a) {
  return a.map((row, i) => row.map((v, j) => (v + a[j][i]) / 2));
}

/**
 * Least squares: minimise |A x - b|^2 through the normal equations. Fine for
 * the small, well-scaled problems here (the columns are centred by callers
 * where it matters).
 * @param {Mat} a rows x cols
 * @param {Vec} b rows
 * @returns {Vec}
 */
export function lstsq(a, b) {
  const at = transpose(a);
  return solve(matMul(at, a), matVec(at, b));
}
