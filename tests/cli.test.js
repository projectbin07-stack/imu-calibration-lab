import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION, main } from "../src/cli.js";
import { calibrateAccel } from "../src/core/accel.js";
import { accelJson, combinedJsonText, gyroJson, magJson } from "../src/core/export.js";
import { calibrateGyro } from "../src/core/gyro.js";
import { loadCsv } from "../src/core/load.js";
import { calibrateMag } from "../src/core/mag.js";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Run the CLI in memory; files are read from the repository, or from the
 * in-memory map first (so tests can feed generated logs).
 * @param {string[]} argv
 * @param {Record<string, string>} [mem]
 */
function cli(argv, mem = {}) {
  let out = "";
  let err = "";
  /** @type {Record<string, string>} */
  const files = {};
  const code = main(argv, {
    out: (t) => (out += t),
    err: (t) => (err += t),
    readFile: (p) => mem[p] ?? readFileSync(new URL(p, new URL("../", import.meta.url)), "utf8"),
    writeFile: (p, d) => (files[p] = d),
  });
  return { code, out, err, files };
}

test("--version and --help", () => {
  assert.equal(cli(["--version"]).out, `${VERSION}\n`);
  assert.match(cli(["--help"]).out, /accel <file.csv>/);
  assert.match(cli([]).out, /Usage:/);
});

test("accel --json has the documented shape and is deterministic", () => {
  const a = cli(["accel", "examples/accel-15pose.csv", "--json"]);
  assert.equal(a.code, 0, a.err);
  const j = JSON.parse(a.out);
  assert.equal(j.kind, "accel");
  assert.equal(j.model, "nine");
  assert.equal(j.units, "g");
  assert.equal(j.bias.length, 3);
  assert.equal(j.matrix.length, 3);
  assert.equal(j.poses.length, 15);
  for (const k of ["rmsBefore", "rmsAfter", "maxBefore", "maxAfter"])
    assert.equal(typeof j.residuals[k], "number");
  assert.ok(j.residuals.rmsAfter < j.residuals.rmsBefore / 50);
  assert.equal(cli(["accel", "examples/accel-15pose.csv", "--json"]).out, a.out);
});

test("accel on the raw six-position file: units detected, text and C output", () => {
  const t = cli(["accel", "examples/accel-6pose-mpu6050-raw.csv"]);
  assert.equal(t.code, 0, t.err);
  assert.match(t.out, /; accel lsb \(\+\/-2 g\), gyro lsb \(\+\/-250 deg\/s\)\n/);
  assert.match(t.out, /model: twelve/);
  assert.match(t.out, /\+X up/);
  const six = cli(["accel", "examples/accel-6pose-mpu6050-raw.csv", "--model", "six", "--json"]);
  assert.equal(JSON.parse(six.out).model, "six");
  const c = cli(["accel", "examples/accel-6pose-mpu6050-raw.csv", "--c"]);
  assert.match(c.out, /IMU_ACCEL_LSB_PER_G 16384\.0f/);
  const forced = cli([
    "accel",
    "examples/accel-6pose-mpu6050-raw.csv",
    "--accel-units",
    "lsb",
    "--accel-range",
    "4",
    "--json",
  ]);
  // read with the wrong range, |a| is about 2 g and the scale shows it
  assert.ok(JSON.parse(forced.out).scale[2] > 1.9);
});

