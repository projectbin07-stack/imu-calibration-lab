// Import pipeline shared by the CLI and the browser: text -> table ->
// mapping (automatic, with overrides) -> units (guessed, with overrides) ->
// dataset.

import { autoMap, buildDataset, CHANNELS, CsvError, guessUnits, parseTable } from "./csv.js";
import { defaultUnits } from "./units.js";

/** @typedef {import("./csv.js").Mapping} Mapping */
/** @typedef {import("./csv.js").Table} Table */
/** @typedef {import("./units.js").Units} Units */

/**
 * Parse "ax=AcX,gy=GyY,t=millis" into a partial mapping. A value of "-"
 * removes a channel.
 * @param {string} spec
 * @returns {Partial<Mapping>}
 */
export function parseMapSpec(spec) {
  /** @type {Partial<Mapping>} */
  const out = {};
  for (const part of spec.split(",")) {
    if (part.trim() === "") continue;
    const eq = part.indexOf("=");
    if (eq < 1) throw new CsvError(`bad mapping "${part}": use channel=column`);
    const key = part.slice(0, eq).trim();
    const col = part.slice(eq + 1).trim();
    if (key !== "t" && !(/** @type {readonly string[]} */ (CHANNELS).includes(key)))
      throw new CsvError(`unknown channel "${key}" (t, ${CHANNELS.join(", ")})`);
    out[/** @type {keyof Mapping} */ (key)] = col === "-" ? null : col;
  }
  return out;
}

/**
 * @typedef {object} Loaded
 * @property {Table} table
 * @property {Mapping} mapping
 * @property {Units} units
 * @property {import("./csv.js").Dataset} data
 */

/**
 * @param {string} text
 * @param {{mapping?: Partial<Mapping>, units?: Partial<Units>, rate?: number}} [overrides]
 * @returns {Loaded}
 */
export function loadCsv(text, overrides = {}) {
  const table = parseTable(text);
  const auto = autoMap(table);
  const mapping = { ...auto.mapping, ...overrides.mapping };
  const units = {
    ...defaultUnits(),
    time: auto.timeUnit,
    ...guessUnits(table, mapping),
    ...overrides.units,
  };
  const data = buildDataset(table, mapping, units, { rate: overrides.rate });
  return { table, mapping, units, data };
}
