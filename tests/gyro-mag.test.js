import { test } from "node:test";
import assert from "node:assert/strict";
import { biasAt, calibrateGyro, weightedLine } from "../src/core/gyro.js";
import { calibrateMag, fitEllipsoid, headingErrorUncorrected } from "../src/core/mag.js";
import { identity, inverse, matMul, maxAbsDiff, sqrtmSym } from "../src/core/linalg.js";
import { createRng } from "../src/core/rng.js";
import { synthGyro, synthMag } from "../src/core/synth.js";
import { near } from "./helpers.js";

/** @param {number[]} a @param {number[]} b */
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

test("gyroscope: temperature-binned bias, slope and scale recovered (5 seeds)", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { data, truth } = synthGyro({ seed });
    const r = calibrateGyro(data);
    assert.ok(r.temperature, "temperature model");
    const tm = /** @type {NonNullable<typeof r.temperature>} */ (r.temperature);
    // bias at 25 degC from the model vs truth: within 0.01 deg/s
    assert.ok(maxDiff(biasAt(tm, 25), truth.bias) < 0.01, `seed ${seed} ${biasAt(tm, 25)}`);
    assert.ok(maxDiff(tm.slope, truth.tempSlope) < 1e-3, `seed ${seed} ${tm.slope}`);
    // scale from the 360 deg turns: within 0.2 %
    assert.ok(maxDiff(r.scale, truth.scale) < 2e-3, `seed ${seed} ${r.scale}`);
    assert.equal(r.rotations.length, 3);
    assert.equal(r.rotations.find((x) => x.axis === 1)?.known, -360);
    // white noise of the static samples: density 0.005 deg/s/sqrt(Hz) at 100 Hz
    for (const s of r.noiseStd) near(s, 0.05, 0.01);
    assert.deepEqual(r.warnings, []);
  }
});

test("gyroscope without temperature: constant bias; manual rotation window; whole-file static", () => {
  const { data, truth } = synthGyro({ seed: 7, tempSlope: [0, 0, 0] });
  const noTemp = { ...data, temp: null };
  const r = calibrateGyro(noTemp);
  assert.equal(r.temperature, null);
  assert.ok(maxDiff(r.bias, truth.bias) < 0.005);
  const z = r.rotations.find((x) => x.axis === 2);
  assert.ok(z);
  const manual = calibrateGyro(noTemp, {
    rotation: { t0: /** @type {any} */ (z).t0, t1: /** @type {any} */ (z).t1, axis: 2 },
  });
  assert.equal(manual.rotations.length, 1);
  near(manual.scale[2], truth.scale[2], 2e-3);
  assert.deepEqual([manual.scale[0], manual.scale[1]], [1, 1]);
  const all = calibrateGyro(noTemp, { wholeFileStatic: true, tempBin: 0 });
  assert.equal(all.staticSamples, data.t.length);
  assert.ok(all.warnings.some((w) => w.includes("no rotation")) || all.rotations.length === 0);
  assert.throws(
    () => calibrateGyro(noTemp, { rotation: { t0: 1, t1: 1.001, axis: 0 } }),
    /fewer than two samples/,
  );
  assert.throws(() => calibrateGyro({ ...data, gyro: null }), /no gyroscope/);
});

test("gyroscope: a wrong known angle is flagged; a too-narrow temperature range is reported", () => {
  const { data } = synthGyro({ seed: 1 });
  const r = calibrateGyro(data, { knownAngle: 400 });
  assert.ok(r.warnings.some((w) => w.includes("more than 10 %")));
  const flat = synthGyro({ seed: 1, tempStart: 30.4, tempEnd: 30.6 });
  const r2 = calibrateGyro(flat.data);
  assert.equal(r2.temperature, null);
  assert.ok(r2.warnings.some((w) => w.includes("temperature range too small")));
});

test("weighted line fit is exact on a line and falls back to the mean", () => {
  const f = weightedLine([1, 2, 3], [3, 5, 7], [1, 2, 1], 2);
  near(f.a, 5, 1e-12);
  near(f.b, 2, 1e-12);
  assert.deepEqual(weightedLine([2, 2], [1, 3], [1, 1], 0), { a: 2, b: 0 });
});

/**
 * Points on an ellipsoid: c + S u for unit vectors u from a seeded RNG.
 * @param {number[]} c
 * @param {number[][]} S
 * @param {number} n
 * @returns {Float64Array[]}
 */
function ellipsoidPoints(c, S, n) {
  const rng = createRng(11);
  const out = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) {
    const u = [rng.gaussian(), rng.gaussian(), rng.gaussian()];
    const l = Math.hypot(...u);
    for (let a = 0; a < 3; a++)
      out[a][i] = c[a] + (S[a][0] * u[0] + S[a][1] * u[1] + S[a][2] * u[2]) / l;
  }
  return out;
}

