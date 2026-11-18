// Units and the MPU6050 register scaling. Internally accelerations are in g,
// angular rates in deg/s, magnetic field in microtesla (or whatever unit the
// log uses, see MAG_UNITS) and temperature in degC.
//
// MPU6050 sensitivities: InvenSense register map RM-MPU-6000A-00 rev 4.2,
// sections 4.17 (ACCEL_XOUT..ZOUT, AFS_SEL) and 4.19 (GYRO_XOUT..ZOUT,
// FS_SEL); temperature from section 4.18. See docs/methods.md section 6.

/** Standard gravity, m/s^2 (CGPM 1901, ISO 80000-3). */
export const STANDARD_GRAVITY = 9.80665;

/**
 * Accelerometer LSB per g for each full-scale range (AFS_SEL 0..3).
 * @type {Record<number, number>}
 */
export const MPU6050_ACCEL_LSB_PER_G = { 2: 16384, 4: 8192, 8: 4096, 16: 2048 };

/**
 * Gyroscope LSB per deg/s for each full-scale range (FS_SEL 0..3).
 * @type {Record<number, number>}
 */
export const MPU6050_GYRO_LSB_PER_DPS = { 250: 131, 500: 65.5, 1000: 32.8, 2000: 16.4 };

/** @typedef {"g" | "mps2" | "lsb"} AccelUnit */
/** @typedef {"dps" | "rads" | "lsb"} GyroUnit */
/** @typedef {"uT" | "nT" | "mG" | "gauss" | "raw"} MagUnit */
/** @typedef {"C" | "mpu6050"} TempUnit */
/** @typedef {"s" | "ms" | "us"} TimeUnit */

/**
 * @typedef {object} Units
 * @property {AccelUnit} accel
 * @property {number} accelRange MPU6050 full scale in g, used when accel is "lsb"
 * @property {GyroUnit} gyro
 * @property {number} gyroRange MPU6050 full scale in deg/s, used when gyro is "lsb"
 * @property {MagUnit} mag
 * @property {TempUnit} temp
 * @property {TimeUnit} time
 */

/** @type {AccelUnit[]} */
export const ACCEL_UNITS = ["g", "mps2", "lsb"];
/** @type {GyroUnit[]} */
export const GYRO_UNITS = ["dps", "rads", "lsb"];
/** @type {MagUnit[]} */
export const MAG_UNITS = ["uT", "nT", "mG", "gauss", "raw"];
/** @type {TempUnit[]} */
export const TEMP_UNITS = ["C", "mpu6050"];
/** @type {TimeUnit[]} */
export const TIME_UNITS = ["s", "ms", "us"];
export const ACCEL_RANGES = [2, 4, 8, 16];
export const GYRO_RANGES = [250, 500, 1000, 2000];

/** @returns {Units} */
export function defaultUnits() {
  return {
    accel: "g",
    accelRange: 2,
    gyro: "dps",
    gyroRange: 250,
    mag: "uT",
    temp: "C",
    time: "s",
  };
}

/**
 * Factor that converts an accelerometer reading to g.
 * @param {AccelUnit} unit
 * @param {number} range
 * @returns {number}
 */
export function accelToG(unit, range) {
  if (unit === "g") return 1;
  if (unit === "mps2") return 1 / STANDARD_GRAVITY;
  const lsb = MPU6050_ACCEL_LSB_PER_G[range];
  if (!lsb) throw new RangeError(`MPU6050 accelerometer range must be 2, 4, 8 or 16 g`);
  return 1 / lsb;
}

/**
 * Factor that converts a gyroscope reading to deg/s.
 * @param {GyroUnit} unit
 * @param {number} range
 * @returns {number}
 */
export function gyroToDps(unit, range) {
  if (unit === "dps") return 1;
  if (unit === "rads") return 180 / Math.PI;
  const lsb = MPU6050_GYRO_LSB_PER_DPS[range];
  if (!lsb) throw new RangeError(`MPU6050 gyroscope range must be 250, 500, 1000 or 2000 deg/s`);
  return 1 / lsb;
}

/**
 * Factor that converts a magnetometer reading to microtesla. "raw" keeps the
 * sensor counts: an ellipsoid fit does not need physical units.
 * @param {MagUnit} unit
 * @returns {number}
 */
export function magToUt(unit) {
  return { uT: 1, nT: 1e-3, mG: 0.1, gauss: 100, raw: 1 }[unit];
}

/**
 * MPU6050 die temperature from the raw TEMP_OUT register value.
 * @param {number} raw signed 16-bit
 * @returns {number} degC
 */
export function mpu6050Temperature(raw) {
  return raw / 340 + 36.53;
}

/**
 * @param {TimeUnit} unit
 * @returns {number} seconds per unit
 */
export function timeToSeconds(unit) {
  return { s: 1, ms: 1e-3, us: 1e-6 }[unit];
}
