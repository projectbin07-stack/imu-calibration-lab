# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-19

First release. All bundled results come from synthetic data; nothing has been
validated on a physical sensor yet.

### Added

- CSV import: plain `t,ax,ay,az,gx,gy,gz,mx,my,mz`, headerless files,
  arbitrary column names with automatic and manual mapping, Arduino MPU6050
  names (`AcX`, `Tmp`, `GyX`...), serial-scope decoded exports
  (`host_time,device_time,source,...`) and snapshots (`channel,time,value`);
  comma, semicolon or tab; BOM, CRLF, comments, quoted fields; line-numbered
  errors.
- Units: raw MPU6050 counts at every full-scale range (register map
  sensitivities), g, m/s^2, deg/s, rad/s, uT, nT, mG, gauss, raw magnetometer
  counts, MPU6050 raw temperature; automatic guesses from magnitudes.
- Static-segment detection from the moving variance with an automatic
  threshold.
- Accelerometer: six-position bias and scale, twelve-parameter least squares
  on axis-aligned poses, nine-parameter Levenberg-Marquardt fit on
  |a| = 1 g; pose list, residuals before and after, scale factors and
  non-orthogonality.
- Gyroscope: bias from static data, temperature-binned linear bias model,
  scale factors from known-angle turns.
- Magnetometer: Li-Griffiths ellipsoid fit, hard-iron offset, symmetric
  soft-iron matrix, sphericity, magnitude spread, coverage, heading error
  estimate with dip from the accelerometer.
- Overlapping Allan deviation with log-spaced cluster times, read-off of
  white noise, bias instability and rate random walk, single-point
  confidence.
- Seeded synthetic generator for every method and four synthetic example
  logs.
- Export as JSON and as a C/C++ header with const structs, apply functions
  and an Arduino example; CI compiles it as C99 and C++11 and compares the
  results with JavaScript.
- CLI: `accel`, `gyro`, `mag`, `allan`, `synth`; text, JSON or C output.
- Browser app: drag and drop, column mapper, time series with static
  segments, pose table, residual histograms, magnetometer projections and a
  rotatable 3D view, Allan plot with fitted lines, temperature plot,
  shareable settings in the URL, light and dark themes, phone layout.

[0.1.0]: https://github.com/projectbin07-stack/imu-calibration-lab/releases/tag/v0.1.0
