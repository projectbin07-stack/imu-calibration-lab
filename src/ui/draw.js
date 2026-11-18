// Canvas charts, no libraries. Colours come from CSS custom properties so
// the light and dark themes both work. Every function redraws the whole
// chart from its inputs.

/**
 * @typedef {object} Palette
 * @property {string} fg
 * @property {string} muted
 * @property {string} grid
 * @property {string} axis
 * @property {string} surface
 * @property {string[]} series
 * @property {string} neutral
 * @property {string} seg
 * @property {string} crit
 */

/** @returns {Palette} */
export function palette() {
  const s = getComputedStyle(document.documentElement);
  const v = (/** @type {string} */ name) => s.getPropertyValue(name).trim();
  return {
    fg: v("--fg"),
    muted: v("--muted"),
    grid: v("--grid"),
    axis: v("--axis"),
    surface: v("--chart-bg"),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--s${i}`)),
    neutral: v("--neutral"),
    seg: v("--seg"),
    crit: v("--crit"),
  };
}

const FONT = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * Size the backing store to the CSS box and the device pixel ratio.
 * @param {HTMLCanvasElement} canvas
 * @returns {{ctx: CanvasRenderingContext2D, w: number, h: number}}
 */
function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(160, canvas.clientWidth);
  const h = Math.max(80, canvas.clientHeight);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = FONT;
  ctx.lineJoin = "round";
  return { ctx, w, h };
}

/**
 * "Nice" linear ticks.
 * @param {number} lo
 * @param {number} hi
 * @param {number} count
 * @returns {number[]}
 */
export function ticks(lo, hi, count) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  /** @type {number[]} */
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step)
    out.push(Number(v.toPrecision(10)));
  return out;
}

/**
 * @param {number} v
 * @returns {string}
 */
function tickLabel(v) {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e4 || a < 1e-3) return v.toExponential(0);
  return String(Number(v.toPrecision(4)));
}

/**
 * @typedef {object} Frame
 * @property {number} x0 left of plot area
 * @property {number} x1 right
 * @property {number} y0 top
 * @property {number} y1 bottom
 * @property {(v: number) => number} sx
 * @property {(v: number) => number} sy
 */

/**
 * Axes with grid lines and tick labels; returns the coordinate mapping.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Palette} p
 * @param {{x0: number, x1: number, y0: number, y1: number}} box
 * @param {[number, number]} xr
 * @param {[number, number]} yr
 * @param {{xLabel?: string, yLabel?: string, xTicks?: number, yTicks?: number}} [opts]
 * @returns {Frame}
 */
function axes(ctx, p, box, xr, yr, opts = {}) {
  const { x0, x1, y0, y1 } = box;
  const sx = (/** @type {number} */ v) => x0 + ((v - xr[0]) / (xr[1] - xr[0] || 1)) * (x1 - x0);
  const sy = (/** @type {number} */ v) => y1 - ((v - yr[0]) / (yr[1] - yr[0] || 1)) * (y1 - y0);
  ctx.lineWidth = 1;
  ctx.strokeStyle = p.grid;
  ctx.fillStyle = p.muted;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const t of ticks(yr[0], yr[1], opts.yTicks ?? 5)) {
    const y = Math.round(sy(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.fillText(tickLabel(t), x0 - 4, y);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const t of ticks(xr[0], xr[1], opts.xTicks ?? 8)) {
    const x = Math.round(sx(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
    ctx.fillText(tickLabel(t), x, y1 + 4);
  }
  ctx.strokeStyle = p.axis;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
  if (opts.xLabel) {
    ctx.textAlign = "right";
    ctx.fillText(opts.xLabel, x1, y1 + 18);
  }
  if (opts.yLabel) {
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(opts.yLabel, x0, y0 - 3);
  }
  return { x0, x1, y0, y1, sx, sy };
}

/**
 * Small legend in the top-right corner of a frame.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Palette} p
 * @param {Frame} f
 * @param {Array<{label: string, color: string, dash?: boolean}>} items
 */
function legend(ctx, p, f, items) {
  ctx.font = FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const widths = items.map((it) => ctx.measureText(it.label).width + 26);
  let x = f.x1 - widths.reduce((s, v) => s + v, 0) - 4;
  const y = f.y0 + 10;
  ctx.fillStyle = p.surface;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(x - 4, y - 8, f.x1 - x, 16);
  ctx.globalAlpha = 1;
  items.forEach((it, i) => {
    ctx.strokeStyle = it.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(it.dash ? [5, 3] : []);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 16, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = p.fg;
    ctx.fillText(it.label, x + 20, y);
    x += widths[i];
  });
}

/**
 * Three-axis time series, decimated to min/max per pixel column, with shaded
 * spans (static segments) and outlined spans (rotations used).
 * @param {HTMLCanvasElement} canvas
 * @param {Float64Array} t
 * @param {ArrayLike<number>[]} series
 * @param {{shade?: Array<{start: number, end: number}>, mark?: Array<{t0: number, t1: number, label: string}>, labels?: string[], unit?: string}} [opts]
 */
export function drawTimeSeries(canvas, t, series, opts = {}) {
  const { ctx, w, h } = setup(canvas);
  const p = palette();
  const n = t.length;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series)
    for (let i = 0; i < n; i++) {
      if (s[i] < lo) lo = s[i];
      if (s[i] > hi) hi = s[i];
    }
  const pad = (hi - lo) * 0.06 || 1;
  const f = axes(
    ctx,
    p,
    { x0: 48, x1: w - 8, y0: 20, y1: h - 34 },
    [t[0], t[n - 1]],
    [lo - pad, hi + pad],
    {
      xLabel: "time (s)",
      yLabel: opts.unit,
    },
  );
  ctx.fillStyle = p.seg;
  for (const s of opts.shade ?? []) {
    const a = f.sx(t[s.start]);
    const b = f.sx(t[Math.min(n - 1, s.end - 1)]);
    ctx.fillRect(a, f.y0, Math.max(1, b - a), f.y1 - f.y0);
  }
  ctx.strokeStyle = p.fg;
  ctx.setLineDash([3, 3]);
  ctx.fillStyle = p.fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const m of opts.mark ?? []) {
    const a = f.sx(m.t0);
    const b = f.sx(m.t1);
    ctx.strokeRect(a, f.y0 + 1, b - a, f.y1 - f.y0 - 2);
    ctx.fillText(m.label, (a + b) / 2, f.y0 + 3);
  }
  ctx.setLineDash([]);
  const cols = Math.max(1, Math.floor(f.x1 - f.x0));
  series.forEach((s, k) => {
    ctx.strokeStyle = p.series[k];
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (n <= cols * 2) {
      for (let i = 0; i < n; i++) {
        const x = f.sx(t[i]);
        const y = f.sy(s[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    } else {
      let i = 0;
      for (let c = 0; c < cols && i < n; c++) {
        const tEnd = t[0] + ((c + 1) / cols) * (t[n - 1] - t[0]);
        let mn = Infinity;
        let mx = -Infinity;
        for (; i < n && t[i] <= tEnd; i++) {
          if (s[i] < mn) mn = s[i];
          if (s[i] > mx) mx = s[i];
        }
        if (mn === Infinity) continue;
        const x = f.x0 + c + 0.5;
        if (c === 0) ctx.moveTo(x, f.sy(mx));
        ctx.lineTo(x, f.sy(mx));
        ctx.lineTo(x, f.sy(mn));
      }
    }
    ctx.stroke();
  });
  legend(
    ctx,
    p,
    f,
    (opts.labels ?? ["x", "y", "z"]).map((label, k) => ({ label, color: p.series[k] })),
  );
}

/**
 * @param {number[]} v
 * @returns {number}
 */
const rms = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / Math.max(1, v.length));

/**
 * Two histograms one above the other, each with its own x range, so a
 * residual that shrinks by 100x is still visible after calibration.
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} before
 * @param {number[]} after
 * @param {{unit: string, scale?: number}} opts scale multiplies the values (g -> mg)
 */
export function drawHistograms(canvas, before, after, opts) {
  const { ctx, w, h } = setup(canvas);
  const p = palette();
  const k = opts.scale ?? 1;
  const half = (h - 8) / 2;
  [
    { data: before, label: "before", color: p.neutral, top: 4 },
    { data: after, label: "after", color: p.series[0], top: 4 + half },
  ].forEach(({ data, label, color, top }) => {
    const v = data.map((x) => x * k);
    if (v.length === 0) return;
    const sorted = [...v].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.005)];
    const hi = sorted[Math.ceil(sorted.length * 0.995) - 1];
    const span = hi - lo || Math.abs(hi) || 1;
    const a = lo - span * 0.05;
    const b = hi + span * 0.05;
    const bins = 40;
    const counts = new Array(bins).fill(0);
    for (const x of v) {
      const i = Math.floor(((x - a) / (b - a)) * bins);
      if (i >= 0 && i < bins) counts[i]++;
    }
    const cmax = Math.max(...counts, 1);
    const f = axes(
      ctx,
      p,
      { x0: 40, x1: w - 8, y0: top + 16, y1: top + half - 22 },
      [a, b],
      [0, cmax],
      {
        yTicks: 2,
        xTicks: 6,
      },
    );
    ctx.fillStyle = color;
    const bw = (f.x1 - f.x0) / bins;
    counts.forEach((c, i) => {
      const y = f.sy(c);
      ctx.fillRect(f.x0 + i * bw + 0.5, y, Math.max(1, bw - 1), f.y1 - y);
    });
    ctx.fillStyle = p.fg;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(
      `${label}: RMS ${Number(rms(v).toPrecision(3))} ${opts.unit}, n = ${v.length}`,
      f.x0,
      f.y0 - 2,
    );
  });
}

/**
 * Three orthographic projections (XY, XZ, YZ) of raw and corrected samples.
 * Raw points are drawn relative to the fitted centre so both clouds share
 * the panel; the reference circle has the field-strength radius.
 * @param {HTMLCanvasElement} canvas
 * @param {number[][]} raw
 * @param {number[][]} cal
 * @param {number[]} center hard-iron offset
 * @param {number} radius field strength
 * @param {string} unit
 */
export function drawProjections(canvas, raw, cal, center, radius, unit) {
  const { ctx, w, h } = setup(canvas);
  const p = palette();
  /** @type {Array<[number, number, string, string]>} */
  const pairs = [
    [0, 1, "x", "y"],
    [0, 2, "x", "z"],
    [1, 2, "y", "z"],
  ];
  let ext = radius;
  for (const q of raw) for (let a = 0; a < 3; a++) ext = Math.max(ext, Math.abs(q[a] - center[a]));
  ext *= 1.08;
  const pw = w / 3;
  pairs.forEach(([i, j, li, lj], k) => {
    const size = Math.min(pw - 16, h - 30);
    const cx = pw * k + pw / 2;
    const cy = 12 + size / 2;
    const s = size / (2 * ext);
    ctx.strokeStyle = p.axis;
    ctx.strokeRect(cx - size / 2 + 0.5, cy - size / 2 + 0.5, size, size);
    ctx.strokeStyle = p.grid;
    ctx.beginPath();
    ctx.moveTo(cx - size / 2, cy);
    ctx.lineTo(cx + size / 2, cy);
    ctx.moveTo(cx, cy - size / 2);
    ctx.lineTo(cx, cy + size / 2);
    ctx.stroke();
    ctx.fillStyle = p.neutral;
    ctx.globalAlpha = 0.45;
    for (const q of raw)
      ctx.fillRect(cx + (q[i] - center[i]) * s - 1, cy - (q[j] - center[j]) * s - 1, 2, 2);
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = p.series[0];
    for (const q of cal) ctx.fillRect(cx + q[i] * s - 1, cy - q[j] * s - 1, 2, 2);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = p.series[1];
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, radius * s, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = p.muted;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(`${li} (right) vs ${lj} (up), ${unit}`, cx, cy + size / 2 + 4);
  });
}

/**
 * Rotatable orthographic 3D scatter of raw (around its centre) and
 * corrected samples with body axes.
 * @param {HTMLCanvasElement} canvas
 * @param {number[][]} raw
 * @param {number[][]} cal
 * @param {number[]} center
 * @param {number} yaw rad
 * @param {number} pitch rad
 */
export function draw3D(canvas, raw, cal, center, yaw, pitch) {
  const { ctx, w, h } = setup(canvas);
  const p = palette();
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // view: rotate about z by yaw, then about the screen x axis by pitch
  /** @param {number[]} v @returns {[number, number, number]} */
  const view = (v) => {
    const x1 = cy * v[0] - sy * v[1];
    const y1 = sy * v[0] + cy * v[1];
    return [x1, cp * v[2] - sp * y1, sp * v[2] + cp * y1];
  };
  let ext = 1e-9;
  for (const q of raw)
    ext = Math.max(ext, Math.hypot(q[0] - center[0], q[1] - center[1], q[2] - center[2]));
  const s = Math.min(w, h) / (2.3 * ext);
  const ox = w / 2;
  const oy = h / 2;
  /** @type {Array<[number, number, number, string]>} */
  const pts = [];
  for (const q of raw) {
    const v = view([q[0] - center[0], q[1] - center[1], q[2] - center[2]]);
    pts.push([v[0], v[1], v[2], p.neutral]);
  }
  for (const q of cal) {
    const v = view(q);
    pts.push([v[0], v[1], v[2], p.series[0]]);
  }
  pts.sort((a, b) => a[2] - b[2]);
  for (const [x, y, z, color] of pts) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35 + 0.5 * Math.min(1, Math.max(0, (z / ext + 1) / 2));
    ctx.fillRect(ox + x * s - 1, oy - y * s - 1, 2.2, 2.2);
  }
  ctx.globalAlpha = 1;
  ["x", "y", "z"].forEach((name, a) => {
    const e = [0, 0, 0];
    e[a] = ext * 0.9;
    const v = view(e);
    ctx.strokeStyle = p.series[a + 2];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + v[0] * s, oy - v[1] * s);
    ctx.stroke();
    ctx.fillStyle = p.fg;
    ctx.fillText(name, ox + v[0] * s * 1.06, oy - v[1] * s * 1.06);
  });
  ctx.lineWidth = 1;
  legend(ctx, p, { x0: 0, x1: w - 4, y0: 2, y1: h, sx: (v) => v, sy: (v) => v }, [
    { label: "raw - centre", color: p.neutral },
    { label: "corrected", color: p.series[0] },
  ]);
}

/**
 * Log-log Allan deviation plot with error bars and fitted read-off lines.
 * @param {HTMLCanvasElement} canvas
 * @param {import("../core/allan.js").AllanAxis[]} axesData
 * @param {string} unit
 */
export function drawAllan(canvas, axesData, unit) {
  const { ctx, w, h } = setup(canvas);
  const p = palette();
  let tl = Infinity;
  let th = -Infinity;
  let al = Infinity;
  let ah = -Infinity;
  for (const a of axesData)
    a.curve.tau.forEach((t, i) => {
      const v = a.curve.adev[i];
      const e = a.curve.relError[i];
      tl = Math.min(tl, t);
      th = Math.max(th, t);
      al = Math.min(al, v * Math.max(0.05, 1 - e));
      ah = Math.max(ah, v * (1 + e));
    });
  const lx = [Math.floor(Math.log10(tl)), Math.ceil(Math.log10(th))];
  const ly = [Math.floor(Math.log10(al)), Math.ceil(Math.log10(ah))];
  const box = { x0: 54, x1: w - 10, y0: 22, y1: h - 36 };
  const sx = (/** @type {number} */ t) =>
    box.x0 + ((Math.log10(t) - lx[0]) / (lx[1] - lx[0] || 1)) * (box.x1 - box.x0);
  const sy = (/** @type {number} */ v) =>
    box.y1 - ((Math.log10(v) - ly[0]) / (ly[1] - ly[0] || 1)) * (box.y1 - box.y0);
  ctx.lineWidth = 1;
  ctx.fillStyle = p.muted;
  for (let d = lx[0]; d <= lx[1]; d++) {
    for (let m = 1; m < 10; m++) {
      const x = Math.round(sx(m * 10 ** d)) + 0.5;
      if (x > box.x1 + 1) break;
      ctx.strokeStyle = m === 1 ? p.axis : p.grid;
      ctx.beginPath();
      ctx.moveTo(x, box.y0);
      ctx.lineTo(x, box.y1);
      ctx.stroke();
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(`1e${d}`, sx(10 ** d), box.y1 + 4);
  }
  for (let d = ly[0]; d <= ly[1]; d++) {
    for (let m = 1; m < 10; m++) {
      const y = Math.round(sy(m * 10 ** d)) + 0.5;
      if (y < box.y0 - 1) break;
      ctx.strokeStyle = m === 1 ? p.axis : p.grid;
      ctx.beginPath();
      ctx.moveTo(box.x0, y);
      ctx.lineTo(box.x1, y);
      ctx.stroke();
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(`1e${d}`, box.x0 - 4, sy(10 ** d));
  }
  ctx.strokeStyle = p.axis;
  ctx.strokeRect(box.x0 + 0.5, box.y0 + 0.5, box.x1 - box.x0, box.y1 - box.y0);
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText("cluster time tau (s)", box.x1, box.y1 + 18);
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(`Allan deviation (${unit})`, box.x0, box.y0 - 3);

  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
  ctx.clip();
  axesData.forEach((a, k) => {
    const color = p.series[k];
    const c = a.curve;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    c.tau.forEach((t, i) => {
      const x = sx(t);
      ctx.beginPath();
      ctx.moveTo(x, sy(c.adev[i] * (1 + c.relError[i])));
      ctx.lineTo(x, sy(c.adev[i] * Math.max(0.02, 1 - c.relError[i])));
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    c.tau.forEach((t, i) =>
      i ? ctx.lineTo(sx(t), sy(c.adev[i])) : ctx.moveTo(sx(t), sy(c.adev[i])),
    );
    ctx.stroke();
    ctx.fillStyle = color;
    c.tau.forEach((t, i) => ctx.fillRect(sx(t) - 1.5, sy(c.adev[i]) - 1.5, 3, 3));
    // fitted lines, dashed, over the whole plot width
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.2;
    const wn = a.terms.whiteNoise;
    if (wn) {
      ctx.beginPath();
      ctx.moveTo(sx(10 ** lx[0]), sy(wn.value / Math.sqrt(10 ** lx[0])));
      ctx.lineTo(sx(10 ** lx[1]), sy(wn.value / Math.sqrt(10 ** lx[1])));
      ctx.stroke();
    }
    const rr = a.terms.rateRandomWalk;
    if (rr) {
      ctx.beginPath();
      ctx.moveTo(sx(10 ** lx[0]), sy(rr.value * Math.sqrt(10 ** lx[0] / 3)));
      ctx.lineTo(sx(10 ** lx[1]), sy(rr.value * Math.sqrt(10 ** lx[1] / 3)));
      ctx.stroke();
    }
    const bi = a.terms.biasInstability;
    if (bi) {
      ctx.beginPath();
      ctx.moveTo(box.x0, sy(bi.adevMin));
      ctx.lineTo(box.x1, sy(bi.adevMin));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(sx(bi.tau), sy(bi.adevMin), 5, 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  });
  ctx.restore();
  legend(
    ctx,
    p,
    { x0: box.x0, x1: box.x1, y0: box.y0, y1: box.y1, sx, sy },
    axesData.map((a, k) => ({ label: a.axis, color: p.series[k] })),
  );
}

/**
 * Gyroscope bias per temperature bin with the fitted lines.
 * @param {HTMLCanvasElement} canvas
 * @param {import("../core/gyro.js").TempModel | null} model
 */
export function drawTempBias(canvas, model) {
  const { ctx, w, h } = setup(canvas);
  const p = palette();
  if (!model) {
    ctx.fillStyle = p.muted;
    ctx.textAlign = "center";
    ctx.fillText("no temperature column, or too small a temperature range", w / 2, h / 2);
    return;
  }
  const temps = model.bins.map((b) => b.temp);
  const t0 = Math.min(...temps) - 0.5;
  const t1 = Math.max(...temps) + 0.5;
  // each axis relative to its bias at the reference temperature
  const rel = model.bins.map((b) => b.bias.map((v, a) => v - model.bias[a]));
  let lo = 0;
  let hi = 0;
  for (const r of rel) for (const v of r) ((lo = Math.min(lo, v)), (hi = Math.max(hi, v)));
  const pad = (hi - lo) * 0.1 || 0.01;
  const f = axes(
    ctx,
    p,
    { x0: 52, x1: w - 8, y0: 20, y1: h - 34 },
    [t0, t1],
    [lo - pad, hi + pad],
    {
      xLabel: "temperature (degC)",
      yLabel: "bias - bias(ref) (deg/s)",
    },
  );
  [0, 1, 2].forEach((a) => {
    ctx.strokeStyle = p.series[a];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(f.sx(t0), f.sy(model.slope[a] * (t0 - model.refTemp)));
    ctx.lineTo(f.sx(t1), f.sy(model.slope[a] * (t1 - model.refTemp)));
    ctx.stroke();
    ctx.fillStyle = p.series[a];
    rel.forEach((r, i) => {
      ctx.beginPath();
      ctx.arc(f.sx(temps[i]), f.sy(r[a]), 3, 0, 2 * Math.PI);
      ctx.fill();
    });
  });
  legend(ctx, p, f, [
    { label: "x", color: p.series[0] },
    { label: "y", color: p.series[1] },
    { label: "z", color: p.series[2] },
  ]);
}
