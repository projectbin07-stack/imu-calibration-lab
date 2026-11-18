// CSV import: text -> table -> dataset. Handles the plain
// t,ax,ay,az,gx,gy,gz,mx,my,mz layout, files with arbitrary column names
// (mapped automatically or by hand), headerless numeric files, and both
// serial-scope exports: the decoded CSV (host_time,device_time,source,
// <channels>) and the snapshot CSV (channel,time,value).

import { accelToG, gyroToDps, magToUt, mpu6050Temperature, timeToSeconds } from "./units.js";

/** @typedef {import("./units.js").Units} Units */

export class CsvError extends Error {
  /**
   * @param {string} message
   * @param {number} [line] 1-based line number in the file
   */
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line ?? null;
  }
}

/**
 * @typedef {object} Table
 * @property {string[]} header
 * @property {string[][]} rows
 * @property {number[]} lines 1-based file line of each row
 * @property {string} delimiter
 * @property {"header" | "headerless" | "serial-scope" | "serial-scope-snapshot"} kind
 */

/**
 * Split one line into fields; double quotes protect delimiters and "" is a
 * literal quote. Fields are trimmed.
 * @param {string} line
 * @param {string} delimiter
 * @param {number} lineNo
 * @returns {string[]}
 */
export function splitLine(line, delimiter, lineNo) {
  /** @type {string[]} */
  const out = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (wasQuoted && ch !== delimiter && ch.trim() === "") {
      // whitespace after a closing quote
    } else if (ch === '"' && field.trim() === "") {
      quoted = true;
      wasQuoted = true;
      field = "";
    } else if (ch === delimiter) {
      out.push(wasQuoted ? field : field.trim());
      field = "";
      wasQuoted = false;
    } else field += ch;
  }
  if (quoted) throw new CsvError("unterminated quoted field", lineNo);
  out.push(wasQuoted ? field : field.trim());
  return out;
}

/**
 * @param {string} s
 * @returns {boolean}
 */
export function isNumeric(s) {
  return s.trim() !== "" && Number.isFinite(Number(s));
}

/**
 * Parse CSV text into a table. Blank lines and lines starting with '#' are
 * skipped. The delimiter is the first of ',', ';', tab that occurs in the
 * first data line. A first line made only of numbers means no header.
 * @param {string} text
 * @returns {Table}
 */
export function parseTable(text) {
  const raw = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  /** @type {Array<[number, string]>} */
  const lines = [];
  raw.forEach((l, i) => {
    const t = l.trim();
    if (t !== "" && !t.startsWith("#")) lines.push([i + 1, l]);
  });
  if (lines.length === 0) throw new CsvError("the file has no data lines");
  const first = lines[0][1];
  const delimiter = [",", ";", "\t"].find((d) => first.includes(d)) ?? ",";
  const firstFields = splitLine(first, delimiter, lines[0][0]);
  const headerless = firstFields.every(isNumeric);
  /** @type {string[]} */
  let header;
  if (headerless) header = defaultNames(firstFields.length);
  else {
    header = firstFields;
    const seen = new Set();
    for (const [i, name] of header.entries()) {
      if (name === "") throw new CsvError(`column ${i + 1} has an empty name`, lines[0][0]);
      if (seen.has(name)) throw new CsvError(`duplicate column name "${name}"`, lines[0][0]);
      seen.add(name);
    }
  }
  /** @type {string[][]} */
  const rows = [];
  /** @type {number[]} */
  const lineNos = [];
  for (const [lineNo, l] of headerless ? lines : lines.slice(1)) {
    const fields = splitLine(l, delimiter, lineNo);
    if (fields.length !== header.length)
      throw new CsvError(`expected ${header.length} fields, found ${fields.length}`, lineNo);
    rows.push(fields);
    lineNos.push(lineNo);
  }
  if (rows.length === 0) throw new CsvError("the file has a header but no data rows");
  /** @type {Table["kind"]} */
  let kind = headerless ? "headerless" : "header";
  const lower = header.map((h) => h.toLowerCase());
  if (lower[0] === "host_time" && lower[1] === "device_time" && lower[2] === "source")
    kind = "serial-scope";
  if (lower.length === 3 && lower[0] === "channel" && lower[1] === "time" && lower[2] === "value")
    return pivotSnapshot({ header, rows, lines: lineNos, delimiter, kind });
  return { header, rows, lines: lineNos, delimiter, kind };
}

