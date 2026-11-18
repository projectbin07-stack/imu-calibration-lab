import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  autoMap,
  buildDataset,
  CsvError,
  emptyMapping,
  guessUnits,
  parseTable,
  splitLine,
} from "../src/core/csv.js";
import { loadCsv, parseMapSpec } from "../src/core/load.js";
import { defaultUnits } from "../src/core/units.js";
import { near } from "./helpers.js";

const fixture = (/** @type {string} */ name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/**
 * @param {() => unknown} fn
 * @param {number} line
 * @param {RegExp} message
 */
function throwsAtLine(fn, line, message) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof CsvError, String(e));
    assert.equal(e.line, line);
    assert.match(e.message, new RegExp(`^line ${line}: `));
    assert.match(e.message, message);
    return true;
  });
}

test("plain t,ax..mz layout is mapped and converted", () => {
  const text =
    "t,ax,ay,az,gx,gy,gz,mx,my,mz\n0,0,0,1,0.1,0.2,0.3,20,-5,40\n0.01,0,0,1,0.1,0.2,0.3,20,-5,40\n";
  const { data, mapping, units } = loadCsv(text);
  assert.equal(mapping.t, "t");
  assert.equal(mapping.mz, "mz");
  assert.equal(units.accel, "g");
  assert.equal(units.mag, "uT");
  assert.equal(data.t.length, 2);
  near(data.fs, 100, 1e-9);
  assert.deepEqual([...(data.acc?.[2] ?? [])], [1, 1]);
  assert.deepEqual([...(data.gyro?.[1] ?? [])], [0.2, 0.2]);
  assert.deepEqual([...(data.mag?.[0] ?? [])], [20, 20]);
  assert.equal(data.temp, null);
});

test("headerless files get the plain names for 7, 8 and 10 columns", () => {
  assert.deepEqual(parseTable("0,0,0,1,0,0,0\n").header, ["t", "ax", "ay", "az", "gx", "gy", "gz"]);
  assert.deepEqual(parseTable("0,0,0,1,0,0,0,25\n").header.at(-1), "temp");
  assert.equal(parseTable("0,0,0,1,0,0,0,1,2,3\n").header[9], "mz");
  assert.deepEqual(parseTable("1,2\n3,4\n").header, ["c1", "c2"]);
  assert.equal(parseTable("1,2\n").kind, "headerless");
});

test("BOM, CRLF, comments, blank lines, semicolons, quotes and raw MPU6050 counts", () => {
  const { data, units, mapping } = loadCsv(fixture("mpu6050-raw-semicolon.csv"));
  assert.equal(mapping.t, "t_ms");
  assert.equal(units.time, "ms");
  assert.equal(units.accel, "lsb");
  assert.equal(units.accelRange, 2);
  assert.equal(units.gyro, "lsb");
  const acc = /** @type {NonNullable<typeof data.acc>} */ (data.acc);
  const gyro = /** @type {NonNullable<typeof data.gyro>} */ (data.gyro);
  assert.deepEqual([...acc[0]], [0, 0.5, -1]);
  assert.deepEqual([...acc[2]], [1, -1, 0]);
  assert.deepEqual([...gyro[0]], [1, 0, 0]);
  near(gyro[1][1], 65 / 131, 1e-12);
  assert.deepEqual([...gyro[2]], [-2, 0, 1]);
  assert.deepEqual([...data.t], [0, 0.01, 0.02]);
});

test("splitLine handles quotes, escaped quotes and reports unterminated ones", () => {
  assert.deepEqual(splitLine(' a , "b,c" ,"d""e"', ",", 1), ["a", "b,c", 'd"e']);
  assert.deepEqual(splitLine("1\t2\t", "\t", 1), ["1", "2", ""]);
  throwsAtLine(() => splitLine('1,"2', ",", 7), 7, /unterminated/);
});

test("line-numbered errors: bad value, wrong field count, time going backwards", () => {
  throwsAtLine(() => loadCsv(fixture("bad-value.csv")), 3, /"0x" in column "ay" is not a number/);
  throwsAtLine(() => loadCsv(fixture("bad-columns.csv")), 4, /expected 4 fields, found 3/);
  throwsAtLine(() => loadCsv(fixture("time-backwards.csv")), 4, /time goes backwards/);
  throwsAtLine(() => parseTable("a,a\n1,2\n"), 1, /duplicate column name "a"/);
  throwsAtLine(() => parseTable("a,,b\n1,2,3\n"), 1, /column 2 has an empty name/);
  assert.throws(() => parseTable("# only a comment\n\n"), /no data lines/);
  assert.throws(() => parseTable("t,ax\n"), /no data rows/);
});

test("mapping problems are reported", () => {
  const table = parseTable("t,ax,ay,az,x\n0,0,0,1,5\n0.1,0,0,1,5\n");
  const m = { ...emptyMapping(), t: "t", ax: "ax", ay: "ay" };
  assert.throws(() => buildDataset(table, m, defaultUnits()), /map all three acc axes or none/);
  assert.throws(
    () => buildDataset(table, { ...emptyMapping(), ax: "nope" }, defaultUnits()),
    /column "nope" \(mapped to ax\) is not in the file/,
  );
  assert.throws(
    () => buildDataset(table, { ...emptyMapping(), t: "t" }, defaultUnits()),
    /no sensor columns/,
  );
  assert.throws(
    () =>
      buildDataset(
        parseTable("t,ax,ay,az\n0,0,0,1\n"),
        autoMap(parseTable("t,ax,ay,az\n0,0,0,1\n")).mapping,
        defaultUnits(),
      ),
    /fewer than two complete rows/,
  );
  assert.throws(
    () => loadCsv("t,ax,ay,az\n1,0,0,1\n1,0,0,1\n1,0,0,1\n"),
    /time stamps are repeated/,
  );
});

