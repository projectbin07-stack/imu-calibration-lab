// Browser app: file and sample loading, column mapper, tabs, charts and
// export. All computation is in src/core; this file only wires the page.
// Files are read with the File API and never leave the browser.

import { calibrateAccel } from "../core/accel.js";
import { allanForDataset } from "../core/allan.js";
import { buildDataset, CHANNELS, CsvError } from "../core/csv.js";
import { accelJson, cHeader, gyroJson, magJson, sig, VERSION } from "../core/export.js";
import { calibrateGyro } from "../core/gyro.js";
import { loadCsv } from "../core/load.js";
import { calibrateMag } from "../core/mag.js";
import { makeSample, SAMPLES } from "../core/samples.js";
import {
  ACCEL_RANGES,
  ACCEL_UNITS,
  defaultUnits,
  GYRO_RANGES,
  GYRO_UNITS,
  MAG_UNITS,
  TEMP_UNITS,
  TIME_UNITS,
} from "../core/units.js";
import {
  draw3D,
  drawAllan,
  drawHistograms,
  drawProjections,
  drawTempBias,
  drawTimeSeries,
} from "./draw.js";
import { decodeState, defaultState, encodeState } from "./state.js";

/** @typedef {import("../core/csv.js").Dataset} Dataset */
/** @typedef {import("../core/csv.js").Table} Table */
/** @typedef {import("../core/csv.js").Mapping} Mapping */
/** @typedef {import("../core/units.js").Units} Units */
/** @typedef {import("./state.js").PageState} PageState */

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function el(id) {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
}
const input = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (el(id));
const select = (/** @type {string} */ id) => /** @type {HTMLSelectElement} */ (el(id));
const canvas = (/** @type {string} */ id) => /** @type {HTMLCanvasElement} */ (el(id));

/**
 * @typedef {object} Results
 * @property {import("../core/accel.js").AccelResult | Error | null} accel
 * @property {import("../core/gyro.js").GyroResult | Error | null} gyro
 * @property {import("../core/mag.js").MagResult | Error | null} mag
 * @property {Record<string, import("../core/allan.js").AllanResult | Error>} allan
 */

const app = {
  /** @type {PageState} */
  state: defaultState(),
  /** @type {string} */
  name: "",
  /** @type {Table | null} */
  table: null,
  /** @type {Mapping | null} */
  mapping: null,
  /** @type {Units} */
  units: defaultUnits(),
  /** @type {number} */
  rate: 100,
  /** @type {Dataset | null} */
  data: null,
  /** @type {Results} */
  results: { accel: null, gyro: null, mag: null, allan: {} },
  view: { yaw: 0.6, pitch: 0.5 },
};

/** @param {number} v @param {number} [d] */
const f = (v, d = 4) => (Number.isFinite(v) ? String(sig(v, d)) : "-");
/** @param {number[]} v @param {number} [d] */
const fv = (v, d = 4) => v.map((x) => f(x, d)).join(", ");

/**
 * Build a table element from rows of cell texts; the first row is the header.
 * @param {string[][]} rows
 * @returns {HTMLTableElement}
 */
function table(rows) {
  const t = document.createElement("table");
  t.className = "data";
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    for (const c of r) {
      const cell = document.createElement(i === 0 ? "th" : "td");
      cell.textContent = c;
      tr.append(cell);
    }
    t.append(tr);
  });
  return t;
}

/**
 * @param {string} id
 * @param {string[]} items
 */
function warnings(id, items) {
  el(id).replaceChildren(
    ...items.map((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      return li;
    }),
  );
}

/**
 * @param {string} text
 * @param {boolean} [error]
 */
function status(text, error = false) {
  const s = el("status");
  s.textContent = text;
  s.className = error ? "status error" : "status";
}

// ---------------------------------------------------------------- loading

/**
 * @param {string} text
 * @param {string} name
 */
