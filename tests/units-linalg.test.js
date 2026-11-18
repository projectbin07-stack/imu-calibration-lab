import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accelToG,
  gyroToDps,
  magToUt,
  MPU6050_ACCEL_LSB_PER_G,
  MPU6050_GYRO_LSB_PER_DPS,
  mpu6050Temperature,
  STANDARD_GRAVITY,
  timeToSeconds,
} from "../src/core/units.js";
import {
  cholesky,
  det3,
  identity,
  inverse,
  lstsq,
  matMul,
  maxAbsDiff,
  SingularMatrixError,
  solve,
  sqrtmSym,
  symEigen,
  transpose,
} from "../src/core/linalg.js";
import { near } from "./helpers.js";

test("MPU6050 accelerometer scaling per full-scale range (register map 4.17)", () => {
  // AFS_SEL 0..3: +/-2, 4, 8, 16 g -> 16384, 8192, 4096, 2048 LSB/g
  assert.deepEqual(MPU6050_ACCEL_LSB_PER_G, { 2: 16384, 4: 8192, 8: 4096, 16: 2048 });
  for (const [range, lsb] of [
    [2, 16384],
    [4, 8192],
    [8, 4096],
    [16, 2048],
  ]) {
    assert.equal(lsb * accelToG("lsb", range), 1);
    // full scale: 32768 counts is the range in g
    assert.equal(32768 * accelToG("lsb", range), range);
  }
  assert.throws(() => accelToG("lsb", 3), /2, 4, 8 or 16/);
  near(STANDARD_GRAVITY * accelToG("mps2", 2), 1, 1e-15);
  assert.equal(accelToG("g", 2), 1);
});

test("MPU6050 gyroscope scaling per full-scale range (register map 4.19)", () => {
  // FS_SEL 0..3: +/-250, 500, 1000, 2000 deg/s -> 131, 65.5, 32.8, 16.4 LSB/(deg/s)
  assert.deepEqual(MPU6050_GYRO_LSB_PER_DPS, { 250: 131, 500: 65.5, 1000: 32.8, 2000: 16.4 });
  near(131 * gyroToDps("lsb", 250), 1, 1e-15);
  near(65.5 * gyroToDps("lsb", 500), 1, 1e-15);
  near(32.8 * gyroToDps("lsb", 1000), 1, 1e-15);
  near(16.4 * gyroToDps("lsb", 2000), 1, 1e-15);
  // full scale within 0.1 %: 32767 counts ~ range (the datasheet values are rounded)
  for (const r of [250, 500, 1000, 2000]) near(32767 * gyroToDps("lsb", r), r, r * 0.002);
  near(gyroToDps("rads", 250) * Math.PI, 180, 1e-12);
  assert.throws(() => gyroToDps("lsb", 300), /250, 500, 1000 or 2000/);
});

test("MPU6050 temperature and other unit factors", () => {
  near(mpu6050Temperature(0), 36.53, 1e-12);
  near(mpu6050Temperature(-512), 35.024, 1e-3);
  near(mpu6050Temperature(340), 37.53, 1e-12);
  assert.equal(magToUt("gauss"), 100);
  assert.equal(magToUt("mG"), 0.1);
  assert.equal(magToUt("nT"), 1e-3);
  assert.equal(timeToSeconds("us"), 1e-6);
});

test("solve, inverse and det3 on a hand-checked system", () => {
  const a = [
    [2, 1, -1],
    [-3, -1, 2],
    [-2, 1, 2],
  ];
  assert.deepEqual(
    solve(a, [8, -11, -3]).map((v) => Math.round(v * 1e9) / 1e9),
    [2, 3, -1],
  );
  assert.ok(maxAbsDiff(matMul(a, inverse(a)), identity(3)) < 1e-12);
  near(det3(a), -1, 1e-12);
  assert.throws(
    () =>
      solve(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    SingularMatrixError,
  );
});

test("symmetric eigen-decomposition, Cholesky and matrix square root", () => {
  const a = [
    [4, 1, 0.5],
    [1, 3, 0.2],
    [0.5, 0.2, 2],
  ];
  const { values, vectors } = symEigen(a);
  assert.ok(values[0] <= values[1] && values[1] <= values[2]);
  const d = [
    [values[0], 0, 0],
    [0, values[1], 0],
    [0, 0, values[2]],
  ];
  assert.ok(maxAbsDiff(matMul(matMul(vectors, d), transpose(vectors)), a) < 1e-12);
  const l = cholesky(a);
  assert.ok(maxAbsDiff(matMul(l, transpose(l)), a) < 1e-12);
  const s = sqrtmSym(a);
  assert.ok(maxAbsDiff(matMul(s, s), a) < 1e-12);
  assert.throws(() => cholesky([[-1]]), /positive definite/);
  assert.throws(
    () =>
      sqrtmSym([
        [1, 0],
        [0, -1],
      ]),
    /positive definite/,
  );
});

test("least squares recovers a line exactly", () => {
  const rows = [0, 1, 2, 3].map((x) => [x, 1]);
  const [m, c] = lstsq(
    rows,
    [0, 1, 2, 3].map((x) => 2 * x - 1),
  );
  near(m, 2, 1e-12);
  near(c, -1, 1e-12);
});