/**
 * Column names for a headerless file: the plain layouts get their usual
 * names, anything else c1..cn.
 * @param {number} n
 * @returns {string[]}
 */
function defaultNames(n) {
  const plain = ["t", "ax", "ay", "az", "gx", "gy", "gz", "mx", "my", "mz"];
  if (n === 7 || n === 10) return plain.slice(0, n);
  if (n === 8) return [...plain.slice(0, 7), "temp"];
  return Array.from({ length: n }, (_, i) => `c${i + 1}`);
}

/**
 * serial-scope snapshot files have one row per point (channel,time,value).
 * Points that share a time stamp become one row; a channel without a point
 * at that time is left empty.
 * @param {Table} long
 * @returns {Table}
 */
function pivotSnapshot(long) {
  /** @type {string[]} */
  const channels = [];
  /** @type {Map<string, {line: number, values: Map<string, string>}>} */
  const byTime = new Map();
  long.rows.forEach(([channel, time, value], i) => {
    if (!isNumeric(time)) throw new CsvError(`time "${time}" is not a number`, long.lines[i]);
    if (channel === "") throw new CsvError("empty channel name", long.lines[i]);
    if (!channels.includes(channel)) channels.push(channel);
    let row = byTime.get(time);
    if (!row) {
      row = { line: long.lines[i], values: new Map() };
      byTime.set(time, row);
    }
    row.values.set(channel, value);
  });
  const times = [...byTime.keys()].sort((a, b) => Number(a) - Number(b));
  return {
    header: ["time", ...channels],
    rows: times.map((t) => {
      const r = /** @type {{line: number, values: Map<string, string>}} */ (byTime.get(t));
      return [t, ...channels.map((c) => r.values.get(c) ?? "")];
    }),
    lines: times.map((t) => /** @type {{line: number}} */ (byTime.get(t)).line),
    delimiter: long.delimiter,
    kind: "serial-scope-snapshot",
  };
}

/** Channels the importer knows about. */
export const CHANNELS = /** @type {const} */ ([
  "ax",
  "ay",
  "az",
  "gx",
  "gy",
  "gz",
  "mx",
  "my",
  "mz",
  "temp",
]);
/** @typedef {typeof CHANNELS[number]} Channel */

/**
 * Column name for time and for each channel, or null when absent.
 * @typedef {{t: string | null} & Record<Channel, string | null>} Mapping
 */

/** @returns {Mapping} */
export function emptyMapping() {
  return {
    t: null,
    ax: null,
    ay: null,
    az: null,
    gx: null,
    gy: null,
    gz: null,
    mx: null,
    my: null,
    mz: null,
    temp: null,
  };
}

/**
 * Lower case, units in brackets removed, only letters and digits kept.
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const PREFIXES = {
  a: ["a", "ac", "acc", "accel", "acceleration", "accelerometer", "imuacc", "imua"],
  g: ["g", "gy", "gyr", "gyro", "gyroscope", "w", "omega", "rate", "imugyro", "imug"],
  m: ["m", "mag", "magn", "magnetometer", "b", "imumag", "imum"],
};

/** @type {Record<string, number>} seconds per unit, by normalised time-column name */
const TIME_NAMES = {
  t: 1,
  time: 1,
  ts: 1,
  timestamp: 1,
  seconds: 1,
  sec: 1,
  timesec: 1,
  devicetime: 1,
  hosttime: 1,
  tms: 1e-3,
  timems: 1e-3,
  millis: 1e-3,
  ms: 1e-3,
  tus: 1e-6,
  timeus: 1e-6,
  micros: 1e-6,
  us: 1e-6,
};

/**
 * Guess the column mapping from the header. Exact plain names win over
 * prefixed ones; for serial-scope exports the device clock is used when the
 * column has values, otherwise the host clock.
 * @param {Table} table
 * @returns {{mapping: Mapping, timeUnit: import("./units.js").TimeUnit}}
 */
