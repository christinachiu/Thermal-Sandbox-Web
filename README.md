# Digital Thermal Sandbox — Data

Two JSON files drive the entire Digital Thermal Sandbox interface. Everything you see —
the ground, buildings, trees, and the colored "heat" field — is read from these two files
at load time. Nothing is hard-coded in the app.

Site: **King's Road, University of Manitoba, Winnipeg.** Site extent ≈ **215 m × 130 m**.
All coordinates are in **meters**, in a shared "sensor space" (both files line up 1:1).

Two design states are stored side by side and can be compared in the app:
- **`baseline`** — the site as it exists today.
- **`scenario_01`** — a proposed intervention (more trees, revised ground/buildings).

---

## 1. `kingsroad_web_geometry.json` — what the place *is*

The physical model: ground surfaces, buildings, and trees.

```
{
  "meta": {
    "units": "meters",
    "site_extent_m": [215, 130],
    "albedo": { "asphalt_path": 0.084, "grass": 0.175, ... },   // solar reflectance per material
    "sources": { "baseline": "...3dm", "scenario_01": "...3dm" },
    "notes": [ ... ]
  },
  "baseline":    { "surfaces": {...}, "buildings": [...], "trees": [...] },
  "scenario_01": { "surfaces": {...}, "buildings": [...], "trees": [...] }
}
```

**`surfaces`** — the ground, grouped into 7 material types:
`asphalt_road`, `asphalt_path`, `asphalt_parking`, `concrete_path`, `unit_pavers`,
`grass`, `stone_landscaping`. Each is a list of polygons:
```
{ "outer": [[x, y], [x, y], ...],   // boundary loop, meters
  "holes": [ [[x,y],...], ... ] }   // optional cut-outs
```
Each material has an **albedo** (0–1) in `meta.albedo` — how much sunlight it reflects
(dark asphalt ≈ 0.08, pale pavers ≈ 0.27, stone ≈ 0.45). This is the physical basis for
why dark ground gets hotter.

**`buildings`** — a list of masses:
```
{ "name": "Stores Building", "height": 2.8, "mesh": { "v": [[x,y,z], ...], ... } }
```
`height` in meters; `mesh.v` are footprint/volume vertices.

**`trees`** — the canopy (baseline = 138 trees, scenario_01 = 390):
```
{ "species": "Linden", "pos": [x, y], "height": 6.13, "radius": 1.08,
  "hull": { "v": [[x,y,z], ...] } }   // canopy shape
```
`radius` = canopy radius (m); `hull` = the 3-D canopy the app sculpts into cut-paper facets.

---

## 2. `kingsroad_sensor_data.json` — how much *sun* lands on it

One year of simulated sunlight, measured at **20,093 points** across the ground
(9,924 in baseline, 10,169 in scenario_01).

```
{
  "meta": {
    "units": { "load": "kWh/m2 per year", "peak": "W/m2" },
    "point_format": ["x", "y", "load", "peak"],
    "derived": "average irradiance (W/m2) = load * 1000 / 8760",
    "source": "Ladybug/Radiance annual irradiance, Winnipeg-Richardson EPW",
    "open_sky": {
      "ghi_kwh_m2_yr": 1323.4,                        // full open-sky sun for one year here
      "usage": "solar_reduction = clamp(1 - load / ghi_kwh_m2_yr, 0, 1)"
    }
  },
  "data": { "baseline": {...}, "scenario_01": {...} }
}
```

Inside each state, points are grouped by material, then by **grid** — one grid per surface
polygon in the geometry file:
```
"asphalt_parking": {
  "grids": [
    { "id": "149f5c69",
      "points": [ [x, y, load, peak], ... ] }   // one row per measured point
  ]
}
```

Each point row is **`[x, y, load, peak]`**:
- **`x`, `y`** — location in meters (same space as the geometry).
- **`load`** — cumulative solar radiation over one year, **kWh/m² per year**. This is the
  primary "how much sun hit this spot" number the app color-maps.
- **`peak`** — peak instantaneous irradiance, **W/m²** (the worst-case moment).

Two handy conversions (from `meta`):
- Average irradiance (W/m²) = `load × 1000 / 8760`.
- **Solar reduction** (0 = full sun, 1 = fully shaded) = `1 − load / 1323.4`. This is how
  much the shade/canopy cuts the open-sky sun (1323.4 kWh/m²/yr is the full open-sky total
  for Winnipeg).

---

## How the two files relate

`geometry.grids` ↔ `sensor.grids`: each sensor grid `id` corresponds to one surface polygon
in the geometry, in the same material group and the same coordinate space. So you can lay
the measured sun values directly onto the ground shapes, and compare **baseline vs.
scenario_01** point-for-point.

**Provenance:** geometry from Rhino models (`FES_DTS_Kings Road_*.3dm`); sun values from
Ladybug/Radiance annual irradiance runs on the Winnipeg-Richardson EPW weather file.
See `meta.notes` in the geometry file for modeling caveats (e.g. which tree layer fed the
simulation).
