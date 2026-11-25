// Output: calibration parameters as JSON, and as a C/C++ header with const
// structs and apply functions that compile for Arduino (AVR, ESP32, STM32)
// and desktop C99/C++.

export const VERSION = "0.2.0";

/** @typedef {import("./accel.js").AccelResult} AccelResult */
/** @typedef {import("./gyro.js").GyroResult} GyroResult */
/** @typedef {import("./mag.js").MagResult} MagResult */
/** @typedef {import("./allan.js").AllanResult} AllanResult */
/** @typedef {import("./units.js").Units} Units */

/**
 * Round to a fixed number of significant digits for stable, readable output.
 * @param {number} v
 * @param {number} [digits]
 * @returns {number}
 */
export function sig(v, digits = 7) {
  if (!Number.isFinite(v) || v === 0) return v === 0 ? 0 : v;
  return Number(v.toPrecision(digits));
}

/**
 * @param {unknown} v
 * @param {number} [digits]
 * @returns {unknown}
 */
export function roundDeep(v, digits = 7) {
  if (typeof v === "number") return sig(v, digits);
  if (Array.isArray(v)) return v.map((x) => roundDeep(x, digits));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, roundDeep(x, digits)]));
  return v;
}

/**
 * JSON summary of an accelerometer calibration (no per-sample arrays).
 * @param {AccelResult} r
 */
export function accelJson(r) {
  return roundDeep({
    kind: "accel",
    model: r.model,
    units: "g",
    apply: "a_cal = M (a_raw - b)",
    bias: r.b,
    matrix: r.M,
    scale: r.scale,
    nonOrthogonalityDeg: r.nonOrthogonalityDeg,
    residuals: r.poseResiduals,
    poses: r.poses.map((p) => ({
      t0: p.t0,
      t1: p.t1,
      samples: p.n,
      label: p.label,
      mean: p.mean,
      normBefore: p.normBefore,
      normAfter: p.normAfter,
    })),
    detection: r.detection,
    fit: r.fit,
    warnings: r.warnings,
  });
}

/**
 * @param {GyroResult} r
 */
export function gyroJson(r) {
  return roundDeep({
    kind: "gyro",
    units: "deg/s",
    apply: r.temperature
      ? "w_cal = (w_raw - (bias + slope (T - refTemp))) / scale"
      : "w_cal = (w_raw - bias) / scale",
    bias: r.temperature ? r.temperature.bias : r.bias,
    meanBias: r.bias,
    noiseStd: r.noiseStd,
    staticSamples: r.staticSamples,
    scale: r.scale,
    rotations: r.rotations,
    temperature: r.temperature
      ? {
          refTemp: r.temperature.refTemp,
          slope: r.temperature.slope,
          bins: r.temperature.bins,
        }
      : null,
    warnings: r.warnings,
  });
}

/**
 * @param {MagResult} r
 */
export function magJson(r) {
  return roundDeep({
    kind: "mag",
    apply: "m_cal = W (m_raw - c)",
    hardIron: r.hardIron,
    softIron: r.softIron,
    fieldStrength: r.fieldStrength,
    radii: r.radii,
    sphericity: r.sphericity,
    magnitude: r.magnitude,
    coverage: r.coverage,
    heading: r.heading,
    warnings: r.warnings,
  });
}

/**
 * @param {AllanResult} r
 */
export function allanJson(r) {
  return roundDeep(
    {
      kind: "allan",
      sensor: r.sensor,
      fs: r.fs,
      duration: r.duration,
      samples: r.samples,
      units: r.units,
      axes: r.axes.map((a, i) => ({
        axis: a.axis,
        ...r.converted[i],
        whiteNoiseFit: a.terms.whiteNoise,
        biasInstabilityFit: a.terms.biasInstability,
        rateRandomWalkFit: a.terms.rateRandomWalk,
        curve: { tau: a.curve.tau, adev: a.curve.adev, relError: a.curve.relError },
      })),
      warnings: r.warnings,
    },
    5,
  );
}

/**
 * The parts of a combined calibration file: the per-sensor JSON summaries
 * from accelJson, gyroJson and magJson (or null when absent).
 * @typedef {object} CombinedParts
 * @property {string} source file or sample name the calibrations came from
 * @property {unknown} accel
 * @property {unknown} gyro
 * @property {unknown} mag
 */