export function autoMap(table) {
  const mapping = emptyMapping();
  const names = table.header.map(normalizeName);
  for (const ch of CHANNELS) {
    if (ch === "temp") {
      const i = names.findIndex((n) =>
        ["temp", "temperature", "tmp", "tempc", "dietemp", "t_c", "tc", "degc"].includes(n),
      );
      if (i >= 0) mapping.temp = table.header[i];
      continue;
    }
    const kind = /** @type {"a" | "g" | "m"} */ (ch[0]);
    const axis = ch[1];
    const i = names.findIndex((n) =>
      PREFIXES[kind].some(
        (p) => n === p + axis || n === p + axis + "raw" || n === "raw" + p + axis,
      ),
    );
    if (i >= 0) mapping[ch] = table.header[i];
  }
  /** @type {import("./units.js").TimeUnit} */
  let timeUnit = "s";
  if (table.kind === "serial-scope") {
    const deviceHasValues = table.rows.some((r) => r[1] !== "");
    mapping.t = table.header[deviceHasValues ? 1 : 0];
  } else {
    const i = names.findIndex((n) => n in TIME_NAMES);
    if (i >= 0) {
      mapping.t = table.header[i];
      const f = TIME_NAMES[names[i]];
      timeUnit = f === 1 ? "s" : f === 1e-3 ? "ms" : "us";
    }
  }
  return { mapping, timeUnit };
}

/** @typedef {[Float64Array, Float64Array, Float64Array]} Series3 */

/**
 * @typedef {object} Dataset
 * @property {Float64Array} t seconds from the first sample
 * @property {Series3 | null} acc g
 * @property {Series3 | null} gyro deg/s
 * @property {Series3 | null} mag microtesla (or raw counts)
 * @property {Float64Array | null} temp degC
 * @property {number} fs sample rate from the median time step, Hz
 * @property {number} skipped rows skipped because a mapped field was empty
 * @property {string[]} warnings
 */

/**
 * Convert the mapped columns of a table to a dataset in internal units.
 * A row with an empty mapped field is skipped (serial-scope exports leave a
 * channel empty in rows from other record types); any other non-numeric
 * value is an error with its line number. Time must not go backwards.
 * @param {Table} table
 * @param {Mapping} mapping
 * @param {Units} units
 * @param {{rate?: number}} [opts] sample rate when there is no time column
 * @returns {Dataset}
 */
export function buildDataset(table, mapping, units, opts = {}) {
  /** @type {Array<[string, number]>} */
  const used = [];
  for (const key of /** @type {Array<keyof Mapping>} */ (["t", ...CHANNELS])) {
    const name = mapping[key];
    if (name === null) continue;
    const idx = table.header.indexOf(name);
    if (idx < 0) throw new CsvError(`column "${name}" (mapped to ${key}) is not in the file`);
    used.push([key, idx]);
  }
  const groups = {
    acc: /** @type {const} */ (["ax", "ay", "az"]),
    gyro: /** @type {const} */ (["gx", "gy", "gz"]),
    mag: /** @type {const} */ (["mx", "my", "mz"]),
  };
  for (const [g, keys] of Object.entries(groups)) {
    const n = keys.filter((k) => mapping[k] !== null).length;
    if (n !== 0 && n !== 3) throw new CsvError(`map all three ${g} axes or none`);
  }
  if (used.every(([k]) => k === "t" || k === "temp"))
    throw new CsvError("no sensor columns are mapped");

  /** @type {Record<string, number[]>} */
  const cols = {};
  for (const [k] of used) cols[k] = [];
  let skipped = 0;
  /** @type {number[]} */
  const lineOf = [];
  table.rows.forEach((row, r) => {
    const fields = used.map(([, idx]) => row[idx]);
    if (fields.some((f) => f === "")) {
      skipped++;
      return;
    }
    used.forEach(([k], j) => {
      const v = Number(fields[j]);
      if (!Number.isFinite(v) || fields[j].trim() === "")
        throw new CsvError(
          `"${fields[j]}" in column "${table.header[used[j][1]]}" is not a number`,
          table.lines[r],
        );
      cols[k].push(v);
    });
    lineOf.push(table.lines[r]);
  });
  const n = lineOf.length;
  if (n < 2) throw new CsvError("fewer than two complete rows");

  /** @type {string[]} */
  const warnings = [];
  const t = new Float64Array(n);
  if (cols.t) {
    const f = timeToSeconds(units.time);
    const t0 = cols.t[0];
    for (let i = 0; i < n; i++) {
      t[i] = (cols.t[i] - t0) * f;
      if (i > 0 && t[i] < t[i - 1])
        throw new CsvError(`time goes backwards (${cols.t[i - 1]} -> ${cols.t[i]})`, lineOf[i]);
    }
  } else {
    const rate = opts.rate ?? 100;
    if (!(rate > 0)) throw new CsvError("sample rate must be positive");
    for (let i = 0; i < n; i++) t[i] = i / rate;
    warnings.push(`no time column: assuming ${rate} Hz`);
  }
  const steps = [];
  for (let i = 1; i < n; i++) steps.push(t[i] - t[i - 1]);
  const sorted = [...steps].sort((a, b) => a - b);
  const dt = sorted[Math.floor(sorted.length / 2)];
  if (!(dt > 0)) throw new CsvError("most time stamps are repeated; check the time column");
  const gaps = steps.filter((s) => s > 3 * dt).length;
  if (gaps > 0) warnings.push(`${gaps} gap(s) longer than 3 sample periods in the time column`);
  if (skipped > 0) warnings.push(`${skipped} row(s) skipped because a mapped field was empty`);

  /**
   * @param {readonly [string, string, string]} keys
   * @param {number} factor
   * @returns {Series3 | null}
   */
  const series = (keys, factor) =>
    cols[keys[0]]
      ? /** @type {Series3} */ (keys.map((k) => Float64Array.from(cols[k], (v) => v * factor)))
      : null;
  return {
    t,
    acc: series(groups.acc, accelToG(units.accel, units.accelRange)),
    gyro: series(groups.gyro, gyroToDps(units.gyro, units.gyroRange)),
    mag: series(groups.mag, magToUt(units.mag)),
    temp: cols.temp
      ? Float64Array.from(cols.temp, (v) => (units.temp === "mpu6050" ? mpu6050Temperature(v) : v))
      : null,
    fs: 1 / dt,
    skipped,
    warnings,
  };
}