function loadText(text, name) {
  try {
    const loaded = loadCsv(text);
    app.table = loaded.table;
    app.mapping = loaded.mapping;
    app.units = loaded.units;
    app.data = loaded.data;
    app.name = name;
    buildMapper();
    afterLoad();
  } catch (e) {
    if (!(e instanceof CsvError)) throw e;
    app.data = null;
    status(`${name}: ${e.message}`, true);
    clearResults();
  }
}

/**
 * @param {Dataset} data
 * @param {string} name
 */
function loadDataset(data, name) {
  app.table = null;
  app.mapping = null;
  app.units = defaultUnits();
  app.data = data;
  app.name = name;
  buildMapper();
  afterLoad();
}

function rebuildFromMapper() {
  if (!app.table || !app.mapping) return;
  try {
    app.data = buildDataset(app.table, app.mapping, app.units, { rate: app.rate });
    afterLoad();
  } catch (e) {
    if (!(e instanceof CsvError)) throw e;
    app.data = null;
    status(`${app.name}: ${e.message}`, true);
    clearResults();
  }
}

function clearResults() {
  app.results = { accel: null, gyro: null, mag: null, allan: {} };
  warnings("data-warnings", []);
  render();
}

function afterLoad() {
  const d = /** @type {Dataset} */ (app.data);
  const has = [
    d.acc && "accelerometer",
    d.gyro && "gyroscope",
    d.mag && "magnetometer",
    d.temp && "temperature",
  ]
    .filter(Boolean)
    .join(", ");
  status(
    `ready: ${app.name}, ${d.t.length} samples, ${f(d.t[d.t.length - 1], 4)} s at ${f(d.fs, 4)} Hz (${has})`,
  );
  warnings("data-warnings", d.warnings);
  app.results = { accel: null, gyro: null, mag: null, allan: {} };
  compute();
  render();
}

/** @param {string} id */
function loadSample(id) {
  const sample = SAMPLES.find((s) => s.id === id);
  if (!sample) return;
  el("sample-note").textContent = `${sample.name}. True values: ${sample.truth}.`;
  status("generating the sample...");
  const made = makeSample(id);
  const name = `sample "${sample.name}"`;
  if ("csv" in made) loadText(made.csv, name);
  else loadDataset(made.data, name);
}

// ---------------------------------------------------------------- mapper

function buildMapper() {
  const box = /** @type {HTMLDetailsElement} */ (el("mapper-box"));
  const mapper = el("mapper");
  const units = el("units");
  mapper.replaceChildren();
  units.replaceChildren();
  if (!app.table || !app.mapping) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const header = app.table.header;
  const mapping = app.mapping;
  /** @type {Array<keyof Mapping>} */
  const keys = ["t", ...CHANNELS];
  for (const key of keys) {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = key === "t" ? "time" : key;
    const sel = document.createElement("select");
    for (const name of ["", ...header]) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name === "" ? "(none)" : name;
      sel.append(o);
    }
    sel.value = mapping[key] ?? "";
    sel.addEventListener("change", () => {
      mapping[key] = sel.value === "" ? null : sel.value;
      rebuildFromMapper();
    });
    label.append(span, sel);
    mapper.append(label);
  }
  /**
   * @param {string} text
   * @param {readonly (string | number)[]} options
   * @param {() => string | number} get
   * @param {(v: string) => void} set
   */
  const unitSelect = (text, options, get, set) => {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = text;
    const sel = document.createElement("select");
    for (const v of options) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = String(v);
      sel.append(o);
    }
    sel.value = String(get());
    sel.addEventListener("change", () => {
      set(sel.value);
      rebuildFromMapper();
    });
    label.append(span, sel);
    units.append(label);
  };
  const u = app.units;
  unitSelect(
    "time unit",
    TIME_UNITS,
    () => u.time,
    (v) => (u.time = /** @type {any} */ (v)),
  );
  unitSelect(
    "accel unit",
    ACCEL_UNITS,
    () => u.accel,
    (v) => (u.accel = /** @type {any} */ (v)),
  );
  unitSelect(
    "accel range (g, raw)",
    ACCEL_RANGES,
    () => u.accelRange,
    (v) => (u.accelRange = Number(v)),
  );
  unitSelect(
    "gyro unit",
    GYRO_UNITS,
    () => u.gyro,
    (v) => (u.gyro = /** @type {any} */ (v)),
  );
  unitSelect(
    "gyro range (deg/s, raw)",
    GYRO_RANGES,
    () => u.gyroRange,
    (v) => (u.gyroRange = Number(v)),
  );
  unitSelect(
    "mag unit",
    MAG_UNITS,
    () => u.mag,
    (v) => (u.mag = /** @type {any} */ (v)),
  );
  unitSelect(
    "temp unit",
    TEMP_UNITS,
    () => u.temp,
    (v) => (u.temp = /** @type {any} */ (v)),
  );
  const label = document.createElement("label");
  const span = document.createElement("span");
  span.textContent = "rate if no time (Hz)";
  const rate = document.createElement("input");
  rate.type = "number";
  rate.min = "0.1";
  rate.value = String(app.rate);
  rate.addEventListener("change", () => {
    const v = Number(rate.value);
    if (v > 0) {
      app.rate = v;
      rebuildFromMapper();
    }
  });
  label.append(span, rate);
  units.append(label);
}

