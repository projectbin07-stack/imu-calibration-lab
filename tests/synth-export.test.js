import { test } from "node:test";
import assert from "node:assert/strict";
import { calibrateAccel } from "../src/core/accel.js";
import { accelJson, cf, cHeader, gyroJson, magJson, roundDeep, sig } from "../src/core/export.js";
import { calibrateGyro } from "../src/core/gyro.js";
import { loadCsv } from "../src/core/load.js";
import { calibrateMag } from "../src/core/mag.js";
import { createRng } from "../src/core/rng.js";
import {
  axisAngle,
  datasetToCsv,
  runScript,
  synthAccel,
  synthGyro,
  synthMag,
  synthNoise,
} from "../src/core/synth.js";
import { defaultUnits } from "../src/core/units.js";
import { near } from "./helpers.js";

test("generators are deterministic for a seed and differ between seeds", () => {
  const a = synthAccel({ seed: 5 }).data;
  const b = synthAccel({ seed: 5 }).data;
  const c = synthAccel({ seed: 6 }).data;
  assert.deepEqual(a.acc, b.acc);
  assert.notDeepEqual(a.acc, c.acc);
  assert.equal(datasetToCsv(synthMag({ seed: 1 }).data), datasetToCsv(synthMag({ seed: 1 }).data));
  assert.deepEqual(synthNoise({ seconds: 10 }).data.gyro, synthNoise({ seconds: 10 }).data.gyro);
  assert.deepEqual(synthGyro().data.temp, synthGyro().data.temp);
  const r1 = createRng(42);
  const r2 = createRng(42);
  for (let i = 0; i < 5; i++) assert.equal(r1.gaussian(), r2.gaussian());
});

test("motion scripts rotate by exactly the requested angle", () => {
  const { R, w } = runScript(
    [{ hold: 1 }, { rotate: [0, 0, 1], deg: 90, seconds: 2 }, { hold: 0.1 }],
    100,
  );
  assert.equal(R.length, 100 + 200 + 10);
  const end = R[R.length - 1];
  const want = axisAngle([0, 0, 1], Math.PI / 2);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) near(end[i][j], want[i][j], 1e-9);
  // the rate integrates (rectangle rule, at sample starts) to 90 deg
  near(
    w.reduce((s, v) => s + v[2] / 100, 0),
    90,
    0.01,
  );
});

test("raw MPU6050 CSV round trip: counts are rounded to 1 LSB and read back", () => {
  const { data } = synthAccel({ seed: 1, poses: "axis" });
  const csv = datasetToCsv(data, { raw: true });
  assert.ok(csv.startsWith("t_ms,AcX,AcY,AcZ,GyX,GyY,GyZ\n"));
  const back = loadCsv(csv);
  assert.equal(back.units.accel, "lsb");
  assert.equal(back.units.accelRange, 2);
  const acc = /** @type {NonNullable<typeof back.data.acc>} */ (back.data.acc);
  const orig = /** @type {NonNullable<typeof data.acc>} */ (data.acc);
  for (let i = 0; i < orig[0].length; i += 97) near(acc[2][i], orig[2][i], 0.5 / 16384 + 1e-12);
  // the calibration from the raw file matches the one from the floats
  const a = calibrateAccel(data, { model: "twelve" });
  const b = calibrateAccel(back.data, { model: "twelve" });
  for (let i = 0; i < 3; i++) near(a.b[i], b.b[i], 2e-5);
  const g = synthGyro({ seed: 1 }).data;
  const gb = loadCsv(datasetToCsv(g, { raw: true }));
  assert.equal(gb.units.temp, "mpu6050");
  near(
    /** @type {Float64Array} */ (gb.data.temp)[500],
    /** @type {Float64Array} */ (g.temp)[500],
    2 / 340,
  );
});

test("number formatting for JSON and C", () => {
  assert.equal(sig(1.23456789, 3), 1.23);
  assert.equal(sig(0), 0);
  assert.equal(sig(Infinity), Infinity);
  assert.deepEqual(roundDeep({ a: [1.234567891, "x"], b: null }, 4), { a: [1.235, "x"], b: null });
  assert.equal(cf(1), "1.0f");
  assert.equal(cf(0), "0.0f");
  assert.equal(cf(-0.5), "-0.5f");
  assert.equal(cf(1.5e-7), "1.5e-7f");
  assert.equal(cf(2e21), "2e21f");
});

test("C header holds the constants and apply functions for each sensor", () => {
  const accel = calibrateAccel(synthAccel({ seed: 1 }).data);
  const gyro = calibrateGyro(synthGyro({ seed: 1 }).data);
  const mag = calibrateMag(synthMag({ seed: 1 }).data);
  const units = {
    ...defaultUnits(),
    accel: /** @type {const} */ ("lsb"),
    gyro: /** @type {const} */ ("lsb"),
    gyroRange: 500,
  };
  const h = cHeader({ accel, gyro, mag, units, source: "test\nlog" });
  assert.match(h, /#pragma once/);
  assert.match(h, /\/\/ Data: test log/);
  assert.match(h, /#define IMU_ACCEL_LSB_PER_G 16384\.0f/);
  assert.match(h, /#define IMU_GYRO_LSB_PER_DPS 65\.5f/);
  assert.match(
    h,
    /static const imu_accel_cal_t IMU_ACCEL_CAL = \{\n  \{0\.03\d+f, -0\.02\d+f, 0\.05\d+f\}/,
  );
  assert.match(h, /imu_accel_apply\(const imu_accel_cal_t \*c/);
  assert.match(h, /imu_gyro_apply\(const imu_gyro_cal_t \*c, const float in\[3\], float temp_c/);
  assert.match(h, /imu_mag_apply/);
  assert.match(h, /float temp_c = traw \/ 340\.0f \+ 36\.53f;/);
  // every float literal is a valid C literal
  for (const lit of h.match(/-?[0-9][0-9.e-]*f\b/g) ?? [])
    assert.match(lit, /^-?\d+(\.\d+)?(e-?\d+)?f$/);
  // the Arduino example is one block comment: no nested comment opener
  assert.equal((h.match(/\/\*/g) ?? []).length, 1);
  assert.equal((h.match(/\*\//g) ?? []).length, 1);
  // braces balance
  assert.equal((h.match(/\{/g) ?? []).length, (h.match(/\}/g) ?? []).length);
  const gOnly = cHeader({
    gyro: calibrateGyro({ ...synthGyro().data, temp: null }),
    units: defaultUnits(),
  });
  assert.match(gOnly, /w_cal = \(w - bias\) \/ scale/);
  assert.match(gOnly, /default ranges/);
  assert.doesNotMatch(gOnly, /IMU_ACCEL_CAL/);
});

test("JSON summaries carry the parameters and no per-sample arrays", () => {
  const a = /** @type {any} */ (accelJson(calibrateAccel(synthAccel({ seed: 1 }).data)));
  assert.equal(a.kind, "accel");
  assert.equal(a.poses.length, 15);
  assert.equal(a.sampleResiduals, undefined);
  const g = /** @type {any} */ (gyroJson(calibrateGyro(synthGyro({ seed: 1 }).data)));
  assert.match(g.apply, /refTemp/);
  assert.equal(g.temperature.bins.length > 2, true);
  const m = /** @type {any} */ (magJson(calibrateMag(synthMag({ seed: 1 }).data)));
  assert.equal(m.plot, undefined);
  assert.equal(m.softIron.length, 3);
});