/**
 * The combined calibration file the page exports:
 * { generator, source, accel, gyro, mag }, two-space indented, with a
 * trailing newline. The browser and the CLI both call this, so the bytes are
 * the same for the same parts.
 * @param {CombinedParts} parts
 * @returns {string}
 */
export function combinedJsonText(parts) {
  const { source, accel, gyro, mag } = parts;
  const generator = `imu-calibration-lab ${VERSION}`;
  return JSON.stringify({ generator, source, accel, gyro, mag }, null, 2) + "\n";
}

/**
 * C float literal.
 * @param {number} v
 * @returns {string}
 */
export function cf(v) {
  if (v === 0) return "0.0f";
  const s = sig(v).toString();
  const lit = /[.e]/.test(s) ? s : `${s}.0`;
  return `${lit.replace("e+", "e")}f`;
}

/**
 * @param {number[]} v
 * @returns {string}
 */
const vec = (v) => `{${v.map(cf).join(", ")}}`;

/**
 * @param {number[][]} m
 * @param {string} indent
 * @returns {string}
 */
const mat = (m, indent) => `{\n${m.map((r) => `${indent}  ${vec(r)}`).join(",\n")}\n${indent}}`;

/**
 * @typedef {object} HeaderInput
 * @property {AccelResult | null} [accel]
 * @property {GyroResult | null} [gyro]
 * @property {MagResult | null} [mag]
 * @property {Units} units units the data was imported in
 * @property {string} [source] file name or sample name for the comment
 */

/**
 * C/C++ header with the calibration constants and apply functions.
 * @param {HeaderInput} input
 * @returns {string}
 */
