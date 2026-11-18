import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allanDeviation,
  allanForDataset,
  BI_FACTOR,
  clusterSizes,
  fitSlope,
  readOff,
} from "../src/core/allan.js";
import { createRng } from "../src/core/rng.js";
import { synthNoise } from "../src/core/synth.js";
import { near, nearRel } from "./helpers.js";

test("cluster sizes are log-spaced, unique and end at (N-1)/2", () => {
  const m = clusterSizes(10001, 10);
  assert.equal(m[0], 1);
  assert.equal(m[m.length - 1], 5000);
  for (let i = 1; i < m.length; i++) assert.ok(m[i] > m[i - 1]);
  assert.ok(m.length >= 30 && m.length <= 38);
  assert.deepEqual(clusterSizes(2), []);
});

test("overlapping Allan variance matches a hand computation", () => {
  // x = [1, 3, 2, 6], tau0 = 1. theta = [0, 1, 4, 6, 12].
  // m = 1: terms k = 0..2: (4-2+0)^2 + (6-8+1)^2 + (12-12+4)^2 = 4 + 1 + 16 = 21
  // AVAR = 21 / (2 * 1 * 3) = 3.5 (the mean removal does not change it)
  const c = allanDeviation([1, 3, 2, 6], 1);
  assert.deepEqual(c.clusters, [1]);
  near(c.adev[0], Math.sqrt(3.5), 1e-12);
  near(c.relError[0], 1 / Math.sqrt(2 * 3), 1e-12);
  assert.throws(() => allanDeviation([1, 2], 1), /at least 3/);
});

test("white noise: slope -1/2 and the noise density is recovered within 3 % (5 seeds)", () => {
  const fs = 100;
  const density = 0.005; // deg/s/sqrt(Hz)
  for (const seed of [1, 2, 3, 4, 5]) {
    const rng = createRng(seed);
    const x = Float64Array.from({ length: 200000 }, () => density * Math.sqrt(fs) * rng.gaussian());
    const c = allanDeviation(x, 1 / fs);
    // log-log regression over tau <= T/20, where many clusters remain
    const idx = c.tau.map((_, i) => i).filter((i) => c.tau[i] <= 100);
    const lx = idx.map((i) => Math.log(c.tau[i]));
    const ly = idx.map((i) => Math.log(c.adev[i]));
    const mx = lx.reduce((s, v) => s + v, 0) / lx.length;
    const my = ly.reduce((s, v) => s + v, 0) / ly.length;
    const slope =
      lx.reduce((s, v, i) => s + (v - mx) * (ly[i] - my), 0) /
      lx.reduce((s, v) => s + (v - mx) ** 2, 0);
    near(slope, -0.5, 0.02, `seed ${seed} slope`);
    const terms = readOff(c);
    assert.ok(terms.whiteNoise);
    nearRel(/** @type {any} */ (terms.whiteNoise).value, density, 0.03, `seed ${seed} N`);
    // sigma(tau0) = per-sample standard deviation
    nearRel(c.adev[0], density * Math.sqrt(fs), 0.01);
  }
});

test("read-off on an analytic curve: N, B and K", () => {
  const N = 0.005;
  const B = 0.002;
  const K = 0.00002;
  // Allan variance of white + flicker (constant) + rate random walk
  const tau = Array.from({ length: 90 }, (_, i) => 0.01 * 10 ** (i / 10));
  const adev = tau.map((t) => Math.sqrt((N * N) / t + (BI_FACTOR * B) ** 2 + (K * K * t) / 3));
  const curve = { tau, adev, clusters: tau.map((t) => t * 100), relError: tau.map(() => 0.01) };
  const r = readOff(curve);
  nearRel(/** @type {any} */ (r.whiteNoise).value, N, 0.03);
  nearRel(/** @type {any} */ (r.rateRandomWalk).value, K, 0.08);
  // the minimum also holds a little white and RRW noise, so it reads high
  const b = /** @type {any} */ (r.biasInstability);
  assert.ok(b.value > B && b.value < 1.15 * B, String(b.value));
  assert.equal(b.atEnd, false);
  // a curve that only falls: bias instability is an upper bound at the end
  const falling = { ...curve, adev: tau.map((t) => N / Math.sqrt(t)) };
  const rf = readOff(falling);
  assert.equal(/** @type {any} */ (rf.biasInstability).atEnd, true);
  assert.equal(rf.rateRandomWalk, null);
  assert.equal(fitSlope(falling, 0.5, 3), null);
  assert.deepEqual(readOff({ tau: [], adev: [], clusters: [], relError: [] }), {
    whiteNoise: null,
    biasInstability: null,
    rateRandomWalk: null,
  });
});

test("synthetic rate random walk is recovered within 35 % from a 2 h log", () => {
  const { data, truth } = synthNoise({
    seed: 9,
    seconds: 7200,
    gyroGm: [0, 0, 0],
    gyroRrw: [3e-4, 3e-4, 3e-4],
  });
  const r = allanForDataset(data, { sensor: "gyro" });
  let found = 0;
  r.axes.forEach((a, i) => {
    const k = a.terms.rateRandomWalk;
    if (!k) return;
    found++;
    nearRel(k.value, truth.gyroRrw[i], 0.35, `axis ${a.axis}`);
    nearRel(/** @type {number} */ (r.converted[i].rateRandomWalk), truth.gyroRrw[i] * 216000, 0.35);
  });
  assert.ok(found >= 2, `found ${found}`);
  r.axes.forEach((a, i) =>
    nearRel(/** @type {any} */ (a.terms.whiteNoise).value, truth.gyroWhite[i], 0.05),
  );
});

test("dataset wrapper: units, conversions, short-log warning, accelerometer noise", () => {
  const { data } = synthNoise({ seconds: 300 });
  const g = allanForDataset(data);
  assert.equal(g.sensor, "gyro");
  assert.equal(g.units.whiteNoise, "deg/sqrt(h)");
  g.axes.forEach((a, i) => {
    near(
      /** @type {number} */ (g.converted[i].whiteNoise),
      /** @type {any} */ (a.terms.whiteNoise).value * 60,
      1e-12,
    );
    near(
      /** @type {number} */ (g.converted[i].biasInstability),
      /** @type {any} */ (a.terms.biasInstability).value * 3600,
      1e-9,
    );
  });
  assert.ok(g.warnings.some((w) => w.includes("300 s long")));
  const a = allanForDataset(data, { sensor: "accel" });
  assert.equal(a.units.whiteNoise, "ug/sqrt(Hz)");
  // 400 ug/sqrt(Hz) white noise
  for (const c of a.converted) nearRel(/** @type {number} */ (c.whiteNoise), 400, 0.05);
  assert.throws(() => allanForDataset({ ...data, gyro: null }, { sensor: "gyro" }), /no gyroscope/);
});
