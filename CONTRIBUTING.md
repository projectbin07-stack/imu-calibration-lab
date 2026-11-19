# Contributing

Bug reports, logs from real sensors, corrections to the methods and pull
requests are welcome.

## Setup

```bash
git clone https://github.com/projectbin07-stack/imu-calibration-lab.git
cd imu-calibration-lab
npm ci            # dev tools only: TypeScript (type checking), Prettier, Node types
npm run serve     # http://127.0.0.1:8000/
```

The site has no runtime dependencies and no build step: `index.html` loads
the ES modules in `src/` directly. Any static file server works.

## Checks

All of these must pass; CI runs them on Ubuntu and Windows with Node 22 and
24, plus a CLI smoke test, a compile check of the generated C/C++ header
(gcc and g++, warnings as errors) and a headless Chrome smoke test of the
page.

```bash
npm run format:check
npm run typecheck
npm run coverage      # node:test with line, branch and function thresholds
node scripts/check-c-export.js   # needs gcc and g++
```

`npm run check` runs the first three.

## Guidelines

- Keep the shipped page free of runtime dependencies and network calls.
  Data must never leave the browser. Dev tools go in `devDependencies` and
  must not be imported from `src/`.
- Keep computation out of `src/ui/app.js` and `src/ui/draw.js`. Everything
  that computes a number lives in `src/core/` (or `src/ui/state.js`) and has
  tests.
- A new method needs a synthetic test that recovers known parameters within
  a stated tolerance, over several seeds, and a section in
  `docs/methods.md` with the equations and a citation. Implement published
  equations yourself; do not copy code from other libraries.
- Do not describe a result as validated on hardware unless the log and the
  reference it was compared with are part of the change.
- Real sensor logs are the most useful contribution: a multi-position
  accelerometer log, a gyroscope turn on a fixture, a magnetometer tumble,
  or a long stationary log, with the sensor, full-scale settings, filter
  settings and sample rate. Keep files small (minutes, not hours) or link
  to them.
- Synthetic examples in `examples/` are regenerated with
  `node scripts/make-examples.js`; do not edit them by hand.
- Types are JSDoc comments checked by `tsc --checkJs` in strict mode.
- Small, focused commits with imperative messages.
