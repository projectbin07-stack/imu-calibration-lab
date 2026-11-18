import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeState, defaultState, encodeState, sampleTab } from "../src/ui/state.js";
import { makeSample, SAMPLES } from "../src/core/samples.js";
import { loadCsv } from "../src/core/load.js";

test("defaults encode to an empty query and decode back", () => {
  assert.equal(encodeState(defaultState()), "");
  assert.deepEqual(decodeState("").state, defaultState());
});

test("round trip of every setting", () => {
  const st = {
    ...defaultState(),
    sample: "gyro",
    tab: /** @type {const} */ ("accel"),
    model: /** @type {const} */ ("twelve"),
    window: 0.8,
    k: 6,
    minStatic: 2.5,
    angle: 720,
    tempBin: 0.5,
    dip: -12.5,
    allanSensor: /** @type {const} */ ("accel"),
    theme: /** @type {const} */ ("dark"),
  };
  const q = encodeState(st);
  assert.equal(
    q,
    "s=gyro&tab=accel&am=twelve&w=0.8&k=6&ms=2.5&ang=720&tb=0.5&dip=-12.5&as=accel&theme=dark",
  );
  const back = decodeState(q);
  assert.deepEqual(back.state, st);
  assert.deepEqual(back.ignored, []);
});

test("a sample opens on its own tab unless the link names another", () => {
  assert.equal(sampleTab("mag"), "mag");
  assert.equal(sampleTab("file"), "accel");
  assert.equal(decodeState("s=noise").state.tab, "allan");
  assert.equal(encodeState(decodeState("s=noise").state), "s=noise");
  assert.equal(decodeState("s=noise&tab=gyro").state.tab, "gyro");
});

test("invalid values and unknown keys are ignored and listed", () => {
  const { state, ignored } = decodeState(
    "s=nope&tab=x&am=ten&w=-1&k=abc&dip=200&as=mag&theme=pink&zzz=1&tb=",
  );
  assert.deepEqual(state, defaultState());
  assert.deepEqual(ignored.sort(), ["am", "as", "dip", "k", "s", "tab", "tb", "theme", "w", "zzz"]);
  assert.equal(decodeState("s=file").state.sample, "file");
});

test("every sample generates and imports", () => {
  for (const s of SAMPLES) {
    const made = makeSample(s.id);
    const data = "csv" in made ? loadCsv(made.csv).data : made.data;
    assert.ok(data.t.length > 1000, s.id);
  }
  assert.throws(() => makeSample("nope"), /unknown sample/);
});