// ---------------------------------------------------------------- compute

/**
 * @template T
 * @param {() => T} fn
 * @returns {T | Error}
 */
function attempt(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && !(e instanceof TypeError) && !(e instanceof ReferenceError)) return e;
    throw e;
  }
}

function staticOptions() {
  const s = app.state;
  return { windowSeconds: s.window, thresholdK: s.k, minSeconds: s.minStatic };
}

/** Calibrations are fast; Allan deviation runs only for the open tab. */
function compute() {
  const d = app.data;
  if (!d) return;
  const s = app.state;
  if (d.acc)
    app.results.accel = attempt(() =>
      calibrateAccel(d, { model: s.model, static: staticOptions() }),
    );
  if (d.gyro)
    app.results.gyro = attempt(() =>
      calibrateGyro(d, { knownAngle: s.angle, tempBin: s.tempBin, static: staticOptions() }),
    );
  if (d.mag) app.results.mag = attempt(() => calibrateMag(d, { dipDeg: s.dip }));
}

function computeAllan() {
  const d = app.data;
  if (!d) return;
  const sensor = app.state.allanSensor;
  if (!app.results.allan[sensor])
    app.results.allan[sensor] = attempt(() => allanForDataset(d, { sensor }));
}

// ---------------------------------------------------------------- render

/**
 * @param {string} id
 * @param {string} text
 * @param {boolean} [bad]
 */
function summary(id, text, bad = false) {
  const e = el(id);
  e.textContent = text;
  e.className = bad ? "summary bad" : "summary";
}

/** @param {string} id */
function blank(id) {
  const c = canvas(id);
  const ctx = c.getContext("2d");
  ctx?.clearRect(0, 0, c.width, c.height);
}