export function cHeader(input) {
  const { accel, gyro, mag, units } = input;
  const out = [];
  out.push(`// Generated by imu-calibration-lab ${VERSION}`);
  out.push(`// https://github.com/projectbin07-stack/imu-calibration-lab`);
  if (input.source) out.push(`// Data: ${input.source.replace(/[\r\n]/g, " ")}`);
  out.push(
    "// Check the residuals in the report before trusting these numbers.",
    "#pragma once",
    "",
    "#include <stdint.h>",
    "",
  );
  const lsb = units.accel === "lsb" || units.gyro === "lsb";
  if (lsb)
    out.push("// MPU6050 full-scale settings the log was captured with (register map 4.17, 4.19).");
  if (units.accel === "lsb") {
    const per = { 2: 16384, 4: 8192, 8: 4096, 16: 2048 }[units.accelRange] ?? 16384;
    out.push(`#define IMU_ACCEL_LSB_PER_G ${cf(per)}  // AFS_SEL = +/-${units.accelRange} g`);
  }
  if (units.gyro === "lsb") {
    const per = { 250: 131, 500: 65.5, 1000: 32.8, 2000: 16.4 }[units.gyroRange] ?? 131;
    out.push(`#define IMU_GYRO_LSB_PER_DPS ${cf(per)}  // FS_SEL = +/-${units.gyroRange} deg/s`);
  }
  if (lsb) out.push("");
  if (accel) {
    out.push(
      `// Accelerometer, model "${accel.model}": a_cal = M (a - b), a in g.`,
      `// Pose residual |a|-1 g: RMS ${sig(accel.poseResiduals.rmsBefore * 1000, 3)} mg before, ${sig(accel.poseResiduals.rmsAfter * 1000, 3)} mg after.`,
      "typedef struct {",
      "  float bias[3];       // g",
      "  float matrix[3][3];  // scale and misalignment",
      "} imu_accel_cal_t;",
      "",
      `static const imu_accel_cal_t IMU_ACCEL_CAL = {\n  ${vec(accel.b)},\n  ${mat(accel.M, "  ")}\n};`,
      "",
      "static inline void imu_accel_apply(const imu_accel_cal_t *c, const float in[3], float out[3]) {",
      "  const float u[3] = {in[0] - c->bias[0], in[1] - c->bias[1], in[2] - c->bias[2]};",
      "  for (int i = 0; i < 3; i++)",
      "    out[i] = c->matrix[i][0] * u[0] + c->matrix[i][1] * u[1] + c->matrix[i][2] * u[2];",
      "}",
      "",
    );
  }
  if (gyro) {
    const t = gyro.temperature;
    out.push(
      t
        ? "// Gyroscope: w_cal = (w - (bias + temp_slope (T - ref_temp))) / scale, w in deg/s, T in degC."
        : "// Gyroscope: w_cal = (w - bias) / scale, w in deg/s.",
      "typedef struct {",
      "  float bias[3];        // deg/s" + (t ? " at ref_temp" : ""),
      "  float temp_slope[3];  // deg/s per degC",
      "  float ref_temp;       // degC",
      "  float scale[3];       // measured / true",
      "} imu_gyro_cal_t;",
      "",
      `static const imu_gyro_cal_t IMU_GYRO_CAL = {\n  ${vec(t ? t.bias : gyro.bias)},\n  ${vec(t ? t.slope : [0, 0, 0])},\n  ${cf(t ? t.refTemp : 25)},\n  ${vec(gyro.scale)}\n};`,
      "",
      "static inline void imu_gyro_apply(const imu_gyro_cal_t *c, const float in[3], float temp_c, float out[3]) {",
      "  for (int i = 0; i < 3; i++)",
      "    out[i] = (in[i] - (c->bias[i] + c->temp_slope[i] * (temp_c - c->ref_temp))) / c->scale[i];",
      "}",
      "",
    );
  }
  if (mag) {
    out.push(
      `// Magnetometer: m_cal = W (m - c), in the log's units (${units.mag}). Field ${sig(mag.fieldStrength, 4)}.`,
      "typedef struct {",
      "  float hard_iron[3];",
      "  float soft_iron[3][3];",
      "} imu_mag_cal_t;",
      "",
      `static const imu_mag_cal_t IMU_MAG_CAL = {\n  ${vec(mag.hardIron)},\n  ${mat(mag.softIron, "  ")}\n};`,
      "",
      "static inline void imu_mag_apply(const imu_mag_cal_t *c, const float in[3], float out[3]) {",
      "  const float u[3] = {in[0] - c->hard_iron[0], in[1] - c->hard_iron[1], in[2] - c->hard_iron[2]};",
      "  for (int i = 0; i < 3; i++)",
      "    out[i] = c->soft_iron[i][0] * u[0] + c->soft_iron[i][1] * u[1] + c->soft_iron[i][2] * u[2];",
      "}",
      "",
    );
  }
  out.push("/* Arduino example (MPU6050 at 0x68, Wire library):");
  out.push("", "  #include <Wire.h>", '  #include "imu_calibration.h"', "");
  out.push(
    "  static int16_t read16() { uint8_t hi = Wire.read(); uint8_t lo = Wire.read(); return (int16_t)((hi << 8) | lo); }",
    "",
  );
  out.push("  void loop() {");
  out.push("    Wire.beginTransmission(0x68); Wire.write(0x3B); Wire.endTransmission(false);");
  out.push("    Wire.requestFrom(0x68, 14);");
  out.push("    int16_t ax = read16(), ay = read16(), az = read16(), traw = read16();");
  out.push("    int16_t gx = read16(), gy = read16(), gz = read16();");
  out.push("    float temp_c = traw / 340.0f + 36.53f;");
  const ga = units.accel === "lsb" ? "IMU_ACCEL_LSB_PER_G" : "16384.0f";
  const gg = units.gyro === "lsb" ? "IMU_GYRO_LSB_PER_DPS" : "131.0f";
  if (accel) {
    out.push(`    float a[3] = {ax / ${ga}, ay / ${ga}, az / ${ga}}, a_cal[3];`);
    out.push("    imu_accel_apply(&IMU_ACCEL_CAL, a, a_cal);");
  }
  if (gyro) {
    out.push(`    float w[3] = {gx / ${gg}, gy / ${gg}, gz / ${gg}}, w_cal[3];`);
    out.push("    imu_gyro_apply(&IMU_GYRO_CAL, w, temp_c, w_cal);");
  }
  if (mag) {
    out.push("    float m[3] = {mx, my, mz}, m_cal[3];  // your magnetometer reading");
    out.push("    imu_mag_apply(&IMU_MAG_CAL, m, m_cal);");
  }
  out.push("  }");
  if (units.accel !== "lsb" || units.gyro !== "lsb")
    out.push(
      "",
      "  The divisors above assume the default ranges (+/-2 g, +/-250 deg/s);",
      "  use the ones your firmware configures.",
    );
  out.push("*/", "");
  return out.join("\n");
}