test("gyro, mag and allan commands", () => {
  const g = cli(["gyro", "examples/gyro-turns-mpu6050-raw.csv", "--json"]);
  assert.equal(g.code, 0, g.err);
  const gj = JSON.parse(g.out);
  assert.equal(gj.rotations.length, 3);
  assert.ok(Math.abs(gj.scale[2] - 1.034) < 2e-3);
  assert.match(cli(["gyro", "examples/gyro-turns-mpu6050-raw.csv"]).out, /temperature model/);
  assert.match(cli(["gyro", "examples/gyro-turns-mpu6050-raw.csv", "--c"]).out, /IMU_GYRO_CAL/);
  const rot = cli([
    "gyro",
    "examples/gyro-turns-mpu6050-raw.csv",
    "--rotation",
    "79,85,z",
    "--temp-bin",
    "0",
    "--json",
  ]);
  assert.equal(rot.code, 0, rot.err);
  assert.equal(JSON.parse(rot.out).rotations.length, 1);
  const all = cli([
    "gyro",
    "examples/gyro-turns-mpu6050-raw.csv",
    "--all-static",
    "--angle",
    "180",
    "--json",
  ]);
  assert.equal(JSON.parse(all.out).staticSamples, 15200);

  const m = cli(["mag", "examples/mag-tumble.csv"]);
  assert.equal(m.code, 0, m.err);
  assert.match(m.out, /hard iron c: +\[18\.\d+, -7\.\d+, 3\d\.\d+\] uT/);
  assert.match(m.out, /dip 2\d(\.\d+)? deg from accelerometer/);
  const mj = JSON.parse(cli(["mag", "examples/mag-tumble.csv", "--json", "--dip", "30"]).out);
  assert.equal(mj.heading.dipSource, "option");
  assert.match(cli(["mag", "examples/mag-tumble.csv", "--c"]).out, /IMU_MAG_CAL/);

  const syn = cli(["synth", "noise", "--seconds", "120", "--seed", "3", "--out", "n.csv"]);
  assert.equal(syn.code, 0);
  assert.match(syn.err, /wrote n\.csv: 12000 samples/);
  const mem = { "n.csv": syn.files["n.csv"] };
  const a = cli(["allan", "n.csv"], mem);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /white noise \(deg\/sqrt\(h\)\)/);
  assert.match(a.out, /warning: the log is 120 s long/);
  const aj = JSON.parse(
    cli(["allan", "n.csv", "--json", "--sensor", "accel", "--per-decade", "5"], mem).out,
  );
  assert.equal(aj.sensor, "accel");
  assert.equal(aj.axes.length, 3);
  assert.ok(Math.abs(aj.axes[0].whiteNoise - 400) < 40);
  assert.equal(
    cli(["allan", "n.csv", "--json"], mem).out,
    cli(["allan", "n.csv", "--json"], mem).out,
  );
});

test("synth writes each kind to standard output with a synthetic-data comment", () => {
  for (const kind of ["accel", "accel-axis", "gyro", "mag"]) {
    const r = cli(["synth", kind, "--seed", "4"]);
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(`^# synthetic ${kind} log .* seed 4; not sensor data\\n`));
  }
  assert.match(cli(["synth", "accel", "--raw"]).out.split("\n")[1], /^t_ms,AcX/);
});

