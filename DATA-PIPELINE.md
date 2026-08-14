# Data pipeline — how the source drops became the app's JSON

Two independent conversions feed every site:

| output | built from | tool |
|---|---|---|
| `<site>_sensor_data.json` | the simulation drop in Dropbox (Ladybug/Radiance results + EPW) | per-site converter |
| `<site>_web_geometry.json` | the team's Rhino `.3dm` (King's Road) or the Radiance envelope exported from Rhino/GH (Lee Square) | per-site converter |

Both land in **sensor space**: metres, one shared origin per site, XY only for ground.
The two files must agree on that frame or the colour map slides off the geometry — this is
the single invariant the whole pipeline exists to protect.

`convert_treeheat_to_web.py` (in this repo) is the Lee Square converter and the worked
reference for both halves. The King's Road converter ran earlier, off-repo, against the
`.3dm` files directly; its behaviour is recorded in `kingsroad_web_geometry.json`'s `meta`
and reproduced below.

---

## Part 1 — Dropbox drop → `<site>_sensor_data.json`

### What arrives in Dropbox

A simulation drop, not a model. Per state (baseline / scenario):

- **Annual raytrace results** — one value per sensor per hour, 8760 hours.
  Lee Square: `outputs_vancouver/raytracing/<scenario>_direct.feather` +
  `<scenario>_diffuse.feather`. King's Road: Ladybug annual-irradiance result files.
- **The sensor grid** — `inputs/grid_records/scenario_sensor_grid.csv`: one row per sensor,
  `x_coord`, `y_coord`, and `ghp_tree` (the grid name, e.g. `grid00_unit_paver_pathways`).
- **The weather file** — the EPW the run used.
  Lee Square: `weather_vancouver.epw`. King's Road: `CAN_MB_Winnipeg-Richardson.Intl.AP.718520_TDY-CWEC2020v2.epw`.
- **The material library** — `inputs/base_material_library.txt` (Radiance), for albedo.

### Steps

**1. Sum the annual hourly stack per sensor.**
`total = direct + diffuse` → `(n_sensors, 8760)` W/m². Then

```
load_kwh_m2_yr = total.sum(axis=1) / 1000
peak_w_m2      = total.max(axis=1)
```

**2. Read the true open-sky reference out of the EPW.** Field 13 (0-based) of each data
row is Global Horizontal Radiation. Sum over 8760 h for the annual reference, max for the
peak. A flat unobstructed sensor receives exactly this.
Vancouver = **1262.6 kWh/m²·yr**, peak **930 W/m²**. Winnipeg = **1323.4 kWh/m²·yr**.

**3. Calibrate the raytrace to a horizontal basis (Lee Square only).** The treeheat
feathers sum the direct component as **DNI, never projected to horizontal**, so raw loads
run ~2.23× and raw peaks ~1.57× above physical. Rather than re-run the raytrace, the
converter anchors the brightest (open) ground sensor of the **reference state** to the EPW:

```
load_scale = OPEN_SKY_KWH / (max(load_kwh) * 1.05)   # brightest ≈ 95% of annual GHI
peak_scale = PEAK_GHI_W   /  max(peak_w)             # brightest peak = annual peak GHI
```

That one calibration is cached and reused for **every** state, so TODAY and PROPOSED stay
directly comparable. Both scales are written into `meta.calibration` — the record of what
was multiplied and why. The root-cause fix is projecting DNI→horizontal
(`DHI + DNI·max(cos z, 0)`) inside the raytrace; the anchor reproduces that result without
a re-run. King's Road came out of Ladybug already horizontal and is **not** calibrated.

**4. Group sensors by material and grid.** Strip the `grid\d+_` prefix off `ghp_tree` to get
the material key; the remainder of the name is the grid. Each point becomes a bare 4-tuple:

```
["x", "y", "load_kwh_m2_yr", "peak_w_m2"]
```

**5. Write the file.** Shape:

```jsonc
{ "meta": {
    "units":        { "xy": "m …", "load": "kWh/m2 per year", "peak": "W/m2" },
    "point_format": ["x","y","load","peak"],
    "derived":      "average irradiance (W/m2) = load * 1000 / 8760",
    "source":       "…which engine, which EPW…",
    "open_sky":     { "ghi_kwh_m2_yr": 1323.4, "source": "…", "usage": "solar_reduction = clamp(1 - load/ghi, 0, 1)" },
    "calibration":  { "load_scale": …, "peak_scale": … }        // Lee Square only
  },
  "data": { "<state>": { "<material>": { "grids": [ { "id": …, "points": [[x,y,load,peak], …] } ] } } } }
```

Minified (`separators=(",",":")`) — these files are 0.65–0.80 MB and are fetched at load.

### Gotcha carried forward

The Lee Square converter emits `open_sky.kwh_m2_yr`; King's Road uses `ghi_kwh_m2_yr`. The
manifest's `openSkyKey` plus the engine's defensive read
(`_os[site.openSkyKey] ?? _os.ghi_kwh_m2_yr ?? _os.kwh_m2_yr`) make both load. To
standardise, have the converter emit `ghi_kwh_m2_yr` too and point every `openSkyKey` at it.

---

## Part 2 — Rhino → `<site>_web_geometry.json`

Two routes were used, because the two sites arrived differently.

### Route A — King's Road: straight out of the `.3dm`

Sources: `FES_DTS_Kings Road_Baseline Simulation_20260614.3dm` (baseline) and
`Kings Road Scenario 1.3dm` (scenario_01).

1. **Read the layers.** Ground surfaces are grouped by their Rhino layer, and the layer name
   *is* the material key (`asphalt_road`, `unit_pavers`, `grass`, …). Same keys as the sensor
   file — that's what lets the engine join them.