function renderAccel() {
  const r = app.results.accel;
  const d = app.data;
  el("accel-params").replaceChildren();
  el("accel-poses").replaceChildren();
  if (!d || !d.acc || !r || r instanceof Error) {
    summary(
      "accel-summary",
      !d
        ? "No data loaded."
        : !d.acc
          ? "This log has no accelerometer columns."
          : `Not calibrated: ${r instanceof Error ? r.message : ""}`,
      Boolean(d && d.acc),
    );
    warnings("accel-warnings", []);
    if (d && d.acc) drawTimeSeries(canvas("accel-ts"), d.t, d.acc, { unit: "g" });
    else blank("accel-ts");
    blank("accel-hist");
    return;
  }
  const pr = r.poseResiduals;
  summary(
    "accel-summary",
    `${r.poses.length} poses, ${r.model} model: |a| - 1 g over the poses ${f(pr.rmsBefore * 1000, 3)} mg RMS before, ${f(pr.rmsAfter * 1000, 3)} mg after.`,
  );
  warnings("accel-warnings", r.warnings);
  drawTimeSeries(canvas("accel-ts"), d.t, d.acc, { shade: r.segments, unit: "g" });
  drawHistograms(canvas("accel-hist"), r.sampleResiduals.before, r.sampleResiduals.after, {
    unit: "mg",
    scale: 1000,
  });
  const no = r.nonOrthogonalityDeg;
  el("accel-params").append(
    table([
      ["", "x", "y", "z"],
      ["bias b (mg)", ...r.b.map((v) => f(v * 1000, 4))],
      ["M row 1", ...r.M[0].map((v) => f(v, 6))],
      ["M row 2", ...r.M[1].map((v) => f(v, 6))],
      ["M row 3", ...r.M[2].map((v) => f(v, 6))],
      ["scale (raw g per g)", ...r.scale.map((v) => f(v, 5))],
      ["non-orthogonality (deg)", `xy ${f(no.xy, 3)}`, `xz ${f(no.xz, 3)}`, `yz ${f(no.yz, 3)}`],
    ]),
  );
  el("accel-poses").append(
    table([
      [
        "#",
        "time (s)",
        "samples",
        "pose",
        "mean x (g)",
        "mean y (g)",
        "mean z (g)",
        "|a| before",
        "|a| after",
      ],
      ...r.poses.map((p, i) => [
        String(i + 1),
        `${p.t0.toFixed(1)}-${p.t1.toFixed(1)}`,
        String(p.n),
        p.label,
        ...p.mean.map((v) => v.toFixed(4)),
        p.normBefore.toFixed(4),
        p.normAfter.toFixed(5),
      ]),
    ]),
  );
}

function renderGyro() {
  const r = app.results.gyro;
  const d = app.data;
  el("gyro-params").replaceChildren();
  if (!d || !d.gyro || !r || r instanceof Error) {
    summary(
      "gyro-summary",
      !d
        ? "No data loaded."
        : !d.gyro
          ? "This log has no gyroscope columns."
          : `Not calibrated: ${r instanceof Error ? r.message : ""}`,
      Boolean(d && d.gyro),
    );
    warnings("gyro-warnings", []);
    if (d && d.gyro) drawTimeSeries(canvas("gyro-ts"), d.t, d.gyro, { unit: "deg/s" });
    else blank("gyro-ts");
    drawTempBias(canvas("gyro-temp"), null);
    return;
  }
  const t = r.temperature;
  summary(
    "gyro-summary",
    `Bias [${fv(r.bias)}] deg/s from ${r.staticSamples} static samples; scale [${fv(r.scale, 5)}] from ${r.rotations.length} rotation(s)${t ? `; temperature model over ${f(t.bins[0].temp, 3)}-${f(t.bins[t.bins.length - 1].temp, 3)} degC` : ""}.`,
  );
  warnings("gyro-warnings", r.warnings);
  drawTimeSeries(canvas("gyro-ts"), d.t, d.gyro, {
    shade: r.segments,
    mark: r.rotations.map((x) => ({
      t0: x.t0,
      t1: x.t1,
      label: `${"XYZ"[x.axis]} ${f(x.known, 4)}`,
    })),
    unit: "deg/s",
  });
  drawTempBias(canvas("gyro-temp"), t);
  /** @type {string[][]} */
  const rows = [
    ["", "x", "y", "z"],
    ["mean bias (deg/s)", ...r.bias.map((v) => f(v, 5))],
    ["noise std (deg/s)", ...r.noiseStd.map((v) => f(v, 3))],
    ["scale", ...r.scale.map((v) => f(v, 5))],
  ];
  if (t) {
    rows.push([`bias at ${f(t.refTemp, 4)} degC`, ...t.bias.map((v) => f(v, 5))]);
    rows.push(["slope (deg/s per degC)", ...t.slope.map((v) => f(v, 3))]);
  }
  for (const x of r.rotations)
    rows.push([
      `turn ${"XYZ"[x.axis]} ${f(x.t0, 4)}-${f(x.t1, 4)} s (deg)`,
      ...x.integrated.map((v) => f(v, 5)),
    ]);
  el("gyro-params").append(table(rows));
}

