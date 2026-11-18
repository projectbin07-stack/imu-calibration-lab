// The sample datasets offered in the browser. All are synthetic (see
// synth.js); the descriptions say so and list the true parameters, so the
// recovered values can be compared with them.

import { datasetToCsv, synthAccel, synthGyro, synthMag, synthNoise } from "./synth.js";

/**
 * @typedef {object} Sample
 * @property {string} id
 * @property {string} name
 * @property {"accel" | "gyro" | "mag" | "allan"} tab the tab it is meant for
 * @property {string} truth the parameters it was generated with
 */

/** @type {Sample[]} */
export const SAMPLES = [
  {
    id: "accel",
    name: "Accelerometer, 15 poses (g)",
    tab: "accel",
    truth:
      "bias [31, -24, 52] mg; scale [1.012, 0.991, 1.023]; axis coupling up to 0.008 rad; 400 ug/sqrt(Hz) white noise",
  },
  {
    id: "accel-raw",
    name: "Accelerometer, 6 axis poses (MPU6050 raw)",
    tab: "accel",
    truth: "same sensor as the 15-pose sample, written as +/-2 g raw counts with t in ms",
  },
  {
    id: "gyro",
    name: "Gyroscope, warm-up and 360 deg turns (raw)",
    tab: "gyro",
    truth:
      "bias at 25 degC [-1.8, 0.9, 0.35] deg/s; slope [0.021, -0.012, 0.03] deg/s per degC; scale [1.021, 0.987, 1.034]; +/-250 deg/s raw counts",
  },
  {
    id: "mag",
    name: "Magnetometer tumble",
    tab: "mag",
    truth:
      "42 uT field, dip 25 deg; hard iron [18.5, -7.2, 31.0] uT; symmetric soft iron with diagonal [1.08, 0.93, 1.01]; 0.4 uT noise",
  },
  {
    id: "noise",
    name: "Stationary 1 h noise log (Allan)",
    tab: "allan",
    truth:
      "gyro white noise [0.005, 0.006, 0.0055] deg/s/sqrt(Hz) = [0.30, 0.36, 0.33] deg/sqrt(h); rate random walk [43, 54, 32] deg/h/sqrt(h); Gauss-Markov bias, 60 s; accel 400 ug/sqrt(Hz)",
  },
];

/**
 * Generate a sample. The small ones come back as CSV text so they go through
 * the same import path as a dropped file; the 1 h noise log (360 000 rows)
 * comes back as a dataset to skip formatting and parsing 25 MB of text.
 * @param {string} id
 * @returns {{csv: string} | {data: import("./csv.js").Dataset}}
 */
export function makeSample(id) {
  switch (id) {
    case "accel":
      return { csv: datasetToCsv(synthAccel({ seed: 1 }).data) };
    case "accel-raw":
      return { csv: datasetToCsv(synthAccel({ seed: 1, poses: "axis" }).data, { raw: true }) };
    case "gyro":
      return { csv: datasetToCsv(synthGyro({ seed: 2, holdSeconds: 20 }).data, { raw: true }) };
    case "mag":
      return { csv: datasetToCsv(synthMag({ seed: 3 }).data, { digits: 5 }) };
    case "noise":
      return { data: synthNoise({ seed: 4 }).data };
    default:
      throw new RangeError(`unknown sample "${id}"`);
  }
}
