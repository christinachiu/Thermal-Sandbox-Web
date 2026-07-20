# Digital Thermal Sandbox

An interactive, scroll-driven 3D visualization of measured solar load and shade across a
real site — and a sandbox for testing design interventions against the simulation. Every
colour on screen traces back to a Radiance/Ladybug result file; nothing between sensors
is invented.

Two sites ship live:

- **King's Road · University of Manitoba** (Winnipeg)
- **Lee Square · UBC** (Vancouver)

> A project by Future Elements Studio · UBC SALA · ETH Zürich · UM Campus Planning.

---

## Highlights

- **Scrollytelling → sandbox.** A narrative sequence stands a published site plan up into
  a live isometric model, then hands the model to the user.
- **Measured, not decorative.** Solar load (kWh/m²·yr) and reduction vs. open sky are the
  two measured metrics; modelled metrics (ground temp, sun hours, tree health) are shown
  and badged as such, never dressed up as measured.
- **Design sandbox.** Swap ground materials, plant/remove trees, flip between design
  states, tip from isometric to plan, raise the data as terrain, and cut live sections.
- **Comfort threshold.** Mute every surface below a chosen comfort level, live.
- **Guided + free walkthroughs** with ambient life (people, bikes, cars) on the site's
  real circulation lanes.
- **Multi-site by data.** Adding a site is a data-only change — no engine edits.

---

## Quick start

The app is a single Design Component that loads its runtime, engine, and data at runtime,
so it needs to be served over HTTP (opening the `.dc.html` from `file://` won't work).

```bash
# from the repo root
python3 -m http.server 8000
# then open http://localhost:8000/Digital%20Thermal%20Sandbox%20v3.dc.html
```

Any static server works (`npx serve`, etc.).

### Offline single-file build

`Digital Thermal Sandbox.html` is a self-contained build with the data, engine, fonts,
and runtime inlined — just open it in a browser. **Note:** it still fetches three.js from
a CDN, so it needs an internet connection to render the 3D stage.

---

## Project structure

```
Digital Thermal Sandbox v3.dc.html   # the app (interface + logic)
engine-v2.js                         # 3D rendering engine (three.js); site-generic
sites.json                           # the registry the site toggle binds to
kingsroad_manifest.json              # King's Road constants (reference site)
leesquare_manifest.json              # Lee Square constants + spatial data
kingsroad_web_geometry.json          # King's Road geometry
kingsroad_sensor_data.json           # King's Road simulation results
data/leesquare_web_geometry.json     # Lee Square geometry
leesquare_sensor_data.json           # Lee Square simulation results
dts_standalone_src.html              # source for the offline build
Digital Thermal Sandbox.html         # generated offline build
```

---

## Architecture

The interface and engine behave **identically for every site**. Everything site-specific
lives in that site's manifest and data files — never in the engine. King's Road is the
reference: it omits the optional manifest blocks and falls through to the engine's
built-in defaults, so it renders byte-for-byte as the original.

A manifest supplies materials, metric domains, states, camera framing (`frame`), site
extent (`space.bounds`), ambient circulation (`lanes`), and street furniture (`props`).
`sites.json` lists which manifests are live.

### Adding a site

1. Export the site's geometry + calibrated sensor JSON.
2. Write `<site>_manifest.json` (materials, metrics, states, plus `frame`, `space.bounds`,
   `lanes`, `props`).
3. Add a row to `sites.json` with `status: "live"`.

No engine edit required. See the in-repo notes for the full manifest schema.

---

## Data & honesty rules

- Legend domains are fixed across design states, so flipping the lever never rescales colours.
- Only states that were actually simulated exist; new states arrive as new simulation drops.
- Nothing is interpolated between sensors — unmeasured ground reads as unmeasured.
- Estimated figures (e.g. care & cost) are visibly segregated and badged, never mixed with measured data.

---

## Tech

Vanilla JS + [three.js](https://threejs.org/) (loaded from CDN). No build step — the app
runs directly in the browser.

---

## License

TODO — add a license before publishing.
