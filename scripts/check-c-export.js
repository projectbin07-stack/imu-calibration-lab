// Compiles the generated C headers as C99 and C++11 with warnings as errors,
// runs the apply functions on fixed inputs and compares the results with
// the JavaScript implementation. Needs gcc and g++ (CI runs it on Ubuntu).
// Usage: node scripts/check-c-export.js

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAccel, calibrateAccel } from "../src/core/accel.js";
import { cHeader } from "../src/core/export.js";
import { biasAt, calibrateGyro } from "../src/core/gyro.js";
import { loadCsv } from "../src/core/load.js";
import { calibrateMag } from "../src/core/mag.js";

const root = new URL("../", import.meta.url);
const out = new URL("out/", root);
mkdirSync(out, { recursive: true });
const load = (/** @type {string} */ p) => loadCsv(readFileSync(new URL(p, root), "utf8"));

const a = load("examples/accel-15pose.csv");
const g = load("examples/gyro-turns-mpu6050-raw.csv");
const m = load("examples/mag-tumble.csv");
const accel = calibrateAccel(a.data);
const gyro = calibrateGyro(g.data);
const mag = calibrateMag(m.data);
writeFileSync(new URL("accel.h", out), cHeader({ accel, units: a.units }));
writeFileSync(new URL("gyro.h", out), cHeader({ gyro, units: g.units }));
writeFileSync(new URL("mag.h", out), cHeader({ mag, units: m.units }));

const ain = [0.12, -0.31, 0.95];
const gin = [-1.2, 3.4, 10.5];
const temp = 29.5;
const min = [40.5, -12.25, 3.75];
const c = `#include <stdio.h>
#include "accel.h"
#include "gyro.h"
#include "mag.h"
int main(void) {
  const float ain[3] = {${ain.join("f, ")}f};
  const float gin[3] = {${gin.join("f, ")}f};
  const float min[3] = {${min.join("f, ")}f};
  float o[3];
  imu_accel_apply(&IMU_ACCEL_CAL, ain, o);
  printf("%.7g %.7g %.7g\\n", o[0], o[1], o[2]);
  imu_gyro_apply(&IMU_GYRO_CAL, gin, ${temp}f, o);
  printf("%.7g %.7g %.7g\\n", o[0], o[1], o[2]);
  imu_mag_apply(&IMU_MAG_CAL, min, o);
  printf("%.7g %.7g %.7g\\n", o[0], o[1], o[2]);
  return 0;
}
`;
writeFileSync(new URL("check.c", out), c);
writeFileSync(new URL("check.cpp", out), c);
const dir = fileURLToPath(out);
const flags = ["-Wall", "-Wextra", "-Werror", "-pedantic", "-I", dir];
execFileSync("gcc", ["-std=c99", ...flags, "-o", join(dir, "check-c"), join(dir, "check.c")], {
  stdio: "inherit",
});
execFileSync(
  "g++",
  ["-std=c++11", ...flags, "-o", join(dir, "check-cpp"), join(dir, "check.cpp")],
  {
    stdio: "inherit",
  },
);

const t = gyro.temperature;
const gb = t ? biasAt(t, temp) : gyro.bias;
const want = [
  applyAccel(accel, ain),
  gin.map((v, i) => (v - gb[i]) / gyro.scale[i]),
  mag.softIron.map((row) => row.reduce((s, w, j) => s + w * (min[j] - mag.hardIron[j]), 0)),
];
let bad = 0;
for (const exe of ["check-c", "check-cpp"]) {
  const lines = execFileSync(join(dir, exe), { encoding: "utf8" }).trim().split("\n");
  lines.forEach((line, k) => {
    const got = line.split(" ").map(Number);
    got.forEach((v, i) => {
      const w = want[k][i];
      // float32 constants and arithmetic: 1e-4 relative is plenty
      if (Math.abs(v - w) > 1e-4 * Math.max(1, Math.abs(w))) {
        console.error(`${exe} line ${k + 1} component ${i}: C ${v}, JS ${w}`);
        bad++;
      }
    });
  });
  console.log(`${exe}: ${lines.join(" | ")}`);
}
if (bad) process.exit(1);
console.log("C and C++ exports compile without warnings and match the JavaScript results");