2. **Transform into sensor space.** The baseline model is in centimetres on the survey grid:

   ```
   sensor_xy = (model_cm − (−307470.5, −139398.9)) / 100
   ```

   which puts it on the Radiance `.pts` frame. `scenario_01` was *already* exported in sensor
   metres and is passed through untransformed — verify this on any new drop rather than
   assuming it.
3. **Flatten ground to 2D rings.** Each surface becomes `{ "outer": [[x,y], …], "holes": [] }`,
   coordinates rounded to 3 dp.
4. **Buildings** keep their Z: `{ "name", "height", "mesh": { "v": [[x,y,z]…], "f": [[i,j,k]…] } }`.
   7 in the baseline. The Stores Building is absent from `scenario_01` (replaced by planted
   area) — design intent, not a conversion loss.
5. **Trees** come from the species layers `Trees::*` → `{ species, pos:[x,y], height, radius, hull }`.
   138 in the baseline. **Open item:** the source also carries `SimTrees` (276 meshes) and
   `Sim2Trees` (185 meshes); both were skipped to avoid duplicating the canopy, and the team
   still needs to confirm which set actually fed the Radiance runs.
6. **Albedo** per material is written to `meta.albedo` (see below).
7. `meta.site_extent_m` = the bounding extent, `[215, 130]` m.

### Route B — Lee Square: via the Radiance envelope Rhino/GH already exported

Source: `Lee Square Site Model 20260610.3dm` / `Lee Square.gh` → the treeheat project's
`inputs/radiance/<project>/model/scene/envelope.rad`. Using the `.rad` rather than the `.3dm`
guarantees the geometry is *the geometry that was simulated*.

1. **Tokenise `envelope.rad`.** Every `void <type> <mat> … polygon <id> … N x y z x y z …`
   block yields `(material, surface_id, points)`.
2. **Split ground from facade by face normal.** `|nz| > 0.5` → ground/roof surface, keyed by
   material name; otherwise → a facade, grouped by the `facade_(\d+)` id into one building
   mesh each (22 buildings). Building `height` = zmax − zmin of its faces.
3. **Trees from the CSV, canopies synthesised.** `inputs/grid_records/baseline_trees.csv`
   gives position + species (173 trees); the `.rad` has no usable canopy volume, so
   `unit_canopy()` builds a 4-ring, 8-segment low-poly hull (h 7.5–8.5 m by species,
   r 3.2 m) so the viewer has something to shade with. **These hulls are representational,
   not surveyed.**
4. **Align to the sensor frame.** `shift(−5, −5)`, then a hard clip to the sensor grid so no
   surface extends past measured ground. Extent `[378.9, 394.0]` m.
5. `scenario_01` is currently a **placeholder — an identical copy of baseline** until the real
   scenario extract lands. It is flagged in `meta.notes` and in the sensor file's
   `placeholder_note`; don't read it as a design proposal.

### Albedo, both routes

Parsed out of the Radiance material library — for each `void plastic <name> / 0 / 0 / 5 R G B spec rough`
block, luminous reflectance:

```
albedo = 0.2126·R + 0.7152·G + 0.0722·B
```

written to `meta.albedo[material]`. The manifest's `categories.<key>.albedo` mirrors these
values; the geometry file is the provenance, the manifest is what the engine reads.

### Output shape

```jsonc
{ "meta": { "units": "meters", "coordinate_note": "…exact transform…",
            "site_extent_m": [w,h], "sources": { "<state>": "<source file>" },
            "albedo": { … }, "notes": [ "…every judgement call…" ] },
  "<state>": { "surfaces": { "<material>": [ { "outer": [[x,y]…], "holes": [] } ] },
               "buildings": [ { "name", "height", "mesh": { "v", "f" } } ],
               "trees":     [ { "species", "pos", "height", "radius", "hull" } ] } }
```

Minified. 2.2–2.9 MB per site.

---

## Checks before a drop goes live

1. **Material keys match.** Every key in `geometry.<state>.surfaces` has a counterpart in
   `sensors.data.<state>` and in `manifest.categories`. A mismatch renders grey, silently.
2. **Frames match.** Overlay sensor points on the surfaces; they must sit inside their own
   material's polygons. Any global offset means step 2 of the geometry route was wrong.
3. **`node preflight.mjs <site>_manifest.json`.** Checks state keys against both data files,
   metric domains against the p2–p98 spread, routes inside the geometry extent, and blocks a
   third live state (the crossfade is two-deep).
   *Lee Square: 0 errors. King's Road flags "max load 1426.7 > open_sky 1323.4" and a low-tail
   clip — pre-existing characteristics of the shipping reference data (sloped/reflective points
   above the horizontal basis, deliberate display domain). KR is grandfathered.*
4. **Sanity-check the physics.** Brightest open ground should land near the site's open-sky
   GHI; deep-shade sensors well under it. A brightest-sensor value far above GHI means an
   uncalibrated or unprojected direct component.

## The round trip back to Rhino

`engine/export-design.js` writes the sandbox's edited state back out in two coordinate modes:
`site-local` (metres, origin at the site bounds corner) and `rhino-model` (**centimetres in
the source model's own coordinates** — drops straight into the team's `.3dm`). Trees export
onto per-species layers `TREES_<SPECIES>`. Those are the inverse of the Part 2 transform;
if the ingest transform changes, this changes with it.

## Adding a site

1. Run the converter over the drop → the two JSONs.
2. Write `<site>_manifest.json` (materials, metrics, states, `frame`, `space.bounds`, `lanes`, `props`).
3. `node preflight.mjs <site>_manifest.json`, fix what it names.
4. Add the row to `sites.json`, set `status: "live"`.

No engine edit. See `MIGRATION.md` for the manifest contract and `SYNC-OUT.md` for the
verification harnesses.