test("serial-scope decoded export: host clock when the device clock is empty, other records skipped", () => {
  const { data, mapping, table } = loadCsv(fixture("serial-scope-export.csv"));
  assert.equal(table.kind, "serial-scope");
  assert.equal(mapping.t, "host_time");
  assert.equal(data.t.length, 4);
  assert.equal(data.skipped, 1);
  assert.ok(data.warnings.some((w) => w.includes("1 row(s) skipped")));
  near(data.t[1], 0.02, 1e-6);
  near(data.fs, 100, 1e-3);
  assert.deepEqual([...(data.gyro?.[2] ?? [])], [0.33, 0.31, 0.32, 0.34]);
});

test("serial-scope export with a device clock and Arduino MPU6050 names (AcX, Tmp, GyX)", () => {
  const { data, mapping, units } = loadCsv(fixture("serial-scope-device-time.csv"));
  assert.equal(mapping.t, "device_time");
  assert.equal(mapping.ax, "AcX");
  assert.equal(mapping.gz, "GyZ");
  assert.equal(mapping.temp, "Tmp");
  assert.equal(units.temp, "mpu6050");
  assert.equal(units.accel, "lsb");
  near(data.t[2], 0.02, 1e-6);
  near(/** @type {Float64Array} */ (data.temp)[0], -1200 / 340 + 36.53, 1e-12);
  near(/** @type {NonNullable<typeof data.acc>} */ (data.acc)[2][0], 16420 / 16384, 1e-12);
});

test("serial-scope snapshot (channel,time,value) is pivoted; incomplete rows are skipped", () => {
  const { data, table } = loadCsv(fixture("serial-scope-snapshot.csv"));
  assert.equal(table.kind, "serial-scope-snapshot");
  assert.deepEqual(table.header, ["time", "mx", "my", "mz"]);
  assert.equal(table.rows.length, 3);
  assert.equal(data.t.length, 2);
  assert.equal(data.skipped, 1);
  assert.deepEqual([...(data.mag?.[1] ?? [])], [-3.25, -3.5]);
  assert.throws(() => parseTable("channel,time,value\nmx,abc,1\n"), /line 2: time "abc"/);
});

test("unit guesses: m/s^2, gauss, milligauss, nanotesla", () => {
  const t = parseTable("t,ax,ay,az,mx,my,mz\n0,0,0,9.81,0.2,0,0.4\n0.1,0,0,9.8,0.2,0,0.4\n");
  const g = guessUnits(t, autoMap(t).mapping);
  assert.equal(g.accel, "mps2");
  assert.equal(g.mag, "gauss");
  const mg = parseTable("mx,my,mz\n200,0,400\n");
  assert.equal(guessUnits(mg, autoMap(mg).mapping).mag, "mG");
  const nt = parseTable("mx,my,mz\n20000,0,40000\n");
  assert.equal(guessUnits(nt, autoMap(nt).mapping).mag, "nT");
  const r16 = parseTable("ax,ay,az\n0,0,2048\n");
  assert.equal(guessUnits(r16, autoMap(r16).mapping).accelRange, 16);
  const { data } = loadCsv("t,ax,ay,az\n0,0,0,9.80665\n1,0,0,9.80665\n");
  near(/** @type {NonNullable<typeof data.acc>} */ (data.acc)[2][0], 1, 1e-12);
});

test("no time column: sample rate from the option, with a warning", () => {
  const { data } = loadCsv("ax,ay,az\n0,0,1\n0,0,1\n0,0,1\n", { rate: 50 });
  assert.deepEqual([...data.t], [0, 0.02, 0.04]);
  assert.ok(data.warnings[0].includes("50 Hz"));
  assert.throws(() => loadCsv("ax,ay,az\n0,0,1\n0,0,1\n", { rate: 0 }), /sample rate/);
});

test("gaps in the time column are counted", () => {
  const { data } = loadCsv("t,ax,ay,az\n0,0,0,1\n0.01,0,0,1\n0.02,0,0,1\n0.5,0,0,1\n0.51,0,0,1\n");
  assert.ok(data.warnings.some((w) => w.startsWith("1 gap(s)")));
});

test("--map spec parsing and overrides", () => {
  assert.deepEqual(parseMapSpec("t=millis, ax=A1 ,temp=-"), { t: "millis", ax: "A1", temp: null });
  assert.throws(() => parseMapSpec("bogus=1"), /unknown channel/);
  assert.throws(() => parseMapSpec("ax"), /channel=column/);
  const { data } = loadCsv("time,A,B,C\n0,0,0,1\n0.1,0,0,1\n", {
    mapping: parseMapSpec("ax=A,ay=B,az=C"),
  });
  assert.equal(data.acc?.[2][1], 1);
});

test("prefixed names: accel_x, gyro_x, mag_x, temperature, t_us", () => {
  const t = parseTable(
    "t_us,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,mag_x,mag_y,mag_z,temperature\n0,0,0,1,0,0,0,1,1,1,25\n",
  );
  const { mapping, timeUnit } = autoMap(t);
  assert.equal(timeUnit, "us");
  assert.equal(mapping.ax, "accel_x");
  assert.equal(mapping.gy, "gyro_y");
  assert.equal(mapping.mz, "mag_z");
  assert.equal(mapping.temp, "temperature");
});