test("ellipsoid fit on a perfect sphere returns the centre and an identity soft-iron matrix", () => {
  const pts = ellipsoidPoints([0, 0, 0], identity(3), 500);
  const e = fitEllipsoid(pts);
  assert.ok(maxDiff(e.center, [0, 0, 0]) < 1e-9);
  assert.ok(maxAbsDiff(e.A, identity(3)) < 1e-9);
  assert.ok(maxDiff(e.radii, [1, 1, 1]) < 1e-9);
  const d = {
    t: new Float64Array(500),
    acc: null,
    gyro: null,
    mag: /** @type {any} */ (
      ellipsoidPoints(
        [0, 0, 0],
        [
          [50, 0, 0],
          [0, 50, 0],
          [0, 0, 50],
        ],
        500,
      )
    ),
    temp: null,
    fs: 50,
    skipped: 0,
    warnings: [],
  };
  const r = calibrateMag(d);
  assert.ok(maxAbsDiff(r.softIron, identity(3)) < 1e-9);
  near(r.fieldStrength, 50, 1e-9);
  near(r.sphericity.before, 1, 1e-9);
  near(r.heading.beforeDeg, 0, 1e-9);
  assert.equal(r.heading.dipSource, "default");
});

test("noise-free ellipsoid: exact centre and shape", () => {
  const S = [
    [30, 4, -2],
    [4, 25, 3],
    [-2, 3, 40],
  ];
  const c = [12, -30, 7];
  const e = fitEllipsoid(ellipsoidPoints(c, S, 400));
  assert.ok(maxDiff(e.center, c) < 1e-6);
  // A = (S S^T)^-1 for points c + S u
  assert.ok(maxAbsDiff(e.A, inverse(matMul(S, S))) < 1e-9);
});

test("magnetometer: hard iron within 0.2 uT, soft iron within 1 %, heading error reduced (5 seeds)", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { data, truth } = synthMag({ seed });
    const r = calibrateMag(data);
    assert.ok(maxDiff(r.hardIron, truth.hardIron) < 0.2, `seed ${seed} ${r.hardIron}`);
    // W S should be a multiple of the identity (S symmetric here)
    const ws = matMul(r.softIron, truth.softIron);
    const k = (ws[0][0] + ws[1][1] + ws[2][2]) / 3;
    assert.ok(
      maxAbsDiff(
        ws.map((row) => row.map((v) => v / k)),
        identity(3),
      ) < 0.01,
      `seed ${seed}`,
    );
    near(r.fieldStrength / k, truth.field, truth.field * 0.01);
    assert.ok(r.sphericity.before < 0.85 && r.sphericity.after > 0.98);
    assert.ok(r.magnitude.after.cv < 0.015 && r.magnitude.before.cv > 0.2);
    assert.equal(r.heading.dipSource, "accelerometer");
    near(r.heading.dipDeg, truth.dipDeg, 1.5);
    assert.ok(r.heading.beforeDeg > 20 && r.heading.afterDeg < 1.5);
    assert.ok(r.coverage > 0.6);
  }
});

test("magnetometer: dip option, poor coverage warning, planar data rejected", () => {
  const { data } = synthMag({ seed: 1 });
  assert.equal(calibrateMag(data, { dipDeg: 60 }).heading.dipSource, "option");
  // Only a quarter of the log: the tumble has not covered the sphere yet.
  const n = 250;
  const part = {
    ...data,
    t: data.t.slice(0, n),
    mag: /** @type {any} */ (data.mag).map((/** @type {Float64Array} */ x) => x.slice(0, n)),
    acc: null,
  };
  const r = calibrateMag(part);
  assert.ok(r.coverage < 0.3 ? r.warnings.length > 0 : true);
  const flat = {
    ...data,
    mag: /** @type {any} */ ([
      Float64Array.from({ length: 50 }, (_, i) => Math.cos(i)),
      Float64Array.from({ length: 50 }, (_, i) => Math.sin(i)),
      new Float64Array(50),
    ]),
  };
  assert.throws(() => calibrateMag(flat), /degenerate|ellipsoid|centre/);
  assert.throws(() => fitEllipsoid([[1], [2], [3]]), /at least 10/);
  assert.throws(() => calibrateMag({ ...data, mag: null }), /no magnetometer/);
});

test("heading error of a pure hard-iron offset matches the closed form", () => {
  // Level compass, field Bh = 20, offset 10 along y: worst error asin(10/20) = 30 deg.
  const e = headingErrorUncorrected([0, 10, 0], identity(3), 20, 0);
  near(e, 30, 0.05);
  const s = sqrtmSym([
    [4, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  // axis ratio 2 in x: worst error atan(2 tan psi) - psi at tan psi = 1/sqrt(2): 19.47 deg
  near(headingErrorUncorrected([0, 0, 0], inverse(s), 1, 0), 19.47, 0.05);
});