function renderMag() {
  const r = app.results.mag;
  const d = app.data;
  el("mag-params").replaceChildren();
  if (!d || !d.mag || !r || r instanceof Error) {
    summary(
      "mag-summary",
      !d
        ? "No data loaded."
        : !d.mag
          ? "This log has no magnetometer columns."
          : `Not calibrated: ${r instanceof Error ? r.message : ""}`,
      Boolean(d && d.mag),
    );
    warnings("mag-warnings", []);
    for (const id of ["mag-proj", "mag-3d", "mag-hist"]) blank(id);
    return;
  }
  const u = app.units.mag;
  summary(
    "mag-summary",
    `Hard iron [${fv(r.hardIron)}] ${u}, field ${f(r.fieldStrength)} ${u}; |m| spread ${f(r.magnitude.before.cv * 100, 3)} % -> ${f(r.magnitude.after.cv * 100, 3)} %; level heading error up to ${f(r.heading.beforeDeg, 3)} deg uncorrected, about ${f(r.heading.afterDeg, 2)} deg after.`,
  );
  warnings("mag-warnings", r.warnings);
  drawProjections(canvas("mag-proj"), r.plot.raw, r.plot.cal, r.hardIron, r.fieldStrength, u);
  draw3D(canvas("mag-3d"), r.plot.raw, r.plot.cal, r.hardIron, app.view.yaw, app.view.pitch);
  drawHistograms(canvas("mag-hist"), r.radialResiduals.before, r.radialResiduals.after, {
    unit: u,
  });
  el("mag-params").append(
    table([
      ["", "x", "y", "z"],
      [`hard iron c (${u})`, ...r.hardIron.map((v) => f(v, 5))],
      ["W row 1", ...r.softIron[0].map((v) => f(v, 5))],
      ["W row 2", ...r.softIron[1].map((v) => f(v, 5))],
      ["W row 3", ...r.softIron[2].map((v) => f(v, 5))],
      [`semi-axes (${u})`, ...r.radii.map((v) => f(v, 4))],
      ["sphericity before / after", f(r.sphericity.before, 4), f(r.sphericity.after, 4), ""],
      ["coverage (1 = all directions)", f(r.coverage, 3), "", ""],
      [`dip (deg, ${r.heading.dipSource})`, f(r.heading.dipDeg, 3), "", ""],
    ]),
  );
}

function renderAllan() {
  const d = app.data;
  const sensor = app.state.allanSensor;
  el("allan-table").replaceChildren();
  if (!d) {
    summary("allan-summary", "No data loaded.");
    blank("allan-plot");
    return;
  }
  computeAllan();
  const r = app.results.allan[sensor];
  if (!r || r instanceof Error) {
    summary("allan-summary", r instanceof Error ? r.message : "", true);
    warnings("allan-warnings", []);
    blank("allan-plot");
    return;
  }
  const u = r.units;
  summary(
    "allan-summary",
    `${r.sensor === "gyro" ? "Gyroscope" : "Accelerometer"}: ${r.samples} samples over ${f(r.duration / 60, 3)} min at ${f(r.fs, 4)} Hz, ${r.axes[0].curve.tau.length} cluster times.`,
  );
  warnings("allan-warnings", r.warnings);
  drawAllan(canvas("allan-plot"), r.axes, r.sensor === "gyro" ? "deg/s" : "g");
  /** @param {number | null} v @param {number | undefined} e */
  const cell = (v, e) => (v === null ? "not found" : `${f(v, 3)} +/- ${f((e ?? 0) * 100, 2)} %`);
  el("allan-table").append(
    table([
      [
        "axis",
        `white noise (${u.whiteNoise})`,
        `density (${u.noiseDensity})`,
        `bias instability (${u.biasInstability})`,
        "at tau (s)",
        `rate random walk (${u.rateRandomWalk})`,
      ],
      ...r.axes.map((a, i) => {
        const c = r.converted[i];
        const bi = a.terms.biasInstability;
        return [
          a.axis,
          cell(c.whiteNoise, a.terms.whiteNoise?.relError),
          c.noiseDensity === null ? "-" : f(c.noiseDensity, 3),
          (bi?.atEnd ? "<= " : "") + cell(c.biasInstability, bi?.relError),
          bi ? f(bi.tau, 3) : "-",
          cell(c.rateRandomWalk, a.terms.rateRandomWalk?.relError),
        ];
      }),
    ]),
  );
}

