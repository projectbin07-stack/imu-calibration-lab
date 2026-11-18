// URL parameters <-> page state. DOM-free so it can be tested under Node.
// Only values that differ from the defaults are written, so links stay
// short. The data itself is never put in the URL: a link made with a local
// file says so and asks for the file again.

import { SAMPLES } from "../core/samples.js";

/**
 * @typedef {object} PageState
 * @property {string} sample sample id, or "file" for a local file
 * @property {"accel" | "gyro" | "mag" | "allan"} tab
 * @property {"auto" | "six" | "twelve" | "nine"} model
 * @property {number} window static-detection window, s
 * @property {number} k threshold multiplier
 * @property {number} minStatic s
 * @property {number} angle known rotation, deg
 * @property {number} tempBin degC, 0 = off
 * @property {number | null} dip deg, null = from the accelerometer
 * @property {"gyro" | "accel"} allanSensor
 * @property {"auto" | "light" | "dark"} theme
 */

/** @returns {PageState} */
export function defaultState() {
  return {
    sample: "accel",
    tab: "accel",
    model: "auto",
    window: 0.5,
    k: 10,
    minStatic: 1.5,
    angle: 360,
    tempBin: 1,
    dip: null,
    allanSensor: "gyro",
    theme: "auto",
  };
}

const TABS = ["accel", "gyro", "mag", "allan"];
const MODELS = ["auto", "six", "twelve", "nine"];
const THEMES = ["auto", "light", "dark"];

/** URL key, field, minimum, maximum for each number. */
const NUMBERS = /** @type {const} */ ([
  ["w", "window", 0.05, 10],
  ["k", "k", 1, 1000],
  ["ms", "minStatic", 0.1, 60],
  ["ang", "angle", 1, 3600],
  ["tb", "tempBin", 0, 20],
]);

/**
 * @param {number} v
 * @returns {string}
 */
const num = (v) => String(Number(v.toPrecision(6)));

/**
 * The tab a sample opens on; a link only names the tab when it differs.
 * @param {string} sample
 * @returns {PageState["tab"]}
 */
export function sampleTab(sample) {
  return SAMPLES.find((s) => s.id === sample)?.tab ?? "accel";
}

/**
 * @param {PageState} st
 * @returns {string} query string without the leading "?"
 */
export function encodeState(st) {
  const d = defaultState();
  const p = new URLSearchParams();
  if (st.sample !== d.sample) p.set("s", st.sample);
  if (st.tab !== sampleTab(st.sample)) p.set("tab", st.tab);
  if (st.model !== d.model) p.set("am", st.model);
  for (const [key, field] of NUMBERS) if (st[field] !== d[field]) p.set(key, num(st[field]));
  if (st.dip !== null) p.set("dip", num(st.dip));
  if (st.allanSensor !== d.allanSensor) p.set("as", st.allanSensor);
  if (st.theme !== d.theme) p.set("theme", st.theme);
  return p.toString();
}

/**
 * Parse a query string. Unknown keys and invalid values are ignored and
 * listed, so a mangled link still opens.
 * @param {string} search
 * @returns {{state: PageState, ignored: string[]}}
 */
export function decodeState(search) {
  const st = defaultState();
  /** @type {string[]} */
  const ignored = [];
  const p = new URLSearchParams(search);
  for (const [key, value] of p) {
    const n = NUMBERS.find(([k]) => k === key);
    if (n) {
      const v = Number(value);
      if (value.trim() !== "" && Number.isFinite(v) && v >= n[2] && v <= n[3]) st[n[1]] = v;
      else ignored.push(key);
      continue;
    }
    if (key === "s" && (value === "file" || SAMPLES.some((s) => s.id === value))) st.sample = value;
    else if (key === "tab" && TABS.includes(value))
      st.tab = /** @type {PageState["tab"]} */ (value);
    else if (key === "am" && MODELS.includes(value))
      st.model = /** @type {PageState["model"]} */ (value);
    else if (key === "as" && (value === "gyro" || value === "accel")) st.allanSensor = value;
    else if (key === "theme" && THEMES.includes(value))
      st.theme = /** @type {PageState["theme"]} */ (value);
    else if (key === "dip" && value.trim() !== "" && Math.abs(Number(value)) <= 90)
      st.dip = Number(value);
    else ignored.push(key);
  }
  if (!p.has("tab") || ignored.includes("tab")) st.tab = sampleTab(st.sample);
  return { state: st, ignored };
}
