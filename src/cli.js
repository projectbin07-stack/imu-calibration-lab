// Headless command-line interface. Runs the same src/core code as the
// browser app. Output is deterministic for a given file and options.

import { parseArgs } from "node:util";
import { calibrateAccel, CalibrationError } from "./core/accel.js";
import { allanForDataset } from "./core/allan.js";
import { CsvError } from "./core/csv.js";
import {
  accelJson,
  allanJson,
  cHeader,
  combinedJsonText,
  gyroJson,
  magJson,
  sig,
  VERSION,
} from "./core/export.js";
import { calibrateGyro } from "./core/gyro.js";
import { loadCsv, parseMapSpec } from "./core/load.js";
import { calibrateMag } from "./core/mag.js";
import { datasetToCsv, synthAccel, synthGyro, synthMag, synthNoise } from "./core/synth.js";
import {
  ACCEL_RANGES,
  ACCEL_UNITS,
  GYRO_RANGES,
  GYRO_UNITS,
  MAG_UNITS,
  TEMP_UNITS,
  TIME_UNITS,
} from "./core/units.js";

export { VERSION };

/**
 * @typedef {object} CliIo
 * @property {(text: string) => void} out
 * @property {(text: string) => void} err
 * @property {(path: string) => string} readFile
 * @property {(path: string, data: string) => void} writeFile
 */

const HELP = `imu-calibration-lab ${VERSION}: IMU calibration and noise analysis from logged data

Usage:
  imu-calibration-lab accel <file.csv> [options]   accelerometer bias, scale, misalignment
  imu-calibration-lab gyro <file.csv> [options]    gyroscope bias, temperature model, scale
  imu-calibration-lab mag <file.csv> [options]     magnetometer hard and soft iron
  imu-calibration-lab allan <file.csv> [options]   Allan deviation and noise terms
  imu-calibration-lab synth <kind> [options]       write a synthetic log (accel,
                                                   accel-axis, gyro, mag, noise)
  imu-calibration-lab combine <result.json>...     merge accel, gyro and mag --json
                                                   results into the page's export file
  imu-calibration-lab --help | --version

Output:
  --json                 print JSON instead of text
  --c                    print a C/C++ header (accel, gyro, mag)

Import (columns and units are detected; these override):
  --map <spec>           e.g. "t=millis,ax=AcX,ay=AcY,az=AcZ"; "temp=-" drops one
  --time-units s|ms|us
  --rate <Hz>            sample rate when the file has no time column
  --accel-units g|mps2|lsb    --accel-range 2|4|8|16   (MPU6050 full scale)
  --gyro-units dps|rads|lsb   --gyro-range 250|500|1000|2000
  --mag-units uT|nT|mG|gauss|raw    --temp-units C|mpu6050

Static detection (accel, gyro):
  --window <s>           moving-variance window (default 0.5)
  --k <x>                threshold = k x 20th percentile of the variance (default 10)
  --threshold <g^2>      fixed accelerometer variance threshold instead
  --min-static <s>       shortest static segment (default 1.5)

accel:  --model auto|six|twelve|nine (default auto)
gyro:   --angle <deg> known rotation angle (default 360)
        --rotation <t0,t1,axis>  use this window (s) and axis (x|y|z) for the scale
        --temp-bin <degC> (default 1; 0 disables the temperature model)
        --all-static  use every sample for the bias
mag:    --dip <deg>   inclination for the heading estimate (default: from the
                      accelerometer, else 45)
allan:  --sensor gyro|accel   --per-decade <n> (default 10)
synth:  --seed <n>  --raw (MPU6050 counts, t in ms)  --seconds <s> (noise)
        --out <file.csv> (default: standard output)
combine: --source <name>  "source" field (default: the result file names)
        --out <file.json> (default: standard output)

Everything runs locally; no file is uploaded anywhere.
`;

class UsageError extends Error {}
/** A result file that cannot go into the combined file. */
class InputError extends Error {}

/**
 * @template {string} T
 * @param {string | undefined} v
 * @param {readonly T[]} allowed
 * @param {string} name
 * @returns {T | undefined}
 */
function oneOf(v, allowed, name) {
  if (v === undefined) return undefined;
  if (!(/** @type {readonly string[]} */ (allowed).includes(v)))
    throw new UsageError(`${name} must be one of ${allowed.join(", ")}`);
  return /** @type {T} */ (v);
}

/**
 * @param {string | undefined} v
 * @param {string} name
 * @returns {number | undefined}
 */