function renderExport() {
  const r = app.results;
  /** @param {unknown} x @returns {any} */
  const ok = (x) => (x && !(x instanceof Error) ? x : null);
  const accel = ok(r.accel);
  const gyro = ok(r.gyro);
  const mag = ok(r.mag);
  const parts = [accel && "accelerometer", gyro && "gyroscope", mag && "magnetometer"].filter(
    Boolean,
  );
  el("export-note").textContent = parts.length
    ? `Calibrations for this log: ${parts.join(", ")}. Check the residuals above before using them.`
    : "Nothing calibrated yet.";
  const kind = select("export-kind").value;
  const text =
    parts.length === 0
      ? ""
      : kind === "c"
        ? cHeader({ accel, gyro, mag, units: app.units, source: app.name })
        : JSON.stringify(
            {
              generator: `imu-calibration-lab ${VERSION}`,
              source: app.name,
              accel: accel ? accelJson(accel) : null,
              gyro: gyro ? gyroJson(gyro) : null,
              mag: mag ? magJson(mag) : null,
            },
            null,
            2,
          );
  /** @type {HTMLTextAreaElement} */ (el("export-text")).value = text;
}

function render() {
  const tab = app.state.tab;
  for (const t of ["accel", "gyro", "mag", "allan"]) {
    el(`panel-${t}`).hidden = t !== tab;
    el(`tab-${t}`).setAttribute("aria-selected", String(t === tab));
  }
  if (tab === "accel") renderAccel();
  else if (tab === "gyro") renderGyro();
  else if (tab === "mag") renderMag();
  else renderAllan();
  renderExport();
}

// ---------------------------------------------------------------- wiring

function syncControls() {
  const s = app.state;
  select("model").value = s.model;
  input("window").value = String(s.window);
  input("k").value = String(s.k);
  input("minStatic").value = String(s.minStatic);
  input("angle").value = String(s.angle);
  input("tempBin").value = String(s.tempBin);
  input("dip").value = s.dip === null ? "" : String(s.dip);
  select("allanSensor").value = s.allanSensor;
  select("sample").value = s.sample === "file" ? "" : s.sample;
}

function applyTheme() {
  const t = app.state.theme;
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = t;
  el("btn-theme").textContent = `Theme: ${t}`;
}

function updateUrl() {
  const q = encodeState(app.state);
  history.replaceState(null, "", q ? `?${q}` : location.pathname);
}

/**
 * Read a number input into the state if it is valid.
 * @param {string} id
 * @param {"window" | "k" | "minStatic" | "angle" | "tempBin"} field
 * @param {number} min
 */
function numberInput(id, field, min) {
  input(id).addEventListener("change", () => {
    const v = Number(input(id).value);
    if (!(Number.isFinite(v) && v >= min)) return;
    app.state[field] = v;
    updateUrl();
    compute();
    render();
  });
}

