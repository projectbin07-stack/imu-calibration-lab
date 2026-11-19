# Security policy

## Supported versions

Only the latest release and the version deployed on GitHub Pages receive fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use the private
vulnerability reporting of this repository on GitHub (Security tab, "Report a
vulnerability"):
https://github.com/projectbin07-stack/imu-calibration-lab/security/advisories/new

Include what you found, how to reproduce it and the version or commit. This is
a spare-time project maintained by one person, so there is no guaranteed
response time.

## Scope

The web page is static. It makes no network requests after loading its own
files and sends no data anywhere. A CSV you drop or choose is read inside the
browser with the File API and is never uploaded. Column names and file
contents are inserted into the page as text, never as HTML. URL parameters
are parsed as numbers or matched against fixed lists, and the data itself is
never put in the URL. The page stores nothing. "Copy" and "Copy link" write
to the clipboard and "Download" creates a local file.

The CLI reads the CSV you name, writes a file only for `synth --out <file>`,
and opens no network connections. `scripts/serve.js` is a development server
bound to 127.0.0.1; do not expose it to a network.

## Not a safety component

Calibration parameters are estimates from your log and have only been tested
on synthetic data. Check the residuals before using them, and do not rely on
them alone where a wrong attitude or heading is dangerous (flight control,
navigation of vehicles that carry people, anything near people or property).