function num(v, name) {
  if (v === undefined) return undefined;
  const x = Number(v);
  if (!Number.isFinite(x)) throw new UsageError(`${name} must be a number`);
  return x;
}

/**
 * @param {number} v
 * @param {number} [d]
 */
const f = (v, d = 4) => (Number.isFinite(v) ? sig(v, d).toString() : String(v));
/** @param {number[]} v @param {number} [d] */
const fv = (v, d = 5) => `[${v.map((x) => f(x, d)).join(", ")}]`;

const OPTIONS = /** @type {const} */ ({
  json: { type: "boolean" },
  c: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  map: { type: "string" },
  "time-units": { type: "string" },
  rate: { type: "string" },
  "accel-units": { type: "string" },
  "accel-range": { type: "string" },
  "gyro-units": { type: "string" },
  "gyro-range": { type: "string" },
  "mag-units": { type: "string" },
  "temp-units": { type: "string" },
  window: { type: "string" },
  k: { type: "string" },
  threshold: { type: "string" },
  "min-static": { type: "string" },
  model: { type: "string" },
  angle: { type: "string" },
  rotation: { type: "string" },
  "temp-bin": { type: "string" },
  "all-static": { type: "boolean" },
  dip: { type: "string" },
  sensor: { type: "string" },
  "per-decade": { type: "string" },
  seed: { type: "string" },
  raw: { type: "boolean" },
  seconds: { type: "string" },
  out: { type: "string" },
  source: { type: "string" },
});

/**
 * @param {string[]} argv
 * @param {CliIo} io
 * @returns {number} exit code
 */
