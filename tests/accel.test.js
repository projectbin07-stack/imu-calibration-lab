import { test } from "node:test";
import assert from "node:assert/strict";
import {
  axisLabel,
  calibrateAccel,
  calibrateNine,
  calibrateSix,
  CalibrationError,
  decompose,
} from "../src/core/accel.js";
import { identity, matMul, maxAbsDiff, transpose } from "../src/core/linalg.js";
import { detectStatic, movingVariance, quantile } from "../src/core/static.js";
import { synthAccel } from "../src/core/synth.js";
import { near } from "./helpers.js";

/** @param {number[]} a @param {number[]} b */
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

test("static detection finds every hold of the synthetic 15-pose log", () => {
  const { data } = synthAccel({ seed: 1 });
  const det = detectStatic(data.t, /** @type {any} */ (data.acc), data.gyro);
  assert.equal(det.segments.length, 15);
  // Holds are 4 s; the detected segment loses at most half a window at each end.
  for (const s of det.segments)
    assert.ok(s.t1 - s.t0 > 3.3 && s.t1 - s.t0 < 4.01, `${s.t0}-${s.t1}`);
  assert.ok(det.threshold > 1e-5 && det.threshold < 1e-2);
});

test("moving variance matches a direct computation; quantile interpolates", () => {
  const x = Float64Array.from([1, 3, 2, 5, 4, 4, 0]);
  const z = new Float64Array(7);
  const mv = movingVariance([x, z, z], 1);
  for (let i = 0; i < 7; i++) {
    const w = [...x.slice(Math.max(0, i - 1), Math.min(7, i + 2))];
    const m = w.reduce((s, v) => s + v, 0) / w.length;
    near(mv[i], w.reduce((s, v) => s + (v - m) ** 2, 0) / w.length, 1e-12);
  }
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([0, 10], 0.25), 2.5);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});

test("nine-parameter fit recovers bias within 1 mg and M D is a rotation within 2e-3 (5 seeds)", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { data, truth } = synthAccel({ seed });
    const r = calibrateAccel(data);
    assert.equal(r.model, "nine");
    assert.equal(r.poses.length, 15);
    assert.ok(maxDiff(r.b, truth.b) < 1e-3, `seed ${seed} bias ${r.b} vs ${truth.b}`);
    const q = matMul(r.M, truth.D);
    assert.ok(maxAbsDiff(matMul(transpose(q), q), identity(3)) < 2e-3, `seed ${seed}`);
    // lower triangular: the calibrated x axis is the sensor x axis
    assert.equal(r.M[0][1], 0);
    assert.equal(r.M[0][2], 0);
    assert.equal(r.M[1][2], 0);
    assert.ok(maxDiff(r.scale, [1.012, 0.991, 1.023]) < 1e-3, `seed ${seed} scale ${r.scale}`);
    assert.ok(r.poseResiduals.rmsAfter < 0.5e-3);
    assert.ok(r.poseResiduals.rmsBefore > 0.03);
    assert.ok(r.fit && r.fit.converged && r.fit.condition < 1e4);
    assert.deepEqual(r.warnings, []);
  }
});

test("noise-free data: twelve and nine recover the model to 1e-6", () => {
  const { data, truth } = synthAccel({ noiseDensity: 0, poses: "axis" });
  const r12 = calibrateAccel(data, { model: "twelve" });
  assert.ok(maxAbsDiff(r12.M, truth.M) < 1e-6);
  assert.ok(maxDiff(r12.b, truth.b) < 1e-6);
  const many = synthAccel({ noiseDensity: 0 });
  const r9 = calibrateAccel(many.data, { model: "nine" });
  const q = matMul(r9.M, many.truth.D);
  assert.ok(maxAbsDiff(matMul(transpose(q), q), identity(3)) < 1e-6);
  assert.ok(maxDiff(r9.b, many.truth.b) < 1e-6);
});

test("twelve-parameter and six-position on the six axis poses (5 seeds)", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { data, truth } = synthAccel({ seed, poses: "axis" });
    const auto = calibrateAccel(data);
    assert.equal(auto.model, "twelve");
    assert.equal(auto.poses.length, 6);
    assert.deepEqual(auto.poses.map((p) => p.label).sort(), [
      "+X up",
      "+Y up",
      "+Z up",
      "-X up",
      "-Y up",
      "-Z up",
    ]);
    assert.ok(maxAbsDiff(auto.M, truth.M) < 1e-3, `seed ${seed}`);
    assert.ok(maxDiff(auto.b, truth.b) < 1e-3);
    const six = calibrateAccel(data, { model: "six" });
    // six-position ignores misalignment: bias and scale still within 1e-3
    assert.ok(maxDiff(six.b, truth.b) < 1e-3);
    assert.ok(maxDiff(six.scale, [1.012, 0.991, 1.023]) < 1e-3);
    assert.deepEqual(six.nonOrthogonalityDeg, { xy: 0, xz: 0, yz: 0 });
  }
});

test("a 2 deg pose placement error degrades the twelve-parameter fit, not the nine-parameter one", () => {
  const axis = synthAccel({ seed: 3, poses: "axis", placementDeg: 2 });
  const r12 = calibrateAccel(axis.data, { model: "twelve" });
  assert.ok(maxAbsDiff(r12.M, axis.truth.M) > 5e-3);
  const many = synthAccel({ seed: 3, placementDeg: 2 });
  const r9 = calibrateAccel(many.data, { model: "nine" });
  assert.ok(maxDiff(r9.b, many.truth.b) < 1e-3);
});

test("misalignment is reported as non-orthogonality of the sensor axes", () => {
  const d = decompose([
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  assert.deepEqual(d.scale, [1, 1, 1]);
  near(d.nonOrthogonalityDeg.xy, 0, 1e-12);
  // Sensor y axis tilted 1 deg towards x: D = [[1,0,0],[sin t, cos t, 0],[0,0,1]],
  // and M = D^-1 by hand.
  const t = (1 * Math.PI) / 180;
  const tilted = decompose([
    [1, 0, 0],
    [-Math.tan(t), 1 / Math.cos(t), 0],
    [0, 0, 1],
  ]);
  near(tilted.nonOrthogonalityDeg.xy, 1, 1e-9);
  near(tilted.scale[1], 1, 1e-12);
});

test("axis labels and the up/down convention", () => {
  assert.deepEqual(axisLabel([0.01, 0.02, 0.99]), { label: "+Z up", ref: [0, 0, 1] });
  assert.equal(axisLabel([-1, 0.05, 0]).label, "-X up");
  assert.equal(axisLabel([0.7, 0.7, 0]).label, "tilted");
});

test("errors for logs that cannot be calibrated", () => {
  const { data } = synthAccel({ poses: "axis" });
  assert.throws(() => calibrateAccel(data, { model: "nine" }), /at least 9 poses/);
  assert.throws(() => calibrateAccel({ ...data, acc: null }), /no accelerometer/);
  const still = {
    ...data,
    acc: /** @type {any} */ (data.acc).map((/** @type {Float64Array} */ x) => x.slice(0, 300)),
    gyro: null,
    t: data.t.slice(0, 300),
  };
  assert.throws(
    () => calibrateAccel(still, { model: "twelve", static: { minSeconds: 1 } }),
    /at least 4 axis-aligned poses/,
  );
  assert.throws(() => calibrateSix([]), /\+X up and a -X up/);
  assert.throws(
    () => calibrateNine([]),
    (e) => e instanceof CalibrationError,
  );
  assert.throws(
    () => calibrateAccel(still, { static: { accelThreshold: 0, minSeconds: 1 } }),
    /no static segments/,
  );
});