function wire() {
  const sampleSel = select("sample");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "(choose a synthetic sample)";
  sampleSel.append(none);
  for (const s of SAMPLES) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.name;
    sampleSel.append(o);
  }
  sampleSel.addEventListener("change", () => {
    if (!sampleSel.value) return;
    app.state.sample = sampleSel.value;
    const s = SAMPLES.find((x) => x.id === sampleSel.value);
    if (s) app.state.tab = s.tab;
    updateUrl();
    loadSample(sampleSel.value);
  });

  const drop = el("drop");
  const fileInput = input("file");
  /** @param {File} file */
  const readFile = async (file) => {
    status(`reading ${file.name}...`);
    const text = await file.text();
    app.state.sample = "file";
    sampleSel.value = "";
    el("sample-note").textContent = "";
    updateUrl();
    loadText(text, file.name);
  };
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void readFile(file);
  });
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const file = e.dataTransfer?.files?.[0];
    if (file) void readFile(file);
  });

  for (const t of /** @type {const} */ (["accel", "gyro", "mag", "allan"]))
    el(`tab-${t}`).addEventListener("click", () => {
      app.state.tab = t;
      updateUrl();
      render();
    });

  select("model").addEventListener("change", () => {
    app.state.model = /** @type {PageState["model"]} */ (select("model").value);
    updateUrl();
    compute();
    render();
  });
  numberInput("window", "window", 0.05);
  numberInput("k", "k", 1);
  numberInput("minStatic", "minStatic", 0.1);
  numberInput("angle", "angle", 1);
  numberInput("tempBin", "tempBin", 0);
  input("dip").addEventListener("change", () => {
    const raw = input("dip").value.trim();
    const v = Number(raw);
    app.state.dip = raw === "" || !(Math.abs(v) <= 90) ? null : v;
    updateUrl();
    compute();
    render();
  });
  select("allanSensor").addEventListener("change", () => {
    app.state.allanSensor = /** @type {"gyro" | "accel"} */ (select("allanSensor").value);
    updateUrl();
    render();
  });
  select("export-kind").addEventListener("change", renderExport);
  el("btn-copy").addEventListener("click", () => {
    void navigator.clipboard?.writeText(
      /** @type {HTMLTextAreaElement} */ (el("export-text")).value,
    );
  });
  el("btn-download").addEventListener("click", () => {
    const text = /** @type {HTMLTextAreaElement} */ (el("export-text")).value;
    if (!text) return;
    const c = select("export-kind").value === "c";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: c ? "text/x-c" : "application/json" }));
    a.download = c ? "imu_calibration.h" : "imu_calibration.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  el("btn-link").addEventListener("click", () => {
    updateUrl();
    void navigator.clipboard?.writeText(location.href);
    el("btn-link").textContent = "Link copied";
    setTimeout(() => (el("btn-link").textContent = "Copy link"), 1500);
  });
  el("btn-theme").addEventListener("click", () => {
    const t = app.state.theme;
    app.state.theme = t === "auto" ? "light" : t === "light" ? "dark" : "auto";
    applyTheme();
    updateUrl();
    render();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

  // 3D view: drag to rotate
  const cube = canvas("mag-3d");
  /** @type {{x: number, y: number} | null} */
  let drag = null;
  cube.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY };
    cube.setPointerCapture(e.pointerId);
  });
  cube.addEventListener("pointermove", (e) => {
    if (!drag) return;
    app.view.yaw += (e.clientX - drag.x) * 0.01;
    app.view.pitch = Math.max(-1.5, Math.min(1.5, app.view.pitch + (e.clientY - drag.y) * 0.01));
    drag = { x: e.clientX, y: e.clientY };
    const r = app.results.mag;
    if (r && !(r instanceof Error))
      draw3D(cube, r.plot.raw, r.plot.cal, r.hardIron, app.view.yaw, app.view.pitch);
  });
  cube.addEventListener("pointerup", () => (drag = null));

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let resize;
  addEventListener("resize", () => {
    clearTimeout(resize);
    resize = setTimeout(render, 150);
  });
}

function main() {
  const { state, ignored } = decodeState(location.search);
  app.state = state;
  wire();
  syncControls();
  applyTheme();
  if (ignored.length) warnings("data-warnings", [`ignored link parameters: ${ignored.join(", ")}`]);
  if (state.sample === "file") {
    status(
      "This link was made with a local file. Drop the same file to see the results; the settings are kept.",
    );
    render();
  } else loadSample(state.sample);
}

main();