test("usage and data errors give exit codes 2 and 1", () => {
  assert.equal(cli(["bogus"]).code, 2);
  assert.equal(cli(["accel"]).code, 2);
  assert.equal(cli(["allan", "x.csv", "--c"]).code, 2);
  assert.equal(cli(["accel", "x.csv", "--model", "seven"]).code, 2);
  assert.equal(cli(["accel", "x.csv", "--accel-range", "3"]).code, 2);
  assert.equal(cli(["accel", "x.csv", "--gyro-range", "3"]).code, 2);
  assert.equal(cli(["accel", "x.csv", "--window", "abc"]).code, 2);
  assert.equal(cli(["accel", "x.csv", "--nope"]).code, 2);
  assert.equal(cli(["gyro", "x.csv", "--rotation", "5,1,q"]).code, 2);
  assert.equal(cli(["synth", "nothing"]).code, 2);
  const missing = cli(["accel", "does-not-exist.csv"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /cannot read does-not-exist\.csv/);
  const bad = cli(["accel", "tests/fixtures/bad-value.csv"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^error: line 3: /);
  const noMag = cli(["mag", "examples/accel-15pose.csv"]);
  assert.equal(noMag.code, 1);
  assert.match(noMag.err, /no magnetometer/);
});

const EX = {
  accel: "examples/accel-15pose.csv",
  gyro: "examples/gyro-turns-mpu6050-raw.csv",
  mag: "examples/mag-tumble.csv",
};

/** --json results of the three example logs, keyed by in-memory file name. */
function exampleResults() {
  /** @type {Record<string, string>} */
  const mem = {};
  for (const [kind, csv] of Object.entries(EX)) {
    const r = cli([kind, csv, "--json"]);
    assert.equal(r.code, 0, r.err);
    mem[`${kind}.json`] = r.out;
  }
  return mem;
}

/**
 * What the page's export produces for a log, computed the way
 * src/ui/app.js does it: calibrate, summarise, combinedJsonText.
 * @param {string} source
 * @param {{ accel?: string, gyro?: string, mag?: string }} csv
 */
function pageExport(source, csv) {
  const read = (/** @type {string} */ p) =>
    loadCsv(readFileSync(new URL(p, new URL("../", import.meta.url)), "utf8")).data;
  return combinedJsonText({
    source,
    accel: csv.accel ? accelJson(calibrateAccel(read(csv.accel))) : null,
    gyro: csv.gyro ? gyroJson(calibrateGyro(read(csv.gyro))) : null,
    mag: csv.mag ? magJson(calibrateMag(read(csv.mag))) : null,
  });
}

test("combine writes the same bytes as the page's export for the example logs", () => {
  const mem = exampleResults();
  const c = cli(["combine", "mag.json", "accel.json", "gyro.json", "--source", "bench"], mem);
  assert.equal(c.code, 0, c.err);
  assert.equal(c.out, pageExport("bench", EX));
  const j = JSON.parse(c.out);
  assert.deepEqual(Object.keys(j), ["generator", "source", "accel", "gyro", "mag"]);
  assert.equal(j.generator, `imu-calibration-lab ${VERSION}`);
  assert.equal(j.accel.kind, "accel");
  assert.equal(j.gyro.kind, "gyro");
  assert.equal(j.mag.kind, "mag");

  // A subset leaves the missing sensors null, like a log without a magnetometer.
  const part = cli(["combine", "gyro.json", "--out", "cal.json"], mem);
  assert.equal(part.code, 0, part.err);
  assert.equal(part.out, "");
  assert.equal(part.err, "wrote cal.json: gyro\n");
  assert.equal(part.files["cal.json"], pageExport("gyro.json", { gyro: EX.gyro }));
  const two = cli(["combine", "accel.json", "mag.json"], mem);
  assert.equal(JSON.parse(two.out).source, "accel.json, mag.json");
  assert.equal(JSON.parse(two.out).gyro, null);
});

test("combine rejects wrong kinds, duplicates and unreadable files", () => {
  /** @type {Record<string, string>} */
  const mem = {
    ...exampleResults(),
    "allan.json": JSON.stringify({ kind: "allan", axes: [] }),
    "array.json": "[1, 2]",
    "broken.json": "{ not json",
  };
  const combined = cli(["combine", "accel.json", "gyro.json"], mem).out;
  mem["combined.json"] = combined;
  /** @param {string[]} files @param {RegExp} msg */
  const fails = (files, msg) => {
    const r = cli(["combine", ...files], mem);
    assert.equal(r.code, 1, files.join(" "));
    assert.equal(r.out, "");
    assert.match(r.err, msg);
  };
  fails(
    ["accel.json", "allan.json"],
    /^error: allan\.json: kind "allan" is not part of the combined file/,
  );
  // a combined file is not a single result either
  fails(["combined.json"], /^error: combined\.json: no "kind" field/);
  fails(["array.json"], /no "kind" field/);
  fails(
    ["accel.json", "gyro.json", "accel.json"],
    /^error: accel\.json: a second accel result \(the first is accel\.json\)/,
  );
  fails(["broken.json"], /^error: broken\.json: not valid JSON/);
  fails(["gyro.json", "does-not-exist.json"], /^error: cannot read does-not-exist\.json/);
  // a CSV log is not a result file
  fails([EX.accel], /not valid JSON/);
  assert.equal(cli(["combine"]).code, 2);
  assert.equal(cli(["combine", "accel.json", "--c"], mem).code, 2);
});

test("the bin script runs as a separate process", () => {
  const r = spawnSync(process.execPath, ["bin/imu-calibration-lab.js", "--version"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), VERSION);
});