/**
 * Median of |v| over the rows of three columns, ignoring empty fields.
 * @param {Table} table
 * @param {Array<string | null>} names
 * @returns {number | null}
 */
function medianNorm(table, names) {
  if (names.some((n) => n === null)) return null;
  const idx = names.map((n) => table.header.indexOf(/** @type {string} */ (n)));
  /** @type {number[]} */
  const norms = [];
  const step = Math.max(1, Math.floor(table.rows.length / 2000));
  for (let r = 0; r < table.rows.length; r += step) {
    const v = idx.map((i) => Number(table.rows[r][i]));
    if (idx.some((i) => table.rows[r][i] === "") || v.some((x) => !Number.isFinite(x))) continue;
    norms.push(Math.hypot(...v));
  }
  if (norms.length === 0) return null;
  norms.sort((a, b) => a - b);
  return norms[Math.floor(norms.length / 2)];
}

/**
 * Guess units from magnitudes: an accelerometer at rest reads |a| = 1 g,
 * 9.81 m/s^2 or thousands of LSB; the Earth's field is 25-65 uT, 250-650 mG
 * or 0.25-0.65 gauss. Gyroscope units follow the accelerometer (raw logs are
 * usually raw throughout); MPU6050 temperature is raw when it is far outside
 * -40..125.
 * @param {Table} table
 * @param {Mapping} mapping
 * @returns {Partial<Units>}
 */
export function guessUnits(table, mapping) {
  /** @type {Partial<Units>} */
  const out = {};
  const a = medianNorm(table, [mapping.ax, mapping.ay, mapping.az]);
  if (a !== null) {
    if (a > 100) {
      out.accel = "lsb";
      // At rest |a| = LSB per g = 32768 / range.
      const range = 32768 / a;
      out.accelRange = [2, 4, 8, 16].reduce((best, r) =>
        Math.abs(Math.log(r / range)) < Math.abs(Math.log(best / range)) ? r : best,
      );
      out.gyro = "lsb";
    } else if (a > 4) out.accel = "mps2";
    else out.accel = "g";
  }
  const m = medianNorm(table, [mapping.mx, mapping.my, mapping.mz]);
  if (m !== null) {
    if (m < 2) out.mag = "gauss";
    else if (m > 2000) out.mag = "nT";
    else if (m > 150) out.mag = "mG";
    else out.mag = "uT";
  }
  if (mapping.temp !== null) {
    const i = table.header.indexOf(mapping.temp);
    const vals = table.rows.map((r) => Number(r[i])).filter((v) => Number.isFinite(v));
    if (vals.length && Math.abs(vals[Math.floor(vals.length / 2)]) > 150) out.temp = "mpu6050";
  }
  return out;
}