export function main(argv, io) {
  try {
    return run(argv, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}\nRun with --help for usage.\n`);
      return 2;
    }
    if (
      e instanceof CsvError ||
      e instanceof CalibrationError ||
      e instanceof RangeError ||
      e instanceof InputError
    ) {
      io.err(`error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

/**
 * @param {string[]} argv
 * @param {CliIo} io
 * @returns {number}
 */
function run(argv, io) {
  /** @type {ReturnType<typeof parseArgs<{options: typeof OPTIONS, allowPositionals: true}>>} */
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    throw new UsageError(/** @type {Error} */ (e).message);
  }
  const { values: o, positionals } = parsed;
  if (o.version) {
    io.out(`${VERSION}\n`);
    return 0;
  }
  if (o.help || positionals.length === 0) {
    io.out(HELP);
    return 0;
  }
  const [cmd, arg] = positionals;
  if (cmd === "synth") return synth(arg, o, io);
  if (cmd === "combine") return combine(positionals.slice(1), o, io);
  if (!["accel", "gyro", "mag", "allan"].includes(cmd))
    throw new UsageError(`unknown command "${cmd}"`);
  if (!arg) throw new UsageError(`${cmd} needs a CSV file`);
  if (o.c && cmd === "allan") throw new UsageError("--c is for accel, gyro and mag");

  /** @type {Partial<import("./core/units.js").Units>} */
  const units = {};
  const set = (/** @type {string} */ key, /** @type {unknown} */ v) => {
    if (v !== undefined) Object.assign(units, { [key]: v });
  };
  set("time", oneOf(o["time-units"], TIME_UNITS, "--time-units"));
  set("accel", oneOf(o["accel-units"], ACCEL_UNITS, "--accel-units"));
  set("gyro", oneOf(o["gyro-units"], GYRO_UNITS, "--gyro-units"));
  set("mag", oneOf(o["mag-units"], MAG_UNITS, "--mag-units"));
  set("temp", oneOf(o["temp-units"], TEMP_UNITS, "--temp-units"));
  const ar = num(o["accel-range"], "--accel-range");
  if (ar !== undefined && !ACCEL_RANGES.includes(ar))
    throw new UsageError("--accel-range must be 2, 4, 8 or 16");
  set("accelRange", ar);
  const gr = num(o["gyro-range"], "--gyro-range");
  if (gr !== undefined && !GYRO_RANGES.includes(gr))
    throw new UsageError("--gyro-range must be 250, 500, 1000 or 2000");
  set("gyroRange", gr);

  const model = oneOf(o.model, /** @type {const} */ (["auto", "six", "twelve", "nine"]), "--model");
  const sensor = oneOf(o.sensor, /** @type {const} */ (["gyro", "accel"]), "--sensor");
  /** @type {{t0: number, t1: number, axis: number} | null} */
  let rotation = null;
  if (o.rotation) {
    const [a, b, ax] = o.rotation.split(",");
    const axis = ["x", "y", "z"].indexOf((ax ?? "").trim().toLowerCase());
    const t0 = num(a, "--rotation t0");
    const t1 = num(b, "--rotation t1");
    if (axis < 0 || t0 === undefined || t1 === undefined || !(t1 > t0))
      throw new UsageError("--rotation must be t0,t1,axis with t1 > t0 and axis x, y or z");
    rotation = { t0, t1, axis };
  }
  /** @type {Partial<import("./core/static.js").StaticOptions>} */
  const stat = {};
  const w = num(o.window, "--window");
  if (w !== undefined) stat.windowSeconds = w;
  const k = num(o.k, "--k");
  if (k !== undefined) stat.thresholdK = k;
  const th = num(o.threshold, "--threshold");
  if (th !== undefined) stat.accelThreshold = th;
  const ms = num(o["min-static"], "--min-static");
  if (ms !== undefined) stat.minSeconds = ms;
  const angle = num(o.angle, "--angle");
  const tempBin = num(o["temp-bin"], "--temp-bin");
  const dip = num(o.dip, "--dip");
  const perDecade = num(o["per-decade"], "--per-decade");
  const rate = num(o.rate, "--rate");

  let text;
  try {
    text = io.readFile(arg);
  } catch (e) {
    io.err(`error: cannot read ${arg}: ${/** @type {Error} */ (e).message}\n`);
    return 1;
  }
  const loaded = loadCsv(text, {
    mapping: o.map ? parseMapSpec(o.map) : {},
    units,
    rate,
  });
  const { data } = loaded;

  const u = loaded.units;
  const unitText = [
    data.acc && `accel ${u.accel}${u.accel === "lsb" ? ` (+/-${u.accelRange} g)` : ""}`,
    data.gyro && `gyro ${u.gyro}${u.gyro === "lsb" ? ` (+/-${u.gyroRange} deg/s)` : ""}`,
    data.mag && `mag ${u.mag}`,
    data.temp && `temp ${u.temp}`,
  ]
    .filter(Boolean)
    .join(", ");
  const head = `${arg}: ${data.t.length} samples, ${f(data.t[data.t.length - 1], 5)} s at ${f(data.fs, 4)} Hz; ${unitText}
`;
  const warnLines = (/** @type {string[]} */ ws) => ws.map((x) => `warning: ${x}\n`).join("");

  if (cmd === "accel") {
    const r = calibrateAccel(data, { model, static: stat });
    if (o.c) io.out(cHeader({ accel: r, units: loaded.units, source: arg }));
    else if (o.json) io.out(JSON.stringify(accelJson(r), null, 2) + "\n");
    else {
      let s = head + warnLines(data.warnings);
      s += `static segments: ${r.detection.segments} (threshold ${f(r.detection.threshold, 3)} g^2, window ${r.detection.window} samples) -> ${r.poses.length} poses\n`;
      s +=
        "pose  time (s)        samples  label    mean (g)                          |a| before  after\n";
      r.poses.forEach((p, i) => {
        s += `${String(i + 1).padStart(4)}  ${`${p.t0.toFixed(1)}-${p.t1.toFixed(1)}`.padEnd(14)}  ${String(p.n).padStart(7)}  ${p.label.padEnd(7)}  ${p.mean.map((v) => v.toFixed(4).padStart(8)).join(" ")}    ${p.normBefore.toFixed(4)}    ${p.normAfter.toFixed(5)}\n`;
      });
      s += `model: ${r.model}${r.fit ? ` (Levenberg-Marquardt, ${r.fit.iterations} iterations, condition ${f(r.fit.condition, 3)})` : ""}\n`;
      s += `bias b (g):            ${fv(r.b)}\n`;
      s += `matrix M:              ${fv(r.M[0])}\n                       ${fv(r.M[1])}\n                       ${fv(r.M[2])}\n`;
      s += `scale (raw g per g):   ${fv(r.scale)}\n`;
      const no = r.nonOrthogonalityDeg;
      s += `non-orthogonality:     xy ${f(no.xy, 3)} deg, xz ${f(no.xz, 3)} deg, yz ${f(no.yz, 3)} deg\n`;
      const pr = r.poseResiduals;
      s += `|a|-1 over poses:      RMS ${f(pr.rmsBefore * 1000, 3)} mg -> ${f(pr.rmsAfter * 1000, 3)} mg, max ${f(pr.maxBefore * 1000, 3)} mg -> ${f(pr.maxAfter * 1000, 3)} mg\n`;
      s += warnLines(r.warnings);
      io.out(s);
    }
    return 0;
  }
  if (cmd === "gyro") {
    /** @type {Partial<import("./core/gyro.js").GyroOptions>} */
    const go = { static: stat, rotation };
    if (angle !== undefined) go.knownAngle = angle;
    if (tempBin !== undefined) go.tempBin = tempBin;
    if (o["all-static"]) go.wholeFileStatic = true;
    const r = calibrateGyro(data, go);
    if (o.c) io.out(cHeader({ gyro: r, units: loaded.units, source: arg }));
    else if (o.json) io.out(JSON.stringify(gyroJson(r), null, 2) + "\n");
    else {
      let s = head + warnLines(data.warnings);
      s += `static samples: ${r.staticSamples} in ${r.segments.length} segment(s)\n`;
      s += `bias (deg/s):          ${fv(r.bias)}\n`;
      s += `noise std (deg/s):     ${fv(r.noiseStd, 3)}\n`;
      if (r.temperature) {
        const t = r.temperature;
        s += `temperature model:     bias(T) = b + k (T - ${f(t.refTemp, 4)} degC), ${t.bins.length} bins from ${f(t.bins[0].temp, 3)} to ${f(t.bins[t.bins.length - 1].temp, 3)} degC\n`;
        s += `  b (deg/s):           ${fv(t.bias)}\n`;
        s += `  k (deg/s per degC):  ${fv(t.slope, 3)}\n`;
      }
      for (const rot of r.rotations)
        s += `rotation ${"XYZ"[rot.axis]}: ${f(rot.t0, 4)}-${f(rot.t1, 4)} s, integrated ${fv(rot.integrated, 5)} deg vs ${f(rot.known)} deg -> scale ${f(rot.scale, 5)}\n`;
      s += `scale:                 ${fv(r.scale)}\n`;
      s += warnLines(r.warnings);
      io.out(s);
    }
    return 0;
  }
  if (cmd === "mag") {
    const r = calibrateMag(data, { dipDeg: dip ?? null });
    if (o.c) io.out(cHeader({ mag: r, units: loaded.units, source: arg }));
    else if (o.json) io.out(JSON.stringify(magJson(r), null, 2) + "\n");
    else {
      let s = head + warnLines(data.warnings);
      s += `hard iron c:           ${fv(r.hardIron)} ${loaded.units.mag}\n`;
      s += `soft iron W:           ${fv(r.softIron[0])}\n                       ${fv(r.softIron[1])}\n                       ${fv(r.softIron[2])}\n`;
      s += `field strength:        ${f(r.fieldStrength)} ${loaded.units.mag}\n`;
      s += `semi-axes:             ${fv(r.radii, 4)}\n`;
      s += `sphericity (min/max):  ${f(r.sphericity.before, 4)} -> ${f(r.sphericity.after, 4)}\n`;
      s += `|m| spread (std/mean): ${f(r.magnitude.before.cv * 100, 3)} % -> ${f(r.magnitude.after.cv * 100, 3)} %\n`;
      s += `coverage:              ${f(r.coverage, 3)} (1 = all directions)\n`;
      s += `heading error (level, dip ${f(r.heading.dipDeg, 3)} deg from ${r.heading.dipSource}): up to ${f(r.heading.beforeDeg, 3)} deg uncorrected, about ${f(r.heading.afterDeg, 2)} deg after\n`;
      s += warnLines(r.warnings);
      io.out(s);
    }
    return 0;
  }
  // allan
  const r = allanForDataset(data, { sensor, perDecade });
  if (o.json) io.out(JSON.stringify(allanJson(r), null, 2) + "\n");
  else {
    let s = head + warnLines(r.warnings);
    s += `Allan deviation (${r.sensor}), ${r.axes[0].curve.tau.length} cluster times from ${f(r.axes[0].curve.tau[0], 3)} s to ${f(r.axes[0].curve.tau[r.axes[0].curve.tau.length - 1], 4)} s\n`;
    const u = r.units;
    s += `axis  white noise (${u.whiteNoise})  bias instability (${u.biasInstability})  rate random walk (${u.rateRandomWalk})\n`;
    r.axes.forEach((a, i) => {
      const c = r.converted[i];
      const wn = a.terms.whiteNoise;
      const bi = a.terms.biasInstability;
      const rr = a.terms.rateRandomWalk;
      const cell = (/** @type {number | null} */ v, /** @type {number | undefined} */ e) =>
        v === null ? "not found" : `${f(v, 3)} +/- ${f((e ?? 0) * 100, 2)} %`;
      s +=
        `${a.axis}     ${cell(c.whiteNoise, wn?.relError).padEnd(24)}  ${(bi?.atEnd ? "<= " : "") + cell(c.biasInstability, bi?.relError)}${bi ? ` at ${f(bi.tau, 3)} s` : ""}`.padEnd(
          70,
        );
      s += `  ${cell(c.rateRandomWalk, rr?.relError)}\n`;
    });
    s += "Confidence: 1-sigma error of a single Allan deviation point, 1/sqrt(2 (N/m - 1)).\n";
    io.out(s);
  }
  return 0;
}

/**
 * @param {string | undefined} kind
 * @param {Record<string, string | boolean | undefined>} o
 * @param {CliIo} io
 * @returns {number}
 */
function synth(kind, o, io) {
  const seed = num(/** @type {string | undefined} */ (o.seed), "--seed");
  const s = seed === undefined ? {} : { seed };
  let d;
  if (kind === "accel") d = synthAccel(s).data;
  else if (kind === "accel-axis") d = synthAccel({ ...s, poses: "axis" }).data;
  else if (kind === "gyro") d = synthGyro(s).data;
  else if (kind === "mag") d = synthMag(s).data;
  else if (kind === "noise") {
    const seconds = num(/** @type {string | undefined} */ (o.seconds), "--seconds");
    d = synthNoise({ ...s, ...(seconds === undefined ? {} : { seconds }) }).data;
  } else throw new UsageError("synth kind must be accel, accel-axis, gyro, mag or noise");
  const csv = `# synthetic ${kind} log from imu-calibration-lab ${VERSION}${seed === undefined ? "" : ` seed ${seed}`}; not sensor data\n${datasetToCsv(d, { raw: Boolean(o.raw) })}`;
  if (typeof o.out === "string") {
    io.writeFile(o.out, csv);
    io.err(`wrote ${o.out}: ${d.t.length} samples\n`);
  } else io.out(csv);
  return 0;
}

const COMBINED_KINDS = /** @type {const} */ (["accel", "gyro", "mag"]);

/**
 * Merge single `--json` results into the combined file the page exports.
 * @param {string[]} files
 * @param {Record<string, string | boolean | undefined>} o
 * @param {CliIo} io
 * @returns {number}
 */
function combine(files, o, io) {
  if (files.length === 0) throw new UsageError("combine needs at least one result JSON file");
  if (o.c) throw new UsageError("--c is not available for combine");
  /** @type {Record<string, { file: string, json: unknown }>} */
  const parts = {};
  for (const file of files) {
    let text;
    try {
      text = io.readFile(file);
    } catch (e) {
      throw new InputError(`cannot read ${file}: ${/** @type {Error} */ (e).message}`);
    }
    /** @type {unknown} */
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new InputError(`${file}: not valid JSON: ${/** @type {Error} */ (e).message}`);
    }
    const kind =
      json && typeof json === "object" && !Array.isArray(json)
        ? /** @type {{ kind?: unknown }} */ (json).kind
        : undefined;
    if (typeof kind !== "string")
      throw new InputError(
        `${file}: no "kind" field; expected the --json output of accel, gyro or mag`,
      );
    if (!(/** @type {readonly string[]} */ (COMBINED_KINDS).includes(kind)))
      throw new InputError(
        `${file}: kind "${kind}" is not part of the combined file (accel, gyro or mag)`,
      );
    const prev = parts[kind];
    if (prev) throw new InputError(`${file}: a second ${kind} result (the first is ${prev.file})`);
    parts[kind] = { file, json };
  }
  const source = typeof o.source === "string" ? o.source : files.join(", ");
  const text = combinedJsonText({
    source,
    accel: parts.accel?.json ?? null,
    gyro: parts.gyro?.json ?? null,
    mag: parts.mag?.json ?? null,
  });
  if (typeof o.out === "string") {
    io.writeFile(o.out, text);
    const kinds = COMBINED_KINDS.filter((k) => parts[k]);
    io.err(`wrote ${o.out}: ${kinds.join(", ")}\n`);
  } else io.out(text);
  return 0;
}
