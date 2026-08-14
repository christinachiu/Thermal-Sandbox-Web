// ============================================================================
// DIGITAL THERMAL SANDBOX — stage engine (iteration two, "dreamscape not diorama")
// Every rendered value traces to kingsroad_sensor_data.json or one division
// by meta.open_sky.ghi_kwh_m2_yr. No temperature, no absorbed heat, no fakes.
// ============================================================================

let THREE = null;
try { window.__engineBuildTag = 'PATCH_m525_boldpatterns'; } catch (e) {}

// Site-specific constants (CATS, CAT_LABEL, CAT_GROUND, CAT_TINT, CAT_TESS,
// CAT_PROPOSALS, CAT_ALBEDO) are now built inside createEngine from opts.site.

function hex2rgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
function makeRamp(stops) {
  const rgb = stops.map(hex2rgb);
  return (t) => {
    t = Math.max(0, Math.min(1, t));
    const f = t * (rgb.length - 1), i = Math.min(rgb.length - 2, Math.floor(f)), u = f - i;
    return [rgb[i][0] + (rgb[i + 1][0] - rgb[i][0]) * u, rgb[i][1] + (rgb[i + 1][1] - rgb[i][1]) * u, rgb[i][2] + (rgb[i + 1][2] - rgb[i][2]) * u];
  };
}
const easeIO = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const easeOut = t => 1 - Math.pow(1 - t, 3);
const clamp01 = v => Math.max(0, Math.min(1, v));
const smooth = t => { t = clamp01(t); return t * t * (3 - 2 * t); };

export async function createEngine(opts) {
  const cb = opts.callbacks || {};
  const RM = !!opts.reducedMotion;
  const canvas = opts.canvas;
  const site = opts.site;
  const siteFrame = (site && site.frame) || {}; // per-site camera framing (center/zoom/azimuth); King's Road omits it -> hardcoded defaults below
  const siteSpace = (site && site.space) || {}; // per-site spatial extent [x0,y0,x1,y1] in sensor space; King's Road omits it -> hardcoded default below
  const SITE_B = siteSpace.bounds || [0, -130, 215, 0];
  const hexNum = s => typeof s === 'string' ? parseInt(s.replace(/^#|^0x/, ''), 16) : s;

  // ---- three.js -----------------------------------------------------------
  try {
    THREE = await import('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js');
  } catch (e) {
    THREE = await import('https://unpkg.com/three@0.160.0/build/three.module.js');
  }
  // ---- fat lines (real lineweight hierarchy; WebGL ignores LineBasicMaterial.linewidth) ----
  let LSG = null, LM = null, LS2 = null;
  try {
    const T_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
    const LBASE = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/lines/';
    const toBlob = async (file, deps) => {
      let s = await fetch(LBASE + file).then(r => r.text());
      s = s.replace(/from\s+['"]three['"]/g, "from '" + T_URL + "'");
      for (const [re, url] of (deps || [])) s = s.replace(re, "from '" + url + "'");
      return URL.createObjectURL(new Blob([s], { type: 'text/javascript' }));
    };
    const uSG = await toBlob('LineSegmentsGeometry.js');
    const uLM = await toBlob('LineMaterial.js');
    const uLS2 = await toBlob('LineSegments2.js', [
      [/from\s+['"][^'"]*LineSegmentsGeometry\.js['"]/g, uSG],
      [/from\s+['"][^'"]*LineMaterial\.js['"]/g, uLM]
    ]);
    LSG = (await import(uSG)).LineSegmentsGeometry;
    LM = (await import(uLM)).LineMaterial;
    LS2 = (await import(uLS2)).LineSegments2;
  } catch (e) { console.warn('[engine] fat lines unavailable \u2014 falling back to 1px', e); }
  try { window.__dtsFatLines = !!LS2; } catch (e) {}

  // ---- data ---------------------------------------------------------------
  const [geo, sen] = await Promise.all([
    fetch(site.data.geometryUrl).then(r => r.json()),
    fetch(site.data.sensorUrl).then(r => r.json())
  ]);
  const _os = sen.meta.open_sky;
  const GHI = _os[site.openSkyKey] ?? _os.ghi_kwh_m2_yr ?? _os.kwh_m2_yr; // defensive: both schemas load
  const STATES = site.states.filter(s => s.status === 'live').map(s => s.key);
  const REF = site.referenceState;

  // ---- category system: built from the manifest (replaces the old module constants) ----
  const CATS = Object.keys(site.categories); // key order preserved -> cat[i] index stays stable
  const CAT_LABEL = {}, CAT_GROUND = {}, CAT_TINT = {}, CAT_TESS = {}, CAT_ALBEDO = {};
  for (const k of CATS) {
    const c = site.categories[k];
    CAT_LABEL[k] = c.label;
    CAT_GROUND[k] = hexNum(c.ground);
    CAT_TINT[k] = hexNum(c.tint);
    CAT_TESS[k] = c.tess;
    CAT_ALBEDO[k] = c.albedo;
  }
  const CAT_PROPOSALS = site.proposals;
  // Category FAMILY tests. The walk/rendered systems must not hardcode King's Road's
  // literal category names — Lee calls the same materials short_grass /
  // asphalt_roadways / unit_paver_pathways, and a name-equality check silently skipped
  // its curbs, turf tufts and road-seam suppression. King's Road's names satisfy these
  // predicates unchanged.
  const isGrassCat = (c) => c.indexOf('grass') >= 0;
  const isRoadCat = (c) => c.indexOf('road') >= 0; // asphalt_road, asphalt_roadways (never *_path*)
  const surfacesWhere = (stGeo, pred) => {
    const out = [];
    for (const k of CATS) if (pred(k)) for (const s of (((stGeo && stGeo.surfaces) || {})[k] || [])) out.push(s);
    return out;
  };

  // working ramp candidates (§5 — final temperatures pending GenEnv verdict)
  const METRICS = {
    load: {
      key: 'load', chip: 'LOAD', title: 'SOLAR LOAD \u00b7 INCIDENT, ANNUAL',
      units: 'kWh/m\u00b2\u00b7yr', domain: [400, 1300], endLo: '\u2264400', endHi: '\u22651300',
      stops: ['#ffab84', '#f06a43', '#c22e47', '#571437'],
      fmt: v => Math.round(v).toLocaleString('en-US'),
      burden: t => t // height = sun burden: high load = high
    },
    reduction: {
      key: 'reduction', chip: 'REDUCTION', title: 'SOLAR REDUCTION VS OPEN SKY \u00b7 ANNUAL',
      units: '%', domain: [0, 0.75], endLo: '0%', endHi: '\u226575%',
      stops: ['#e3f2df', '#7cc7a6', '#1f8a8c', '#0b3f4a'],
      fmt: v => Math.round(v * 100) + '%',
      burden: t => 1 - t // protected ground rests
    },
    groundtemp: { // real PENDING tab — §3: DELTA-NATIVE. Change vs the clean baseline,
      // not absolute degrees: subtracting two modelled runs cancels part of the model's
      // systematic error, so a delta is more defensible than an absolute — and the eye
      // reads change against a fixed reference. Diverging ramp, paper at zero.
      key: 'groundtemp', chip: 'GROUND TEMP', title: 'GROUND TEMPERATURE \u00b7 CHANGE VS TODAY \u00b7 MODELLED',
      units: '\u0394\u00b0C vs today', domain: [-8, 8], endLo: '\u22128\u00b0 cooler', endHi: '+8\u00b0 warmer',
      stops: ['#0b3f4a', '#1f8a8c', '#8fccb2', '#f2ede0', '#e8a25a', '#c3462a', '#611420'],
      fmt: v => (v > 0.05 ? '+' : v < -0.05 ? '\u2212' : '') + Math.abs(v).toFixed(1) + '\u00b0C',
      burden: t => t, status: 'pending', kind: 'ground'
    },
    sunhours: { // derivable from the .ill time series; placeholder until the hour-count step
      key: 'sunhours', chip: 'SUN HOURS', title: 'HARSH SUN HOURS \u00b7 >800 W/m\u00b2, ANNUAL',
      units: 'hrs', domain: [300, 1400], endLo: '\u2264300', endHi: '\u22651400',
      stops: ['#dbe9f2', '#7fb0c4', '#e8c65a', '#d9552b'],
      fmt: v => Math.round(v).toLocaleString('en-US'),
      burden: t => t, status: 'derivable', kind: 'ground'
    },
    treehealth: { // per-tree; PENDING — leaf degree-hours from the thermal run
      key: 'treehealth', chip: 'LEAF TEMPERATURE', title: 'TREE HEAT STRESS \u00b7 LEAF DEGREE-HOURS, MODELLED',
      units: '\u00b0C\u00b7hr > 42\u00b0', domain: [0, 400], endLo: '0', endHi: '\u2265400',
      stops: ['#2f6b3f', '#8fbf4e', '#e8c65a', '#d9552b', '#8a1f2c'],
      fmt: v => Math.round(v).toLocaleString('en-US'),
      burden: t => t, status: 'pending', kind: 'tree'
    }
  };
  METRICS.load.status = 'live'; METRICS.load.kind = 'ground';
  METRICS.reduction.status = 'live'; METRICS.reduction.kind = 'ground';
  // absolute-temperature twin of the delta tab — never a tab itself; shown only while
  // the peek-at-baseline hold is down (§3×§2: baseline-vs-itself is all-zero, so the
  // reference reads as ABSOLUTE baseline temp on a sequential ramp during the hold)
  METRICS._tempabs = {
    key: '_tempabs', chip: 'GROUND TEMP', title: 'GROUND SURFACE TEMPERATURE \u00b7 TODAY \u00b7 MODELLED',
    units: '\u00b0C absolute', domain: [18, 52], endLo: '\u226418\u00b0', endHi: '\u226552\u00b0',
    stops: ['#f4e5c3', '#e59a4b', '#c3462a', '#611420'],
    fmt: v => Math.round(v) + '\u00b0C',
    burden: t => t, status: 'pending', kind: 'ground'
  };
  // manifest metric-domain overrides (site.metrics.<key>.domain wins over the literals above).
  // When the manifest changes a domain, the legend endpoint strings are re-derived from it
  // (or taken verbatim from manifest endLo/endHi) so the legend always states the site's own scale.
  for (const k in (site.metrics || {})) {
    const ov = site.metrics[k], MM = METRICS[k];
    if (!MM || !ov) continue;
    if (ov.domain && (ov.domain[0] !== MM.domain[0] || ov.domain[1] !== MM.domain[1])) {
      MM.domain = ov.domain;
      MM.endLo = ov.endLo || (ov.domain[0] === 0 ? MM.fmt(0) : '\u2264' + MM.fmt(ov.domain[0]));
      MM.endHi = ov.endHi || '\u2265' + MM.fmt(ov.domain[1]);
    } else if (ov.domain) { MM.domain = ov.domain; }
    if (ov.endLo) MM.endLo = ov.endLo;
    if (ov.endHi) MM.endHi = ov.endHi;
  }
  METRICS._tempabs.ramp = makeRamp(METRICS._tempabs.stops);
  METRICS.load.ramp = makeRamp(METRICS.load.stops);
  METRICS.reduction.ramp = makeRamp(METRICS.reduction.stops);
  METRICS.groundtemp.ramp = makeRamp(METRICS.groundtemp.stops);
  METRICS.sunhours.ramp = makeRamp(METRICS.sunhours.stops);
  METRICS.treehealth.ramp = makeRamp(METRICS.treehealth.stops);

  const HASH_CELL = 2.5;
  const D = {}; // per-state processed data
  for (const st of STATES) {
    const cats = sen.data[st];
    let n = 0;
    for (const c of CATS) for (const g of (cats[c] ? cats[c].grids : [])) n += g.points.length;
    const x = new Float32Array(n), y = new Float32Array(n), load = new Float32Array(n),
      red = new Float32Array(n), cat = new Uint8Array(n), gridOf = new Uint16Array(n);
    const grids = []; const hash = new Map();
    let i = 0, sumL = 0, sumR = 0;
    const catStats = {};
    for (let ci = 0; ci < CATS.length; ci++) {
      const c = CATS[ci]; if (!cats[c]) continue;
      catStats[c] = { n: 0, sumL: 0, sumR: 0 };
      cats[c].grids.forEach((g, gi) => {
        const gIdx = grids.length;
        let gsL = 0, gsR = 0, cx = 0, cy = 0;
        // cell size: median NN distance over a sample
        const pts = g.points, sampleN = Math.min(pts.length, 120), dists = [];
        for (let s = 0; s < sampleN; s++) {
          const p = pts[Math.floor(s * pts.length / sampleN)];
          let best = 1e9;
          for (let q = 0; q < pts.length; q += Math.max(1, Math.floor(pts.length / 400))) {
            const dx = pts[q][0] - p[0], dy = pts[q][1] - p[1], d = dx * dx + dy * dy;
            if (d > 1e-4 && d < best) best = d;
          }
          if (best < 1e8) dists.push(Math.sqrt(best));
        }
        dists.sort((a, b) => a - b);
        const cell = dists.length ? Math.max(0.35, Math.min(3, dists[Math.floor(dists.length / 2)])) : 1;
        for (const p of pts) {
          x[i] = p[0]; y[i] = p[1]; load[i] = p[2];
          red[i] = clamp01(1 - p[2] / GHI);
          cat[i] = ci; gridOf[i] = gIdx;
          sumL += p[2]; sumR += red[i]; gsL += p[2]; gsR += red[i]; cx += p[0]; cy += p[1];
          catStats[c].n++; catStats[c].sumL += p[2]; catStats[c].sumR += red[i];
          const k = Math.floor(p[0] / HASH_CELL) * 4096 + Math.floor(-p[1] / HASH_CELL);
          if (!hash.has(k)) hash.set(k, []);
          hash.get(k).push(i);
          i++;
        }
        grids.push({ id: g.id, cat: c, catIdx: gi, n: pts.length, meanLoad: gsL / pts.length, meanRed: gsR / pts.length, cell, cx: cx / pts.length, cy: cy / pts.length });
      });
    }
    const cs = {};
    for (const c in catStats) cs[c] = { n: catStats[c].n, meanLoad: catStats[c].sumL / catStats[c].n, meanRed: catStats[c].sumR / catStats[c].n };
    D[st] = { n, x, y, load, red, cat, gridOf, grids, hash, agg: { n, meanLoad: sumL / n, meanRed: sumR / n, catStats: cs } };
  }
  // dev synthetic temperature (§8): plausible spatial structure, watermarked, never public
  // ground surface temperature (placeholder physics until the real thermal run lands).
  // matSwap-aware: when a material override is active, every ground cell behaves like
  // the chosen material — honest, because absorbed heat depends on albedo.
  // >> when Justin's engine lands, replace the body with a lookup into handed-off
  //    values keyed by (state, material, sensor); the signature stays identical.
  function groundTemp(st) {
    const d = D[st];
    const key = 'temp|' + (S.matSwap || 'as');
    if (d.tempKey === key) return d.temp;
    const t = new Float32Array(d.n);
    for (let i = 0; i < d.n; i++) t[i] = tempModel(d, i, S.matSwap || CATS[d.cat[i]]);
    d.temp = t; d.tempKey = key; return t;
  }
  const TEMP_OFF = site.tempOffsets;
  function tempModel(d, i, cat) {
    return 23.5 + (d.load[i] / 1420) * 17 + (TEMP_OFF[cat] ?? 0) +
      Math.sin(d.x[i] * 0.11) * 0.8 + Math.cos(d.y[i] * 0.14) * 0.7;
  }
  // §3 delta plumbing — display-side prep so the temp tab is delta-native from day one.
  // delta(sensor) = temp_current(sensor) − temp_baseline(reference at the same spot).
  // The two states' sensor sets are never point-matched, so the scenario resamples the
  // CLEAN baseline at the nearest baseline sensor (one-time spatial lookup, cached).
  // When Justin's engine lands, cur/ref become lookups into handed-off values — the
  // subtraction and everything downstream stays identical.
  function cleanBaseTemp() {
    const d = D[REF];
    if (d.cbTemp) return d.cbTemp;
    const t = new Float32Array(d.n);
    for (let i = 0; i < d.n; i++) t[i] = tempModel(d, i, CATS[d.cat[i]]);
    d.cbTemp = t; return t;
  }
  function baseRefTemp(st) {
    if (st === REF) return cleanBaseTemp();
    const d = D[st];
    if (d.refTemp) return d.refTemp;
    const cb = cleanBaseTemp();
    const t = new Float32Array(d.n);
    for (let i = 0; i < d.n; i++) {
      let j = nearestSensor(REF, d.x[i], d.y[i], 6);
      if (j < 0) j = nearestSensor(REF, d.x[i], d.y[i], 26); // new ground where a building stood
      // no reference at all (never expected): treat today as same exposure → reads as no change
      t[i] = j >= 0 ? cb[j] : tempModel(d, i, CATS[d.cat[i]]);
    }
    d.refTemp = t; return t;
  }
  function tempDelta(st) {
    const d = D[st];
    const key = 'tdelta|' + (S.matSwap || 'as');
    if (d.tdKey === key) return d.td;
    const cur = groundTemp(st), ref = baseRefTemp(st);
    const t = new Float32Array(d.n);
    for (let i = 0; i < d.n; i++) t[i] = cur[i] - ref[i];
    d.td = t; d.tdKey = key; return t;
  }
  // derivable placeholder from load (real version reads the .ill hourly series)
  function sunHours(st) {
    const d = D[st]; if (d.sun) return d.sun;
    const t = new Float32Array(d.n);
    for (let i = 0; i < d.n; i++) t[i] = 300 + (d.load[i] / 1300) * 1100;
    d.sun = t; return t;
  }
  function metricValue(st, m, i) {
    if (m === 'load') return (S.preview && D[st].pLoad) ? D[st].pLoad[i] : D[st].load[i];
    if (m === 'reduction') return (S.preview && D[st].pRed) ? D[st].pRed[i] : D[st].red[i];
    if (m === 'sunhours') return (S.preview && D[st].pLoad) ? (300 + D[st].pLoad[i] / 1300 * 1100) : sunHours(st)[i];
    // §3: the temp tab is a DELTA vs today — except while the peek-at-baseline hold is
    // down, when the reference itself shows as ABSOLUTE baseline temperature (its own
    // delta would be all-zero by definition)
    if (m === 'groundtemp') return peeking ? (st === 'baseline' ? cleanBaseTemp()[i] : groundTemp(st)[i]) : tempDelta(st)[i];
    return groundTemp(st)[i]; // treehealth is per-tree (see recolorTrees)
  }
  // while peeking, groundtemp swaps to its absolute twin for domain + ramp
  function effMetricKey(m) { return (m === 'groundtemp' && peeking) ? '_tempabs' : m; }
  function metricT(m, v) { const [a, b] = METRICS[effMetricKey(m)].domain; return clamp01((v - a) / (b - a)); }

  function nearestSensor(st, px, py, maxD, catIdx) {
    const d = D[st]; let best = -1, bd = (maxD || 2.2) * (maxD || 2.2);
    const kx = Math.floor(px / HASH_CELL), ky = Math.floor(-py / HASH_CELL);
    const reach = Math.max(1, Math.ceil((maxD || 2.2) / HASH_CELL));
    for (let ax = -reach; ax <= reach; ax++) for (let ay = -reach; ay <= reach; ay++) {
      const arr = d.hash.get((kx + ax) * 4096 + (ky + ay));
      if (!arr) continue;
      for (const i of arr) {
        if (catIdx != null && d.cat[i] !== catIdx) continue;
        const dx = d.x[i] - px, dy = d.y[i] - py, dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; best = i; }
      }
    }
    return best;
  }

  // Material UNDERFOOT: point-in-polygon against the real surface polygons. The walk
  // readout used to name the material of the nearest sensor sample, but the sensor grid
  // is coarser than the paths on some sites — standing on a 2 m paver walk, the closest
  // sample often belongs to the grass or road beside it, so the name disagreed with the
  // ground and flipped on every small step. Lazily indexed per state; surfaces are static.
  const _catIndex = {};
  function catAtPoint(st, x, y) {
    let list = _catIndex[st];
    if (!list) {
      list = [];
      const surfs = (geo[st] && geo[st].surfaces) || {};
      for (const c of CATS) {
        for (const s of (surfs[c] || [])) {
          if (!s.outer || s.outer.length < 3) continue;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const p of s.outer) {
            if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
            if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
          }
          list.push({ cat: c, s: s, bb: [x0, y0, x1, y1] });
        }
      }
      _catIndex[st] = list;
    }
    const inLoop = (loop) => {
      let inside = false;
      for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const xi = loop[i][0], yi = loop[i][1], xj = loop[j][0], yj = loop[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    };
    for (const e of list) {
      const bb = e.bb;
      if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
      if (!inLoop(e.s.outer)) continue;
      let hole = false;
      for (const h of (e.s.holes || [])) if (inLoop(h)) { hole = true; break; }
      if (!hole) return e.cat;
    }
    return null;
  }

  // Walk-mode seam grooves mark a CHANGE OF MATERIAL. An edge with the same material on
  // both sides (unit-paver panel joints, a lawn split into two polygons by the survey) is
  // a modelling artefact, not a material boundary, so it gets no groove. Cached per state;
  // surfaces are static.
  const _seamSegs = {};
  function seamSegs(st) {
    if (_seamSegs[st]) return _seamSegs[st];
    const segs = [], EPS = 0.25;
    for (const cat of CATS) {
      if (isRoadCat(cat)) continue; // road joints never carry a groove
      for (const surf of ((((geo[st] || {}).surfaces) || {})[cat] || [])) {
        for (const loop of [surf.outer].concat(surf.holes || [])) {
          if (!loop || loop.length < 2) continue;
          for (let i = 0; i < loop.length; i++) {
            const a = loop[i], b = loop[(i + 1) % loop.length];
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const L = Math.hypot(dx, dy);
            if (L < 1e-4) continue;
            const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
            const nx = -dy / L * EPS, ny = dx / L * EPS;
            if (catAtPoint(st, mx + nx, my + ny) === catAtPoint(st, mx - nx, my - ny)) continue;
            segs.push([a[0], a[1], b[0], b[1]]);
          }
        }
      }
    }
    _seamSegs[st] = segs;
    return segs;
  }

  // ---- scene / renderer ---------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff); // white paper void

  const CTR = new THREE.Vector3(siteFrame.center ? siteFrame.center[0] : 107.5, siteFrame.center ? siteFrame.center[1] : 0, siteFrame.center ? siteFrame.center[2] : 65);
  let life = null; // liveliness system, assigned late (init order: stateMix may run first)
  const ISO_EL = Math.atan(1 / Math.SQRT2), ISO_AZ = Math.PI * 0.32;
  const cam = { el: siteFrame.el != null ? siteFrame.el : ISO_EL, az: siteFrame.az != null ? siteFrame.az : ISO_AZ, dist: siteFrame.dist != null ? siteFrame.dist : 420, fit: 1 };
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1200);
  const persp = new THREE.PerspectiveCamera(58, 1, 0.1, 800);
  let activeCam = ortho;
  let W = 2, H = 2;
  const fatMats = []; // LineMaterials needing resolution updates on resize
  // weighted linework: trees read heaviest, then buildings; ground seams stay hairline
  function fatMat(colorHex, weightPx, opacity) {
    if (!LS2) return new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity });
    const m = new LM({ color: colorHex, linewidth: weightPx, transparent: true, opacity, worldUnits: false });
    m.resolution.set(W, H); fatMats.push(m);
    return m;
  }
  function fatSeg(srcGeo, material) {
    if (!LS2) return new THREE.LineSegments(srcGeo, material);
    const g = new LSG(); g.setPositions(srcGeo.attributes.position.array);
    return new LS2(g, material);
  }

  // §V free look: user orbit offsets layered ON TOP of the scroll-driven tilt, so the
  // narrative still owns plan<->iso while the user owns azimuth/elevation/zoom.
  const orb = { az: 0, el: 0, armed: false };
  const ORB_LIM = { el: [-0.55, 0.5], fit: [0.7, 4.2] };

  let viewPanX = 0; // px to slide the framed model right, clearing the left control rail
  function applyOrtho() {
    const aspect = W / H;
    let halfH = Math.max(siteFrame.camMin != null ? siteFrame.camMin : 102, (siteFrame.camHalf != null ? siteFrame.camHalf : 138) / aspect);
    halfH /= cam.fit;
    ortho.left = -halfH * aspect; ortho.right = halfH * aspect;
    ortho.top = halfH; ortho.bottom = -halfH;
    if (viewPanX) { const off = -viewPanX * (halfH * aspect * 2) / W; ortho.left += off; ortho.right += off; }
    const p = new THREE.Vector3(
      Math.sin(cam.az) * Math.cos(cam.el), Math.sin(cam.el), Math.cos(cam.az) * Math.cos(cam.el)
    ).multiplyScalar(cam.dist).add(CTR);
    ortho.position.copy(p); ortho.up.set(0, 1, 0); ortho.lookAt(CTR);
    ortho.updateProjectionMatrix();
  }
  function resize() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(2, r.width); H = Math.max(2, r.height);
    renderer.setSize(W, H, false);
    for (const m of fatMats) m.resolution.set(W, H);
    persp.aspect = W / H; persp.updateProjectionMatrix();
    applyOrtho();
  }
  resize();
  window.addEventListener('resize', resize);

  const toWorld = (px, py) => new THREE.Vector3(px, 0, -py);

  // AO pool — the island floats, no board edge
  {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    const rg = g.createRadialGradient(128, 128, 10, 128, 128, 126);
    rg.addColorStop(0, 'rgba(128,122,108,0.34)'); rg.addColorStop(0.7, 'rgba(128,122,108,0.12)'); rg.addColorStop(1, 'rgba(128,122,108,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(330, 235), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    pool.rotation.x = -Math.PI / 2; pool.position.set(107.5, -9, 65);
    pool.name = 'aoPool';
    scene.add(pool);
    var aoPool = pool;
  }

  // ---- ground surfaces ----------------------------------------------------
  function polyShape(surf) {
    const sh = new THREE.Shape(surf.outer.map(p => new THREE.Vector2(p[0], p[1])));
    for (const h of (surf.holes || [])) sh.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p[0], p[1]))));
    return sh;
  }
  function stippleTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 128);
    g.fillStyle = 'rgba(23,21,15,0.45)';
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let y = 4; y < 128; y += 9) for (let x = 4; x < 128; x += 9) {
      const jx = (rnd() - 0.5) * 5, jy = (rnd() - 0.5) * 5;
      g.beginPath(); g.arc(x + jx, y + jy, 1.15, 0, 6.283); g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / 10, 1 / 10);
    t.anisotropy = 4;
    return t;
  }
  const STIPPLE = stippleTexture();
  function buildGround(stGeo, yOff) {
    const grp = new THREE.Group();
    const seamPts = [];
    const surfMeshes = {}; // cat -> [mesh per polygon]
    for (const c of CATS) {
      surfMeshes[c] = [];
      for (const surf of (stGeo.surfaces[c] || [])) {
        const geoS = new THREE.ShapeGeometry(polyShape(surf));
        geoS.rotateX(-Math.PI / 2); // (x,y,0) -> (x,0,-y): shape y (negative) -> -y (positive z)... 
        const isAsphalt = c.indexOf('asphalt') === 0;
        const m = new THREE.Mesh(geoS, isAsphalt
          ? new THREE.MeshBasicMaterial({ color: 0xffffff, map: STIPPLE, side: THREE.DoubleSide })
          : new THREE.MeshBasicMaterial({ color: CAT_GROUND[c], side: THREE.DoubleSide }));
        m.position.y = yOff;
        m.userData = { cat: c, idx: surfMeshes[c].length };
        grp.add(m); surfMeshes[c].push(m);
        const loops = [surf.outer].concat(surf.holes || []);
        for (const loop of loops) for (let i = 0; i < loop.length; i++) {
          const a = loop[i], b = loop[(i + 1) % loop.length];
          seamPts.push(a[0], yOff + 0.12, -a[1], b[0], yOff + 0.12, -b[1]);
        }
      }
    }
    const seamGeo = new THREE.BufferGeometry();
    seamGeo.setAttribute('position', new THREE.Float32BufferAttribute(seamPts, 3));
    const seams = new THREE.LineSegments(seamGeo, new THREE.LineBasicMaterial({ color: 0x17150f, transparent: true, opacity: 0.5 }));
    grp.add(seams);
    return { grp, surfMeshes, seams };
  }
  // rotateX(-PI/2) maps (x, y, 0) -> (x, 0, -y). y_data negative => z = -y in [0,130]... 
  // NOTE: -(-y)= +y? verify: rotation about X by -90deg: (x,y,z)->(x,z,-y)? For z=0: (x,0,-y). y negative -> -y positive. Good.

  const groundA = buildGround(geo.baseline, 0);
  const groundB = buildGround(geo.scenario_01, 0.015);
  scene.add(groundA.grp); scene.add(groundB.grp);

  // ---- base slab: the map lifts off the page onto a cut plinth as it stands up ----
  // walls span y:0 (top, at ground) -> y:-1 (bottom); the group's scale.y sets the
  // real thickness, driven by the tilt in applyTilt so it grows through the scroll.
  const slab = (() => {
    const box = new THREE.Box3().setFromObject(groundA.grp);
    const o = 0.6; // slight outset so the ground edge overhangs and hides the top rim
    const x0 = box.min.x - o, x1 = box.max.x + o, z0 = box.min.z - o, z1 = box.max.z + o;
    const grp = new THREE.Group();
    const HH = 6; // slab.T — final world height the 45° diagonals are tuned to
    // white paper walls occlude cleanly; the cut-edge poche is drawn as real ink
    // linework (constant screen weight, matching the buildings) — not a texture
    const wallPos = [];
    const quad = (ax, az, bx, bz) => {
      wallPos.push(ax, 0, az, bx, 0, bz, bx, -1, bz, ax, 0, az, bx, -1, bz, ax, -1, az);
    };
    quad(x0, z1, x1, z1); quad(x1, z1, x1, z0); quad(x1, z0, x0, z0); quad(x0, z0, x0, z1);
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
    grp.add(new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })));
    const capPos = [x0, -1, z0, x1, -1, z0, x1, -1, z1, x0, -1, z0, x1, -1, z1, x0, -1, z1];
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(capPos, 3));
    grp.add(new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })));
    // 45° diagonal hatch (poche), clipped per wall, in local space so it lands at
    // 45° once the slab is full height; the y-scale shears it only briefly mid-grow
    const GAP = 2.4; // world units between diagonals
    const cx = CTR.x, cz = CTR.z, hatchPos = [];
    const walls = [[x0, z1, x1, z1], [x1, z1, x1, z0], [x1, z0, x0, z0], [x0, z0, x0, z1]];
    for (const wl of walls) {
      const ax = wl[0], az = wl[1], bx = wl[2], bz = wl[3];
      const L = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / L, dz = (bz - az) / L;
      let nx = dz, nz = -dx; // outward normal, flipped to point away from centre
      if (nx * ((ax + bx) / 2 - cx) + nz * ((az + bz) / 2 - cz) < 0) { nx = -nx; nz = -nz; }
      const ox = nx * 0.06, oz = nz * 0.06; // lift off the wall to avoid z-fight
      for (let c = -HH; c <= L; c += GAP) {
        const pts = [];
        let vv = -c;   if (vv >= 0 && vv <= HH) pts.push([0, vv]);
        vv = L - c;    if (vv >= 0 && vv <= HH) pts.push([L, vv]);
        let uu = c;    if (uu >= 0 && uu <= L)  pts.push([uu, 0]);
        uu = c + HH;   if (uu >= 0 && uu <= L)  pts.push([uu, HH]);
        if (pts.length < 2) continue;
        const p0 = pts[0], p1 = pts[pts.length - 1];
        if (Math.abs(p0[0] - p1[0]) + Math.abs(p0[1] - p1[1]) < 0.001) continue;
        hatchPos.push(ax + dx * p0[0] + ox, -(p0[1] / HH), az + dz * p0[0] + oz,
                      ax + dx * p1[0] + ox, -(p1[1] / HH), az + dz * p1[0] + oz);
      }
    }
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.Float32BufferAttribute(hatchPos, 3));
    grp.add(fatSeg(hg, fatMat(0x17150f, 1.5, 0.9)));
    const edgePos = [], cn = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    for (let i = 0; i < 4; i++) {
      const a = cn[i], b = cn[(i + 1) % 4];
      edgePos.push(a[0], -1, a[1], b[0], -1, b[1]); // bottom rim
      edgePos.push(a[0], 0, a[1], a[0], -1, a[1]);   // vertical corner
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
    grp.add(fatSeg(eg, fatMat(0x17150f, 1.5, 0.9)));
    grp.position.y = -0.5; grp.scale.y = 0.0001; grp.visible = false;
    scene.add(grp);
    return { grp, T: 6 };
  })();
  // slab thickness is driven by SCROLL past the final card (not by the tilt): 0 through
  // the whole narrative, growing only as the model hands off into the interactive sandbox.
  function setSlab(t) {
    const k = Math.max(0, Math.min(1, t));
    slab.grp.scale.y = Math.max(0.0001, k * slab.T);
    slab.grp.visible = k > 0.01;
    aoPool.position.y = -0.5 - k * slab.T - 0.8; // contact shadow rides under the slab
  }

  // ---- buildings -----------------------------------------------------------
  const SUN_XY = [0.35, -0.94]; // consistent world-wide
  const B_ROOF = [0.972, 0.968, 0.955], B_SUN = [0.93, 0.925, 0.91], B_SHADE = [0.628, 0.604, 0.554];
  function meshGeom(mesh, colorFn) {
    const pos = [], col = [];
    const v = mesh.v;
    for (const f of mesh.f) {
      const tris = f.length === 3 ? [f] : [[f[0], f[1], f[2]], [f[0], f[2], f[3]]];
      // face normal in original coords (z up)
      const a = v[f[0]], b = v[f[1]], c2 = v[f[2]];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c2[0] - a[0], c2[1] - a[1], c2[2] - a[2]];
      let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const len = Math.hypot(n[0], n[1], n[2]) || 1; n = [n[0] / len, n[1] / len, n[2] / len];
      const cc = colorFn(n);
      for (const t of tris) for (const vi of [t[0], t[2], t[1]]) {
        const p = v[vi];
        pos.push(p[0], p[2], -p[1]);
        col.push(cc[0], cc[1], cc[2]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
  }
  function buildingColor(n) {
    const nz = Math.abs(n[2]);
    if (nz > 0.6) return n[2] > 0 ? B_ROOF : B_SHADE;
    const d = n[0] * SUN_XY[0] + n[1] * SUN_XY[1];
    return d > 0.1 ? B_SUN : B_SHADE;
  }
  function bboxOf(mesh) {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const p of mesh.v) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    return [x0, y0, x1, y1];
  }
  // v2: riso block buildings — grain-baked lit faces, hatched poche shade faces, ink edges
  function grainPatch(size, base, amp) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, size, size);
    const id = g.getImageData(0, 0, size, size), d = id.data;
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() - 0.5) * amp * 255;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    }
    g.putImageData(id, 0, 0);
    return { c, g };
  }
  function tex(c) {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  }
  const HATCH = (() => {
    const { c, g } = grainPatch(64, '#f5f3ee', 0.08);
    g.fillStyle = 'rgba(23,21,15,0.5)';
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let y = 2; y < 64; y += 6) for (let x = 2; x < 64; x += 6) {
      const jx = (rnd() - 0.5) * 3.5, jy = (rnd() - 0.5) * 3.5;
      g.beginPath(); g.arc(x + jx, y + jy, 1.05, 0, 6.283); g.fill();
    }
    return tex(c);
  })();
  const GRAIN = tex(grainPatch(128, '#ffffff', 0.12).c);
  // white buildings, black linework; shade faces keep the grained hatch poche
  const PAL_SLATE = { roof: [1, 1, 1], sun: [1, 1, 1], shade: 0xffffff };
  const PAL_DUSTY = { roof: [1, 1, 1], sun: [1, 1, 1], shade: 0xffffff };
  function buildingGroup(mesh, pal) {
    const posL = [], colL = [], uvL = [], posS = [], uvS = [];
    const v = mesh.v;
    for (const f of mesh.f) {
      const tris = f.length === 3 ? [f] : [[f[0], f[1], f[2]], [f[0], f[2], f[3]]];
      const a = v[f[0]], b2 = v[f[1]], c2 = v[f[2]];
      const u = [b2[0] - a[0], b2[1] - a[1], b2[2] - a[2]], w = [c2[0] - a[0], c2[1] - a[1], c2[2] - a[2]];
      let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const len = Math.hypot(n[0], n[1], n[2]) || 1; n = [n[0] / len, n[1] / len, n[2] / len];
      const nz = Math.abs(n[2]);
      let cc = null, shade = false, flat = false;
      if (nz > 0.6) { if (n[2] > 0) { cc = pal.roof; flat = true; } else shade = true; }
      else { const d = n[0] * SUN_XY[0] + n[1] * SUN_XY[1]; if (d > 0.1) cc = pal.sun; else shade = true; }
      let tx = n[1], ty = -n[0]; const tl = Math.hypot(tx, ty);
      if (tl < 0.001) { tx = 1; ty = 0; } else { tx /= tl; ty /= tl; }
      if (!shade) {
        for (const t of tris) for (const vi of [t[0], t[2], t[1]]) {
          const p = v[vi]; posL.push(p[0], p[2], -p[1]); colL.push(cc[0], cc[1], cc[2]);
          if (flat) uvL.push(p[0] / 4, p[1] / 4); else uvL.push((p[0] * tx + p[1] * ty) / 4, p[2] / 4);
        }
      } else {
        for (const t of tris) for (const vi of [t[0], t[2], t[1]]) {
          const p = v[vi]; posS.push(p[0], p[2], -p[1]); uvS.push((p[0] * tx + p[1] * ty) / 4, p[2] / 4);
        }
      }
    }
    const grp = new THREE.Group();
    const mats = [];
    if (posL.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(posL, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colL, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvL, 2));
      const mt = new THREE.MeshBasicMaterial({ vertexColors: true, map: GRAIN, side: THREE.DoubleSide, transparent: true });
      grp.add(new THREE.Mesh(g, mt)); mats.push(mt);
    }
    if (posS.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(posS, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvS, 2));
      const mt = new THREE.MeshBasicMaterial({ map: HATCH, color: pal.shade, side: THREE.DoubleSide, transparent: true });
      grp.add(new THREE.Mesh(g, mt)); mats.push(mt);
    }
    const full = meshGeom(mesh, () => [1, 1, 1]);
    const elMat = fatMat(0x17150f, 1.5, 0.9);
    const el = fatSeg(new THREE.EdgesGeometry(full, 10), elMat);
    grp.add(el); mats.push(elMat);
    return { grp, mats };
  }
  const buildings = []; // {mesh: group, mats, name, shared, bbox}
  const scBoxes = geo.scenario_01.buildings.map(b => bboxOf(b.mesh));
  for (const b of geo.baseline.buildings) {
    const bb = bboxOf(b.mesh);
    const shared = scBoxes.some(s => Math.abs(s[0] - bb[0]) < 1.5 && Math.abs(s[1] - bb[1]) < 1.5 && Math.abs(s[2] - bb[2]) < 1.5 && Math.abs(s[3] - bb[3]) < 1.5);
    const bg = buildingGroup(b.mesh, shared ? PAL_SLATE : PAL_DUSTY);
    bg.grp.userData = { name: b.name, shared };
    scene.add(bg.grp);
    buildings.push({ mesh: bg.grp, mats: bg.mats, name: b.name, shared, bbox: bb });
  }
  const removedBuildings = buildings.filter(b => !b.shared);
  // intervention centroid (Stores block) — stagger origin
  let IVX = 70, IVY = -60;
  if (removedBuildings.length) {
    let sx = 0, sy = 0;
    for (const b of removedBuildings) { sx += (b.bbox[0] + b.bbox[2]) / 2; sy += (b.bbox[1] + b.bbox[3]) / 2; }
    IVX = sx / removedBuildings.length; IVY = sy / removedBuildings.length;
  }

  // ---- trees (§11: quantized facet shading, real hulls) --------------------
  // Per-species paper-model identity so a grove doesn't read as one white mass.
  // base   — a muted botanical tone (stays on the ink/cream palette, never cartoon green)
  // dens   — canopy density (1 − shade-proxy porosity): denser crowns get deeper internal
  //          facet contrast + a cooler, darker cast; open ornamentals stay pale, warm, airy.
  const SPECIES_TONE_KR = {
    'Conical Evergreens': { base: [0.45, 0.55, 0.50], dens: 0.90 }, // dense columnar spruce — deepest, coolest
    'Silver Maple':       { base: [0.60, 0.67, 0.59], dens: 0.82 },
    'Ash':                { base: [0.67, 0.70, 0.56], dens: 0.80 }, // the workhorse canopy — soft olive-sage
    'Siberian Elm':       { base: [0.63, 0.66, 0.55], dens: 0.76 }, // greyer olive
    'Linden':             { base: [0.72, 0.72, 0.53], dens: 0.78 }, // warmer, more chartreuse
    'Hawthorn':           { base: [0.81, 0.79, 0.62], dens: 0.72 }, // small, open — pale warm sage
    'Amur Maple':         { base: [0.85, 0.76, 0.58], dens: 0.70 }  // small, open — palest, warmest khaki
  };
  // A site may author its own per-species tone (site.species.<name>.tone), so its
  // trees read as their own species rather than borrowing another site's palette.
  // King's Road authors none, so it resolves to the literals above untouched.
  const SPECIES_TONE = (() => {
    const out = {};
    for (const k in SPECIES_TONE_KR) out[k] = SPECIES_TONE_KR[k];
    const sp = (site && site.species) || {};
    for (const k in sp) if (sp[k] && sp[k].tone) out[k] = sp[k].tone;
    return out;
  })();
  const TREE_FALLBACK = { base: [0.70, 0.72, 0.60], dens: 0.78 };
  const TREE_LIGHT = [0.32, -0.5, 0.8];
  // Per-species crown SILHOUETTE. Rather than the generic blob hulls the survey
  // shipped, each tree is grown procedurally to its species habit: a radial profile
  // prof(u) (u: 0 = crown underside → 1 = crown top) revolved into a low-poly, cut-paper
  // faceted mass on a slim bark trunk. Footprint stays keyed to tree.radius/height so
  // canopy rings, shade proxy, selection and clones are all untouched.
  const _pw = Math.pow, _sin = Math.sin, PI = Math.PI;
  const CROWN_KR = {
    // stem: trunk share of height · sides: facet count · hmulR: canopy-radius scale
    // rings: vertical divisions · lean: gentle asymmetry · prof: normalised silhouette
    'Conical Evergreens': { stem: 0.05, sides: 7,  rings: 6, hmulR: 0.82, lean: 0.04, prof: u => _pw(Math.max(0, 1 - u), 0.82) },                       // narrow spire, wide skirt
    'Silver Maple':       { stem: 0.32, sides: 11, rings: 5, hmulR: 1.06, lean: 0.10, prof: u => _pw(_sin(PI * Math.min(1, 0.16 + 0.80 * u)), 0.60) },   // big rounded spreading dome
    'Ash':                { stem: 0.34, sides: 10, rings: 5, hmulR: 0.94, lean: 0.08, prof: u => _pw(_sin(PI * Math.min(1, 0.11 + 0.85 * u)), 0.72) },   // upright oval crown
    'Siberian Elm':       { stem: 0.40, sides: 10, rings: 5, hmulR: 1.10, lean: 0.12, prof: u => 0.40 + 0.66 * _pw(u, 0.80) },                            // vase — narrow base, broad top
    'Linden':             { stem: 0.28, sides: 9,  rings: 6, hmulR: 0.90, lean: 0.06, prof: u => _pw(Math.max(0, 1 - _pw(u, 1.45)), 0.58) },             // dense pyramidal / heart
    'Hawthorn':           { stem: 0.30, sides: 9,  rings: 4, hmulR: 1.00, lean: 0.09, prof: u => _pw(_sin(PI * Math.min(1, 0.22 + 0.74 * u)), 0.55) },   // small, low, broad dome
    'Amur Maple':         { stem: 0.26, sides: 9,  rings: 4, hmulR: 1.06, lean: 0.11, prof: u => _pw(_sin(PI * Math.min(1, 0.20 + 0.76 * u)), 0.50) }    // small, round, broad-low
  };
  // Named silhouette families, so a manifest can pick a crown habit as data
  // (site.species.<name>.crown = { shape, a, b, k, stem, sides, rings, hmulR, lean }).
  const CROWN_SHAPE = {
    spire:   p => (u => _pw(Math.max(0, 1 - u), p.k != null ? p.k : 0.82)),
    dome:    p => (u => _pw(_sin(PI * Math.min(1, (p.a != null ? p.a : 0.15) + (p.b != null ? p.b : 0.82) * u)), p.k != null ? p.k : 0.60)),
    vase:    p => (u => (p.a != null ? p.a : 0.40) + (p.b != null ? p.b : 0.66) * _pw(u, p.k != null ? p.k : 0.80)),
    pyramid: p => (u => _pw(Math.max(0, 1 - _pw(u, p.a != null ? p.a : 1.45)), p.k != null ? p.k : 0.58))
  };
  const CROWN = (() => {
    const out = {};
    for (const k in CROWN_KR) out[k] = CROWN_KR[k];
    const sp = (site && site.species) || {};
    for (const k in sp) {
      const c = sp[k] && sp[k].crown;
      if (!c) continue;
      const mk = CROWN_SHAPE[c.shape] || CROWN_SHAPE.dome;
      out[k] = {
        stem: c.stem != null ? c.stem : 0.32,
        sides: c.sides || 10,
        rings: c.rings || 5,
        hmulR: c.hmulR != null ? c.hmulR : 1.0,
        lean: c.lean != null ? c.lean : 0.08,
        prof: mk(c)
      };
    }
    return out;
  })();
  const CROWN_FALLBACK = CROWN['Ash'];
  // Alias table: a site with no authored tone/crown for a species borrows the
  // nearest King's Road habit. A site that DOES author one wins over the alias.
  const SP_ALIAS = { 'Conifer': 'Conical Evergreens', 'Columnar': 'Conical Evergreens', 'Oak': 'Silver Maple', 'Broadleaf': 'Ash', 'Maple': 'Silver Maple', 'Cherry': 'Hawthorn', 'Vase': 'Siberian Elm', 'Ornamental': 'Amur Maple' };
  const spKey = function (s) { return SPECIES_TONE[s] ? s : (SP_ALIAS[s] || s); };
  const crownKey = function (s) { return CROWN[s] ? s : (SP_ALIAS[s] || s); };
  const BARK_TONE = [0.44, 0.39, 0.33]; // muted warm grey-brown, stays on the ink/cream palette
  const TREE_TRUNKS = !!(site.trees && site.trees.trunks); // survey hulls float above grade
  // deterministic per-tree noise so a grove reads hand-cut, not lathe-perfect
  function treeRnd(tree) {
    let s = Math.floor((tree.pos[0] * 73.7 + tree.pos[1] * 19.3 + (tree.height || 8) * 11.1)) % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
  }
  // SKETCH crown: the survey's generic paper-model blob hull, quantized cut-paper facets.
  // (Unchanged from v1 — the default sketch aesthetic never shifts.)
  function treeGeom(tree, jit) {
    const sp = SPECIES_TONE[spKey(tree.species)] || TREE_FALLBACK;
    const base = sp.base;
    const shadeFloor = clamp01(0.78 - (sp.dens - 0.70) * 1.5);
    const g = meshGeom(tree.hull, (n) => {
      let l = n[0] * TREE_LIGHT[0] + n[1] * TREE_LIGHT[1] + n[2] * TREE_LIGHT[2];
      l = clamp01((l + 1) / 2);
      const step = Math.round(l * 3) / 3;
      const lf = (shadeFloor + (1.12 - shadeFloor) * step) * jit;
      return [clamp01(base[0] * lf), clamp01(base[1] * lf), clamp01(base[2] * lf)];
    });
    if (!TREE_TRUNKS) return g;
    const tk = hullTrunk(tree, jit);
    if (!tk) return g;
    const p0 = g.getAttribute('position').array, c0 = g.getAttribute('color').array;
    const pos = new Float32Array(p0.length + tk.pos.length), col = new Float32Array(c0.length + tk.col.length);
    pos.set(p0, 0); pos.set(tk.pos, p0.length);
    col.set(c0, 0); col.set(tk.col, c0.length);
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g2.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.dispose();
    return g2;
  }
  // Some surveys ship the crown as a canopy-only volume that starts well above grade
  // (Lee Square's hulls float a median 0.77 m, up to 3.8 m), so the sketch/walk trees
  // read as hovering masses. Opt in per site with trees.trunks and a slim bark stem is
  // grown from grade into the crown underside. Sites whose hulls already meet the ground
  // (King's Road) omit the flag and are untouched.
  function hullTrunk(tree, jit) {
    const v = tree.hull && tree.hull.v;
    if (!v || !v.length) return null;
    let z0 = Infinity;
    for (const p of v) if (p[2] < z0) z0 = p[2];
    if (!(z0 > 0.15)) return null; // already at grade
    // centre on the LOWEST ring of hull vertices so the stem meets the crown underside
    let sx = 0, sy = 0, m = 0;
    const lim = z0 + 0.35;
    for (const p of v) if (p[2] <= lim) { sx += p[0]; sy += p[1]; m++; }
    if (!m) { for (const p of v) { sx += p[0]; sy += p[1]; m++; } }
    const cx = sx / m, cy = sy / m;
    const R = Math.max(0.7, tree.radius || 2);
    const trR = Math.max(0.07, Math.min(0.34, R * 0.075));
    const sides = 6, top = z0 + 0.3; // overlap into the crown so no gap shows at eye level
    const pos = [], col = [];
    for (let s = 0; s < sides; s++) {
      const a0 = s / sides * PI * 2, a1 = (s + 1) / sides * PI * 2;
      const p0 = [cx + Math.cos(a0) * trR * 1.15, cy + Math.sin(a0) * trR * 1.15, 0];
      const p1 = [cx + Math.cos(a1) * trR * 1.15, cy + Math.sin(a1) * trR * 1.15, 0];
      const q0 = [cx + Math.cos(a0) * trR * 0.8, cy + Math.sin(a0) * trR * 0.8, top];
      const q1 = [cx + Math.cos(a1) * trR * 0.8, cy + Math.sin(a1) * trR * 0.8, top];
      const nx = Math.cos((a0 + a1) / 2), ny = Math.sin((a0 + a1) / 2);
      const l = clamp01((nx * TREE_LIGHT[0] + ny * TREE_LIGHT[1] + 1) / 2);
      const lf = (0.52 + 0.60 * (Math.round(l * 3) / 3)) * jit;
      const cc = [clamp01(BARK_TONE[0] * lf), clamp01(BARK_TONE[1] * lf), clamp01(BARK_TONE[2] * lf)];
      // both windings — the crown material is FrontSide, and a mis-wound stem would
      // simply not draw
      const quads = [[p0, p1, q1], [p0, q1, q0], [p1, p0, q0], [p1, q0, q1]];
      for (const t of quads) for (const p of t) { pos.push(p[0], p[2], -p[1]); col.push(cc[0], cc[1], cc[2]); }
    }
    return { pos: pos, col: col };
  }
  // RENDERED crown: procedurally grown to the species' habit. Built lazily and used
  // ONLY in §R rendered mode (swapped in by rTreesApply / rApplyTree, reverted on exit).
  // eye: the walkthrough variant — denser mesh, tighter jitter (the board's coarse jitter
  // is what opens gaps between rings when you stand under a crown), continuous shading
  // instead of 4 cut-paper bands, and cylindrical UVs so a leaf texture can ride on it.
  function speciesTreeGeom(tree, jit, eye) {
    const sp = SPECIES_TONE[spKey(tree.species)] || TREE_FALLBACK;
    const base = sp.base;
    const cr = CROWN[crownKey(tree.species)] || CROWN_FALLBACK;
    const shadeFloor = clamp01(0.78 - (sp.dens - 0.70) * 1.5); // ~0.48 (evergreen) .. 0.78 (amur maple)
    const cx = tree.pos[0], cy = tree.pos[1];
    const H = tree.height || 8, R = Math.max(0.7, tree.radius || 2);
    const rnd = treeRnd(tree);
    const crownZ0 = H * cr.stem, crownH = H - crownZ0;
    // normalise the profile so its widest ring == canopy radius
    let pkMax = 1e-6; for (let i = 0; i <= 24; i++) pkMax = Math.max(pkMax, cr.prof(i / 24));
    const rScale = R * cr.hmulR / pkMax;
    // gentle whole-crown lean, constant per tree
    const la = rnd() * PI * 2, lx = Math.cos(la) * cr.lean * R, ly = Math.sin(la) * cr.lean * R;

    const V = [], F = [], KIND = []; // KIND: 0 crown, 1 trunk
    const mask = [], crownT = []; // per-emitted-vertex: trunk flag + height-in-crown (rendered bake)
    // ---- crown rings ----
    const nR = eye ? Math.ceil(cr.rings * 1.8) : cr.rings;
    const sides = eye ? Math.ceil(cr.sides * 1.8) : cr.sides;
    const jAmp = eye ? 0.10 : 0.28, jLo = eye ? 0.95 : 0.86, zWob = eye ? 0.02 : 0.06;
    const ringIdx = [];
    for (let i = 0; i <= nR; i++) {
      const u = i / nR, z = crownZ0 + crownH * u;
      let rr = cr.prof(u) * rScale;
      const apexish = rr < 0.05 || i === nR && cr.prof(1) < 0.12;
      if (apexish) { // single top vertex (rounded/pointed apex)
        const zt = z + (i === nR ? 0 : 0);
        V.push([cx + lx * u, cy + ly * u, z]); ringIdx.push({ start: V.length - 1, apex: true });
        continue;
      }
      const a0 = rnd() * PI * 2, sway = lx * u, swy = ly * u;
      const start = V.length;
      for (let s = 0; s < sides; s++) {
        const ang = a0 + s / sides * PI * 2;
        const lump = eye ? (1 + 0.13 * Math.sin(ang * 3 + i * 1.7) + 0.07 * Math.sin(ang * 7 - i)) : 1;
        const rj = rr * (jLo + rnd() * jAmp) * lump;     // per-vertex jitter + clumped lumps
        const zj = z + (rnd() - 0.5) * crownH * zWob;    // vertical wobble
        V.push([cx + Math.cos(ang) * rj + sway, cy + Math.sin(ang) * rj + swy, zj]);
      }
      ringIdx.push({ start, apex: false });
    }
    // ensure a closing apex if the top ring wasn't collapsed
    let topApex = ringIdx[ringIdx.length - 1];
    if (!topApex.apex) {
      V.push([cx + lx, cy + ly, H + crownH * 0.02]);
      ringIdx.push({ start: V.length - 1, apex: true });
      topApex = ringIdx[ringIdx.length - 1];
    }
    // crown bottom cap (hidden above trunk, but closes the mass)
    const capC = V.length; V.push([cx, cy, crownZ0]);
    const r0 = ringIdx[0];
    if (!r0.apex) for (let s = 0; s < sides; s++) { F.push([capC, r0.start + (s + 1) % sides, r0.start + s]); KIND.push(0); }
    // stitch consecutive rings
    for (let i = 0; i < ringIdx.length - 1; i++) {
      const A = ringIdx[i], B = ringIdx[i + 1];
      if (A.apex) continue;
      if (B.apex) { for (let s = 0; s < sides; s++) F.push([A.start + s, A.start + (s + 1) % sides, B.start]) && KIND.push(0); continue; }
      for (let s = 0; s < sides; s++) {
        const a = A.start + s, b = A.start + (s + 1) % sides, c = B.start + (s + 1) % sides, d = B.start + s;
        F.push([a, b, c]); KIND.push(0); F.push([a, c, d]); KIND.push(0);
      }
    }
    // ---- trunk ---- slim tapered prism, bark-toned
    const tSides = Math.min(6, sides), trR = Math.max(0.055, R * 0.075);
    const tb = V.length; for (let s = 0; s < tSides; s++) { const ang = s / tSides * PI * 2; V.push([cx + Math.cos(ang) * trR * 1.15, cy + Math.sin(ang) * trR * 1.15, 0]); }
    const tt = V.length; for (let s = 0; s < tSides; s++) { const ang = s / tSides * PI * 2; V.push([cx + Math.cos(ang) * trR * 0.85, cy + Math.sin(ang) * trR * 0.85, crownZ0 + 0.05]); }
    for (let s = 0; s < tSides; s++) {
      const a = tb + s, b = tb + (s + 1) % tSides, c = tt + (s + 1) % tSides, d = tt + s;
      F.push([a, b, c]); KIND.push(1); F.push([a, c, d]); KIND.push(1);
    }

    // ---- bake to geometry (position-aware colour: foliage facets vs bark) ----
    const crownCenterZ = crownZ0 + crownH * 0.5;
    const pos = [], col = [], uvs = [];
    for (let fi = 0; fi < F.length; fi++) {
      const f = F[fi], isTrunk = KIND[fi] === 1;
      const a = V[f[0]], b = V[f[1]], c2 = V[f[2]];
      const u1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c2[0] - a[0], c2[1] - a[1], c2[2] - a[2]];
      let n = [u1[1] * w[2] - u1[2] * w[1], u1[2] * w[0] - u1[0] * w[2], u1[0] * w[1] - u1[1] * w[0]];
      const nl = Math.hypot(n[0], n[1], n[2]) || 1; n = [n[0] / nl, n[1] / nl, n[2] / nl];
      // force outward: point away from the crown/trunk axis-centre of this face
      const gz = isTrunk ? crownZ0 * 0.5 : crownCenterZ;
      const ox = (a[0] + b[0] + c2[0]) / 3 - cx, oy = (a[1] + b[1] + c2[1]) / 3 - cy, oz = (a[2] + b[2] + c2[2]) / 3 - gz;
      let tri = f;
      if (n[0] * ox + n[1] * oy + n[2] * oz < 0) { n = [-n[0], -n[1], -n[2]]; tri = [f[0], f[2], f[1]]; }
      let l = n[0] * TREE_LIGHT[0] + n[1] * TREE_LIGHT[1] + n[2] * TREE_LIGHT[2];
      l = clamp01((l + 1) / 2);
      const step = eye ? l : Math.round(l * 3) / 3;       // eye level: continuous; board: 4 cut-paper bands
      let cc;
      if (isTrunk) {
        const lf = (0.52 + 0.60 * step) * jit;
        cc = [clamp01(BARK_TONE[0] * lf), clamp01(BARK_TONE[1] * lf), clamp01(BARK_TONE[2] * lf)];
      } else {
        const lf = (shadeFloor + (1.12 - shadeFloor) * step) * jit;
        cc = [clamp01(base[0] * lf), clamp01(base[1] * lf), clamp01(base[2] * lf)];
      }
      for (const vi of tri) {
        const p = V[vi]; pos.push(p[0], p[2], -p[1]); col.push(cc[0], cc[1], cc[2]);
        if (eye) {
          const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
          if (az >= ax && az >= ay) uvs.push(p[0] / 1.3, p[1] / 1.3);       // crown top/underside
          else if (ax >= ay) uvs.push(p[1] / 1.3, p[2] / 1.3);              // side facing x
          else uvs.push(p[0] / 1.3, p[2] / 1.3);                            // side facing y
        }
        mask.push(isTrunk ? 1 : 0);
        crownT.push(isTrunk ? 0 : clamp01((p[2] - crownZ0) / (crownH || 1)));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    if (eye && uvs.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    if (eye) g.computeVertexNormals(); // smooth-ish normals: no faceted cut-paper read at 2 m
    g._trunkMask = new Float32Array(mask); // rendered bake: bark trunk vs foliage crown
    g._crownT = new Float32Array(crownT);  // rendered bake: height-in-crown for canopy AO
    return g;
  }
  function buildTrees(list) {
    const grp = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.FrontSide, transparent: true });
    const edgeMat = fatMat(0x17150f, 2.6, 0.9);
    const ringPts = [];
    const trees = [];
    for (const t of list) {
      const jit = 1 + (Math.random() * 2 - 1) * 0.03; // per-tree ±3% value jitter
      const m = new THREE.Mesh(treeGeom(t, jit), mat);
      m.userData = { species: t.species, height: t.height, radius: t.radius, pos: t.pos };
      // pivot at base for plant animation: hull verts are absolute; scale about base via group
      const piv = new THREE.Group();
      piv.position.set(t.pos[0], 0, -t.pos[1]);
      m.position.set(-t.pos[0], 0, t.pos[1]);
      piv.add(m);
      const tl2 = fatSeg(new THREE.EdgesGeometry(m.geometry, 26), edgeMat);
      tl2.position.copy(m.position);
      piv.add(tl2);
      piv.userData = { dist: Math.hypot(t.pos[0] - IVX, t.pos[1] - IVY) };
      grp.add(piv);
      trees.push({ piv, mesh: m, t, _jit: jit });
      const R = Math.max(0.8, t.radius), seg = 20;
      for (let i = 0; i < seg; i++) {
        const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
        ringPts.push(t.pos[0] + Math.cos(a0) * R, 0.15, -t.pos[1] + Math.sin(a0) * R,
          t.pos[0] + Math.cos(a1) * R, 0.15, -t.pos[1] + Math.sin(a1) * R);
      }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(ringPts, 3));
    const rings = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0x17150f, transparent: true, opacity: 0 }));
    rings.visible = false;
    return { grp, mat, edgeMat, trees, rings };
  }
  const treesA = buildTrees(geo.baseline.trees);
  const treesB = buildTrees(geo.scenario_01.trees);
  scene.add(treesA.grp, treesA.rings, treesB.grp, treesB.rings);
  // stagger order for scenario trees
  treesB.trees.forEach(tr => { tr.plantAt = 0; });
  {
    const sorted = [...treesB.trees].sort((a, b) => a.piv.userData.dist - b.piv.userData.dist);
    sorted.forEach((tr, i) => { tr.plantAt = 0.30 + 0.55 * (i / Math.max(1, sorted.length - 1)); });
  }

  // ---- data mosaic (one cell per measurement — honest to 20,093 points) ----
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
  let LOUD = opts.params && opts.params.tessellationLoudness != null ? opts.params.tessellationLoudness : 0.55;
  let EXAG = opts.params && opts.params.reliefExaggeration != null ? opts.params.reliefExaggeration : 1;

  function buildMosaic(st) {
    const d = D[st];
    const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
    // depthWrite:false — the two states' mosaics are coplanar overlay sheets; if the
    // hidden state (opacity 0) wrote depth it would punch holes in the visible state
    // behind it (white ground bleeding through the colour grid). depthTest stays on,
    // so opaque geometry (buildings, trees) still occludes the field correctly.
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const inst = new THREE.InstancedMesh(g, mat, d.n);
    inst.renderOrder = 1;
    inst.frustumCulled = false;
    // deterministic pseudo-random per point
    const rnd = i => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
    inst.userData.layout = (uniform) => {
      if (uniform) {
        // ---- normalized wash: snap points onto ONE regular lattice, one square per cell ----
        // Every square is the SAME size with the SAME gap, regardless of the source grid's
        // native resolution. The dense-vs-sparse illusion and the per-grid size variation are
        // both gone; colour is the only variable. Plan is cached (data + bounds are static).
        let plan = inst.userData.uniformPlan;
        if (!plan) {
          // pitch = high-percentile grid cell → interior cells reliably contain data (no holes)
          // without a few coarse outliers bloating every square.
          // pitch must be >= the COARSEST grid's spacing, else sparsely-sampled regions leave
          // lattice cells stranded between points (holes). At this pitch every region reliably
          // has >=1 point per cell — fine grids simply dedupe more heavily.
          const cs = d.grids.map(g => g.cell).sort((a, b) => a - b);
          const P = cs.length ? cs[cs.length - 1] * 1.05 : 1;
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (let i = 0; i < d.n; i++) { const x = d.x[i], y = d.y[i]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
          const key = (gx, gy) => gx + ',' + gy;
          // bin every point INTO its lattice cell — one representative per occupied cell
          // (nearest to the cell centre). Binning points→cells (not cells hunting for a free
          // point) means no region can get its points exhausted by neighbours, so no cluster holes.
          const cellMap = new Map();
          for (let i = 0; i < d.n; i++) { const k = key(Math.floor(d.x[i] / P), Math.floor(d.y[i] / P)); let a = cellMap.get(k); if (!a) { a = []; cellMap.set(k, a); } a.push(i); }
          const spare = new Map(), assign = [];
          for (const [k, arr] of cellMap) {
            const c = k.split(','), cx = (+c[0] + 0.5) * P, cy = (+c[1] + 0.5) * P;
            let best = -1, bd = Infinity;
            for (const i of arr) { const ex = d.x[i] - cx, ey = d.y[i] - cy, dd = ex * ex + ey * ey; if (dd < bd) { bd = dd; best = i; } }
            assign.push(best, cx, cy);
            if (arr.length > 1) spare.set(k, arr.filter(i => i !== best));
          }
          // fill genuine interior pockets (empty cell ringed by data) by relocating a real
          // spare point from a neighbour — keeps the grid solid without inventing values.
          const gx0 = Math.floor(minX / P), gx1 = Math.floor(maxX / P), gy0 = Math.floor(minY / P), gy1 = Math.floor(maxY / P);
          const fr2 = (P * 1.3) * (P * 1.3);
          for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
            const k = key(gx, gy); if (cellMap.has(k)) continue;
            let occ = 0;
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if ((dx || dy) && cellMap.has(key(gx + dx, gy + dy))) occ++;
            if (occ < 4) continue; // interior pockets only — never grow the silhouette
            const cx = (gx + 0.5) * P, cy = (gy + 0.5) * P;
            let best = -1, bd = fr2, bk = null;
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
              const nk = key(gx + dx, gy + dy), sp = spare.get(nk); if (!sp || !sp.length) continue;
              for (const i of sp) { const ex = d.x[i] - cx, ey = d.y[i] - cy, dd = ex * ex + ey * ey; if (dd < bd) { bd = dd; best = i; bk = nk; } }
            }
            if (best >= 0) { const sp = spare.get(bk); sp.splice(sp.indexOf(best), 1); assign.push(best, cx, cy); cellMap.set(k, [best]); }
          }
          plan = inst.userData.uniformPlan = { P, assign };
        }
        const sq = plan.P * 0.8; // 20% gap between squares
        _q.identity();
        for (let i = 0; i < d.n; i++) { _p.set(0, -60, 0); _s.set(0.0001, 1, 0.0001); _m4.compose(_p, _q, _s); inst.setMatrixAt(i, _m4); }
        const A = plan.assign;
        for (let j = 0; j < A.length; j += 3) { _p.set(A[j + 1], 0.07, -A[j + 2]); _s.set(sq, 1, sq); _m4.compose(_p, _q, _s); inst.setMatrixAt(A[j], _m4); }
        inst.instanceMatrix.needsUpdate = true;
        return;
      }
      for (let i = 0; i < d.n; i++) {
        const c = CATS[d.cat[i]], T = CAT_TESS[c], cell = d.grids[d.gridOf[i]].cell;
        const r1 = rnd(i), r2 = rnd(i + 7919), r3 = rnd(i + 104729);
        const size = cell * (T[0] + (r1 - 0.5) * 2 * T[1] * LOUD) * (1 - 0.06 * LOUD);
        _e.set(0, (r2 - 0.5) * 2 * T[2] * LOUD, 0); _q.setFromEuler(_e);
        _p.set(d.x[i] + (r3 - 0.5) * 2 * T[3] * cell * LOUD, 0.07, -d.y[i] + (r1 - 0.5) * 2 * T[3] * cell * LOUD);
        _s.set(size, 1, size);
        _m4.compose(_p, _q, _s);
        inst.setMatrixAt(i, _m4);
      }
      inst.instanceMatrix.needsUpdate = true;
    };
    inst.userData.layout();
    inst.setColorAt(0, new THREE.Color(1, 1, 1));
    scene.add(inst);
    return inst;
  }
  const mosaic = { baseline: buildMosaic('baseline'), scenario_01: buildMosaic('scenario_01') };

  const MUTE = [0.898, 0.886, 0.855];
  function recolorMosaic(st, mode) {
    // mode: {metric} | {binary} | {materialPlan}
    const d = D[st], inst = mosaic[st], col = new THREE.Color();
    for (let i = 0; i < d.n; i++) {
      let r, g2, b;
      if (mode.materialPlan) {
        const c = new THREE.Color(CAT_TINT[CATS[d.cat[i]]]); r = c.r; g2 = c.g; b = c.b;
      } else if (mode.binary) {
        if (d.red[i] >= 0.3) { r = 0.55; g2 = 0.73; b = 0.66; } else { r = 0.94; g2 = 0.45; b = 0.30; }
      } else if (mode.stage != null) {
        // continuous scene-1 merge: 0 = material tint → 1 = measured/unmeasured → 2 = full load ramp
        const x = mode.stage;
        const cm = new THREE.Color(CAT_TINT[CATS[d.cat[i]]]);
        let br, bg, bb2;
        if (d.red[i] >= 0.3) { br = 0.55; bg = 0.73; bb2 = 0.66; } else { br = 0.94; bg = 0.45; bb2 = 0.30; }
        if (x <= 1) {
          r = cm.r + (br - cm.r) * x; g2 = cm.g + (bg - cm.g) * x; b = cm.b + (bb2 - cm.b) * x;
        } else {
          const k = x - 1;
          const cr = METRICS.load.ramp(metricT('load', d.load[i]));
          r = br + (cr[0] - br) * k; g2 = bg + (cr[1] - bg) * k; b = bb2 + (cr[2] - bb2) * k;
        }
      } else if (mode.blend != null) {
        const cL = METRICS.load.ramp(metricT('load', d.load[i]));
        const cR = METRICS.reduction.ramp(metricT('reduction', d.red[i]));
        const k = mode.blend;
        r = cL[0] + (cR[0] - cL[0]) * k; g2 = cL[1] + (cR[1] - cL[1]) * k; b = cL[2] + (cR[2] - cL[2]) * k;
      } else {
        const m = mode.metric, v = metricValue(st, m, i), t = metricT(m, v);
        const c = METRICS[effMetricKey(m)].ramp(t); r = c[0]; g2 = c[1]; b = c[2];
        // pending metrics render pulled toward paper-grey so no one mistakes a
        // placeholder for a measured result (dev flag reveals the raw field)
        if (METRICS[m].status === 'pending' && !S.devTemp) {
          const gk = 0.60; r = r * (1 - gk) + 0.60 * gk; g2 = g2 * (1 - gk) + 0.59 * gk; b = b * (1 - gk) + 0.55 * gk;
        }
        // FAST PREVIEW register: proxy-driven field is visibly desaturated so it
        // never reads as the measured simulation (shade trio only)
        if (S.preview && (m === 'load' || m === 'reduction' || m === 'sunhours')) {
          const lum = r * 0.3 + g2 * 0.5 + b * 0.2, dk = 0.34;
          r = r * (1 - dk) + lum * dk; g2 = g2 * (1 - dk) + lum * dk; b = b * (1 - dk) + lum * dk;
        }
        if (mode.threshold != null) {
          const tv = mode.threshold;
          const rv = (S.preview && d.pRed) ? d.pRed[i] : d.red[i];
          const below = (m === 'reduction') ? (rv < tv) : (metricValue(st, m, i) < tv);
          if (below) { r = r * 0.14 + MUTE[0] * 0.86; g2 = g2 * 0.14 + MUTE[1] * 0.86; b = b * 0.14 + MUTE[2] * 0.86; }
        }
      }
      col.setRGB(r, g2, b);
      inst.setColorAt(i, col);
    }
    inst.instanceColor.needsUpdate = true;
  }

  // ---- relief cloud (§7: extruded prisms, tops opaque-ish, sides misty) ----
  const HOVER_H = 1.4;
  // relief styles — how much visual hierarchy the cloud claims
  const RELIEF_STYLES = {
    veil:  { op: 0.32, h: 0.55, pow: 1,   aB: 0.6,  aK: 0.25, mute: 0.42, quant: 0, shd: 0.55 }, // quiet glass tint — site leads
    mist:  { op: 0.5,  h: 1.05, pow: 2.6, aB: 0.72, aK: 0.28, mute: 0.12, quant: 0, shd: 0.6 },  // ground fog that BULGES where burden is high
    dots:  { op: 0.62, h: 1.05, pow: 2.6, aB: 1,    aK: 0,    mute: 0,    quant: 0, shd: 0, dots: true }, // exploded sensor sheet — one dot per measurement, sized by burden
    bands: { op: 0.38, h: 0.8,  pow: 1,   aB: 0.65, aK: 0.2,  mute: 0.3,  quant: 6, shd: 0.75 }, // stepped topo-model bands — pale, architectural
    bold:  { op: 0.62, h: 1,    pow: 1,   aB: 0.8,  aK: 0.2,  mute: 0,    quant: 0, shd: 1 }     // the full landform
  };
  let RSTYLE = (opts.params && opts.params.reliefStyle) in RELIEF_STYLES ? opts.params.reliefStyle : 'veil';
  const CREAM = [0.973, 0.965, 0.941];
  const RELIEF_DIM = 0.1;  // the mosaic nearly sleeps under the cloud so the site reads through
  function buildRelief(st) {
    const d = D[st];
    // grid bounds over this state's sensors
    let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
    for (let i = 0; i < d.n; i++) {
      if (d.x[i] < bx0) bx0 = d.x[i]; if (d.x[i] > bx1) bx1 = d.x[i];
      if (d.y[i] < by0) by0 = d.y[i]; if (d.y[i] > by1) by1 = d.y[i];
    }
    const PAD = 3.5, CELL = 1.35;
    bx0 -= PAD; by0 -= PAD; bx1 += PAD; by1 += PAD;
    const nx = Math.ceil((bx1 - bx0) / CELL) + 1, ny = Math.ceil((by1 - by0) / CELL) + 1;
    const nv = nx * ny;
    // gaussian gather: which sensors inform each vertex, and with what weight
    const RR = 3.0, SIG = 1.5, R2 = RR * RR, around = Math.ceil(RR / HASH_CELL);
    const sIdx = [], sW = [], start = new Int32Array(nv + 1);
    const sumW = new Float32Array(nv);
    const dMin = new Float32Array(nv); dMin.fill(1e9);
    const cellN = new Float32Array(nv); cellN.fill(1);
    for (let vy = 0; vy < ny; vy++) for (let vx = 0; vx < nx; vx++) {
      const vi = vy * nx + vx;
      start[vi] = sIdx.length;
      const px = bx0 + vx * CELL, py = by0 + vy * CELL;
      const kx = Math.floor(px / HASH_CELL), ky = Math.floor(-py / HASH_CELL);
      for (let ax = -around; ax <= around; ax++) for (let ay = -around; ay <= around; ay++) {
        const arr = d.hash.get((kx + ax) * 4096 + (ky + ay));
        if (!arr) continue;
        for (const i of arr) {
          const dx = d.x[i] - px, dy = d.y[i] - py, dd = dx * dx + dy * dy;
          if (dd > R2) continue;
          const w = Math.exp(-dd / (2 * SIG * SIG));
          sIdx.push(i); sW.push(w); sumW[vi] += w;
          if (dd < dMin[vi]) { dMin[vi] = dd; cellN[vi] = d.grids[d.gridOf[i]].cell; }
        }
      }
    }
    start[nv] = sIdx.length;
    // coverage = distance to nearest sensor in units of THAT sensor's grid spacing
    // (density-independent: a 2m parking grid counts as covered as a 0.5m path grid)
    let maxW = 0; for (let vi = 0; vi < nv; vi++) if (sumW[vi] > maxW) maxW = sumW[vi];
    const alphaRaw = new Float32Array(nv);
    for (let vi = 0; vi < nv; vi++) {
      if (sumW[vi] <= 0) { alphaRaw[vi] = 0; continue; }
      const dn = Math.sqrt(dMin[vi]), c = cellN[vi];
      alphaRaw[vi] = smooth(clamp01(1 - (dn - 1.15 * c) / (1.6 * c)));
    }
    const alpha = new Float32Array(nv);
    for (let vy = 0; vy < ny; vy++) for (let vx = 0; vx < nx; vx++) {
      let s = 0, c = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const qx = vx + ox, qy = vy + oy;
        if (qx < 0 || qy < 0 || qx >= nx || qy >= ny) continue;
        s += alphaRaw[qy * nx + qx]; c++;
      }
      alpha[vy * nx + vx] = s / c;
    }
    // geometry: one soft sheet; skip quads with no data anywhere near
    const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 4);
    for (let vy = 0; vy < ny; vy++) for (let vx = 0; vx < nx; vx++) {
      const vi = vy * nx + vx;
      pos[vi * 3] = bx0 + vx * CELL; pos[vi * 3 + 1] = HOVER_H; pos[vi * 3 + 2] = -(by0 + vy * CELL);
      col[vi * 4 + 3] = alpha[vi];
    }
    const idx = [];
    for (let vy = 0; vy < ny - 1; vy++) for (let vx = 0; vx < nx - 1; vx++) {
      const a = vy * nx + vx, b = a + 1, c = a + nx, e = c + 1;
      if (alpha[a] < 0.004 && alpha[b] < 0.004 && alpha[c] < 0.004 && alpha[e] < 0.004) continue;
      idx.push(a, c, b, b, c, e);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    g.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 5;
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    // exploded sensor sheet: one flat dot per measurement, floated on the same surface
    const dotG = new THREE.CircleGeometry(0.5, 10); dotG.rotateX(-Math.PI / 2);
    const dotsMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    const dots = new THREE.InstancedMesh(dotG, dotsMat, d.n);
    dots.renderOrder = 6; dots.frustumCulled = false; dots.visible = false;
    dots.setColorAt(0, new THREE.Color(1, 1, 1));
    scene.add(dots);
    // faint ink edge beneath each dot — keeps the palest ramp colors legible on cream
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0x5a564a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    const dotsEdge = new THREE.InstancedMesh(dotG, edgeMat, d.n);
    dotsEdge.renderOrder = 5; dotsEdge.frustumCulled = false; dotsEdge.visible = false;
    scene.add(dotsEdge);
    return { mesh, mat, dots, dotsMat, dotsEdge, edgeMat, bx0, by0, CELL, nx, ny, nv, start, sIdx, sW, sumW, alpha, tV: new Float32Array(nv), tTmp: new Float32Array(nv) };
  }
  const relief = { baseline: buildRelief('baseline'), scenario_01: buildRelief('scenario_01') };
  function layoutRelief(st, metric) {
    const d = D[st], R = relief[st], M = METRICS[metric];
    // per-sensor ramp position
    const tS = new Float32Array(d.n);
    for (let i = 0; i < d.n; i++) tS[i] = metricT(metric, metricValue(st, metric, i));
    // weighted mean per vertex
    const { nv, nx, ny, start, sIdx, sW, sumW, alpha, tV, tTmp } = R;
    for (let vi = 0; vi < nv; vi++) {
      if (sumW[vi] <= 0) { tV[vi] = 0; continue; }
      let s = 0;
      for (let k = start[vi]; k < start[vi + 1]; k++) s += tS[sIdx[k]] * sW[k];
      tV[vi] = s / sumW[vi];
    }
    // two soft blur passes -> one continuous cloud, no spikes
    const tRaw = R.tRaw || (R.tRaw = new Float32Array(nv));
    tRaw.set(tV);
    for (let pass = 0; pass < 2; pass++) {
      for (let vy = 0; vy < ny; vy++) for (let vx = 0; vx < nx; vx++) {
        const vi = vy * nx + vx;
        let s = 0, c = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const qx = vx + ox, qy = vy + oy;
          if (qx < 0 || qy < 0 || qx >= nx || qy >= ny) continue;
          const qi = qy * nx + qx;
          if (alpha[qi] <= 0.004) continue;
          const w = (ox === 0 && oy === 0) ? 2 : 1;
          s += tV[qi] * w; c += w;
        }
        tTmp[vi] = c ? s / c : tV[vi];
      }
      tV.set(tTmp);
    }
    // write heights: a continuous terrain over the whole measured site
    const cfg = RELIEF_STYLES[RSTYLE];
    const posA = R.mesh.geometry.attributes.position, colA = R.mesh.geometry.attributes.color;
    const { nx: gx, ny: gy } = R;
    for (let vi = 0; vi < nv; vi++) {
      const burden = M.burden(tV[vi]);
      const taper = 0.2 + 0.8 * alpha[vi]; // edges dive softly to the base
      // pow > 1 keeps the fog low over calm ground and bulges it hard where burden climbs
      posA.array[vi * 3 + 1] = HOVER_H + (0.5 + Math.pow(burden, cfg.pow) * 14.5 * cfg.h) * EXAG * taper;
    }
    // hillshade: form reads even where the ramp is pale — shading, never data
    const LX = 0.5, LY = 0.72, LZ = 0.48;
    for (let vy = 0; vy < gy; vy++) for (let vx = 0; vx < gx; vx++) {
      const vi = vy * gx + vx;
      const hl = posA.array[(vy * gx + Math.max(0, vx - 1)) * 3 + 1], hr = posA.array[(vy * gx + Math.min(gx - 1, vx + 1)) * 3 + 1];
      const hd = posA.array[(Math.max(0, vy - 1) * gx + vx) * 3 + 1], hu = posA.array[(Math.min(gy - 1, vy + 1) * gx + vx) * 3 + 1];
      let nxv = hl - hr, nyv = 2.7, nzv = hd - hu;
      const nl = Math.hypot(nxv, nyv, nzv);
      const lam = clamp01((nxv * LX + nyv * LY + nzv * LZ) / nl);
      const shade = 1 + (0.68 + 0.46 * lam - 1) * cfg.shd;
      // color keeps more of the raw local signal than the height does — punchy, still soft
      let tc = tRaw[vi] * 0.55 + tV[vi] * 0.45;
      if (cfg.quant) tc = (Math.floor(tc * cfg.quant) + 0.5) / cfg.quant; // stepped topo bands
      const c = M.ramp(tc);
      const burden2 = M.burden(tV[vi]);
      colA.array[vi * 4] = Math.min(1, (c[0] * (1 - cfg.mute) + CREAM[0] * cfg.mute) * shade);
      colA.array[vi * 4 + 1] = Math.min(1, (c[1] * (1 - cfg.mute) + CREAM[1] * cfg.mute) * shade);
      colA.array[vi * 4 + 2] = Math.min(1, (c[2] * (1 - cfg.mute) + CREAM[2] * cfg.mute) * shade);
      colA.array[vi * 4 + 3] = alpha[vi] * (cfg.aB + cfg.aK * burden2);
    }
    R.key = metric + '|' + EXAG + '|' + RSTYLE;
    posA.needsUpdate = true; colA.needsUpdate = true;
    // ---- dot layout (dots style): size by burden, height from the smoothed sheet ----
    if (cfg.dots) {
      const bil = (arr, px, py) => { // bilinear sample of a vertex-grid array at data coords
        let fx = (px - R.bx0) / R.CELL, fy = (py - R.by0) / R.CELL;
        fx = Math.max(0, Math.min(gx - 1.001, fx)); fy = Math.max(0, Math.min(gy - 1.001, fy));
        const x0 = Math.floor(fx), y0 = Math.floor(fy), ux = fx - x0, uy = fy - y0;
        const a = arr[y0 * gx + x0], b = arr[y0 * gx + x0 + 1], c2 = arr[(y0 + 1) * gx + x0], e = arr[(y0 + 1) * gx + x0 + 1];
        return (a + (b - a) * ux) * (1 - uy) + (c2 + (e - c2) * ux) * uy;
      };
      const col = new THREE.Color();
      const rnd = i => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
      for (let i = 0; i < d.n; i++) {
        const cell = d.grids[d.gridOf[i]].cell;
        // density-aware thinning: dense grids shed dots, coarse grids keep theirs — even air throughout
        const keep = rnd(i) < clamp01(Math.pow(cell / 1.5, 2) * 0.85 + 0.12);
        if (!keep) { _s.set(0.0001, 1, 0.0001); _p.set(0, -50, 0); _q.identity(); _m4.compose(_p, _q, _s); R.dots.setMatrixAt(i, _m4); R.dotsEdge.setMatrixAt(i, _m4); continue; }
        const bRaw = M.burden(tS[i]);
        const tSm = bil(tV, d.x[i], d.y[i]);
        const taper = 0.2 + 0.8 * bil(alpha, d.x[i], d.y[i]);
        // height: mostly this sensor's OWN burden, part neighborhood — hot points rise above the sheet
        const bMix = bRaw * 0.55 + M.burden(tSm) * 0.45;
        const yy = HOVER_H + (0.5 + Math.pow(bMix, cfg.pow) * 14.5 * cfg.h) * EXAG * taper;
        // size: pure function of this sensor's burden — no grid-spacing confound
        const size = 1.5 * (0.2 + 0.78 * bRaw);
        _q.identity();
        _p.set(d.x[i], yy, -d.y[i]); _s.set(size, 1, size);
        _m4.compose(_p, _q, _s);
        R.dots.setMatrixAt(i, _m4);
        _p.set(d.x[i], yy - 0.04, -d.y[i]); _s.set(size * 1.16 + 0.08, 1, size * 1.16 + 0.08);
        _m4.compose(_p, _q, _s);
        R.dotsEdge.setMatrixAt(i, _m4);
        const c = M.ramp(tS[i]);
        col.setRGB(c[0], c[1], c[2]);
        R.dots.setColorAt(i, col);
      }
      R.dots.instanceMatrix.needsUpdate = true;
      R.dots.instanceColor.needsUpdate = true;
      R.dotsEdge.instanceMatrix.needsUpdate = true;
    }
  }

  // ---- selection / highlight ----------------------------------------------
  const selLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x17150f, linewidth: 2 }));
  selLine.visible = false; selLine.renderOrder = 8;
  scene.add(selLine);
  const hoverEdge = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x17150f }));
  hoverEdge.visible = false; hoverEdge.renderOrder = 9;
  scene.add(hoverEdge);
  const pickPlane = new THREE.Mesh(new THREE.PlaneGeometry(600, 500), new THREE.MeshBasicMaterial({ visible: false }));
  pickPlane.rotation.x = -Math.PI / 2; pickPlane.position.set(107.5, 0.05, 65);
  scene.add(pickPlane);

  function outlineSurface(st, grid) {
    const surf = geo[st].surfaces[grid.cat][grid.catIdx];
    if (!surf) { selLine.visible = false; return; }
    const pts = surf.outer.map(p => new THREE.Vector3(p[0], 0.18, -p[1]));
    pts.push(pts[0].clone());
    selLine.geometry.dispose();
    selLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    selLine.visible = true;
  }

  // ---- hover: the surface under the cursor lifts, its boundary drawn white ----
  const hoverLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x17150f, transparent: true, opacity: 0.95 }));
  hoverLine.visible = false; hoverLine.renderOrder = 9;
  scene.add(hoverLine);
  const hoverFill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide }));
  hoverFill.visible = false; hoverFill.renderOrder = 8;
  scene.add(hoverFill);
  // persistent selection wash: stays on the clicked surface until its card closes
  const selFill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
  selFill.visible = false; selFill.renderOrder = 7;
  scene.add(selFill);
  // persistent selection edge: stays darkening the clicked tree until its card closes
  const selEdge = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x17150f }));
  selEdge.visible = false; selEdge.renderOrder = 9;
  scene.add(selEdge);
  function fillSurface(stKey, grid) {
    const surf = geo[stKey].surfaces[grid.cat][grid.catIdx];
    if (!surf) { selFill.visible = false; return; }
    const fg = new THREE.ShapeGeometry(polyShape(surf));
    fg.rotateX(-Math.PI / 2); fg.translate(0, 0.24, 0);
    selFill.geometry.dispose(); selFill.geometry = fg; selFill.visible = true;
  }
  let hoverSurf = null;
  function clearHoverSurf() {
    if (hoverSurf) { hoverSurf.mesh.material.color.setHex(CAT_GROUND[hoverSurf.cat]); hoverSurf = null; }
    hoverLine.visible = false;
    hoverFill.visible = false;
  }
  function setHoverSurf(mesh, stKey) {
    if (hoverSurf && hoverSurf.mesh === mesh) return;
    clearHoverSurf();
    const u = mesh.userData;
    const surf = geo[stKey].surfaces[u.cat][u.idx];
    if (!surf) return;
    mesh.material.color.copy(new THREE.Color(CAT_GROUND[u.cat]).lerp(new THREE.Color(0xffffff), 0.55));
    const pts = surf.outer.map(p => new THREE.Vector3(p[0], 0.3, -p[1]));
    pts.push(pts[0].clone());
    hoverLine.geometry.dispose();
    hoverLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    hoverLine.visible = true;
    const fg = new THREE.ShapeGeometry(polyShape(surf));
    fg.rotateX(-Math.PI / 2); fg.translate(0, 0.26, 0);
    hoverFill.geometry.dispose();
    hoverFill.geometry = fg;
    hoverFill.visible = true;
    hoverSurf = { mesh, cat: u.cat };
  }

  // ---- tweens ---------------------------------------------------------------
  let tweens = [];
  let timeouts = [];
  function tween(dur, fn, ease, done) {
    if (RM) { fn(1); if (done) done(); return; }
    tweens.push({ t0: performance.now(), dur, fn, ease: ease || easeIO, done });
  }
  function after(ms, fn) {
    if (RM) { fn(); return; }
    timeouts.push(setTimeout(fn, ms));
  }
  function cancelAll() {
    tweens = [];
    for (const t of timeouts) clearTimeout(t);
    timeouts = [];
  }

  // ---- app state (mirrors handoff contract) ---------------------------------
  const S = {
    site: 'kingsroad',
    designState: 'baseline',
    metric: 'load',
    relief: false,
    plan: 0,          // 0 iso .. 1 plan
    fieldOn: false,
    rendered: false, showData: false, // §R parallel aesthetic (sketch is default)
    threshold: null,
    scene: -1,
    phase: 'narrative',
    walk: null,
    devTemp: !!(opts.params && opts.params.devSyntheticTemperature),
    matSwap: null,
    firstPullDone: false,
    breathe: false
  };

  function activeMosaicColors() {
    recolorMosaic('baseline', { metric: S.metric, threshold: S.threshold });
    recolorMosaic('scenario_01', { metric: S.metric, threshold: S.threshold });
  }
  activeMosaicColors();

  function setFieldOpacity(st, o) {
    mosaic[st].material.opacity = o;
    if (R_PRIMER && R_PRIMER[st]) { // white primer tracks the wash (lever crossfade included)
      const k = rWashOn ? Math.min(1, o / R_WASH_OP) : 0;
      R_PRIMER[st].material.opacity = k * 0.9;
      R_PRIMER[st].visible = rWashOn && k > 0.001;
    }
  }
  function stateMix(p) {
    // p: 0 = baseline world, 1 = scenario world (ground/trees/buildings/field)
    groundA.grp.traverse(o => { if (o.material) { o.material.transparent = true; o.material.opacity = 1 - p * 0.999; } });
    groundB.grp.traverse(o => { if (o.material) { o.material.transparent = true; o.material.opacity = p; } });
    groundB.grp.visible = p > 0.001;
    for (const b of removedBuildings) {
      b.mesh.position.y = p * 46;
      const o = 1 - smooth(p * 1.6);
      for (const mt of b.mats) mt.opacity = o;
      b.mesh.visible = o > 0.01;
    }
    // baseline trees fade out mid-transition; scenario trees plant staggered (scale).
    // Design-mode edits must survive the crossfade: added trees (no authored plantAt)
    // default to the mid-stagger slot, deleted trees stay deleted.
    treesB.mat.opacity = 1;
    for (const tr of treesB.trees) {
      if (tr._del) { tr.piv.visible = false; continue; }
      const k = smooth((p - (tr.plantAt != null ? tr.plantAt : 0.55)) / 0.09);
      tr.piv.scale.setScalar(Math.max(0.0001, k));
      tr.piv.visible = k > 0.001;
    }
    syncTrees();
    // field crossfade (§R wash mode reroutes it at a gentler opacity over the materials)
    if (S.fieldOn && !S.relief) {
      if (flatSketchMode()) {
        // smooth iso field: tiles stay hidden; swap the baked field at the crossover
        setFieldOpacity('baseline', 0); setFieldOpacity('scenario_01', 0);
        const sk = p < 0.5 ? 'baseline' : 'scenario_01';
        if (sk !== _auraStateKey) { _auraStateKey = sk; bakeAura(sk, auraGroundMetric()); auraMesh.visible = true; }
      } else {
        const fop = rWashOn ? R_WASH_OP : FIELD_OP;
        setFieldOpacity('baseline', (1 - smooth((p - 0.5) / 0.35)) * fop);
        setFieldOpacity('scenario_01', smooth((p - 0.55) / 0.35) * fop);
      }
    }
    // §R rendered floor crossfades with the same lever (guards are hoisted vars —
    // this path is inert until rendered mode has been built at least once)
    if (S.rendered && rBuilt) {
      // floor stays up under the heat wash — and now at eye level too (§RW): the walk
      // in rendered aesthetic stands ON the rendered materials
      const showFloor = !rSuspended;
      for (const m of rGround.baseline.mats) m.opacity = 1 - p;
      for (const m of rGround.scenario_01.mats) m.opacity = p;
      rGround.baseline.grp.visible = showFloor && p < 0.999;
      rGround.scenario_01.grp.visible = showFloor && p > 0.001;
    }
    // relief crossfade (mosaics stay dimmed beneath the cloud)
    if (S.relief) {
      reliefVis('baseline', (1 - smooth((p - 0.4) / 0.4)));
      reliefVis('scenario_01', smooth((p - 0.5) / 0.4));
      setFieldOpacity('baseline', (1 - smooth((p - 0.5) / 0.35)) * RELIEF_DIM);
      setFieldOpacity('scenario_01', smooth((p - 0.55) / 0.35) * RELIEF_DIM);
    }
    if (life) life.stateFade(p);
  }
  const FIELD_OP = 0.97;
  let ghostK = 0;  // plan-tilt ghosting (trees -> rings, buildings -> footprints)
  let yieldK = 0;  // canopy yields while a ground surface is selected
  function syncTrees() {
    const aBase = clamp01(1 - smooth((mixP - 0.2) / 0.3));
    // plan view keeps the crowns STANDING so they read from directly above (seen from on
    // top) — no ghost-to-rings fade. Only the surface-select canopy yield still dims them.
    const vis = (1 - 0.75 * yieldK);
    treesA.mat.opacity = aBase * vis;
    treesA.edgeMat.opacity = aBase * vis * 0.5;
    treesA.grp.visible = treesA.mat.opacity > 0.01;
    treesB.mat.opacity = vis;
    treesB.edgeMat.opacity = vis * 0.5;
    treesB.grp.visible = mixP > 0.28 && treesB.mat.opacity > 0.01;
    // §R: the rendered tree materials mirror the sketch material's opacity plumbing
    if (S.rendered && rTreeMatsA.length) {
      for (const m2 of rTreeMatsA) m2.opacity = treesA.mat.opacity;
      for (const m2 of rTreeMatsB) m2.opacity = treesB.mat.opacity;
    }
    // plan-view ghost rings are retired now that the crowns stay visible; the scene-2
    // ringPulse still drives treesA.rings directly for its protection-halo beat.
    treesA.rings.material.opacity = 0; treesA.rings.visible = false;
    treesB.rings.material.opacity = 0; treesB.rings.visible = false;
  }
  function reliefVis(st, k) {
    const R = relief[st], cfg = RELIEF_STYLES[RSTYLE];
    if (R.mesh.visible || R.dots.visible || k > 0.01) {
      if (R.key !== S.metric + '|' + EXAG + '|' + RSTYLE) layoutRelief(st, S.metric); // self-heal stale layouts
    }
    R.mesh.visible = k > 0.01 && !cfg.dots;
    R.dots.visible = k > 0.01 && !!cfg.dots;
    R.dotsEdge.visible = R.dots.visible;
    R.mat.opacity = cfg.op * k;
    R.dotsMat.opacity = cfg.op * k;
    R.edgeMat.opacity = 0.34 * k;
  }
  let mixP = 0; // 0 baseline, 1 scenario
  stateMix(0);

  // ---- tilt (§4: plan is a tilt state of the same camera) -------------------
  // NOTE: the page OPENS in plan — the published-map view — and only stands up
  // into the isometric model at the intervention (scene 3) and beyond.
  function applyTilt(k) {
    S.plan = k;
    const bEl = ISO_EL + (Math.PI / 2 - 0.03 - ISO_EL) * smooth(k);
    cam.el = Math.max(0.14, Math.min(Math.PI / 2 - 0.02, bEl + orb.el));
    cam.az = ISO_AZ + (0.001 - ISO_AZ) * smooth(k) + orb.az;
    applyOrtho();
    ghostK = smooth((k - 0.55) / 0.3);
    syncTrees();
    for (const b of buildings) {
      b.mesh.scale.y = 1 - ghostK * 0.985;
    }
  }
  applyTilt(1); // the page opens in plan — the published map, live

  // ---- scenes ----------------------------------------------------------------
  function labelsPayload() {
    // largest polygon centroid per category, projected to screen
    const out = [];
    const d = D[S.designState === REF ? REF : STATES[1]];
    const biggest = {};
    for (const g of d.grids) {
      if (!biggest[g.cat] || g.n > biggest[g.cat].n) biggest[g.cat] = g;
    }
    for (const c of CATS) {
      const g = biggest[c]; if (!g) continue;
      const v = toWorld(g.cx, g.cy).project(activeCam);
      out.push({ label: CAT_LABEL[c], x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H });
    }
    return out;
  }

  // ---- scenes: seamless target-state transitions -----------------------------
  let leverFired = false;
  function clearSel() {
    selLine.visible = false; hoverEdge.visible = false;
    selFill.visible = false; selEdge.visible = false;
    if (ghostForSelection) { ghostForSelection = false; yieldK = 0; syncTrees(); }
  }
  function maybeLever() {
    if (!leverFired) { leverFired = true; cb.onLeverPresent && cb.onLeverPresent(); }
  }
  // Every scene is a target state; transitions tween each dimension from wherever
  // it currently is, so any scroll direction or speed lands smoothly.
  function transitionTo(n) {
    const tPlan = n <= 2 ? 1 : 0;   // plan is home for scenes 1-3; the model stands up at the intervention
    const tMix = n === 3 ? 1 : 0;
    const tMetric = n === 2 ? 'reduction' : 'load';
    const tField = n >= 1;
    if (S.relief) setRelief(false);
    if (S.metric !== tMetric) { S.metric = tMetric; activeMosaicColors(); }
    cb.onLegend && cb.onLegend(n === 0 ? null : tMetric);
    S.fieldOn = tField;
    if (Math.abs(S.plan - tPlan) > 0.002) {
      const fp = S.plan;
      tween(1150, k => applyTilt(fp + (tPlan - fp) * k));
    }
    if (Math.abs(mixP - tMix) > 0.002) {
      const fm = mixP;
      tween(950, k => { mixP = fm + (tMix - fm) * k; stateMix(mixP); }, easeIO, () => {
        S.designState = tMix === 1 ? 'scenario_01' : 'baseline';
        cb.onStateSettled && cb.onStateSettled(S.designState, 'scene');
      });
    } else {
      const st = tMix === 1 ? 'scenario_01' : 'baseline';
      const other = tMix === 1 ? 'baseline' : 'scenario_01';
      const from = mosaic[st].material.opacity, to = tField ? FIELD_OP : 0;
      if (Math.abs(from - to) > 0.01) tween(550, k => setFieldOpacity(st, from + (to - from) * k));
      setFieldOpacity(other, 0);
    }
  }

  function ringPulse() {
    // shade-makers beat in plan: the canopy rings ARE the protection halo
    after(350, () => {
      const m = treesA.rings.material;
      tween(1250, k => { m.opacity = Math.max(0.12, (0.85 - Math.sin(k * Math.PI) * 0.62)) * Math.max(ghostK, 0.001); }, easeIO, () => syncTrees());
    });
  }

  function igniteScene() {
    // THE SUN TURNS ON — in plan: labeled material plan -> binary -> full ramp + legend
    S.fieldOn = true; S.metric = 'load';
    if (S.relief) setRelief(false);
    if (Math.abs(S.plan - 1) > 0.002) { const fp = S.plan; tween(900, k => applyTilt(fp + (1 - fp) * k)); }
    if (Math.abs(mixP) > 0.002) { const fm = mixP; tween(800, k => { mixP = fm * (1 - k); stateMix(mixP); }); }
    setFieldOpacity('scenario_01', 0);
    after(250, () => {
      recolorMosaic('baseline', { materialPlan: true });
      tween(500, k => setFieldOpacity('baseline', k * 0.92));
      after(520, () => cb.onMaterialLabels && cb.onMaterialLabels(labelsPayload()));
    });
    after(3100, () => {
      cb.onMaterialLabels && cb.onMaterialLabels(null);
      recolorMosaic('baseline', { binary: true });   // categorical before continuous
      mosaic.baseline.position.y = 5;
      tween(700, k => { mosaic.baseline.position.y = 5 * (1 - easeOut(k)); setFieldOpacity('baseline', 0.92); });
    });
    after(5000, () => {
      recolorMosaic('baseline', { metric: 'load' });  // resolves into the full ramp
      setFieldOpacity('baseline', FIELD_OP);
      cb.onLegend && cb.onLegend('load');             // legend slides in
    });
  }

  function interveneScene() {
    // THE INTERVENTION — the map stands up into the model, then the reversible choreography
    S.fieldOn = true;
    if (S.metric !== 'load') { S.metric = 'load'; activeMosaicColors(); }
    cb.onLegend && cb.onLegend('load');
    const fp = S.plan;
    if (Math.abs(fp) > 0.002) tween(1250, k => applyTilt(fp * (1 - k)));
    after(650, () => {
      tween(3400, k => { mixP = k; stateMix(k); }, easeIO, () => {
        S.designState = 'scenario_01';
        cb.onStateSettled && cb.onStateSettled('scenario_01', 'scene');
      });
    });
  }

  // ---- scroll-scrubbed narrative: every change is owned by the scroll position ----
  // Each scene-N transformation runs over the window where card N rises into view,
  // completing exactly when the card reaches its resting position (sy = N).
  const sd = { colorKey: '', labelsOn: false, legend: undefined, settled: 'baseline', leverAt: false };
  function scrollDrive(sy) {
    if (S.phase === 'sandbox' && sy >= 4.95) { setSlab(1); return; } // sandbox: user's controls own the stage
    cancelAll();
    // any relief left over from the sandbox hides hard — narrative never shows it
    if (S.relief || relief.baseline.mesh.visible || relief.baseline.dots.visible || relief.scenario_01.mesh.visible || relief.scenario_01.dots.visible) {
      S.relief = false;
      for (const s2 of STATES) {
        const R = relief[s2];
        R.mesh.visible = R.dots.visible = R.dotsEdge.visible = false;
        R.mat.opacity = R.dotsMat.opacity = R.edgeMat.opacity = 0;
      }
    }
    S.breathe = sy < 0.5;
    // long, overlapping windows: each scene scrubs across most of its scroll band
    // and completes exactly as its card reaches rest (sy = N)
    const ph = (N) => clamp01((sy - (N - 0.85)) / 0.85);
    const p1 = ph(1), p2 = ph(2), p3 = ph(3), p4 = ph(4);
    // tilt: plan (the published map) through scenes 0-2; stands up gently as the intervention begins
    if (S.phase !== 'sandbox') applyTilt(1 - smooth(clamp01(p3 / 0.45)));
    S.fieldOn = p1 > 0.05;
    // metric crossfade in scene 2 (eased both ends), unwinding at the start of scene 3
    const k2 = smooth(p2) * (1 - smooth(clamp01(p3 / 0.3)));
    // scene-1 color merge: material key → measured/unmeasured → full ramp, one continuous slide
    const stage = Math.max(0, Math.min(2, p1 * 2.6 - 0.25));
    let key = 'off', mode = null;
    if (p1 <= 0.02) key = 'off';
    else if (k2 >= 0.999) { key = 'red'; mode = { metric: 'reduction' }; }
    else if (k2 > 0.001) { const q = Math.round(k2 * 40) / 40; key = 'blend' + q; mode = { blend: q }; }
    else if (stage >= 1.995) { key = 'load'; mode = { metric: 'load' }; }
    else { const q = Math.round(stage * 40) / 40; key = 'st' + q; mode = { stage: q }; }
    if (key !== sd.colorKey) {
      sd.colorKey = key;
      if (mode) { recolorMosaic('baseline', mode); recolorMosaic('scenario_01', mode); }
    }
    S.metric = k2 > 0.5 ? 'reduction' : 'load';
    // material labels name the seven ground surfaces — they belong WITH section 1
    // ("seven kinds of ground"), so tie them to section 1 being on screen (card rests
    // at sy=1), not to the early color-merge stage that runs during the title scroll.
    const lab = sy > 0.78 && sy < 1.42;
    if (lab !== sd.labelsOn) { sd.labelsOn = lab; cb.onMaterialLabels && cb.onMaterialLabels(lab ? labelsPayload() : null); }
    // legend arrives with the full ramp and tracks the visible metric
    const leg = stage < 1.9 ? null : (k2 > 0.5 ? 'reduction' : 'load');
    if (leg !== sd.legend) { sd.legend = leg; cb.onLegend && cb.onLegend(leg); }
    // the intervention is scrubbed across nearly the whole band, eased at both ends; scene 4 rewinds it
    const mixT = smooth(clamp01((p3 - 0.15) / 0.85)) * (1 - smooth(p4));
    mixP = mixT; stateMix(mixT);
    const fk = smooth(clamp01((p1 - 0.05) / 0.4));
    // sandbox merge: the tessellated tiles dissolve into the smooth thermal field (the
    // sandbox's solid fill) over the same window the slab grows — so the handoff is
    // seamless, not a snap. sb 0→1 across sy 4.1→4.9.
    const sb = smooth(clamp01((sy - 4.1) / 0.8));
    const tileFade = 1 - sb;
    if (S.fieldOn) {
      setFieldOpacity('baseline', (1 - smooth((mixT - 0.5) / 0.35)) * FIELD_OP * fk * tileFade);
      setFieldOpacity('scenario_01', smooth((mixT - 0.55) / 0.35) * FIELD_OP * fk * tileFade);
    } else { setFieldOpacity('baseline', 0); setFieldOpacity('scenario_01', 0); }
    const settled = mixT > 0.5 ? 'scenario_01' : 'baseline';
    if (settled !== sd.settled) { sd.settled = settled; S.designState = settled; cb.onStateSettled && cb.onStateSettled(settled, 'scroll'); }
    // ...and the smooth thermal field rises in over the same window, so it is already
    // fully present when the sandbox takes over (setPhase('sandbox') just holds it at 1).
    if (sb > 0.02 && !S.rendered && !S.walk && !fw.active && !S.relief) {
      _auraStateKey = settled;
      bakeAura(settled, auraGroundMetric()); // cached by key — cheap once baked
      auraMesh.position.y = ISO_AURA_Y;
      auraMesh.material.opacity = sb;
      auraMesh.visible = true;
    } else if (sb <= 0.02 && S.phase !== 'sandbox') {
      auraMesh.visible = false; // above the merge window the narrative shows the tiles
    }
    if (p4 > 0.96) maybeLever();
    // base slab: appears only past the final card, growing into the sandbox handoff
    setSlab(smooth(clamp01((sy - 4.1) / 0.8)));
  }

  function playScene(n, prev) {
    cancelAll();
    cb.onMaterialLabels && cb.onMaterialLabels(null);
    clearSel();
    S.scene = n;
    S.breathe = (n === 0);
    const fwd = n === prev + 1;
    if (n >= 4) maybeLever();
    if (!RM && n === 1 && fwd) { igniteScene(); return; }
    if (!RM && n === 3 && fwd) { interveneScene(); return; }
    transitionTo(n);
    if (!RM && n === 2 && fwd) ringPulse();
  }

  // ---- design-state lever ----------------------------------------------------
  function setDesignState(target, opts2) {
    const to = target === 'baseline' ? 0 : 1;
    if (Math.abs(mixP - to) < 0.001) return;
    if (fw.active) endFreeWalk();          // free walk ends on state change
    else if (S.walk || walk) endWalk();   // step out first, then watch the world change
    cancelAll();
    const from = mixP;
    const full = !S.firstPullDone && to === 1 && !(opts2 && opts2.condensed);
    const dur = full ? 3400 : 650; // first pull = full choreography; then condensed
    if (to === 1) S.firstPullDone = true;
    if (S.designMode) { stashEditSession(); enterEditSession(target); } // arm the target state's edit session before mixP crosses 0.5
    clearHoverSurf();
    if (S.relief) layoutRelief(target, S.metric); // incoming sheet ready before crossfade
    life.leverStart(); // ambient figures fade out during the lever, respawn on the new state's lanes
    tween(dur, k => { mixP = from + (to - from) * k; stateMix(mixP); }, easeIO, () => {
      S.designState = target;
      life.leverSettled();
      syncClusterViz();
      refreshEditField(target); // re-bake the smooth iso field to the newly shown state's edited data
      cb.onStateSettled && cb.onStateSettled(target, 'lever');
    });
  }

  // ---- peek-at-baseline (§2: press-and-hold compare) -------------------------
  // Instant, no-tween flip of the whole world to the CLEAN simulated baseline
  // (mixP = 0, design edits suppressed, preview field off) while a control is
  // held, then a deterministic snap back on release. Reuses the exact stateMix
  // endpoints the lever tweens between — no second viewport, no scissored render.
  // Edits on the scenario live in treesB (hidden at mixP 0 anyway); edits on the
  // baseline live in treesA, so those are visually reverted for the hold:
  // added trees hidden, deleted originals re-shown, moved trees sent home, and
  // the mosaic recoloured from the clean sim arrays (S.preview off). Everything
  // is restored exactly on release.
  var peeking = false, peekUndo = null; // var: read by metricT/effMetricKey paths that can run before this line executes
  function peekBaseline(on, restoreState) {
    if (on) {
      if (peeking) return;
      peeking = true;
      cancelAll();          // stop any in-flight lever tween so the flip is clean
      const undo = { trees: [], preview: S.preview };
      for (const tr of treesA.trees) {
        if (tr._added) { if (tr.piv.visible) { tr.piv.visible = false; undo.trees.push({ tr, vis: true }); } }
        else if (tr._del && !tr.piv.visible) { tr.piv.visible = true; undo.trees.push({ tr, vis: false }); }
        else if (tr._home && !tr.piv.position.equals(tr._home)) { undo.trees.push({ tr, pos: tr.piv.position.clone() }); tr.piv.position.copy(tr._home); }
      }
      peekUndo = undo;
      S.preview = false;    // metricValue falls back to the clean sim arrays
      clusterThinClear();   // thin ghosts are edit furniture — not part of the reference
      mixP = 0; stateMix(0);
      activeMosaicColors();
      refreshEditField('baseline'); // re-bake the smooth iso field to the clean baseline data (S.preview off)
      syncClusterViz();
    } else {
      if (!peeking) return;
      peeking = false;
      const u = peekUndo; peekUndo = null;
      if (u) {
        for (const it of u.trees) {
          if (it.pos) it.tr.piv.position.copy(it.pos);
          else it.tr.piv.visible = it.vis;
        }
        S.preview = u.preview;
      }
      const r = restoreState === 'scenario_01' ? 1 : 0;
      mixP = r; stateMix(r);
      S.designState = r ? 'scenario_01' : 'baseline';
      activeMosaicColors();
      refreshEditField(S.designState); // restore the edited preview field on release
      syncClusterViz();
    }
  }

  // §2 popup viewport: render the clean simulated baseline at the CURRENT camera
  // into a small JPEG. One hidden frame — peek on (edits suppressed), render,
  // read back, peek off, re-render. Works without preserveDrawingBuffer because
  // the read-back happens immediately after our own render call. Selection/hover/
  // planting overlays are hidden for the shot so the reference reads clean.
  function snapshotBaseline(w) {
    if (peeking) return null;
    const rs = mixP < 0.5 ? 'baseline' : 'scenario_01';
    const hid = [];
    for (const o of [hoverLine, selLine, selFill, selEdge, ghost]) {
      if (o && o.visible) { hid.push(o); o.visible = false; }
    }
    peekBaseline(true, null);
    renderer.render(scene, activeCam);
    const src = renderer.domElement;
    const c = document.createElement('canvas');
    const k = (w || 560) / src.width;
    c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    for (const o of hid) o.visible = true;
    peekBaseline(false, rs);
    renderer.render(scene, activeCam);
    return c.toDataURL('image/jpeg', 0.72);
  }

  // ---- metric flip -------------------------------------------------------------
  // per-tree tint for TREE HEALTH — rewrites each tree's baked vertex colours
  // (the tree material is shared + vertexColors:true, so per-geometry colour wins).
  function treeSetTint(tr, r, g, b) {
    const col = tr.mesh.geometry.getAttribute('color');
    if (!tr._col0) tr._col0 = col.array.slice();
    for (let k = 0; k < col.count; k++) col.setXYZ(k, r, g, b);
    col.needsUpdate = true;
  }
  function treeRestore(tr) {
    const col = tr.mesh.geometry.getAttribute('color');
    if (tr._col0) { col.array.set(tr._col0); col.needsUpdate = true; }
  }
  function recolorTrees() {
    const pending = METRICS.treehealth.status === 'pending' && !S.devTemp;
    for (const T of [treesA, treesB]) for (const tr of T.trees) {
      const x = tr.t.pos[0], y = tr.t.pos[1];
      const v = 120 + 130 * Math.sin(x * 0.18 + y * 0.12); // placeholder stress field
      const c = METRICS.treehealth.ramp(metricT('treehealth', v));
      let r = c[0], g = c[1], b = c[2];
      if (pending) { const k = 0.55; r = r * (1 - k) + 0.60 * k; g = g * (1 - k) + 0.59 * k; b = b * (1 - k) + 0.55 * k; }
      treeSetTint(tr, r, g, b);
    }
  }
  function restoreTrees() { for (const T of [treesA, treesB]) for (const tr of T.trees) treeRestore(tr); }
  // ---- smooth iso heat field (sketch mode): the flat data ground renders as one
  // continuous splat (same bakeAura machinery as the walkthrough) instead of the
  // tessellated mosaic tiles. Active only in the flat sketch view of the sandbox.
  var _auraStateKey = null;
  const ISO_AURA_Y = 0.07;
  function flatSketchMode() { return !S.rendered && !S.walk && !fw.active && S.phase === 'sandbox' && !S.relief; }
  function auraGroundMetric() { const mm = METRICS[S.metric]; return (mm && mm.kind === 'tree') ? 'load' : S.metric; }
  function showIsoField(dimForTrees) {
    setFieldOpacity('baseline', 0); setFieldOpacity('scenario_01', 0); // hide tessellated tiles
    _auraStateKey = S.designState;
    bakeAura(S.designState, auraGroundMetric());
    auraMesh.position.y = ISO_AURA_Y;
    auraMesh.material.opacity = dimForTrees ? 0.34 : 1;
    auraMesh.visible = true;
  }
  function setGroundDim(on) {
    if (rWashOn) {
      // §R wash: the mosaic rides over the materials — dim for tree tabs, R_WASH_OP otherwise
      setFieldOpacity(S.designState, on ? 0.16 : R_WASH_OP);
      setFieldOpacity(S.designState === 'baseline' ? 'scenario_01' : 'baseline', 0);
      return;
    }
    if (flatSketchMode()) { showIsoField(on); return; } // smooth field replaces the tiles
    if (on) { setFieldOpacity('baseline', 0.16); setFieldOpacity('scenario_01', 0.16); }
    else { setFieldOpacity(S.designState, FIELD_OP); setFieldOpacity(S.designState === 'baseline' ? 'scenario_01' : 'baseline', 0); }
  }

  function setMetric(m) {
    if (!METRICS[m]) return;
    S.metric = m;
    const treeMetric = METRICS[m].kind === 'tree';
    if (treeMetric) { recolorTrees(); if (!S.relief) setGroundDim(true); }
    else { restoreTrees(); if (!S.relief) setGroundDim(false); activeMosaicColors(); }
    if (S.relief && !treeMetric) layoutRelief(S.designState, m, 0);
    if (fw.active) { auraMesh.visible && bakeAura(stateKey(), fw.groundMetric()); setFieldOpacity(stateKey(), 0); auraMesh.visible = true; }
    cb.onLegend && cb.onLegend(m);
    cb.onMetricStatus && cb.onMetricStatus(METRICS[m].status);
  }

  function setThreshold(v) {
    S.threshold = v;
    activeMosaicColors();
    // the sandbox iso view (and free-walk) paint the smooth field, not the mosaic tiles —
    // re-bake it so the comfort mute is visible there too.
    if (auraMesh.visible) bakeAura(fw.active ? stateKey() : S.designState, auraGroundMetric());
  }

  // ---- relief toggle -------------------------------------------------------------
  function setRelief(on) {
    S.relief = on;
    const st = S.designState;
    if (on) {
      auraMesh.visible = false; // relief bars own the data view — smooth field steps aside
      layoutRelief(st, S.metric);
      const R = relief[st];
      const fFrom = mosaic[st].material.opacity;
      // condense: settle from a slight rise + fade up; mosaic sleeps beneath
      tween(900, k => {
        const rise = (1 - easeOut(k)) * 5;
        R.mesh.position.y = rise; R.dots.position.y = rise;
        reliefVis(st, k);
        setFieldOpacity(st, fFrom + (RELIEF_DIM - fFrom) * k);
      });
    } else {
      for (const s2 of STATES) {
        const R = relief[s2];
        if (!R.mesh.visible && !R.dots.visible) continue;
        const from = Math.max(R.mat.opacity, R.dotsMat.opacity), fromE = R.edgeMat.opacity;
        tween(500, k => { R.mat.opacity = from * (1 - k); R.dotsMat.opacity = from * (1 - k); R.edgeMat.opacity = fromE * (1 - k); }, easeIO, () => { R.mesh.visible = R.dots.visible = R.dotsEdge.visible = false; });
      }
      if (flatSketchMode()) {
        // relief off in sketch → fade the smooth iso field back in (tiles stay hidden)
        for (const s2 of STATES) setFieldOpacity(s2, 0);
        _auraStateKey = st;
        bakeAura(st, auraGroundMetric());
        auraMesh.position.y = ISO_AURA_Y;
        auraMesh.material.opacity = 0; auraMesh.visible = true;
        const tgt = (METRICS[S.metric] && METRICS[S.metric].kind === 'tree') ? 0.34 : 1;
        tween(500, k => { auraMesh.material.opacity = tgt * k; });
      } else {
        const from = mosaic[st].material.opacity;
        tween(500, k => setFieldOpacity(st, from + (FIELD_OP - from) * k));
      }
    }
  }

  // ---- tilt toggle ---------------------------------------------------------------
  function setPlan(on) {
    const from = S.plan, to = on ? 1 : 0;
    tween(1100, k => applyTilt(from + (to - from) * k));
  }

  // ---- picking --------------------------------------------------------------------
  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  let hoverTree = null;
  function setPointer(ev) {
    const r = canvas.getBoundingClientRect();
    ptr.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ptr.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ptr, activeCam);
  }
  function treeMeshes() {
    return (mixP < 0.5 ? treesA : treesB).trees.filter(t => t.piv.visible).map(t => t.mesh);
  }
  function pickAt(ev) {
    setPointer(ev);
    // trees first
    const th = ray.intersectObjects(treeMeshes(), false);
    if (th.length) {
      const u = th[0].object.userData;
      const stTrees = (mixP < 0.5 ? geo.baseline : geo.scenario_01).trees;
      const count = stTrees.filter(t => t.species === u.species).length;
      const trP = meshToTree(th[0].object), pid = (trP && trP._pid) || null;
      let pidCount = 0;
      if (pid) { const TT = mixP < 0.5 ? treesA : treesB; for (const t2 of TT.trees) if (t2._pid === pid && !t2._del) pidCount++; }
      const existing = !!(trP && !trP._added);
      const cluster = (S.designMode && existing && trP._cluster) || null;
      return { type: 'tree', species: u.species, height: u.height, count, pid, pidCount, existing, cluster, mesh: th[0].object };
    }
    // cluster hulls: tapping inside a hull selects the cluster (design mode only)
    if (S.designMode && clusterViz[stateKey()] && clusterViz[stateKey()].grp.visible) {
      const fh = ray.intersectObjects(clusterViz[stateKey()].fills, false);
      if (fh.length) return { type: 'cluster', id: fh[0].object.userData.clusterId };
    }
    if (S.relief) {
      const st = S.designState, R = relief[st];
      if (R.dots.visible) {
        const dh = ray.intersectObjects([R.dots, R.dotsEdge], false);
        if (dh.length && dh[0].instanceId != null) return { type: 'point', index: dh[0].instanceId, st };
      }
      const rh = ray.intersectObject(R.mesh, false);
      if (rh.length) {
        const px = rh[0].point.x, py = -rh[0].point.z;
        const ri = nearestSensor(st, px, py, 3.2);
        if (ri >= 0) return { type: 'point', index: ri, st };
      }
    }
    // pick the actual clicked polygon, then a sensor OF THAT SURFACE'S CATEGORY
    const ground = mixP < 0.5 ? groundA : groundB;
    const polys = ground.grp.children.filter(m => m.userData && m.userData.cat);
    const ph2 = ray.intersectObjects(polys, false);
    if (ph2.length) {
      const u = ph2[0].object.userData;
      const px = ph2[0].point.x, py = -ph2[0].point.z;
      const st = S.designState;
      const idx = nearestSensor(st, px, py, 3.5, CATS.indexOf(u.cat));
      if (idx < 0) return { type: 'mute' };
      return { type: 'point', index: idx, st, surf: { cat: u.cat, catIdx: u.idx } };
    }
    const gh = ray.intersectObject(pickPlane, false);
    if (gh.length) return { type: 'mute' };
    return null;
  }

  function surfaceCard(st, idx) {
    const d = D[st];
    const g = d.grids[d.gridOf[idx]];
    const other = st === 'baseline' ? 'scenario_01' : 'baseline';
    const catNow = d.agg.catStats[g.cat];
    const catOther = D[other].agg.catStats[g.cat];
    return {
      type: 'surface', st,
      cat: g.cat, label: CAT_LABEL[g.cat],
      grid: g,
      pointLoad: d.load[idx], pointRed: d.red[idx],
      meanLoad: g.meanLoad, meanRed: g.meanRed,
      vsSite: g.meanLoad / d.agg.meanLoad - 1,
      catNow: catNow ? { load: catNow.meanLoad, red: catNow.meanRed } : null,
      catOther: catOther ? { load: catOther.meanLoad, red: catOther.meanRed } : null,
      proposals: CAT_PROPOSALS[g.cat] || []
    };
  }

  let ghostForSelection = false;
  function setCanopyYield(on) {
    // §11: canopy yields to data while a ground surface is selected
    ghostForSelection = on;
    const T = mixP < 0.5 ? treesA : treesB;
    tween(350, k => { const o = on ? 1 - k * 0.75 : 0.25 + k * 0.75; T.mat.opacity = o; T.edgeMat.opacity = o * 0.5; });
  }

  function selectTree(hit) {
    selLine.visible = false;
    if (ghostForSelection) setCanopyYield(false);
    const eg = new THREE.EdgesGeometry(hit.mesh.geometry, 20);
    hoverEdge.geometry.dispose(); hoverEdge.geometry = eg;
    hoverEdge.position.copy(hit.mesh.parent.position).add(hit.mesh.position);
    hoverEdge.visible = true;
    selEdge.geometry.dispose(); selEdge.geometry = new THREE.EdgesGeometry(hit.mesh.geometry, 20);
    selEdge.position.copy(hit.mesh.parent.position).add(hit.mesh.position);
    selEdge.visible = true; selFill.visible = false;
    selMeshRef = hit.mesh;
    cb.onPick && cb.onPick({ type: 'tree', species: hit.species, height: hit.height, count: hit.count, pid: hit.pid || null, pidCount: hit.pidCount || 0, existing: !!hit.existing, cluster: hit.cluster || null, clusterInfo: hit.cluster ? clusterInfo(hit.cluster) : null });
  }

  // Every DOM listener goes through this so dispose() can take them ALL off. Without it
  // a previous site's engine kept listening on the shared canvas: its picks ran against
  // its own (stale) scene and data and still reached the live callbacks, so clicking on
  // Lee could raise a King's Road surface card.
  const _domOff = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); _domOff.push(() => target.removeEventListener(type, fn, opts)); };
  on(canvas, 'pointerdown', ev => {
    if (disposed) return;
    if (S.phase === 'narrative' && S.scene < 2) return; // trees tappable from scene 3 (§2.3)
    if (S.walk || fw.active) {
      if (S.walk === 'free' || fw.active) return; // free walk: taps glide — leave the gesture alone
      // route walkthrough: trees stay inspectable at eye level — same card as the model
      const hitW = pickAt(ev);
      if (hitW && hitW.type === 'tree') selectTree(hitW);
      return;
    }
    const hit = pickAt(ev);
    if (!hit) return;
    if (hit.type === 'tree') {
      // §5 manual thinning: clicks toggle removal inside the armed cluster
      if (S.designMode && clusterManual && clusterManualToggle(hit.mesh)) return;
      selectTree(hit);
      return;
    }
    if (hit.type === 'cluster') {
      setClusterSelected(hit.id);
      clearSelection(); selMeshRef = null;
      cb.onPick && cb.onPick({ type: 'cluster', ...clusterInfo(hit.id) });
      return;
    }
    if (S.phase !== 'sandbox') return;
    hoverEdge.visible = false;
    if (hit.type === 'mute') {
      selLine.visible = false; selFill.visible = false; selEdge.visible = false;
      if (ghostForSelection) setCanopyYield(false);
      cb.onPick && cb.onPick({ type: 'mute' });
      return;
    }
    const card = surfaceCard(hit.st, hit.index);
    const stK = hit.st === 'baseline' ? 'baseline' : 'scenario_01';
    outlineSurface(stK, hit.surf || card.grid);
    fillSurface(stK, hit.surf || card.grid);
    selEdge.visible = false;
    if (!ghostForSelection) setCanopyYield(true);
    cb.onPick && cb.onPick(card);
  });

  // ---- §V orbit + zoom -------------------------------------------------------
  // Armed from the rail so it never steals the scroll-driven narrative or a select
  // click. While armed the handlers sit in CAPTURE phase on the stage wrapper, above
  // the canvas and the design-mode placement overlay alike, and swallow the gesture.
  const orbHost = canvas.parentElement || canvas;
  function setFit(v) {
    const f = Math.max(ORB_LIM.fit[0], Math.min(ORB_LIM.fit[1], v));
    if (f === cam.fit) return;
    cam.fit = f; applyOrtho();
    cb.onViewChange && cb.onViewChange(viewState());
  }
  function viewState() { return { armed: orb.armed, fit: cam.fit, az: orb.az, el: orb.el, moved: !!(orb.az || orb.el) || cam.fit !== 1 }; }
  let orbPtr = null;
  const orbLive = () => orb.armed && !fw.active && !S.walk && S.phase !== 'narrative';
  on(orbHost, 'pointerdown', ev => {
    if (disposed || !orbLive() || ev.button > 1) return;
    if (ev.target !== canvas) return; // chrome (buttons, rail, EXIT) keeps its own clicks
    orbPtr = { x: ev.clientX, y: ev.clientY };
    ev.stopPropagation(); ev.preventDefault();
    canvas.style.cursor = 'grabbing';
    try { orbHost.setPointerCapture(ev.pointerId); } catch (e) {}
  }, true);
  on(window, 'pointermove', ev => {
    if (!orbPtr) return;
    const dx = ev.clientX - orbPtr.x, dy = ev.clientY - orbPtr.y;
    orbPtr.x = ev.clientX; orbPtr.y = ev.clientY;
    orb.az -= dx * 0.0062;
    orb.el = Math.max(ORB_LIM.el[0], Math.min(ORB_LIM.el[1], orb.el - dy * 0.0042));
    applyTilt(S.plan);
    cb.onViewChange && cb.onViewChange(viewState());
  });
  on(window, 'pointerup', () => {
    if (!orbPtr) return;
    orbPtr = null; canvas.style.cursor = orb.armed ? 'grab' : '';
  });
  on(orbHost, 'wheel', ev => {
    if (disposed || !orbLive()) return; // unarmed: the page keeps its scroll
    if (ev.target !== canvas) return;   // let panels and the rail scroll normally
    ev.preventDefault(); ev.stopPropagation();
    setFit(cam.fit * Math.exp(-ev.deltaY * 0.0014));
  }, { capture: true, passive: false });

  on(canvas, 'pointerleave', () => { clearHoverSurf(); setClusterHover(null); if (hoverTree) { hoverTree = null; hoverEdge.visible = false; } cb.onHover && cb.onHover(null); });

  let lastHover = 0;
  on(canvas, 'pointermove', ev => {
    if (disposed) return;
    if (S.walk === 'free' && fwPtr) return; // free walk: dragging to look
    const walkMode = !!S.walk; // walk modes: tree-only hover, no surface hover
    const now = performance.now();
    if (now - lastHover < 60) return;
    lastHover = now;
    if (S.phase === 'narrative' && S.scene < 2) return;
    setPointer(ev);
    const th = ray.intersectObjects(treeMeshes(), false);
    if (th.length) {
      const u = th[0].object.userData;
      canvas.style.cursor = 'pointer';
      setClusterHover(null);
      if (hoverSurf) clearHoverSurf();
      if (hoverTree !== th[0].object) {
        hoverTree = th[0].object;
        const eg = new THREE.EdgesGeometry(hoverTree.geometry, 20);
        hoverEdge.geometry.dispose(); hoverEdge.geometry = eg;
        hoverEdge.position.copy(hoverTree.parent.position).add(hoverTree.position);
        hoverEdge.visible = true;
      }
      cb.onHover && cb.onHover({ species: u.species, x: ev.clientX, y: ev.clientY });
    } else {
      canvas.style.cursor = S.phase === 'sandbox' && !walkMode ? 'crosshair' : 'default';
      if (hoverTree) { hoverTree = null; if (!cb.pinnedTree) hoverEdge.visible = false; }
      // §5 discoverability: hovering inside a dashed hull highlights the grove + names it
      if (S.phase === 'sandbox' && !walkMode && S.designMode) {
        const V = clusterViz[stateKey()];
        if (V && V.grp.visible) {
          const fh = ray.intersectObjects(V.fills, false);
          if (fh.length) {
            const cid = fh[0].object.userData.clusterId;
            setClusterHover(cid);
            if (hoverSurf) clearHoverSurf();
            canvas.style.cursor = 'pointer';
            const inf = clusterInfo(cid);
            cb.onHover && cb.onHover({ species: 'CLUSTER · ' + inf.active + ' TREES — CLICK TO THIN', x: ev.clientX, y: ev.clientY });
            return;
          }
        }
        setClusterHover(null);
      }
      // surface under the cursor: white boundary highlight + name popup (like trees),
      // in BOTH sketch and rendered modes.
      if (S.phase === 'sandbox' && !walkMode) {
        const stKey = mixP < 0.5 ? 'baseline' : 'scenario_01';
        const sketchGround = mixP < 0.5 ? groundA : groundB;
        let polys = sketchGround.grp.children.filter(m => m.userData && m.userData.cat);
        if (S.rendered && rBuilt && rGround[stKey] && rGround[stKey].grp.visible)
          polys = polys.concat(rGround[stKey].grp.children.filter(m => m.userData && m.userData.cat));
        const hh = ray.intersectObjects(polys, false);
        if (hh.length) {
          const o = hh[0].object, cat = o.userData.cat, idx = o.userData.idx;
          // always highlight via the sketch twin (setHoverSurf reads sketch geometry + restores the flat colour)
          const twin = sketchGround.grp.children.find(m => m.userData && m.userData.cat === cat && m.userData.idx === idx) || o;
          setHoverSurf(twin, stKey);
          canvas.style.cursor = 'pointer';
          cb.onHover && cb.onHover({ species: CAT_LABEL[cat] || cat, x: ev.clientX, y: ev.clientY });
        } else {
          clearHoverSurf();
          cb.onHover && cb.onHover(null);
        }
      } else {
        if (hoverSurf) clearHoverSurf();
        cb.onHover && cb.onHover(null);
      }
    }
  });

  // design-mode hover/select driven from the placement overlay (which otherwise swallows
  // canvas hover). Mirrors the canvas pointermove/pointerdown design behaviour: an existing
  // tree reads as a tree, the gaps inside a grove hull read as a CLUSTER — so the cluster
  // highlight + name survive even while a planting tool is armed.
  function designHoverAt(clientX, clientY) {
    if (!S.designMode) return { over: null };
    setPointer({ clientX, clientY });
    const th = ray.intersectObjects(treeMeshes(), false);
    if (th.length) {
      const u = th[0].object.userData;
      setClusterHover(null);
      if (hoverSurf) clearHoverSurf();
      if (hoverTree !== th[0].object) {
        hoverTree = th[0].object;
        const eg = new THREE.EdgesGeometry(hoverTree.geometry, 20);
        hoverEdge.geometry.dispose(); hoverEdge.geometry = eg;
        hoverEdge.position.copy(hoverTree.parent.position).add(hoverTree.position);
        hoverEdge.visible = true;
      }
      cb.onHover && cb.onHover({ species: u.species, x: clientX, y: clientY });
      return { over: 'tree' };
    }
    if (hoverTree) { hoverTree = null; if (!cb.pinnedTree) hoverEdge.visible = false; }
    const V = clusterViz[stateKey()];
    if (V && V.grp.visible) {
      const fh = ray.intersectObjects(V.fills, false);
      if (fh.length) {
        const cid = fh[0].object.userData.clusterId;
        setClusterHover(cid);
        if (hoverSurf) clearHoverSurf();
        const inf = clusterInfo(cid);
        cb.onHover && cb.onHover({ species: 'CLUSTER · ' + inf.active + ' TREES — CLICK TO THIN', x: clientX, y: clientY });
        return { over: 'cluster' };
      }
    }
    setClusterHover(null);
    cb.onHover && cb.onHover(null);
    return { over: null };
  }
  function selectAt(clientX, clientY) {
    const hit = pickAt({ clientX, clientY });
    if (!hit) return null;
    if (hit.type === 'tree') {
      if (S.designMode && clusterManual && clusterManualToggle(hit.mesh)) return 'tree';
      selectTree(hit); return 'tree';
    }
    if (hit.type === 'cluster') {
      setClusterSelected(hit.id); clearSelection(); selMeshRef = null;
      cb.onPick && cb.onPick({ type: 'cluster', ...clusterInfo(hit.id) });
      return 'cluster';
    }
    return null;
  }

  function clearSelection() {
    selLine.visible = false; hoverEdge.visible = false;
    selFill.visible = false; selEdge.visible = false;
    clearHoverSurf();
    if (ghostForSelection) setCanopyYield(false);
  }

  // §5/§planting UX: existing trees stay reachable while a placer is armed — the DC's
  // placement catcher sits above the canvas, so it asks the engine to try a tree pick
  // first and only plants when nothing stands under the cursor.
  function selectTreeAt(clientX, clientY) {
    const hit = pickAt({ clientX, clientY });
    if (!hit || hit.type !== 'tree') return false;
    if (S.designMode && clusterManual && clusterManualToggle(hit.mesh)) return true;
    selectTree(hit);
    return true;
  }
  function treeAt(clientX, clientY) {
    setPointer({ clientX, clientY });
    const th = ray.intersectObjects(treeMeshes(), false);
    return th.length ? th[0].object.userData.species : null;
  }

  // ---- walkthrough (§10, locked: on-rails, data-lit ground) ---------------------
  // state-aware routes — verified ≥2 m clear of all building footprints per state
  const ROUTES = site.routes;
  const routeName = (id) => ROUTES[id].name[S.designState] || ROUTES[id].name.baseline;
  let walk = null;
  function routeCurve(id) {
    const raw = ROUTES[id].pts[S.designState] || ROUTES[id].pts.baseline;
    const pts = raw.map(p => new THREE.Vector3(p[0], 1.7, -p[1]));
    return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.3);
  }
  // route preview: a highlighted path drawn on the map when a WALK option is hovered.
  // white casing under accent dashes keeps it legible over the warm data ground.
  const routePreview = (() => {
    const Y = 1.2; // float just above the ground so it reads over the data
    const matCase = LS2
      ? new LM({ color: 0xffffff, linewidth: 6.5, transparent: true, opacity: 0.95, worldUnits: false, depthTest: false })
      : new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false });
    const matLine = LS2
      ? new LM({ color: 0xe2452d, linewidth: 3.4, transparent: true, opacity: 1, worldUnits: false, depthTest: false, dashed: true, dashSize: 2.8, gapSize: 1.9, dashScale: 1 })
      : new THREE.LineDashedMaterial({ color: 0xe2452d, transparent: true, opacity: 1, depthTest: false, dashSize: 2.8, gapSize: 1.9 });
    if (LS2) { matCase.resolution.set(W, H); matLine.resolution.set(W, H); fatMats.push(matCase, matLine); }
    const backMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide });
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xe2452d, transparent: true, opacity: 1, depthTest: false, side: THREE.DoubleSide });
    const disc = (r) => { const g = new THREE.CircleGeometry(r, 24); g.rotateX(-Math.PI / 2); return g; };
    const startBack = new THREE.Mesh(disc(2.7), backMat), startDot = new THREE.Mesh(disc(1.7), dotMat);
    const endBack = new THREE.Mesh(disc(3.5), backMat), endRingG = new THREE.RingGeometry(2.0, 3.0, 28); endRingG.rotateX(-Math.PI / 2);
    const endDot = new THREE.Mesh(endRingG, dotMat);
    const dots = [[startBack, 22], [startDot, 23], [endBack, 22], [endDot, 23]];
    for (const [m, ro] of dots) { m.renderOrder = ro; m.visible = false; scene.add(m); }
    let caseMesh = null, lineMesh = null;
    const mk = (pos, mat, ro) => {
      let o;
      if (LS2) { const g = new LSG(); g.setPositions(pos); o = new LS2(g, mat); }
      else { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); o = new THREE.LineSegments(g, mat); }
      o.computeLineDistances && o.computeLineDistances();
      o.renderOrder = ro; scene.add(o); return o;
    };
    function show(id) {
      if (!id || !ROUTES[id]) return hide();
      const curve = routeCurve(id), n = 130, pos = [];
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const pt = curve.getPointAt(i / n);
        if (prev) pos.push(prev.x, Y, prev.z, pt.x, Y, pt.z);
        prev = pt;
      }
      if (caseMesh) { scene.remove(caseMesh); caseMesh.geometry.dispose(); }
      if (lineMesh) { scene.remove(lineMesh); lineMesh.geometry.dispose(); }
      caseMesh = mk(pos, matCase, 20);
      lineMesh = mk(pos, matLine, 21);
      const s = curve.getPointAt(0), e = curve.getPointAt(1);
      startBack.position.set(s.x, Y, s.z); startDot.position.set(s.x, Y, s.z);
      endBack.position.set(e.x, Y, e.z); endDot.position.set(e.x, Y, e.z);
      for (const [m] of dots) m.visible = true;
    }
    function hide() {
      if (caseMesh) caseMesh.visible = false;
      if (lineMesh) lineMesh.visible = false;
      for (const [m] of dots) m.visible = false;
    }
    return {
      show(id) {
        if (!id || !ROUTES[id]) { hide(); return; }
        show(id);
        if (caseMesh) caseMesh.visible = true;
        if (lineMesh) lineMesh.visible = true;
      },
      hide
    };
  })();
  // walk modes: hide the ground FILLS but keep the seam ink — the ground-material
  // boundaries stay readable at eye level, drawn over the smooth aura. Seams float
  // at y≈0.12, above the aura plane (y 0.07), so they depth-win cleanly.
  // ---- Monument-Valley walk style (walk modes ONLY — the iso model is untouched) --
  // Cohesive stylized eye level: pastel-lifted palette, flat face-orientation building
  // tones, no ink outlines (materials read by texture instead), soft canopy shadows,
  // gentle distance haze. Everything reverses exactly on walk exit.
  var MVON = false;
  const MV_SUNW = [0.81, 0, 0.58]; // horizontal sun axis — matches the sky sun sprite (az 0.95)
  const MVB = { roof: [0.965, 0.945, 0.905], lit: [0.96, 0.885, 0.775], side: [0.918, 0.895, 0.868], shade: [0.788, 0.804, 0.855] };
  // ---- prop/figure MV recolor: one base hue, flat face-orientation shades (people,
  // benches, lamps, bins, cars, cyclists) so the small objects share the cut-paper
  // language instead of their per-object gouache tones. Driven by a single base color.
  function mvShadesFrom(col) {
    const r = col.r, g = col.g, b = col.b;
    const lerp = (f) => [r + (1 - r) * f, g + (1 - g) * f, b + (1 - b) * f];
    return { top: lerp(0.46), lit: lerp(0.24), side: [r, g, b], shade: [r * 0.68, g * 0.68, b * 0.68] };
  }
  let mvPropHex = (opts.params && opts.params.walkPropHue) || '#c46b4a';
  let MV_PROP_SHADES = mvShadesFrom(new THREE.Color(mvPropHex));
  const mvTreeOrig = new Map(); // geometry -> original vertex-color array (clones share geometry)
  const mvShadowDiscs = [];
  const mvShadowGeo = (() => { const g = new THREE.CircleGeometry(1, 18); g.rotateX(-Math.PI / 2); return g; })();
  const mvShadowMat = new THREE.MeshBasicMaterial({ color: 0x2c3038, transparent: true, opacity: 0.14, depthWrite: false });
  function mvEnsureShadows() { // soft blob under every canopy — parented to the pivot so it plants/sways/hides with its tree
    for (const T of [treesA, treesB]) for (const piv of T.grp.children) {
      if (!piv.isGroup || piv._mvShadow) continue;
      let r = 2.2;
      for (const c of piv.children) if (c.isMesh && c.userData && c.userData.radius) r = c.userData.radius;
      const d = new THREE.Mesh(mvShadowGeo, mvShadowMat);
      d.scale.set(r * 0.95, 1, r * 0.95); d.position.y = 0.1; d.renderOrder = 3; d.visible = false;
      piv.add(d); piv._mvShadow = d;
      mvShadowDiscs.push(d);
    }
  }
  function mvTrees(on) {
    for (const T of [treesA, treesB]) for (const piv of T.grp.children) {
      if (!piv.isGroup) continue;
      for (const c of piv.children) {
        if (c === piv._mvShadow) continue;
        if (c.isLineSegments2 || c.isLine) { c.visible = !on; continue; } // ink edges off (NB LineSegments2.isMesh is true)
        if (c.isMesh && c.geometry.getAttribute('color')) {
          const g = c.geometry, col = g.getAttribute('color'), a = col.array;
          if (on) {
            if (mvTreeOrig.has(g)) continue; // shared clone geometry — already lifted
            mvTreeOrig.set(g, a.slice());
            for (let i = 0; i < a.length; i++) a[i] = a[i] + (1 - a[i]) * 0.16; // gentle pastel lift, facets + species tone kept
            col.needsUpdate = true;
          } else if (mvTreeOrig.has(g)) {
            a.set(mvTreeOrig.get(g)); mvTreeOrig.delete(g); col.needsUpdate = true;
          }
        }
      }
    }
  }
  function mvBuildings(on) {
    for (const b of buildings) {
      for (const o of b.mesh.children) {
        if (o.isLineSegments2 || o.isLine) { o.visible = !on; continue; }
        if (!o.isMesh) continue;
        const col = o.geometry.getAttribute('color');
        if (col) {
          // lit mesh (vertex colors, all white in iso): flat MV face-orientation tones —
          // roofs near-white, sun-axis walls warm cream, cross walls cool. Restore = white.
          const pos = o.geometry.getAttribute('position'), pa = pos.array, ca = col.array;
          if (on) {
            if (o._mvMaxY == null) { let my = 0.01; for (let v = 0; v < pos.count; v++) my = Math.max(my, pa[v * 3 + 1]); o._mvMaxY = my; }
            for (let v = 0; v < pos.count; v += 3) {
              const i = v * 3;
              const ux = pa[i + 3] - pa[i], uy = pa[i + 4] - pa[i + 1], uz = pa[i + 5] - pa[i + 2];
              const wx = pa[i + 6] - pa[i], wy = pa[i + 7] - pa[i + 1], wz = pa[i + 8] - pa[i + 2];
              let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
              const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
              const dd = Math.abs(nx * MV_SUNW[0] + nz * MV_SUNW[2]);
              const t = Math.abs(ny) > 0.6 ? MVB.roof : (dd > 0.5 ? MVB.lit : MVB.side);
              for (let k2 = 0; k2 < 3; k2++) { // MV vertical gradient: darker base, lighter top
                const gk = 0.88 + 0.16 * (pa[i + k2 * 3 + 1] / o._mvMaxY);
                ca[i + k2 * 3] = Math.min(1, t[0] * gk); ca[i + k2 * 3 + 1] = Math.min(1, t[1] * gk); ca[i + k2 * 3 + 2] = Math.min(1, t[2] * gk);
              }
            }
          } else ca.fill(1);
          col.needsUpdate = true;
        } else {
          // hatched shade mesh → cool pastel with the same vertical gradient (vertex-colored)
          const m = o.material, g2 = o.geometry;
          if (on) {
            if (m.map) { o._mvMap = m.map; m.map = null; }
            if (!g2.getAttribute('color')) {
              const p2 = g2.getAttribute('position'), n2 = p2.count, arr = new Float32Array(n2 * 3);
              let my = 0.01; for (let v = 0; v < n2; v++) my = Math.max(my, p2.array[v * 3 + 1]);
              for (let v = 0; v < n2; v++) {
                const gk = 0.86 + 0.20 * (p2.array[v * 3 + 1] / my);
                arr[v * 3] = Math.min(1, MVB.shade[0] * gk); arr[v * 3 + 1] = Math.min(1, MVB.shade[1] * gk); arr[v * 3 + 2] = Math.min(1, MVB.shade[2] * gk);
              }
              g2.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
            }
            m.color.setHex(0xffffff); m.vertexColors = true;
          } else {
            if (o._mvMap) { m.map = o._mvMap; o._mvMap = null; }
            m.vertexColors = false; m.color.setHex(0xffffff);
          }
          m.needsUpdate = true;
        }
      }
    }
  }
  function walkStyle(on) {
    if (MVON === on) return;
    MVON = on;
    mvTrees(on); mvBuildings(on);
    if (life && life.mvStyle) life.mvStyle(on, MV_PROP_SHADES);
    mvEnsureShadows();
    for (const d of mvShadowDiscs) d.visible = on;
    scene.fog = on ? new THREE.Fog(0xd8e6f2, 85, 470) : null; // pastel distance haze (sky mats opt out)
    if (life) life.stateFade(mixP); // re-apply prop edge opacities under the MV factor
  }
  // ---- walkthrough curb geometry: real 3D concrete curbs along road edges that meet
  // a DIFFERENT material (road–road joints get none). Built per state, shown only in
  // walk modes (the iso/rendered views have their own baked curbs).
  const walkCurbG = {};
  const walkCurbRoot = new THREE.Group(); walkCurbRoot.visible = false; scene.add(walkCurbRoot);
  function buildWalkCurbs(st) {
    if (walkCurbG[st]) return walkCurbG[st];
    const stGeo = st === 'baseline' ? geo.baseline : geo.scenario_01;
    const roadSurfs = surfacesWhere(stGeo, isRoadCat);
    const inLoop = (loop, x, y) => { let inside = false; for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) { const xi = loop[i][0], yi = loop[i][1], xj = loop[j][0], yj = loop[j][1]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside; } return inside; };
    const inRoad = (x, y) => { for (const s of roadSurfs) { if (inLoop(s.outer, x, y)) { let ih = false; for (const h of (s.holes || [])) if (inLoop(h, x, y)) { ih = true; break; } if (!ih) return true; } } return false; };
    // any measured ground under the point (any category) → on-site; nothing → off-site edge
    const allSurfs = [];
    for (const c of CATS) for (const s of (stGeo.surfaces[c] || [])) allSurfs.push(s);
    const onSite = (x, y) => { for (const s of allSurfs) { if (inLoop(s.outer, x, y)) { let ih = false; for (const h of (s.holes || [])) if (inLoop(h, x, y)) { ih = true; break; } if (!ih) return true; } } return false; };
    const segs = [];
    for (const surf of roadSurfs) {
      for (const loop of [surf.outer].concat(surf.holes || [])) {
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i], b = loop[(i + 1) % loop.length];
          const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
          if (L < 0.05) continue;
          const nx = -dy / L, ny = dx / L, e = 0.3;
          let internal = true, neighboured = true;
          for (const t of [0.25, 0.5, 0.75]) {
            const px = a[0] + dx * t, py = a[1] + dy * t;
            const sPlus = { x: px + nx * e, y: py + ny * e }, sMinus = { x: px - nx * e, y: py - ny * e };
            const rPlus = inRoad(sPlus.x, sPlus.y), rMinus = inRoad(sMinus.x, sMinus.y);
            if (!(rPlus && rMinus)) internal = false;
            // the non-road side of this station — must be on some other material, else site edge
            const out = rPlus ? sMinus : sPlus;
            if (!(rPlus && rMinus) && !onSite(out.x, out.y)) neighboured = false;
          }
          if (internal) continue;      // road–road joint: no curb
          if (!neighboured) continue;  // road meets the site boundary (off-site): no curb
          segs.push([a[0], a[1], b[0], b[1], L]);
        }
      }
    }
    const grp = new THREE.Group();
    if (segs.length) {
      const CW = 0.12, CH = 0.15; // ~0.1 m thick, standard curb height
      const cgeo = new THREE.BoxGeometry(1, 1, 1); cgeo.translate(0, 0.5, 0);
      // face tones = the walk PROP palette (lampposts / benches / bins) so curbs share
      // the same cut-paper object colour: lit top, side face, darker base.
      const PS = MV_PROP_SHADES;
      const col = (a) => new THREE.MeshBasicMaterial({ color: new THREE.Color(a[0], a[1], a[2]) });
      const paper = col(PS.top), mid = col(PS.side), shade = col(PS.shade);
      const faceMats = [mid, mid, paper, shade, mid, mid]; // +x,-x,+y(top),-y,+z,-z
      const inst = new THREE.InstancedMesh(cgeo, faceMats, segs.length);
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), P = new THREE.Vector3(), Sc = new THREE.Vector3();
      segs.forEach((sg, i) => {
        const mx = (sg[0] + sg[2]) / 2, my = (sg[1] + sg[3]) / 2;
        E.set(0, Math.atan2(sg[3] - sg[1], sg[2] - sg[0]), 0); Q.setFromEuler(E);
        P.set(mx, 0.02, -my); Sc.set(sg[4] + CW, CH, CW);
        M.compose(P, Q, Sc); inst.setMatrixAt(i, M);
      });
      inst.frustumCulled = false; inst.renderOrder = 3;
      grp.add(inst);
    }
    grp.visible = false; walkCurbRoot.add(grp); walkCurbG[st] = grp; return grp;
  }
  // §RW curbs: cut-paper faces in the sketch walk, a lit concrete material once the
  // rendered aesthetic carries the walkthrough.
  let curbRMat = null;
  function curbRendered(on) {
    for (const k in walkCurbG) {
      for (const ch of walkCurbG[k].children) {
        if (!ch.isInstancedMesh) continue;
        if (on) {
          if (!ch._sketchMat) ch._sketchMat = ch.material;
          if (!curbRMat) curbRMat = new THREE.MeshStandardMaterial({ color: 0xc9c4b8, roughness: 0.94, metalness: 0 });
          ch.material = curbRMat;
          ch.castShadow = false; ch.receiveShadow = false;
        } else if (ch._sketchMat) {
          ch.material = ch._sketchMat;
        }
      }
    }
  }
  function showWalkCurbs(on) {
    walkCurbRoot.visible = !!on;
    if (on) { const st = stateKey(); buildWalkCurbs(st); for (const k in walkCurbG) walkCurbG[k].visible = (k === st); curbRendered(!!S.rendered); }
  }
  function groundWalkMode(on) {
    // §RW: a rendered walkthrough keeps the rendered picture — no cut-paper walk
    // palette, no sketch prop shades. The sketch walk is unchanged.
    const rw = on && !!S.rendered;
    if (on) syncRendered();  // stand the aesthetic up (or down) BEFORE walkStyle stashes colours
    walkStyle(rw ? false : on);
    syncClusterViz(); // hulls are a plan-view affordance — never at eye level
    if (!on) syncRendered(); // §R: back from walk — re-apply rendered treatments
    if (on) {
      const cur = stateKey() === 'baseline' ? groundA : groundB;
      const oth = cur === groundA ? groundB : groundA;
      oth.grp.visible = false;
      cur.grp.visible = true;
      // hide the ground FILLS and the OLD material-boundary seam ink — the recent seam
      // line (floats at y≈0.15) and the baked AO seam-shadows carry the boundaries now.
      // Hard-hide via .visible: the state crossfade re-sets seam material.opacity every
      // frame, so opacity=0 alone leaks the ink back as a bright hairline at eye level.
      for (const ch of cur.grp.children) ch.visible = false;
      grass3D.show(stateKey());
      showWalkCurbs(true);
    } else {
      for (const G of [groundA, groundB]) { G.grp.visible = true; for (const ch of G.grp.children) ch.visible = true; }
      grass3D.hide();
      showWalkCurbs(false);
      stateMix(mixP); // resync fill/seam opacities to the resting state
    }
  }
  function startWalk(id) {
    routePreview.hide();
    if (S.relief) setRelief(false); // walkthrough always on the flat data-lit ground
    clearSelection();
    const curve = routeCurve(id);
    const len = curve.getLength();
    // profile: nearest-sensor sample every metre — ONE lookup drives HUD + chart
    const N = Math.max(40, Math.round(len));
    const mkProfile = (st) => {
      const arr = [];
      for (let i = 0; i <= N; i++) {
        const p = curve.getPointAt(i / N);
        const idx = nearestSensor(st, p.x, -p.z, 3.2);
        arr.push(idx);
      }
      return arr;
    };
    walk = {
      id, curve, len, t: 0, speed: 2, playing: !RM,
      profiles: { baseline: mkProfile('baseline'), scenario_01: mkProfile('scenario_01') }
    };
    S.walk = id;
    activeCam = persp;
    // smooth aura ground instead of the flashing tessellated tiles at eye level
    bakeAura(stateKey(), fw.groundMetric());
    setFieldOpacity(stateKey(), 0);
    mosaic.baseline.visible = false; mosaic.scenario_01.visible = false;
    groundWalkMode(true);
    auraMesh.visible = !(S.rendered && !S.showData); // §RW rendered walk: materials, not the data plane
    sky.visible = true;
    walkFrame(0, true);
    cb.onWalkStart && cb.onWalkStart({ id, name: routeName(id), len: Math.round(len), samples: N });
  }
  function walkFrame(t, force) {
    if (!walk) return;
    walk.t = clamp01(t);
    const p = walk.curve.getPointAt(walk.t);
    const ahead = walk.curve.getPointAt(Math.min(1, walk.t + 0.03));
    persp.position.copy(p);
    persp.lookAt(ahead.x, 1.55, ahead.z);
    grass3D.follow(p.x, -p.z); // §RW near-field turf follows the route camera
    const st = mixP < 0.5 ? 'baseline' : 'scenario_01';
    const i = Math.round(walk.t * (walk.profiles[st].length - 1));
    const idx = walk.profiles[st][i];
    if (cb.onWalkTick) {
      const d = D[st];
      cb.onWalkTick({
        t: walk.t, i,
        load: idx >= 0 ? d.load[idx] : null,
        red: idx >= 0 ? d.red[idx] : null,
        color: idx >= 0 ? METRICS[S.metric === 'reduction' ? 'reduction' : 'load'].ramp(metricT(S.metric === 'reduction' ? 'reduction' : 'load', S.metric === 'reduction' ? d.red[idx] : d.load[idx])) : MUTE,
        playing: walk.playing, done: walk.t >= 1
      });
    }
  }
  function walkProfileValues() {
    if (!walk) return null;
    const st = mixP < 0.5 ? 'baseline' : 'scenario_01';
    const d = D[st];
    const m = S.metric === 'reduction' ? 'reduction' : 'load';
    return walk.profiles[st].map(idx => {
      if (idx < 0) return null;
      const v = m === 'reduction' ? d.red[idx] : d.load[idx];
      return { v, t: metricT(m, v), c: METRICS[m].ramp(metricT(m, v)) };
    });
  }
  function endWalk() {
    walk = null; S.walk = null;
    auraMesh.visible = false;
    sky.visible = false;
    mosaic.baseline.visible = true; mosaic.scenario_01.visible = true;
    groundWalkMode(false);
    activeCam = ortho;
    applyOrtho();
    setMetric(S.metric); // restore the data-lit ground field for the current metric
    cb.onWalkEnd && cb.onWalkEnd();
  }

  // ---- FREE-WALK: first-person roam (sibling of guided routes) ----------------------
  const SITE = { x0: SITE_B[0], y0: SITE_B[1], x1: SITE_B[2], y1: SITE_B[3] };  const SITE_W = SITE.x1 - SITE.x0, SITE_H = SITE.y1 - SITE.y0;
  const WALK_R = 0.35;
  const stateKey = () => (mixP < 0.5 ? 'baseline' : 'scenario_01');
  const stateColliders = () => {
    const st = stateKey();
    return (st === 'baseline' ? buildings : buildings.filter(b => b.shared)).map(b => b.bbox);
  };
  function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }

  // aura-paint ground: baked colour field per (state, metric), draped on one plane
  const AURA_CW = 660, AURA_CH = Math.round(AURA_CW * SITE_H / SITE_W);
  const auraCanvas = document.createElement('canvas'); auraCanvas.width = AURA_CW; auraCanvas.height = AURA_CH;
  const auraCtx = auraCanvas.getContext('2d');
  const auraTex = new THREE.CanvasTexture(auraCanvas);
  // bumped whenever the design edit recomputes the field, so the smooth iso aura
  // (which caches by state/metric) is forced to re-bake and reflect planted/removed trees.
  var auraEditV = 0;
  auraTex.minFilter = THREE.LinearFilter; auraTex.magFilter = THREE.LinearFilter; auraTex.generateMipmaps = false;
  // display canvas: 3× upscale of the data splat so eye-level material texture
  // (grass blades, aggregate speckle, joints) has real resolution to live in
  const TEXS = 3;
  const texCanvas = document.createElement('canvas'); texCanvas.width = AURA_CW * TEXS; texCanvas.height = AURA_CH * TEXS;
  const texCtx = texCanvas.getContext('2d');
  // scratch canvas for grayscale texture marks — composited onto texCanvas in
  // 'overlay' so texture is VALUE-ONLY: the data hue never shifts, marks just
  // darken/lighten it (painterly tonal grain, per user's reference)
  const texMark = document.createElement('canvas'); texMark.width = texCanvas.width; texMark.height = texCanvas.height;
  const texMarkCtx = texMark.getContext('2d');
  auraTex.image = texCanvas;
  const auraGeo = new THREE.PlaneGeometry(SITE_W, SITE_H); auraGeo.rotateX(-Math.PI / 2);
  const auraMesh = new THREE.Mesh(auraGeo, new THREE.MeshBasicMaterial({ map: auraTex, transparent: true, depthWrite: false }));
  auraMesh.position.set((SITE.x0 + SITE.x1) / 2, 0.07, -(SITE.y0 + SITE.y1) / 2); auraMesh.renderOrder = 2; auraMesh.visible = false;
  scene.add(auraMesh);

  // ---- eye-level sky (walk modes only): collage cut-paper sky — blue gradient dome,
  // warm sun disc with soft halo, flat paper clouds. Never visible in the iso model.
  const sky = new THREE.Group(); sky.visible = false; sky.position.copy(CTR); scene.add(sky);
  {
    const skc = document.createElement('canvas'); skc.width = 4; skc.height = 512;
    const sg = skc.getContext('2d');
    const gr = sg.createLinearGradient(0, 0, 0, 512);
    gr.addColorStop(0.00, '#82b8e0'); gr.addColorStop(0.30, '#a9cfeb');
    gr.addColorStop(0.46, '#d3e7f3'); gr.addColorStop(0.52, '#f3f2ea');
    gr.addColorStop(0.60, '#ffffff'); gr.addColorStop(1.00, '#ffffff');
    sg.fillStyle = gr; sg.fillRect(0, 0, 4, 512);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(620, 32, 24),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(skc), side: THREE.BackSide, depthWrite: false, fog: false }));
    dome.renderOrder = -10;
    dome.name = 'skydome';
    sky.add(dome);
    // sun: warm disc + soft halo on one sprite
    const sunC = document.createElement('canvas'); sunC.width = sunC.height = 256;
    const sc2 = sunC.getContext('2d');
    const rg = sc2.createRadialGradient(128, 128, 0, 128, 128, 128);
    rg.addColorStop(0.00, 'rgba(255,245,208,0.95)'); rg.addColorStop(0.18, 'rgba(255,241,198,0.85)');
    rg.addColorStop(0.45, 'rgba(255,244,210,0.28)'); rg.addColorStop(1.00, 'rgba(255,246,215,0)');
    sc2.fillStyle = rg; sc2.fillRect(0, 0, 256, 256);
    const sun = new THREE.Mesh(new THREE.PlaneGeometry(170, 170),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sunC), transparent: true, depthWrite: false, fog: false }));
    const sunAz = 0.95, sunEl = 0.60, sunR = 555;
    sun.position.set(Math.sin(sunAz) * Math.cos(sunEl) * sunR, Math.sin(sunEl) * sunR, Math.cos(sunAz) * Math.cos(sunEl) * sunR);
    sun.renderOrder = -9;
    sun.name = 'skysun';
    sky.add(sun);
    // clouds: wispy — layered soft radial gradients (no hard edges), feathering into
    // the sky. Cumulus bodies low, thin cirrus streaks high.
    const cloudBlob = (x2, cx, cy, rx, ry, a, tint) => {
      x2.save(); x2.translate(cx, cy); x2.scale(rx / 100, ry / 100);
      const g = x2.createRadialGradient(0, 0, 0, 0, 0, 100);
      g.addColorStop(0.00, 'rgba(' + tint + ',' + a + ')');
      g.addColorStop(0.55, 'rgba(' + tint + ',' + (a * 0.42).toFixed(3) + ')');
      g.addColorStop(1.00, 'rgba(' + tint + ',0)');
      x2.fillStyle = g; x2.fillRect(-100, -100, 200, 200); x2.restore();
    };
    const WHT = '255,255,255', UND = '211,220,229'; // body / cool shadowed underside
    const mkCloudTex = (seed) => {
      const c = document.createElement('canvas'); c.width = 512; c.height = 256;
      const x2 = c.getContext('2d');
      let s2 = seed; const rr = () => (s2 = (s2 * 16807) % 2147483647) / 2147483647;
      const cy = 120 + rr() * 26, n = 7 + Math.floor(rr() * 5);
      for (let i = 0; i < n; i++) {
        const px = 95 + (i / (n - 1)) * 320 + (rr() - 0.5) * 55;
        const py = cy - rr() * 36 + (rr() - 0.5) * 12;
        cloudBlob(x2, px, py + 18, 62 + rr() * 52, 20 + rr() * 12, 0.13 + rr() * 0.09, UND);
        cloudBlob(x2, px, py, 56 + rr() * 58, 26 + rr() * 20, 0.22 + rr() * 0.16, WHT);
      }
      for (let i = 0; i < 6; i++) // trailing wisps feathering off the mass
        cloudBlob(x2, 70 + rr() * 380, cy + (rr() - 0.5) * 76, 95 + rr() * 95, 6 + rr() * 8, 0.10 + rr() * 0.09, WHT);
      const t = new THREE.CanvasTexture(c); return t;
    };
    const mkCirrusTex = (seed) => {
      const c = document.createElement('canvas'); c.width = 512; c.height = 128;
      const x2 = c.getContext('2d');
      let s2 = seed; const rr = () => (s2 = (s2 * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 5; i++)
        cloudBlob(x2, 90 + rr() * 340, 40 + rr() * 50, 130 + rr() * 110, 4 + rr() * 6, 0.11 + rr() * 0.10, WHT);
      const t = new THREE.CanvasTexture(c); return t;
    };
    for (let i = 0; i < 12; i++) {
      const w = 150 + (i % 4) * 75;
      const cl = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.5),
        new THREE.MeshBasicMaterial({ map: mkCloudTex(11 + i * 97), transparent: true, depthWrite: false, opacity: 0.9, fog: false }));
      const az = (i / 12) * Math.PI * 2 + ((i * 0.618) % 1) * 0.6;
      const el = 0.17 + ((i * 0.37) % 1) * 0.34, R = 535;
      cl.position.set(Math.sin(az) * Math.cos(el) * R, Math.sin(el) * R, Math.cos(az) * Math.cos(el) * R);
      cl.renderOrder = -8;
      cl.name = 'cloud';
      sky.add(cl);
    }
    for (let i = 0; i < 5; i++) { // high thin cirrus
      const w = 260 + (i % 3) * 90;
      const cl = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.25),
        new THREE.MeshBasicMaterial({ map: mkCirrusTex(311 + i * 53), transparent: true, depthWrite: false, opacity: 0.8, fog: false }));
      const az = (i / 5) * Math.PI * 2 + 0.9 + ((i * 0.71) % 1) * 0.5;
      const el = 0.36 + ((i * 0.41) % 1) * 0.22, R = 545;
      cl.position.set(Math.sin(az) * Math.cos(el) * R, Math.sin(el) * R, Math.cos(az) * Math.cos(el) * R);
      cl.renderOrder = -8;
      cl.name = 'cirrus';
      sky.add(cl);
    }
    sky.updateMatrixWorld(true);
    for (const ch of sky.children) if (ch !== dome) ch.lookAt(CTR.x, CTR.y + ch.position.y, CTR.z);
  }

  // §RW rendered walkthrough sky: the sketch dome washes out to paper at the horizon
  // (it sits in a white void). Under the rendered aesthetic the site is a real place,
  // so the dome deepens, the haze band warms, and the paper clouds pull back.
  let skyRMap = null, skySMap = null;
  function skyRendered(on) {
    const dome = sky.getObjectByName('skydome');
    if (!dome) return;
    if (!skySMap) skySMap = dome.material.map;
    if (on && !skyRMap) {
      const c = document.createElement('canvas'); c.width = 4; c.height = 512;
      const x2 = c.getContext('2d');
      const g2 = x2.createLinearGradient(0, 0, 0, 512);
      g2.addColorStop(0.00, '#1f6cba'); g2.addColorStop(0.24, '#4d97d3');
      g2.addColorStop(0.42, '#7fb8e2'); g2.addColorStop(0.50, '#aed0e9');
      g2.addColorStop(0.55, '#d7e2e4'); g2.addColorStop(0.62, '#e7e6dc');
      g2.addColorStop(1.00, '#e3ded1');
      x2.fillStyle = g2; x2.fillRect(0, 0, 4, 512);
      skyRMap = new THREE.CanvasTexture(c);
    }
    if (dome.material.map !== (on ? skyRMap : skySMap)) {
      dome.material.map = on ? skyRMap : skySMap;
      dome.material.needsUpdate = true;
    }
    for (const ch of sky.children) {
      if (ch.name === 'cloud') ch.material.opacity = on ? 0.7 : 0.9;
      else if (ch.name === 'cirrus') ch.material.opacity = on ? 0.55 : 0.8;
      else if (ch.name === 'skysun') ch.material.opacity = on ? 0.7 : 1;
    }
  }

  // eye-level ground realism: material texture stamped over the baked data field.
  // Ground texture pass: grayscale marks (black = shade, white = light) drawn per
  // material category into texMark, confined to where data paint exists via
  // 'destination-in', then composited over the data field with 'overlay'. Hue stays
  // 100% the metric ramp — texture reads as tonal material grain (grass blades /
  // asphalt aggregate / concrete joints / pavers / stone) plus low-frequency painterly
  // mottling. Deterministic RNG so rebakes don't shimmer.
  function paintGroundTexture(st) {
    const ctx = texMarkCtx, pxx = AURA_CW * TEXS / SITE_W, pyy = AURA_CH * TEXS / SITE_H;
    let s = 1234567; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const R = (a, b) => a + rnd() * (b - a);
    const path = (loop) => { ctx.moveTo((loop[0][0] - SITE.x0) * pxx, (SITE.y1 - loop[0][1]) * pyy); for (let i = 1; i < loop.length; i++) ctx.lineTo((loop[i][0] - SITE.x0) * pxx, (SITE.y1 - loop[i][1]) * pyy); ctx.closePath(); };
    // soft tonal blotches — the large mottled patches in the reference
    const blotch = (x0, y0, x1, y1, area, aDark, aLight) => {
      const n = Math.min(26, 2 + Math.round(area / 7000));
      for (let i = 0; i < n; i++) {
        const bx = R(x0, x1), by = R(y0, y1), br = R(26, 85), light = rnd() < 0.45;
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        const cc = light ? '255,255,255' : '0,0,0', aa = (light ? aLight : aDark) * 0.55;
        g.addColorStop(0, 'rgba(' + cc + ',' + aa + ')'); g.addColorStop(1, 'rgba(' + cc + ',0)');
        ctx.fillStyle = g; ctx.fillRect(bx - br, by - br, br * 2, br * 2);
      }
    };
    ctx.clearRect(0, 0, texMark.width, texMark.height);
    for (const c of CATS) {
      for (const surf of (geo[st].surfaces[c] || [])) {
        ctx.save(); ctx.beginPath();
        path(surf.outer); for (const h of (surf.holes || [])) path(h);
        ctx.clip('evenodd');
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const p of surf.outer) { const u = (p[0] - SITE.x0) * pxx, v = (SITE.y1 - p[1]) * pyy; if (u < x0) x0 = u; if (u > x1) x1 = u; if (v < y0) y0 = v; if (v > y1) y1 = v; }
        const area = Math.max(1, (x1 - x0) * (y1 - y0));
        if (c.indexOf('grass') >= 0) {
          blotch(x0, y0, x1, y1, area, 0.09, 0.11);
          // fine dark speckle — a dense grainy stipple so turf reads as textured grain,
          // clearly distinct from smooth concrete/asphalt (the 3D blades carry the close
          // read; this is the flat-ground grain). Thin 1px dots keep interior value true.
          const gn = Math.min(9000, Math.round(area / 8));
          ctx.fillStyle = 'rgba(0,0,0,0.30)';
          for (let i = 0; i < gn; i++) ctx.fillRect(R(x0, x1), R(y0, y1), 1, 1);
          ctx.fillStyle = 'rgba(255,255,255,0.16)';
          for (let i = 0; i < gn * 0.4; i++) ctx.fillRect(R(x0, x1), R(y0, y1), 1, 1);
        } else if (c.indexOf('asphalt') === 0) {
          blotch(x0, y0, x1, y1, area, 0.07, 0.06);
          // smooth asphalt differentiated by bold widely-spaced expansion joints + cracks.
          // ROADS are left clean (no joint/crack pattern) per design request — matched by
          // material family, so a site whose road category is spelled asphalt_roadways
          // stays clean too.
          if (!isRoadCat(c)) {
          ctx.strokeStyle = 'rgba(0,0,0,0.42)'; ctx.lineWidth = 1.1;
          ctx.beginPath();
          const jA = 2.82 * pyy; // 2.82 m expansion joints (was a fixed 26 px, King's-Road-scaled)
          for (let v = Math.ceil(y0 / jA) * jA; v < y1; v += jA) { ctx.moveTo(x0, v); ctx.lineTo(x1, v); }
          ctx.stroke();
          const cracks = area > 14000 ? 2 : (area > 6000 ? 1 : 0);
          if (cracks) {
            ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.8;
            ctx.beginPath();
            for (let i = 0; i < cracks; i++) {
              let cx2 = R(x0, x1), cy2 = R(y0, y1); ctx.moveTo(cx2, cy2);
              for (let k2 = 0; k2 < 6; k2++) { cx2 += R(-16, 16); cy2 += R(5, 16); ctx.lineTo(cx2, cy2); }
            }
            ctx.stroke();
          }
          }
        } else if (c.indexOf('concrete') >= 0) {
          blotch(x0, y0, x1, y1, area, 0.06, 0.09);
          const n = Math.min(4000, Math.round(area / 30));
          ctx.fillStyle = 'rgba(0,0,0,0.30)';
          for (let i = 0; i < n; i++) ctx.fillRect(R(x0, x1), R(y0, y1), 1, 1);
          ctx.strokeStyle = 'rgba(0,0,0,0.44)'; ctx.lineWidth = 1.0;
          ctx.beginPath();
          const jC = 1.41 * pxx; // 1.41 m saw-cut control joints
          for (let u = Math.ceil(x0 / jC) * jC; u < x1; u += jC) { ctx.moveTo(u, y0); ctx.lineTo(u, y1); }
          ctx.stroke();
        } else if (c.indexOf('paver') >= 0) {
          blotch(x0, y0, x1, y1, area, 0.05, 0.08);
          // running-bond pavers (~0.56 x 0.37 m each): horizontal joints every row,
          // vertical joints offset half a module on alternate rows so it reads as
          // laid brick rather than a plain grid, even at this small scale.
          const pw = 0.565 * pxx, ph = 0.369 * pxx; // real 0.565 x 0.369 m running bond
          ctx.strokeStyle = 'rgba(0,0,0,0.46)'; ctx.lineWidth = 0.85;
          ctx.beginPath();
          let prow = 0;
          for (let v = Math.floor(y0 / ph) * ph; v < y1; v += ph, prow++) {
            ctx.moveTo(x0, v); ctx.lineTo(x1, v);
            const off = (prow % 2) * (pw / 2);
            for (let u = Math.floor(x0 / pw) * pw + off; u < x1; u += pw) { ctx.moveTo(u, v); ctx.lineTo(u, v + ph); }
          }
          ctx.stroke();
        } else if (c.indexOf('stone') >= 0) {
          blotch(x0, y0, x1, y1, area, 0.08, 0.09);
          const n = Math.min(4000, Math.round(area / 22));
          ctx.strokeStyle = 'rgba(0,0,0,0.46)'; ctx.lineWidth = 0.85;
          for (let i = 0; i < n; i++) { const ex = R(x0, x1), ey = R(y0, y1), er = R(1.1, 3.0); ctx.beginPath(); ctx.ellipse(ex, ey, er, er * 0.7, R(0, 3.1), 0, 7); ctx.stroke(); }
        }
        ctx.restore();
      }
    }
    // confine marks to where data paint exists (soft aura edge stays authoritative)
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(texCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    // value-only composite: MULTIPLY darkens the data hue along the material line-work
    // (joints / stipple / paver bond) without shifting it. Overlay was used here before
    // but barely marks the pastel ramp — the patterns baked yet stayed invisible. The
    // structural marks are thin/low-alpha so surface INTERIORS keep their true data colour;
    // only the joints and grain darken. (Iso never reads this canvas.)
    texCtx.save();
    texCtx.globalCompositeOperation = 'multiply';
    texCtx.drawImage(texMark, 0, 0);
    texCtx.restore();

    // ---- grass-on-top relief (walk-only, fully reversible) --------------------
    // Turf sits proud of the hardscape, so each grass polygon casts a soft shadow onto
    // its LOWER neighbours (road / stone / paving). That cast shadow is the ENTIRE seam
    // cue — no keyline / rim stroke (a drawn line reads as a hard outline on the pastel
    // ground, which we ruled out). Composited with MULTIPLY by a neutral grey, so it darkens the data hue
    // WITHOUT shifting it — surfaces still match the iso colour bar. Confined to the data
    // mask (texCanvas alpha) so nothing spills onto the paper; the iso model never reads
    // texCanvas, and walk exit hides the aura ground, so this reverts with no cleanup.
    if (S.walk) {
      const gsurfs = (CATS.filter(k => k.indexOf('grass') >= 0).reduce((a, k) => a.concat(geo[st].surfaces[k] || []), []));
      if (gsurfs.length) {
        const SUN = (typeof MV_SUNW !== 'undefined') ? MV_SUNW : [0.81, 0, 0.58];
        // site metres -> canvas px, SAME mapping as the material marks above. The old
        // form (x * pxx, -y * pyy) assumed a site whose origin is (0,0) with y <= 0 —
        // King's Road — so on any other extent the shadow landed hundreds of px away and
        // was masked out, which is why Lee had no seam shadows at all.
        const CXp = (x) => (x - SITE.x0) * pxx, CYp = (y) => (SITE.y1 - y) * pyy;
        const trace = (c) => {
          c.beginPath();
          for (const surf of gsurfs) {
            const o = surf.outer;
            c.moveTo(CXp(o[0][0]), CYp(o[0][1]));
            for (let i = 1; i < o.length; i++) c.lineTo(CXp(o[i][0]), CYp(o[i][1]));
            c.closePath();
            for (const h of (surf.holes || [])) {
              c.moveTo(CXp(h[0][0]), CYp(h[0][1]));
              for (let i = 1; i < h.length; i++) c.lineTo(CXp(h[i][0]), CYp(h[i][1]));
              c.closePath();
            }
          }
        };
        const throwPx = 12, blurPx = 7;              // bold enough to read at eye level (~1.3 m)
        const ox = -SUN[0] * throwPx, oy = SUN[2] * throwPx;
        const sc = document.createElement('canvas'); sc.width = texCanvas.width; sc.height = texCanvas.height;
        const sctx = sc.getContext('2d');
        // 1) blurred neutral-grey silhouette, offset away from the sun
        sctx.save(); sctx.translate(ox, oy); sctx.filter = 'blur(' + blurPx + 'px)';
        trace(sctx); sctx.fillStyle = '#3c3a37'; sctx.fill('evenodd'); sctx.restore();
        // 2) knock out the grass interior so the shadow lands only on the neighbours
        sctx.save(); sctx.globalCompositeOperation = 'destination-out';
        trace(sctx); sctx.fillStyle = '#000'; sctx.fill('evenodd'); sctx.restore();
        // 3) confine to measured ground (the data mask) so nothing spills onto paper
        sctx.globalCompositeOperation = 'destination-in'; sctx.drawImage(texCanvas, 0, 0);
        // 4) MULTIPLY onto the data field — darkens, hue-preserving. This cast shadow on
        //    the LOWER neighbours is the entire seam cue: no keyline / rim stroke (a drawn
        //    line reads as a hard outline on the pastel ground, which we explicitly ruled
        //    out). The value step is carried by the grass's own tonal mottling meeting the
        //    smoother hardscape, plus this shadow on the shaded side.
        texCtx.save(); texCtx.globalCompositeOperation = 'multiply'; texCtx.globalAlpha = 0.72;
        texCtx.drawImage(sc, 0, 0); texCtx.restore();
      }
    }
    // ---- material seam shadows (walk-only, reversible) ------------------------
    // A soft dark AO groove along EVERY material boundary. This REPLACES the old
    // white boundary lines: material separation now reads as an incised shadow at
    // each joint, not a bright keyline. Value-only (MULTIPLY, hue-preserving) and
    // confined to the data mask, so surface INTERIORS keep their exact ramp colour —
    // only the thin boundary band darkens. Iso never reads this canvas, and walk exit
    // hides the aura ground, so this reverts with no cleanup.
    if (S.walk) {
      const sc2 = document.createElement('canvas'); sc2.width = texCanvas.width; sc2.height = texCanvas.height;
      const c2 = sc2.getContext('2d');
      c2.filter = 'blur(0.8px)'; c2.strokeStyle = '#211f1b'; c2.lineJoin = 'round'; c2.lineCap = 'round'; c2.lineWidth = 1.8;
      // site metres -> canvas px (see the note on the grass relief above: the old
      // origin-at-zero form silently placed every groove off-site on non-King's-Road extents)
      const SX = (x) => (x - SITE.x0) * pxx, SY = (y) => (SITE.y1 - y) * pyy;
      c2.beginPath();
      // only true material boundaries (see seamSegs): road edges and same-material
      // joints are excluded, so a paver field reads as one surface, not a tiled grid.
      for (const sg of seamSegs(st)) { c2.moveTo(SX(sg[0]), SY(sg[1])); c2.lineTo(SX(sg[2]), SY(sg[3])); }
      c2.stroke();
      c2.filter = 'none';
      c2.globalCompositeOperation = 'destination-in'; c2.drawImage(texCanvas, 0, 0);
      texCtx.save(); texCtx.globalCompositeOperation = 'multiply'; texCtx.globalAlpha = 0.72;
      texCtx.drawImage(sc2, 0, 0); texCtx.restore();
    }
  }
  function bakeAura(st, m) {
    const key = st + '|' + m + '|' + (S.matSwap || 'as') + '|' + (S.walk || 'iso') + '|' + auraEditV + '|' + (S.threshold == null ? 'x' : S.threshold);
    if (auraCanvas._key === key) return;
    const d = D[st], CW = AURA_CW, CH = AURA_CH, N = CW * CH;
    const acc = new Float32Array(N * 3), wacc = new Float32Array(N);
    const metric = METRICS[m], ramp = metric.ramp, dom = metric.domain;
    const pending = metric.status === 'pending';
    const pxx = CW / SITE_W, pyy = CH / SITE_H, rad = 7, r2 = rad * rad;
    for (let i = 0; i < d.n; i++) {
      const cu = (d.x[i] - SITE.x0) * pxx, cv = (SITE.y1 - d.y[i]) * pyy;
      const t = clamp01((metricValue(st, m, i) - dom[0]) / (dom[1] - dom[0]));
      const c = ramp(t); let cr = c[0], cg = c[1], cb = c[2];
      if (pending) { cr = cr * 0.42 + MUTE[0] * 0.58; cg = cg * 0.42 + MUTE[1] * 0.58; cb = cb * 0.42 + MUTE[2] * 0.58; }
      // comfort threshold: mute ground below the chosen level (same rule as the mosaic tiles,
      // so the smooth iso field and the tessellated field agree)
      if (S.threshold != null) {
        const rv = (S.preview && d.pRed) ? d.pRed[i] : d.red[i];
        const below = (m === 'reduction') ? (rv < S.threshold) : (metricValue(st, m, i) < S.threshold);
        if (below) { cr = cr * 0.14 + MUTE[0] * 0.86; cg = cg * 0.14 + MUTE[1] * 0.86; cb = cb * 0.14 + MUTE[2] * 0.86; }
      }
      const u0 = Math.max(0, Math.floor(cu - rad)), u1 = Math.min(CW - 1, Math.ceil(cu + rad));
      const v0 = Math.max(0, Math.floor(cv - rad)), v1 = Math.min(CH - 1, Math.ceil(cv + rad));
      for (let py = v0; py <= v1; py++) for (let px = u0; px <= u1; px++) {
        const dx = px - cu, dy = py - cv, dd = dx * dx + dy * dy;
        if (dd > r2) continue;
        const w = Math.exp(-dd / (r2 * 0.5)), o = py * CW + px;
        acc[o * 3] += cr * w; acc[o * 3 + 1] += cg * w; acc[o * 3 + 2] += cb * w; wacc[o] += w;
      }
    }
    const img = auraCtx.createImageData(CW, CH), dd = img.data;
    for (let o = 0; o < N; o++) {
      const w = wacc[o];
      if (w > 0.03) {
        dd[o * 4] = Math.round(clamp01(acc[o * 3] / w) * 255);
        dd[o * 4 + 1] = Math.round(clamp01(acc[o * 3 + 1] / w) * 255);
        dd[o * 4 + 2] = Math.round(clamp01(acc[o * 3 + 2] / w) * 255);
        dd[o * 4 + 3] = Math.round(Math.min(1, w * 0.85) * 255);
      } else dd[o * 4 + 3] = 0;
    }
    auraCtx.putImageData(img, 0, 0);
    // upscale the data field to display res, then stamp material texture over it
    texCtx.clearRect(0, 0, texCanvas.width, texCanvas.height);
    texCtx.drawImage(auraCanvas, 0, 0, texCanvas.width, texCanvas.height);
    if (S.walk) {
      // MV pastel: lift the ramp toward paper at eye level (this canvas is walk-only;
      // the iso mosaic keeps the full-saturation ramp untouched)
      texCtx.globalCompositeOperation = 'source-atop';
      texCtx.fillStyle = 'rgba(255,255,255,0.22)';
      texCtx.fillRect(0, 0, texCanvas.width, texCanvas.height);
      texCtx.globalCompositeOperation = 'source-over';
      // MV: unmeasured ground gets a quiet pastel paper base instead of raw white —
      // eye level reads as one continuous stylized ground, texture marks land everywhere
      texCtx.globalCompositeOperation = 'destination-over';
      texCtx.fillStyle = '#efece2';
      texCtx.fillRect(0, 0, texCanvas.width, texCanvas.height);
      texCtx.globalCompositeOperation = 'source-over';
      paintGroundTexture(st);
      // paint building footprints back to the pastel paper base — no splat bleeds under
      // a mass, and bbox overshoot on L-shaped buildings reads as paper, not stark white
      texCtx.fillStyle = '#efece2';
      for (const bb of (st === 'baseline' ? buildings : buildings.filter(b => b.shared)).map(b => b.bbox)) {
        const x0 = (bb[0] - SITE.x0) * pxx * TEXS, y0 = (SITE.y1 - bb[3]) * pyy * TEXS, x1 = (bb[2] - SITE.x0) * pxx * TEXS, y1 = (SITE.y1 - bb[1]) * pyy * TEXS;
        texCtx.fillRect(x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4);
      }
    } else {
      // ISO smooth field (sketch mode): full-saturation ramp, one continuous seamless
      // field. The building MASSES occlude their own footprints from the iso camera, so
      // we do NOT erase footprints — erasing by bounding-box punched rectangular white
      // halos around non-rectangular buildings (and notches into L-shaped ones). The
      // soft splat bleed under a building base is hidden by the mass above it.
    }
    auraTex.needsUpdate = true; auraCanvas._key = key;
    if (g3AfterBake) g3AfterBake(st); // retint 3D grass if it's up mid-walk
  }

  // ---- 3D grass (walk modes only): instanced blade tufts scattered over the grass
  // polygons, each tuft tinted by sampling the baked ground field at its root — the
  // established data hue carries up into the third dimension, blended with the same
  // botanical blade tones as the 2D texture. Never visible in the iso model.
  var g3AfterBake = null;
  const grass3D = (() => {
    // tuft geometry: 6 tapered one-tri blades, darker at root, lighter at tip
    const pos = [], col = [];
    let s = 424243; const rr = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let b = 0; b < 6; b++) {
      const yaw = (b / 6) * Math.PI * 2 + rr() * 0.9;
      const bw = 0.028 + rr() * 0.026, h = 0.09 + rr() * 0.07, lean = 0.05 + rr() * 0.10;
      const cx = Math.cos(yaw), sz = Math.sin(yaw);
      const ox = (rr() - 0.5) * 0.14, oz = (rr() - 0.5) * 0.14;
      pos.push(ox - sz * bw, 0, oz + cx * bw, ox + sz * bw, 0, oz - cx * bw, ox + cx * lean, h, oz + sz * lean);
      const sh = 0.52 + rr() * 0.18;
      col.push(sh, sh, sh, sh, sh, sh, 1.06, 1.06, 1.06);
    }
    const bladeGeo = new THREE.BufferGeometry();
    bladeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    bladeGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const bladeMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });

    // §RW realistic turf: curved, tapered, three-segment blades with real normals so they
    // take the rendered sun — swapped in only under the rendered aesthetic at eye level.
    // The sketch walk keeps the flat one-triangle blades above, unchanged.
    const rBladeGeo = (() => {
      const pos2 = [], col2 = [], nor2 = [];
      let s3 = 909091; const r3 = () => (s3 = (s3 * 16807) % 2147483647) / 2147483647;
      const SEG = 3;
      for (let b = 0; b < 10; b++) {
        const yaw = (b / 10) * Math.PI * 2 + r3() * 0.8;
        const bw = 0.035 + r3() * 0.022;    // half-width: 7–11 cm across — deliberately oversized
        const h = 0.26 + r3() * 0.18;       // blade length 26–44 cm: rough-cut lawn, still reads at 10 m
        const bend = 0.16 + r3() * 0.22;    // strong arc — leaning blades knit into a mat
        const cx = Math.cos(yaw), sz = Math.sin(yaw);
        const ox = (r3() - 0.5) * 0.17, oz = (r3() - 0.5) * 0.17;
        const shade = 0.58 + r3() * 0.14;   // root darkness
        const at = (t) => {
          const w = bw * (1 - t * 0.94), d = bend * t * t;
          return { lx: ox + cx * d - sz * w, lz: oz + sz * d + cx * w,
                   rx: ox + cx * d + sz * w, rz: oz + sz * d - cx * w, y: h * t };
        };
        const nl = Math.hypot(cx, 0.42, sz);
        const nx = cx / nl, ny = 0.42 / nl, nz = sz / nl;
        const N = (n) => { for (let k = 0; k < n; k++) nor2.push(nx, ny, nz); };
        for (let i = 0; i < SEG; i++) {
          const t0 = i / SEG, t1 = (i + 1) / SEG;
          const a = at(t0), c = at(t1);
          const v0 = shade + (1 - shade) * t0 * 0.92, v1 = shade + (1 - shade) * t1 * 0.92;
          if (i === SEG - 1) {
            pos2.push(a.lx, a.y, a.lz, a.rx, a.y, a.rz, ox + cx * bend, c.y, oz + sz * bend);
            col2.push(v0, v0, v0, v0, v0, v0, 1.06, 1.06, 1.06);
            N(3);
          } else {
            pos2.push(a.lx, a.y, a.lz, a.rx, a.y, a.rz, c.rx, c.y, c.rz);
            pos2.push(a.lx, a.y, a.lz, c.rx, c.y, c.rz, c.lx, c.y, c.lz);
            col2.push(v0, v0, v0, v0, v0, v0, v1, v1, v1);
            col2.push(v0, v0, v0, v1, v1, v1, v1, v1, v1);
            N(6);
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos2, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col2, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor2, 3));
      return g;
    })();
    // Lambert, not Standard: a specular lobe on a near-horizontal blade blows out to a
    // white sliver under the rendered sun — turf is matte.
    const rBladeMat = new THREE.MeshLambertMaterial({
      vertexColors: true, side: THREE.DoubleSide
    });
    // Blade greens: a shade deeper and more saturated than the lawn beneath, with lighter
    // tips — too dark and they read as dirt specks, too light and the sun blows them white.
    const TURF = [[0.30, 0.42, 0.18], [0.36, 0.48, 0.22], [0.26, 0.37, 0.16], [0.40, 0.52, 0.26], [0.33, 0.45, 0.20]];
    const pip = (px, py, loop) => {
      let inside = false;
      for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const xi = loop[i][0], yi = loop[i][1], xj = loop[j][0], yj = loop[j][1];
        if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    };
    const mk = (st) => {
      let s2 = st === 'baseline' ? 7771 : 7772;
      const rr2 = () => (s2 = (s2 * 16807) % 2147483647) / 2147483647;
      const spots = [];
      for (const surf of surfacesWhere(geo[st], isGrassCat)) {
        const o = surf.outer;
        let A = 0; for (let i = 0, j = o.length - 1; i < o.length; j = i++) A += (o[j][0] + o[i][0]) * (o[j][1] - o[i][1]);
        A = Math.abs(A / 2);
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const p of o) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
        const want = Math.min(9000, Math.round(A * 1.6));
        let placed = 0, tries = 0;
        while (placed < want && tries < want * 8) {
          tries++;
          const px = x0 + rr2() * (x1 - x0), py = y0 + rr2() * (y1 - y0);
          if (!pip(px, py, o)) continue;
          let bad = false;
          for (const h of (surf.holes || [])) if (pip(px, py, h)) { bad = true; break; }
          if (bad) continue;
          spots.push({ x: px, y: py, r: rr2() * Math.PI * 2, sc: 0.75 + rr2() * 0.6, hs: 0.65 + rr2() * 0.35, tone: rr2() });
          placed++;
        }
      }
      const im = new THREE.InstancedMesh(bladeGeo, bladeMat, spots.length);
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), Sc = new THREE.Vector3(), E = new THREE.Euler();
      const yb = st === 'baseline' ? 0.02 : 0.035;
      spots.forEach((sp, i) => {
        E.set(0, sp.r, 0); Q.setFromEuler(E);
        P.set(sp.x, yb, -sp.y); Sc.set(sp.sc, sp.hs, sp.sc);
        M.compose(P, Q, Sc); im.setMatrixAt(i, M);
      });
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(spots.length * 3).fill(0.5), 3);
      im.visible = false; im.frustumCulled = false;
      scene.add(im);
      return { im, spots, key: null, yb, lift: yb, mode: 'data' };
    };
    const G3 = { baseline: mk('baseline'), scenario_01: mk('scenario_01') };
    // §RW the rendered lawn sits PROUD of the hardscape (R_GRASS_H), so turf blades have
    // to ride up with it — at the sketch height they were buried under the raised surface.
    const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _P = new THREE.Vector3(), _S = new THREE.Vector3(), _E = new THREE.Euler();
    function reseat(gs, y, wide, tall) {
      if (gs.lift === y && gs.wide === wide) return;
      gs.spots.forEach((sp, i) => {
        _E.set(0, sp.r, 0); _Q.setFromEuler(_E);
        _P.set(sp.x, y, -sp.y);
        _S.set(sp.sc * wide, sp.hs * tall, sp.sc * wide);
        _M.compose(_P, _Q, _S); gs.im.setMatrixAt(i, _M);
      });
      gs.im.instanceMatrix.needsUpdate = true;
      gs.lift = y; gs.wide = wide;
    }
    const turfMode = () => (!!S.rendered && !S.showData) ? 'turf' : 'data';
    function recolor(st) {
      const gs = G3[st];
      if (!gs || !gs.spots.length) return;
      const mode = turfMode();
      if (gs.mode !== mode) { gs.mode = mode; gs.key = null; }
      // rendered turf: swap in the curved lit blades; sketch/data: flat unlit blades
      const wantGeo = mode === 'turf' ? rBladeGeo : bladeGeo;
      const wantMat = mode === 'turf' ? rBladeMat : bladeMat;
      if (gs.im.geometry !== wantGeo) gs.im.geometry = wantGeo;
      if (gs.im.material !== wantMat) gs.im.material = wantMat;
      // blades root IN the lawn surface for THIS state: at eye level that plane is at
      // grade (§RW), so blade bases sit a hair above it rather than under a floating slab
      const topY = (typeof rLawnTop === 'object' && rLawnTop[st] != null) ? rLawnTop[st] : 0;
      reseat(gs, mode === 'turf' ? (rLawnFlat ? topY + 0.03 : gs.yb + R_GRASS_H) : gs.yb, mode === 'turf' ? 1.35 : 1, mode === 'turf' ? 1.15 : 1);
      if (mode === 'turf') {
        if (gs.key === 'turf') return;
        const a = gs.im.instanceColor.array;
        gs.spots.forEach((sp, i) => {
          const t = TURF[Math.min(TURF.length - 1, Math.floor(sp.tone * TURF.length))];
          const f = 0.88 + ((sp.sc * 7.3) % 1) * 0.26; // per-tuft value jitter
          a[i * 3] = Math.min(1, t[0] * f);
          a[i * 3 + 1] = Math.min(1, t[1] * f);
          a[i * 3 + 2] = Math.min(1, t[2] * f);
        });
        gs.im.instanceColor.needsUpdate = true;
        gs.key = 'turf';
        return;
      }
      if (gs.key === auraCanvas._key) return;
      const W = texCanvas.width, H = texCanvas.height;
      const img = texCtx.getImageData(0, 0, W, H).data;
      const pxx = W / SITE_W, pyy = H / SITE_H, a = gs.im.instanceColor.array;
      gs.spots.forEach((sp, i) => {
        const u = Math.max(0, Math.min(W - 1, Math.round((sp.x - SITE.x0) * pxx)));
        const v = Math.max(0, Math.min(H - 1, Math.round((SITE.y1 - sp.y) * pyy)));
        const k = (v * W + u) * 4;
        let r, g, b;
        if (img[k + 3] > 40) { r = img[k] / 255; g = img[k + 1] / 255; b = img[k + 2] / 255; }
        else { r = 0.78, g = 0.80, b = 0.71; } // unmeasured ground: quiet paper-sage (pastel)
        // monochromatic: blades keep the ground's data hue, varying only in value —
        // slightly darker or lighter than the field so they read without adding color
        const f = sp.tone < 0.55 ? 0.84 : 1.10;
        a[i * 3] = Math.min(1, r * f);
        a[i * 3 + 1] = Math.min(1, g * f);
        a[i * 3 + 2] = Math.min(1, b * f);
      });
      gs.im.instanceColor.needsUpdate = true;
      gs.key = auraCanvas._key;
    }
    g3AfterBake = (st) => { if (G3[st] && G3[st].im.visible) { G3[st].key = null; recolor(st); } };

    // §RW near-field turf: real turf can't be instanced across 10,000 m², and it doesn't
    // need to be — what the eye reads is the ground within ~15 m. A fixed-capacity blade
    // pool FOLLOWS the walker: candidates come from a jittered lattice (so blades never
    // jitter or pop as you walk back over ground you've seen) tested against a rasterised
    // grass mask, which costs one array lookup instead of a point-in-polygon sweep. The
    // painted turf texture carries everything past the pool radius.
    const DENSE = {};
    const MASK_PX = 0.4; // metres per mask pixel
    function grassMask(st) {
      const w = Math.max(4, Math.ceil(SITE_W / MASK_PX)), h = Math.max(4, Math.ceil(SITE_H / MASK_PX));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#fff';
      const X = (x) => (x - SITE.x0) / MASK_PX, Y = (y) => (SITE.y1 - y) / MASK_PX;
      g.beginPath();
      for (const surf of surfacesWhere(geo[st], isGrassCat)) {
        for (const loop of [surf.outer].concat(surf.holes || [])) {
          if (!loop || loop.length < 3) continue;
          g.moveTo(X(loop[0][0]), Y(loop[0][1]));
          for (let i = 1; i < loop.length; i++) g.lineTo(X(loop[i][0]), Y(loop[i][1]));
          g.closePath();
        }
      }
      g.fill('evenodd');
      const src = g.getImageData(0, 0, w, h).data;
      const m = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < src.length; i += 4, j++) m[j] = src[i] > 127 ? 1 : 0;
      return { m, w, h };
    }
    // integer hash → deterministic per-lattice-cell randomness
    const hash01 = (i, j) => {
      let x = (i * 73856093) ^ (j * 19349663);
      x = Math.imul(x ^ (x >>> 13), 1274126177);
      return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
    };
    function ensureDense(st) {
      if (DENSE[st]) return DENSE[st];
      const q = (typeof rQualityEff === 'function') ? rQualityEff() : 'med';
      const per = q === 'high' ? 16 : (q === 'low' ? 6 : 12);  // tufts per m² in the near field
      const R = q === 'high' ? 14 : (q === 'low' ? 9 : 12);     // pool radius, metres
      const d = 1 / Math.sqrt(per);
      const cap = Math.min(14000, Math.ceil(Math.PI * R * R * per * 1.1));
      const im = new THREE.InstancedMesh(rBladeGeo, rBladeMat, cap);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      im.count = 0;
      im.visible = false; im.frustumCulled = false; im.renderOrder = 2;
      scene.add(im);
      DENSE[st] = { im, cap, R, d, mask: grassMask(st), yb: (st === 'baseline' ? 0.02 : 0.035), lift: null, at: null };
      return DENSE[st];
    }
    function follow(st, px, py, force) {
      const D = DENSE[st];
      if (!D || !D.im.visible) return;
      // blades root IN the lawn plane for this state — at grade during a rendered walk (§RW)
      const topY = (typeof rLawnTop === 'object' && rLawnTop[st] != null) ? rLawnTop[st] : 0;
      const y = rLawnFlat ? topY + 0.03 : D.yb + R_GRASS_H;
      if (D.lift !== y) { D.lift = y; force = true; }
      if (!force && D.at && Math.hypot(px - D.at[0], py - D.at[1]) < 2) return;
      D.at = [px, py];
      const R2 = D.R * D.R, d = D.d, col = D.im.instanceColor.array;
      const M = D.mask;
      const i0 = Math.floor((px - D.R) / d), i1 = Math.ceil((px + D.R) / d);
      const j0 = Math.floor((py - D.R) / d), j1 = Math.ceil((py + D.R) / d);
      let k = 0;
      for (let i = i0; i <= i1 && k < D.cap; i++) {
        for (let j = j0; j <= j1 && k < D.cap; j++) {
          const h1 = hash01(i, j);
          const gx = i * d + (h1 - 0.5) * d * 0.95;
          const h2 = hash01(i + 9973, j);
          const gy = j * d + (h2 - 0.5) * d * 0.95;
          const dx = gx - px, dy = gy - py;
          if (dx * dx + dy * dy > R2) continue;
          const mu = Math.round((gx - SITE.x0) / MASK_PX), mv = Math.round((SITE.y1 - gy) / MASK_PX);
          if (mu < 0 || mv < 0 || mu >= M.w || mv >= M.h || !M.m[mv * M.w + mu]) continue;
          const h3 = hash01(i, j + 7919);
          _E.set(0, h3 * Math.PI * 2, 0); _Q.setFromEuler(_E);
          _P.set(gx, y, -gy);
          const sc = 0.85 + h1 * 0.5;
          _S.set(sc, 0.8 + h2 * 0.5, sc);
          _M.compose(_P, _Q, _S); D.im.setMatrixAt(k, _M);
          const t = TURF[Math.min(TURF.length - 1, Math.floor(h3 * TURF.length))];
          const f = 0.84 + h2 * 0.34;
          col[k * 3] = Math.min(1, t[0] * f); col[k * 3 + 1] = Math.min(1, t[1] * f); col[k * 3 + 2] = Math.min(1, t[2] * f);
          k++;
        }
      }
      D.im.count = k;
      D.im.instanceMatrix.needsUpdate = true;
      D.im.instanceColor.needsUpdate = true;
    }
    function denseVis(st) {
      const want = turfMode() === 'turf' && (!!S.walk || fw.active);
      for (const k of STATES) if (DENSE[k]) { DENSE[k].im.visible = false; DENSE[k].at = null; }
      if (!want || !st) return;
      const D = ensureDense(st);
      D.im.visible = true;
      follow(st, fw.px != null ? fw.px : CTR.x, fw.py != null ? fw.py : -CTR.z, true);
    }
    return {
      show(st) { recolor(st); denseVis(st); G3.baseline.im.visible = st === 'baseline'; G3.scenario_01.im.visible = st === 'scenario_01'; },
      hide() { G3.baseline.im.visible = false; G3.scenario_01.im.visible = false; denseVis(null); },
      // the walker moved — re-seat the near-field blade pool around them
      follow(px, py) { const st = stateKey(); if (DENSE[st] && DENSE[st].im.visible) follow(st, px, py, false); },
      // aesthetic changed mid-walk (RENDERED ↔ SKETCH, or SHOW DATA) — re-dress the turf
      restyle() { for (const st of STATES) if (G3[st] && G3[st].im.visible) { recolor(st); denseVis(st); } }
    };
  })();

  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const _hit = new THREE.Vector3();
  function fwGroundAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ptr.x = ((clientX - r.left) / r.width) * 2 - 1; ptr.y = -((clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ptr, activeCam);
    if (!ray.ray.intersectPlane(groundPlane, _hit)) return null;
    const sx = _hit.x, sy = -_hit.z;
    return { px: sx, py: sy, walkable: walkableXY(sx, sy), sx: clientX - r.left, sy: clientY - r.top };
  }
  // world-space plantability/walkability: on site, not inside a building footprint
  function walkableXY(sx, sy) {
    if (sx < SITE.x0 || sx > SITE.x1 || sy < SITE.y0 || sy > SITE.y1) return false;
    for (const bb of stateColliders()) if (sx >= bb[0] && sx <= bb[2] && sy >= bb[1] && sy <= bb[3]) return false;
    return true;
  }

  const fw = {
    active: false, px: 0, py: 0, yaw: 0, pitch: -0.02, target: null,
    keys: {}, hasKbd: false,
    groundMetric() { const m = METRICS[S.metric]; return (m && m.kind === 'tree') ? 'load' : S.metric; }
  };
  function fwMove(mvx, mvy) {
    let nx = fw.px + mvx, ny = fw.py + mvy;
    nx = Math.max(SITE.x0 + WALK_R, Math.min(SITE.x1 - WALK_R, nx));
    ny = Math.max(SITE.y0 + WALK_R, Math.min(SITE.y1 - WALK_R, ny));
    for (const bb of stateColliders()) {
      const qx = Math.max(bb[0], Math.min(bb[2], nx)), qy = Math.max(bb[1], Math.min(bb[3], ny));
      const dx = nx - qx, dy = ny - qy, dd = dx * dx + dy * dy;
      if (dd < WALK_R * WALK_R) {
        if (dd > 1e-6) { const d = Math.sqrt(dd), push = WALK_R - d; nx += dx / d * push; ny += dy / d * push; }
        else {
          const dl = nx - bb[0], dr = bb[2] - nx, db = ny - bb[1], dtp = bb[3] - ny, mn = Math.min(dl, dr, db, dtp);
          if (mn === dl) nx = bb[0] - WALK_R; else if (mn === dr) nx = bb[2] + WALK_R; else if (mn === db) ny = bb[1] - WALK_R; else ny = bb[3] + WALK_R;
        }
      }
    }
    fw.px = nx; fw.py = ny;
  }
  let fwLastRead = 0;
  function fwReadout(now) {
    if (now - fwLastRead < 100) return; fwLastRead = now;
    if (!cb.onFreeWalkTick) return;
    const st = stateKey(), m = fw.groundMetric(), metric = METRICS[m];
    const emit = (idx, label) => cb.onFreeWalkTick({
      unmeasured: false, value: metric.fmt(metricValue(st, m, idx)),
      units: metric.units || '', label: label
    });
    const under = catAtPoint(st, fw.px, fw.py); // the surface actually underfoot
    if (under != null) {
      // the number must come from a sample ON that material, so value and name describe
      // the same ground. Some surfaces (open water, stone landscaping) carry no sensors
      // at all — name them and say so rather than borrowing a neighbour's reading.
      const idx = nearestSensor(st, fw.px, fw.py, 4.5, CATS.indexOf(under));
      if (idx < 0) { cb.onFreeWalkTick({ unmeasured: true, label: CAT_LABEL[under] }); return; }
      emit(idx, CAT_LABEL[under]);
      return;
    }
    const idx = nearestSensor(st, fw.px, fw.py, 3.0); // off every polygon: nearest sample
    if (idx < 0) { cb.onFreeWalkTick({ unmeasured: true }); return; }
    emit(idx, CAT_LABEL[CATS[D[st].cat[idx]]]);
  }
  function fwUpdate(dt, now) {
    if (!fw.active) return;
    const k = fw.keys;
    const ax = (k['w'] || k['arrowup'] ? 1 : 0) - (k['s'] || k['arrowdown'] ? 1 : 0);
    const sx = (k['d'] || k['arrowright'] ? 1 : 0) - (k['a'] || k['arrowleft'] ? 1 : 0);
    const turn = (k['q'] ? 1 : 0) - (k['e'] ? 1 : 0);
    if (turn) fw.yaw += turn * 1.7 * dt;
    let mvx = 0, mvy = 0;
    const f = [Math.sin(fw.yaw), Math.cos(fw.yaw)], rt = [Math.cos(fw.yaw), -Math.sin(fw.yaw)];
    if (ax || sx) {
      fw.target = null;
      let dx = f[0] * ax + rt[0] * sx, dy = f[1] * ax + rt[1] * sx;
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const spd = k['shift'] ? 4.8 : 2.8;
      mvx = dx * spd * dt; mvy = dy * spd * dt;
    } else if (fw.target) {
      let dx = fw.target.px - fw.px, dy = fw.target.py - fw.py; const dist = Math.hypot(dx, dy);
      if (dist < 0.28) fw.target = null;
      else { const step = Math.min(dist, 6.5 * dt); mvx = dx / dist * step; mvy = dy / dist * step; fw.yaw += angDiff(Math.atan2(dx, dy), fw.yaw) * Math.min(1, 7 * dt); }
    }
    if (mvx || mvy) {
      const bx = fw.px, by = fw.py;
      fwMove(mvx, mvy);
      // glide safety net: if a boundary/building clamp swallowed the step (no real
      // progress) drop the target, so you can never get pinned against an edge.
      if (fw.target && Math.hypot(fw.px - bx, fw.py - by) < Math.hypot(mvx, mvy) * 0.35) fw.target = null;
    }
    const cx = fw.px, cz = -fw.py, cp = Math.cos(fw.pitch);
    persp.position.set(cx, 1.7, cz);
    persp.lookAt(cx + Math.sin(fw.yaw) * cp * 4, 1.7 + Math.sin(fw.pitch) * 4, cz - Math.cos(fw.yaw) * cp * 4);
    grass3D.follow(fw.px, fw.py); // §RW near-field turf follows the walker
    fwReadout(now);
  }
  function fwKeyDown(e) {
    if (!fw.active) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') { endFreeWalk(); return; }
    if (['w', 'a', 's', 'd', 'q', 'e', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].indexOf(k) >= 0) { fw.keys[k] = true; fw.hasKbd = true; e.preventDefault(); }
  }
  function fwKeyUp(e) {
    if (!fw.active) return;
    const k = e.key.toLowerCase();
    if (fw.keys[k] != null) { fw.keys[k] = false; e.preventDefault(); }
  }
  let fwPtr = null;
  on(canvas, 'pointerdown', ev => { if (disposed || !fw.active) return; fwPtr = { x: ev.clientX, y: ev.clientY, ox: ev.clientX, oy: ev.clientY, moved: false }; try { canvas.setPointerCapture(ev.pointerId); } catch (e) {} });
  on(canvas, 'pointermove', ev => {
    if (disposed || !fw.active || !fwPtr) return;
    const dx = ev.clientX - fwPtr.x, dy = ev.clientY - fwPtr.y; fwPtr.x = ev.clientX; fwPtr.y = ev.clientY;
    if (Math.abs(ev.clientX - fwPtr.ox) + Math.abs(ev.clientY - fwPtr.oy) > 6) fwPtr.moved = true;
    fw.yaw -= dx * 0.0046; fw.pitch = Math.max(-0.5, Math.min(0.5, fw.pitch - dy * 0.0035));
  });
  on(canvas, 'pointerup', ev => {
    if (disposed) return;
    if (!fw.active || !fwPtr) { fwPtr = null; return; }
    const tap = !fwPtr.moved; fwPtr = null;
    if (!tap) return;
    // tap on a tree inspects it (same card as the model); tap on ground glides
    const hit = pickAt(ev);
    if (hit && hit.type === 'tree') { selectTree(hit); return; }
    fwGlideTo(ev.clientX, ev.clientY);
  });
  function fwGlideTo(clientX, clientY) {
    const g = fwGroundAt(clientX, clientY); if (!g) return;
    let dx = g.px - fw.px, dy = g.py - fw.py; const dist = Math.hypot(dx, dy);
    if (dist > 12) { dx = dx / dist * 12; dy = dy / dist * 12; }
    // keep the target inside walkable site bounds so it is always reachable —
    // a target past the edge would clamp the walker and stall the glide.
    const tx = Math.max(SITE.x0 + WALK_R, Math.min(SITE.x1 - WALK_R, fw.px + dx));
    const ty = Math.max(SITE.y0 + WALK_R, Math.min(SITE.y1 - WALK_R, fw.py + dy));
    fw.target = { px: tx, py: ty };
  }
  function beginFreeWalk(px, py) {
    if (fw.active) return;
    if (S.relief) setRelief(false);
    clearSelection();
    for (const bb of stateColliders()) if (px >= bb[0] && px <= bb[2] && py >= bb[1] && py <= bb[3]) {
      const dl = px - bb[0], dr = bb[2] - px, db = py - bb[1], dtp = bb[3] - py, mn = Math.min(dl, dr, db, dtp);
      if (mn === dl) px = bb[0] - WALK_R - 0.1; else if (mn === dr) px = bb[2] + WALK_R + 0.1; else if (mn === db) py = bb[1] - WALK_R - 0.1; else py = bb[3] + WALK_R + 0.1;
    }
    fw.px = Math.max(SITE.x0 + WALK_R, Math.min(SITE.x1 - WALK_R, px));
    fw.py = Math.max(SITE.y0 + WALK_R, Math.min(SITE.y1 - WALK_R, py));
    fw.pitch = -0.02; fw.target = null; fw.keys = {};
    fw.yaw = Math.atan2(CTR.x - fw.px, -CTR.z - fw.py);
    S.walk = 'free'; // set BEFORE bakeAura so the walk-only seam shadows actually bake
    bakeAura(stateKey(), fw.groundMetric());
    // hide the tessellated mosaic + white ground tiles so the aura plane is the ONLY
    // ground layer (no z-fight flashing); paper reads through as the white void
    setFieldOpacity(stateKey(), 0);
    mosaic.baseline.visible = false; mosaic.scenario_01.visible = false;
    groundWalkMode(true);
    auraMesh.visible = !(S.rendered && !S.showData); // §RW rendered walk: materials, not the data plane
    sky.visible = true;
    fw.active = true; S.walk = 'free'; activeCam = persp;
    window.addEventListener('keydown', fwKeyDown); window.addEventListener('keyup', fwKeyUp);
    fwUpdate(0, performance.now());
    cb.onFreeWalkStart && cb.onFreeWalkStart({ hasKbd: !('ontouchstart' in window) });
  }
  function endFreeWalk() {
    if (!fw.active) return;
    fw.active = false; S.walk = null; fw.keys = {}; fwPtr = null;
    auraMesh.visible = false; activeCam = ortho; applyOrtho();
    sky.visible = false;
    mosaic.baseline.visible = true; mosaic.scenario_01.visible = true;
    groundWalkMode(false);
    window.removeEventListener('keydown', fwKeyDown); window.removeEventListener('keyup', fwKeyUp);
    setMetric(S.metric); // restore ground field / dim for the current metric
    cb.onFreeWalkEnd && cb.onFreeWalkEnd();
  }

  // ---- TREE EDITING + LIVE SHADE PROXY (design mode) --------------------------------
  // Honesty: the shade trio (load/reduction/sunhours) is geometry, so it can be
  // previewed live; ground-temp/tree-health are physics and stay pending/greyed.
  // The proxy is ANCHORED to the measured field — on the unedited scene it
  // reproduces the sensor data exactly; edits move it by the proxy's differential.
  // King's Road's authored species table. Also the fallback for any site whose
  // species names match it, so King's Road resolves to these values verbatim.
  const SPECIES_KR = {
    'Ash': { r: 3.0, h: 11.5, porosity: 0.20 },
    'Silver Maple': { r: 3.6, h: 12.5, porosity: 0.18 },
    'Conical Evergreens': { r: 1.8, h: 9.5, porosity: 0.10 },
    'Linden': { r: 2.8, h: 11.0, porosity: 0.22 },
    'Hawthorn': { r: 2.0, h: 6.5, porosity: 0.28 },
    'Amur Maple': { r: 2.2, h: 7.0, porosity: 0.30 },
    'Siberian Elm': { r: 3.4, h: 13.0, porosity: 0.24 }
  };
  // The species table is SITE-DERIVED: the names come from the site's own geometry
  // (so the planting palette can only offer species the site actually has, and a
  // planted tree always has a real sample to clone and a real care-table entry).
  // r/h are medians measured from that geometry; porosity comes from the manifest
  // (site.species.<name>.porosity) or the engine default. A site whose species all
  // appear in SPECIES_KR keeps the authored King's Road numbers untouched.
  const SPECIES = (() => {
    const ov = (site && site.species) || {};
    const acc = {};
    for (const st of STATES) {
      for (const t of ((geo[st] && geo[st].trees) || [])) {
        const a = acc[t.species] || (acc[t.species] = { r: [], h: [] });
        if (t.radius > 0) a.r.push(t.radius);
        if (t.height > 0) a.h.push(t.height);
      }
    }
    const keys = Object.keys(acc);
    if (!keys.length) return SPECIES_KR;
    if (keys.every(k => SPECIES_KR[k]) && !Object.keys(ov).length) return SPECIES_KR;
    const med = arr => (arr.length ? arr.slice().sort((x, y) => x - y)[arr.length >> 1] : null);
    const out = {};
    for (const k of keys) {
      const d = SPECIES_KR[k] || {};
      out[k] = {
        r: med(acc[k].r) || d.r || 2.5,
        h: med(acc[k].h) || d.h || 10,
        porosity: d.porosity != null ? d.porosity : 0.22
      };
      if (ov[k]) Object.assign(out[k], ov[k]);
    }
    return out;
  })();
  const porosityOf = (sp) => (SPECIES[sp] ? SPECIES[sp].porosity : 0.22);
  // Winnipeg annual sun path (lat 49.9°N), energy-weighted; Σw = 1
  const SUN = (() => {
    const phi = 49.9 * Math.PI / 180, out = []; let tot = 0;
    for (let mo = 0; mo < 12; mo++) {
      const doy = 15 + 30 * mo;
      const dec = 23.44 * Math.PI / 180 * Math.sin(2 * Math.PI * (doy - 81) / 365);
      for (let hh = -7.5; hh <= 7.5; hh += 1) {
        const H = hh * 15 * Math.PI / 180;
        const sinAlt = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
        if (sinAlt <= 0.02) continue;
        const alt = Math.asin(sinAlt), cosAlt = Math.cos(alt);
        let cosAz = (Math.sin(dec) - Math.sin(phi) * sinAlt) / (Math.cos(phi) * cosAlt);
        cosAz = Math.max(-1, Math.min(1, cosAz));
        let az = Math.acos(cosAz); if (H > 0) az = 2 * Math.PI - az; // az from north, clockwise
        const w = sinAlt; tot += w;
        out.push({ az, alt, w });
      }
    }
    for (const s of out) s.w /= tot;
    return out;
  })();
  function rayEllipsoid(ox, oy, oz, dx, dy, dz, cx, cy, cz, ax, ay, az) {
    const rx = (ox - cx) / ax, ry = (oy - cy) / ay, rz = (oz - cz) / az;
    const ex = dx / ax, ey = dy / ay, ez = dz / az;
    const A = ex * ex + ey * ey + ez * ez;
    const B = 2 * (rx * ex + ry * ey + rz * ez);
    const C = rx * rx + ry * ry + rz * rz - 1;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return false;
    const sq = Math.sqrt(disc);
    return (-B + sq) / (2 * A) > 0.05; // canopy ahead of the sensor along the sun ray
  }
  function proxyShadeAt(sx, sy, trees) {
    const ox = sx, oy = 0.2, oz = -sy; let shade = 0;
    for (let s = 0; s < SUN.length; s++) {
      const su = SUN[s], cA = Math.cos(su.alt);
      const dx = cA * Math.sin(su.az), dy = Math.sin(su.alt), dz = -cA * Math.cos(su.az);
      let trans = 1;
      for (let t = 0; t < trees.length; t++) {
        const tr = trees[t], reach = tr.r + tr.h * 1.7;
        if (Math.abs(tr.x - sx) > reach || Math.abs(tr.y - sy) > reach) continue;
        if (rayEllipsoid(ox, oy, oz, dx, dy, dz, tr.x, tr.h * 0.62, -tr.y, tr.r, tr.h * 0.42, tr.r)) trans *= tr.por;
      }
      shade += su.w * (1 - trans);
    }
    return Math.min(0.95, shade);
  }
  const meshToTree = (mesh) => { const T = mixP < 0.5 ? treesA : treesB; return T.trees.find(t => t.mesh === mesh) || null; };
  function proxyTrees() {
    const T = mixP < 0.5 ? treesA : treesB, out = [];
    for (const tr of T.trees) {
      if (tr._del) continue;
      out.push({ x: tr.t.pos[0], y: tr.t.pos[1], r: Math.max(0.8, tr.t.radius || 2), h: tr.t.height || 10, por: porosityOf(tr.t.species) });
    }
    return out;
  }
  // species samples for cloning (add / swap) — one existing tree per species
  const speciesSample = {};
  for (const T of [treesA, treesB]) for (const tr of T.trees) if (!speciesSample[tr.t.species]) speciesSample[tr.t.species] = tr;
  let ed = null; // { st, base:[trees snapshot], pBaseArr, pBaseDone, added:[trees] }
  let selMeshRef = null;
  function gather(st, x, y, R) {
    const d = D[st], out = [], reach = Math.ceil(R / HASH_CELL);
    const kx = Math.floor(x / HASH_CELL), ky = Math.floor(-y / HASH_CELL);
    for (let ax = -reach; ax <= reach; ax++) for (let ay = -reach; ay <= reach; ay++) {
      const arr = d.hash.get((kx + ax) * 4096 + (ky + ay)); if (!arr) continue;
      for (const i of arr) out.push(i);
    }
    return out;
  }
  function recomputeOne(d, cur, base, i) {
    if (!ed.pBaseDone[i]) { ed.pBaseArr[i] = proxyShadeAt(d.x[i], d.y[i], base); ed.pBaseDone[i] = 1; }
    const now = proxyShadeAt(d.x[i], d.y[i], cur);
    const rr = Math.max(0, Math.min(0.75, d.red[i] + (now - ed.pBaseArr[i])));
    d.pRed[i] = rr; d.pLoad[i] = GHI * (1 - rr);
  }
  function recomputeSensors(idxs) {
    const st = stateKey(), d = D[st], cur = proxyTrees(), base = ed.base;
    for (const i of idxs) recomputeOne(d, cur, base, i);
  }
  // large plantings recompute across frames (14ms budget per frame), recoloring
  // progressively so the field visibly sweeps toward the new shade — never a freeze
  let batchJob = null;
  function batchRecompute(idxSet, onDone) {
    const st = stateKey(), d = D[st], base = ed.base;
    if (batchJob) batchJob.cancel = true;
    const job = { cancel: false }; batchJob = job;
    const arr = Array.from(idxSet); let i = 0;
    const step = () => {
      if (job.cancel || !ed) return;
      const cur = proxyTrees(); // fresh each chunk so overlapping edits stay coherent
      const t0 = performance.now();
      while (i < arr.length && performance.now() - t0 < 14) recomputeOne(d, cur, base, arr[i++]);
      recolorMosaic(st, { metric: S.metric, threshold: S.threshold });
      refreshEditField(st);
      if (i < arr.length) requestAnimationFrame(step);
      else { emitPreviewStats(); if (batchJob === job) batchJob = null; onDone && onDone(); }
    };
    step();
  }
  function affectedRecompute(x0, y0, x1, y1) {
    const st = stateKey(), seen = new Set();
    const R = 16; // envelope radius (canopy + low-sun shadow reach)
    for (const [x, y] of [[x0, y0], [x1, y1]]) { if (x == null) continue; for (const i of gather(st, x, y, R)) seen.add(i); }
    recomputeSensors(seen);
    recolorMosaic(st, { metric: S.metric, threshold: S.threshold });
    refreshEditField(st);
    emitPreviewStats();
  }
  // the smooth iso aura caches by state/metric, so a tree edit doesn't invalidate it
  // on its own. Bump the edit version and re-bake if the aura field is what's on screen
  // (flat sketch design view). The rendered wash and tessellated tiles recolour via the
  // shared mosaic instanceColor above, so they need no extra work here.
  function refreshEditField(st) {
    st = st || S.designState;
    auraEditV++;
    if (auraMesh.visible && (flatSketchMode() || fw.active)) {
      const bst = fw.active ? stateKey() : st;
      _auraStateKey = bst;
      bakeAura(bst, fw.active ? fw.groundMetric() : auraGroundMetric());
    }
  }
  function emitPreviewStats() {
    const st = stateKey(), d = D[st]; let sL = 0;
    for (let i = 0; i < d.n; i++) sL += d.pLoad ? d.pLoad[i] : d.load[i];
    cb.onPreviewStats && cb.onPreviewStats({ meanLoad: sL / d.n, base: d.agg.meanLoad });
  }
  const editSessions = {}; // per design state — an edit session survives Design→View→Design round-trips
  // per-state edit session (trees + preview arrays + history). Design edits and the
  // shade proxy operate on whichever state's session is ACTIVE; switching the lever in
  // design mode must stash the current one and activate the target's, or edits in the
  // second state write into null preview arrays (crash) and the ground never responds.
  function enterEditSession(st) {
    const d = D[st];
    const sess = editSessions[st];
    if (sess) {
      ed = sess.ed; hist = sess.hist; histAt = sess.histAt;
      d.pRed = sess.pRed; d.pLoad = sess.pLoad;
    } else {
      d.pRed = Float32Array.from(d.red); d.pLoad = Float32Array.from(d.load);
      ed = { st, base: proxyTrees(), pBaseArr: new Float32Array(d.n), pBaseDone: new Uint8Array(d.n), added: [] };
      hist = [snapTrees()]; histAt = 0;
    }
    emitHist();
  }
  function stashEditSession() {
    if (!ed) return;
    const st = ed.st, d = D[st];
    editSessions[st] = { ed, hist, histAt, pRed: d.pRed, pLoad: d.pLoad };
  }
  function setDesignMode(on) {
    if (on === S.designMode) return;
    if (on) {
      if (S.relief) setRelief(false);
      clearSelection();
      enterEditSession(stateKey());
      S.designMode = true; S.preview = true;
      syncClusterViz();
      if (S.rendered) syncRendered(); // stay rendered — data waits for SHOW DATA, no sketch grid floor
      if (METRICS[S.metric].kind === 'tree') setMetric('load');
      else activeMosaicColors();
      cb.onMode && cb.onMode({ design: true });
    } else {
      setClusterManual(null); setClusterSelected(null); clusterThinClear();
      S.designMode = false; S.preview = false;
      syncClusterViz();
      plantingClear(); if (batchJob) { batchJob.cancel = true; batchJob = null; }
      const st = ed ? ed.st : stateKey(), d = D[st];
      stashEditSession(); // stash, don't discard
      hist = []; histAt = -1;
      clearSelection(); selMeshRef = null;
      d.pRed = null; d.pLoad = null; ed = null;
      activeMosaicColors();
      if (S.rendered) syncRendered(); // back from the sketch data floor to the heat wash
      cb.onMode && cb.onMode({ design: false });
    }
  }
  function editSelectByMesh(mesh) { selMeshRef = mesh; }
  function editDeleteSelected() {
    if (!S.designMode || !selMeshRef) return;
    const tr = meshToTree(selMeshRef); if (!tr) return;
    const ox = tr.t.pos[0], oy = tr.t.pos[1];
    tr._del = true; tr.piv.visible = false;
    clearSelection(); selMeshRef = null;
    affectedRecompute(ox, oy, null, null);
    histPush();
  }
  function editMoveSelected(px, py) {
    if (!S.designMode || !selMeshRef) return;
    const tr = meshToTree(selMeshRef); if (!tr) return;
    if (!tr._home) { tr._home = tr.piv.position.clone(); tr._homePos = tr.t.pos.slice(); }
    const ox = tr.t.pos[0], oy = tr.t.pos[1];
    tr.piv.position.x += (px - ox); tr.piv.position.z += (oy - py);
    tr.t.pos = [px, py]; tr.mesh.userData.pos = [px, py];
    affectedRecompute(ox, oy, px, py);
    histPush();
  }
  function editAddTree(species, px, py, defer) {
    if (!S.designMode) return null;
    // A species with no sample in this site's geometry has nothing to clone AND no
    // entry in the site's care table — so fall back to a species the site really
    // has, and RELABEL the tree to match. Never record a species the site lacks.
    let sample = speciesSample[species];
    if (!sample) {
      const k = Object.keys(speciesSample)[0];
      sample = speciesSample[k];
      species = k;
    }
    if (!sample) return null;
    const sp = SPECIES[species] || {};
    const piv = sample.piv.clone(true);
    const sPos = sample.t.pos;
    piv.position.x += (px - sPos[0]); piv.position.z += (sPos[1] - py);
    piv.scale.setScalar(1); piv.visible = true;
    const T = mixP < 0.5 ? treesA : treesB;
    T.grp.add(piv);
    const mesh = piv.children.find(c => c.isMesh);
    // Rebind the clone to the TARGET group's shared materials. speciesSample is
    // populated baseline-first, so a clone usually carries treesA's materials; in the
    // proposed state those sit at opacity 0 but still depth-write — the planted tree
    // rendered as a tree-shaped WHITE hole (invisible fill punching through the scene).
    for (const c of piv.children) {
      if (c.isLineSegments2 || c.isLine) c.material = T.edgeMat; // fat-line ink edges (NB: LineSegments2.isMesh is true)
      else if (c.isMesh) c.material = T.mat;
    }
    const t = { pos: [px, py], species, height: sp.h || sample.t.height, radius: sp.r || sample.t.radius, hull: sample.t.hull };
    if (mesh) mesh.userData = { species, height: t.height, radius: t.radius, pos: [px, py] };
    const tr = { piv, mesh, t, _added: true, plantAt: 0.55 };
    T.trees.push(tr); ed.added.push(tr);
    if (S.rendered && mesh) rApplyTree(tr, T); // stay in the rendered look — no white sketch tree
    if (!defer) { affectedRecompute(px, py, px, py); histPush(); }
    return tr;
  }
  function editSwapSelected(species) {
    if (!S.designMode || !selMeshRef) return;
    const tr = meshToTree(selMeshRef); if (!tr) return;
    const px = tr.t.pos[0], py = tr.t.pos[1];
    tr._del = true; tr.piv.visible = false;
    const nt = editAddTree(species, px, py);
    selMeshRef = nt ? nt.mesh : null;
    if (nt) { // re-outline the new tree as selected
      selEdge.geometry.dispose(); selEdge.geometry = new THREE.EdgesGeometry(nt.mesh.geometry, 20);
      selEdge.position.copy(nt.mesh.parent.position).add(nt.mesh.position); selEdge.visible = true;
    }
  }
  function editReset() {
    if (!S.designMode) return;
    plantingClear(); if (batchJob) { batchJob.cancel = true; batchJob = null; }
    const T = mixP < 0.5 ? treesA : treesB;
    for (const tr of ed.added) { tr.piv.visible = false; tr._del = true; }
    for (const tr of T.trees) {
      if (tr._added) continue;
      tr._del = false; tr.piv.visible = true;
      if (tr._home) { tr.piv.position.copy(tr._home); tr.t.pos = tr._homePos.slice(); tr.mesh.userData.pos = tr._homePos.slice(); }
    }
    const st = stateKey(), d = D[st];
    d.pRed = Float32Array.from(d.red); d.pLoad = Float32Array.from(d.load);
    ed.pBaseDone = new Uint8Array(d.n); ed.base = proxyTrees();
    clearSelection(); selMeshRef = null;
    activeMosaicColors(); refreshEditField(st); emitPreviewStats();
    histPush();
  }
  // ---- PLANTING TYPOLOGIES (pattern brush: row / grid / stagger / grove) ------------
  // A typology is a brush, not a group: the gesture GENERATES normal editable trees.
  // Positions falling in buildings/off-site are dropped (not clamped) — a pattern drawn
  // across a building honestly has a hole. Seeded RNG so a given stroke is reproducible.
  const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const MAXP = 220; // per-stroke cap keeps the proxy recompute honest-fast
  function ruleSpecies(rule, i, rowIdx, rnd) {
    const fallback = Object.keys(speciesSample)[0] || Object.keys(SPECIES)[0];
    const list = (rule && rule.list && rule.list.length) ? rule.list : [fallback];
    if (!rule || rule.mode === 'single' || list.length === 1) return list[0];
    if (rule.mode === 'alt') return list[(rowIdx != null ? rowIdx : i) % list.length]; // rows alternate in grids, positions in rows
    return list[Math.floor(rnd() * list.length)]; // mix — equal shares, seeded
  }
  function genPlanting(spec) {
    const rnd = mulberry(spec.seed || 1);
    const out = [], jit = spec.jitter || 0;
    const push = (x, y, i, rowIdx) => {
      if (out.length >= MAXP) return;
      const jx = x + (rnd() - 0.5) * 2 * jit, jy = y + (rnd() - 0.5) * 2 * jit;
      if (!walkableXY(jx, jy)) return;
      out.push({ x: jx, y: jy, species: ruleSpecies(spec.rule, i, rowIdx, rnd) });
    };
    const ax = spec.ax, ay = spec.ay, bx = spec.bx, by = spec.by;
    if (spec.type === 'row') {
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      if (len < 0.6) return out;
      const sp = Math.max(1.5, spec.spacing || 6), n = Math.min(MAXP, Math.floor(len / sp) + 1);
      for (let i = 0; i < n; i++) push(ax + dx * (i * sp / len), ay + dy * (i * sp / len), i, null);
    } else if (spec.type === 'grid' || spec.type === 'stagger') {
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
      const sp = Math.max(2, spec.spacing || 6);
      const nx = Math.floor((x1 - x0) / sp) + 1, ny = Math.floor((y1 - y0) / sp) + 1;
      const ox = (x1 - x0 - (nx - 1) * sp) / 2, oy = (y1 - y0 - (ny - 1) * sp) / 2; // centre in the drawn rect
      let i = 0;
      for (let ry = 0; ry < ny; ry++) for (let rx = 0; rx < nx; rx++) {
        let px = x0 + ox + rx * sp;
        if (spec.type === 'stagger' && (ry % 2)) { px += sp / 2; if (px > x1) continue; } // quincunx offset
        push(px, y0 + oy + ry * sp, i++, ry);
      }
    } else if (spec.type === 'grove') {
      const R = Math.max(3, Math.hypot(bx - ax, by - ay));
      const dens = spec.density || 8;
      const want = Math.max(1, Math.min(MAXP, Math.round(dens * Math.PI * R * R / 100)));
      const loose = spec.looseness != null ? spec.looseness : 0.6;
      const minSp = 2 + (1 - loose) * 1.6, falloff = 0.3;
      const pts = []; let i = 0;
      for (let a = 0; a < want * 30 && pts.length < want; a++) {
        const u = rnd(), th = rnd() * Math.PI * 2, r = R * Math.sqrt(u);
        if (rnd() < falloff * (r / R) * (r / R)) continue; // density thins toward the edge
        const x = ax + Math.cos(th) * r, y = ay + Math.sin(th) * r;
        let ok = true;
        for (const p of pts) if ((p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y) < minSp * minSp) { ok = false; break; }
        if (!ok) continue;
        pts.push([x, y]);
      }
      for (const p of pts) push(p[0], p[1], i++, null);
    }
    return out;
  }
  // ghost preview: one canopy-radius ring per generated position, live during the drag
  const ghostMat = new THREE.LineBasicMaterial({ color: 0x17150f, transparent: true, opacity: 0.5 });
  const ghost = new THREE.LineSegments(new THREE.BufferGeometry(), ghostMat);
  ghost.visible = false; ghost.renderOrder = 7; ghost.frustumCulled = false;
  scene.add(ghost);
  function plantingPreview(spec) {
    const pts = genPlanting(spec);
    const seg = 14, arr = new Float32Array(pts.length * seg * 6);
    let o = 0;
    for (const p of pts) {
      const R = SPECIES[p.species] ? SPECIES[p.species].r : 2.5;
      for (let i = 0; i < seg; i++) {
        const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
        arr[o++] = p.x + Math.cos(a0) * R; arr[o++] = 0.4; arr[o++] = -(p.y + Math.sin(a0) * R);
        arr[o++] = p.x + Math.cos(a1) * R; arr[o++] = 0.4; arr[o++] = -(p.y + Math.sin(a1) * R);
      }
    }
    ghost.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    ghost.geometry = g;
    ghost.visible = pts.length > 0;
    return { count: pts.length, capped: pts.length >= MAXP };
  }
  function plantingClear() { ghost.visible = false; }
  let plantingSeq = 0;
  const plantings = {}; // id -> committed spec (gesture + params + rule) — re-tune regenerates from this
  function removeAddedTree(tr, T) {
    T.grp.remove(tr.piv);
    const ti = T.trees.indexOf(tr); if (ti >= 0) T.trees.splice(ti, 1);
    if (ed) { const ai = ed.added.indexOf(tr); if (ai >= 0) ed.added.splice(ai, 1); }
  }
  function plantingCommit(spec) {
    if (!S.designMode) return { count: 0 };
    const pts = genPlanting(spec);
    plantingClear();
    if (!pts.length) return { count: 0 };
    const id = ++plantingSeq;
    const st = stateKey(), idxs = new Set();
    for (const p of pts) {
      const tr = editAddTree(p.species, p.x, p.y, true); // defer: one batched recompute below
      if (tr) tr._pid = id;
      for (const i of gather(st, p.x, p.y, 16)) idxs.add(i);
    }
    batchRecompute(idxs);
    plantings[id] = spec;
    histPush();
    return { count: pts.length, id, capped: pts.length >= MAXP };
  }
  function plantingSpec(id) { return plantings[id] || null; }
  // re-tune: same drawn gesture, new params/species — delete + regenerate under one id.
  // No history push here: a slider session marks history once, via historyMark() on DONE.
  function plantingRetune(id, spec) {
    if (!S.designMode || !id) return { count: 0 };
    const T = mixP < 0.5 ? treesA : treesB;
    const st = stateKey(), idxs = new Set();
    for (let i = T.trees.length - 1; i >= 0; i--) {
      const tr = T.trees[i];
      if (tr._pid !== id) continue;
      if (!tr._del) for (const k of gather(st, tr.t.pos[0], tr.t.pos[1], 16)) idxs.add(k);
      removeAddedTree(tr, T);
    }
    const pts = genPlanting(spec);
    for (const p of pts) {
      const tr = editAddTree(p.species, p.x, p.y, true);
      if (tr) tr._pid = id;
      for (const k of gather(st, p.x, p.y, 16)) idxs.add(k);
    }
    plantings[id] = spec;
    clearSelection(); selMeshRef = null;
    batchRecompute(idxs);
    return { count: pts.length, id };
  }
  function editDeletePlanting(id) {
    if (!S.designMode || !id) return 0;
    const T = mixP < 0.5 ? treesA : treesB;
    const st = stateKey(), idxs = new Set(); let n = 0;
    for (const tr of T.trees) {
      if (tr._pid !== id || tr._del) continue;
      tr._del = true; tr.piv.visible = false; n++;
      for (const i of gather(st, tr.t.pos[0], tr.t.pos[1], 16)) idxs.add(i);
    }
    clearSelection(); selMeshRef = null;
    batchRecompute(idxs);
    delete plantings[id];
    histPush();
    return n;
  }

  // ---- §5 cluster-aware removal of EXISTING trees -----------------------------------
  // Existing (surveyed/authored) trees group by canopy proximity — the grove idea the
  // liveliness lane-exclusion used. Isolated trees stay trivial (no id; the tree card
  // covers them). Hulls draw faintly in design mode; the selected cluster's hull goes
  // vermilion. Ops: remove whole cluster / thin by % (spatially even farthest-point
  // order, ghost preview before commit) / manual per-tree toggle (deleted trees show
  // as pale ghosts while manual is armed) / reset cluster to its simulated state.
  // Every removal runs the same preview proxy + history as any other edit.
  const CLUSTER_SLACK = 2.5; // m beyond canopy touch that still reads as one grove
  const GHOST_TINT = [0.93, 0.91, 0.87];
  const clusterData = {}; // st -> { list: [{id, idxs, hull}] }
  const clusterViz = {};  // st -> { grp, lines:{id:Line}, fills:[Mesh] }
  function clusterTrees(st) { return st === 'baseline' ? treesA : treesB; }
  function clustersFor(st) {
    if (clusterData[st]) return clusterData[st];
    const T = clusterTrees(st);
    const items = [];
    T.trees.forEach((tr, i) => { if (!tr._added) items.push(i); });
    const n = items.length;
    const parent = items.map((_, i) => i);
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (let a = 0; a < n; a++) {
      const ta = T.trees[items[a]].t;
      for (let b = a + 1; b < n; b++) {
        const tb = T.trees[items[b]].t;
        const dx = ta.pos[0] - tb.pos[0], dy = ta.pos[1] - tb.pos[1];
        const lim = (ta.radius || 2) + (tb.radius || 2) + CLUSTER_SLACK;
        if (dx * dx + dy * dy <= lim * lim) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
      }
    }
    const groups = {};
    for (let a = 0; a < n; a++) { const r = find(a); (groups[r] = groups[r] || []).push(items[a]); }
    const list = []; let id = 0;
    for (const k in groups) {
      const idxs = groups[k];
      if (idxs.length < 2) continue;
      id++;
      for (const i of idxs) T.trees[i]._cluster = id;
      list.push({ id, idxs, hull: clusterHull(T, idxs) });
    }
    clusterData[st] = { list };
    return clusterData[st];
  }
  function clusterHull(T, idxs) {
    // convex hull (monotone chain) over 8 samples of each canopy circle, padded tight
    const pts = [];
    for (const i of idxs) {
      const t = T.trees[i].t, r = (t.radius || 2) + 1.0;
      for (let a = 0; a < 8; a++) pts.push([t.pos[0] + r * Math.cos(a * Math.PI / 4), t.pos[1] + r * Math.sin(a * Math.PI / 4)]);
    }
    pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }
  function clusterVizFor(st) {
    if (clusterViz[st]) return clusterViz[st];
    const C = clustersFor(st);
    const grp = new THREE.Group();
    grp.visible = false;
    const lines = {}, fills = [];
    for (const cl of C.list) {
      // fat dashed ink loop — constant screen weight, drawn over the model like a
      // drafting mark-up (annotation layer, not part of the drawing)
      const segPts = [];
      for (let i2 = 0; i2 < cl.hull.length; i2++) {
        const a2 = cl.hull[i2], b2 = cl.hull[(i2 + 1) % cl.hull.length];
        segPts.push(a2[0], 0.22, -a2[1], b2[0], 0.22, -b2[1]);
      }
      const srcGeo = new THREE.BufferGeometry();
      srcGeo.setAttribute('position', new THREE.Float32BufferAttribute(segPts, 3));
      const lmat = fatMat(0x17150f, 1.7, 0);
      lmat.depthTest = false;
      const line = fatSeg(srcGeo, lmat);
      if (line.computeLineDistances) line.computeLineDistances();
      line.renderOrder = 8;
      grp.add(line); lines[cl.id] = line;
      // ray-only pick region: a disc per tree (canopy + small pad), NOT the filled convex
      // hull. The union of discs hugs the actual trees, so open grass BETWEEN spread-out
      // trees inside the hull is not claimed by the cluster — it stays hoverable/plantable.
      const CT = clusterTrees(st);
      for (const i of cl.idxs) {
        const t = CT.trees[i].t, r = (t.radius || 2) + 1.6;
        const cg = new THREE.CircleGeometry(r, 20); cg.rotateX(-Math.PI / 2);
        const disc = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false, side: THREE.DoubleSide }));
        disc.position.set(t.pos[0], 0.18, -t.pos[1]); disc.userData.clusterId = cl.id;
        grp.add(disc); fills.push(disc);
      }
    }
    scene.add(grp);
    clusterViz[st] = { grp, lines, fills };
    return clusterViz[st];
  }
  let clusterSel = null, clusterManual = null, clusterHover = null;
  function paintClusterLines() {
    const V = clusterViz[stateKey()];
    if (!V) return;
    for (const k in V.lines) {
      const sel = +k === clusterSel, hov = +k === clusterHover;
      V.lines[k].material.color.set(sel ? 0xe2452d : 0x17150f);
      // rest = invisible; the grove outline is a hover/selection reveal, not permanent chrome
      V.lines[k].material.opacity = sel ? 0.95 : (hov ? 0.85 : 0);
    }
  }
  function setClusterHover(id) {
    const next = id || null;
    if (next === clusterHover) return;
    clusterHover = next;
    paintClusterLines();
  }
  function syncClusterViz() {
    const st = stateKey();
    const show = !!S.designMode && !peeking && !S.walk && !fw.active;
    for (const s2 of STATES) if (clusterViz[s2]) clusterViz[s2].grp.visible = show && s2 === st;
    if (show) clusterVizFor(st).grp.visible = true;
  }
  function setClusterSelected(id) {
    clusterSel = id || null;
    paintClusterLines();
  }
  function clusterById(st, id) { return clustersFor(st).list.find(c => c.id === id) || null; }
  function clusterInfo(id) {
    const st = stateKey(), cl = clusterById(st, id);
    if (!cl) return null;
    const T = clusterTrees(st), species = {};
    let active = 0;
    for (const i of cl.idxs) { const tr = T.trees[i]; if (!tr._del) { active++; species[tr.t.species] = (species[tr.t.species] || 0) + 1; } }
    return { id, total: cl.idxs.length, active, species };
  }
  function thinOrder(st, cl) {
    // farthest-point order over ACTIVE trees: first kept = most central, each next =
    // farthest from everything kept. Dropping the TAIL removes a spatially even
    // subset, so the cluster thins without clearing one side.
    const T = clusterTrees(st);
    const act = cl.idxs.filter(i => !T.trees[i]._del);
    const P = act.map(i => T.trees[i].t.pos);
    const n = P.length; if (!n) return [];
    let cx = 0, cy = 0; for (const p of P) { cx += p[0]; cy += p[1]; } cx /= n; cy /= n;
    let first = 0, best = Infinity;
    for (let i = 0; i < n; i++) { const d2 = (P[i][0] - cx) * (P[i][0] - cx) + (P[i][1] - cy) * (P[i][1] - cy); if (d2 < best) { best = d2; first = i; } }
    const order = [first], used = new Uint8Array(n); used[first] = 1;
    const mind = new Float64Array(n).fill(Infinity);
    for (let step = 1; step < n; step++) {
      const last = P[order[order.length - 1]];
      let pick = -1, pbest = -1;
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        const d2 = (P[i][0] - last[0]) * (P[i][0] - last[0]) + (P[i][1] - last[1]) * (P[i][1] - last[1]);
        if (d2 < mind[i]) mind[i] = d2;
        if (mind[i] > pbest) { pbest = mind[i]; pick = i; }
      }
      used[pick] = 1; order.push(pick);
    }
    return order.map(i => act[i]);
  }
  let thinGhost = null; // { st, id, idxs }
  function clusterThinClear() {
    if (!thinGhost) return;
    const T = clusterTrees(thinGhost.st);
    for (const i of thinGhost.idxs) treeRestore(T.trees[i]);
    thinGhost = null;
  }
  function clusterThinPreview(id, frac) {
    if (!S.designMode) return { remove: 0, total: 0 };
    const st = stateKey(), cl = clusterById(st, id);
    clusterThinClear();
    if (!cl) return { remove: 0, total: 0 };
    const T = clusterTrees(st);
    const order = thinOrder(st, cl), total = order.length;
    const nRem = Math.round(Math.max(0, Math.min(1, frac)) * total);
    const rem = nRem ? order.slice(total - nRem) : [];
    for (const i of rem) treeSetTint(T.trees[i], GHOST_TINT[0], GHOST_TINT[1], GHOST_TINT[2]);
    thinGhost = { st, id, idxs: rem };
    return { remove: rem.length, total };
  }
  function removeClusterTrees(st, idxs) {
    const T = clusterTrees(st), sens = new Set();
    let n = 0;
    for (const i of idxs) {
      const tr = T.trees[i];
      if (tr._del) continue;
      tr._del = true; tr.piv.visible = false; n++;
      for (const k of gather(st, tr.t.pos[0], tr.t.pos[1], 16)) sens.add(k);
    }
    if (n) { clearSelection(); selMeshRef = null; batchRecompute(sens); histPush(); }
    return n;
  }
  function clusterThinCommit(id, frac) {
    if (!S.designMode) return 0;
    clusterThinPreview(id, frac);
    const rem = thinGhost ? thinGhost.idxs.slice() : [];
    clusterThinClear();
    return removeClusterTrees(stateKey(), rem);
  }
  function clusterRemove(id) {
    if (!S.designMode) return 0;
    clusterThinClear();
    const st = stateKey(), cl = clusterById(st, id);
    if (!cl) return 0;
    const T = clusterTrees(st);
    return removeClusterTrees(st, cl.idxs.filter(i => !T.trees[i]._del));
  }
  function clusterReset(id) {
    if (!S.designMode) return 0;
    clusterThinClear();
    const st = stateKey(), cl = clusterById(st, id);
    if (!cl) return 0;
    const T = clusterTrees(st), sens = new Set();
    let n = 0;
    for (const i of cl.idxs) {
      const tr = T.trees[i];
      let touched = false;
      if (tr._del) { tr._del = false; tr.piv.visible = true; treeRestore(tr); touched = true; }
      if (tr._home && !tr.piv.position.equals(tr._home)) {
        for (const k of gather(st, tr.t.pos[0], tr.t.pos[1], 16)) sens.add(k);
        tr.piv.position.copy(tr._home); tr.t.pos = tr._homePos.slice(); if (tr.mesh) tr.mesh.userData.pos = tr._homePos.slice();
        touched = true;
      }
      if (touched) { n++; for (const k of gather(st, tr.t.pos[0], tr.t.pos[1], 16)) sens.add(k); }
    }
    if (n) { batchRecompute(sens); histPush(); }
    return n;
  }
  // manual mode: deleted cluster trees show as pale ghosts so clicks can TOGGLE both ways
  function setClusterManual(id) {
    const st = stateKey(), T = clusterTrees(st);
    if (clusterManual) {
      const prev = clusterById(st, clusterManual);
      if (prev) for (const i of prev.idxs) { const tr = T.trees[i]; if (tr._del) { tr.piv.visible = false; treeRestore(tr); } }
    }
    clusterManual = id || null;
    clusterThinClear();
    if (clusterManual) {
      const cl = clusterById(st, clusterManual);
      if (cl) for (const i of cl.idxs) { const tr = T.trees[i]; if (tr._del) { tr.piv.visible = true; treeSetTint(tr, GHOST_TINT[0], GHOST_TINT[1], GHOST_TINT[2]); } }
    }
  }
  function clusterManualToggle(mesh) {
    const st = stateKey(), T = clusterTrees(st);
    const tr = meshToTree(mesh);
    if (!tr || tr._added || tr._cluster !== clusterManual) return false;
    const x = tr.t.pos[0], y = tr.t.pos[1];
    if (!tr._del) { tr._del = true; treeSetTint(tr, GHOST_TINT[0], GHOST_TINT[1], GHOST_TINT[2]); } // stays visible as a ghost
    else { tr._del = false; treeRestore(tr); }
    affectedRecompute(x, y, null, null);
    histPush();
    cb.onClusterChange && cb.onClusterChange(clusterInfo(clusterManual));
    return true;
  }

  // ---- UNDO / REDO (design mode) ---------------------------------------------------
  // Snapshot = trees only (original mods + added trees + planting specs). Applying a
  // snapshot diffs against the live scene and re-runs the shade proxy over just the
  // changed region — an undo costs what the edit it reverses cost, and the field is
  // always recomputed, never restored stale.
  let hist = [], histAt = -1;
  function snapTrees() {
    const T = mixP < 0.5 ? treesA : treesB;
    const orig = [], added = [];
    for (const tr of T.trees) {
      if (tr._added) { if (!tr._del) added.push({ species: tr.t.species, x: tr.t.pos[0], y: tr.t.pos[1], pid: tr._pid || null }); }
      else orig.push({ del: !!tr._del, x: tr.t.pos[0], y: tr.t.pos[1] });
    }
    return { orig, added, plantings: JSON.parse(JSON.stringify(plantings)) };
  }
  function emitHist() { cb.onHistory && cb.onHistory({ canUndo: histAt > 0, canRedo: histAt < hist.length - 1 }); }
  function histPush() {
    if (!S.designMode) return;
    hist.length = histAt + 1;
    hist.push(snapTrees()); histAt = hist.length - 1;
    if (hist.length > 40) { hist.shift(); histAt--; }
    emitHist();
  }
  function historyMark() { // end of a live re-tune session
    histPush();
  }
  function applySnap(snap) {
    const T = mixP < 0.5 ? treesA : treesB;
    const st = stateKey(), idxs = new Set();
    const mark = (x, y) => { for (const k of gather(st, x, y, 16)) idxs.add(k); };
    // originals: restore del + position where they differ
    let oi = 0;
    for (const tr of T.trees) {
      if (tr._added) continue;
      const o = snap.orig[oi++]; if (!o) continue;
      const changed = (!!tr._del) !== o.del || tr.t.pos[0] !== o.x || tr.t.pos[1] !== o.y;
      if (!changed) continue;
      mark(tr.t.pos[0], tr.t.pos[1]); mark(o.x, o.y);
      tr.piv.position.x += (o.x - tr.t.pos[0]); tr.piv.position.z += (tr.t.pos[1] - o.y);
      tr.t.pos = [o.x, o.y]; if (tr.mesh) tr.mesh.userData.pos = [o.x, o.y];
      tr._del = o.del; tr.piv.visible = !o.del;
    }
    // added: rebuild from the snapshot
    for (let i = T.trees.length - 1; i >= 0; i--) {
      const tr = T.trees[i];
      if (!tr._added) continue;
      if (!tr._del) mark(tr.t.pos[0], tr.t.pos[1]);
      removeAddedTree(tr, T);
    }
    for (const a of snap.added) {
      const tr = editAddTree(a.species, a.x, a.y, true);
      if (tr) tr._pid = a.pid;
      mark(a.x, a.y);
    }
    for (const k in plantings) delete plantings[k];
    Object.assign(plantings, JSON.parse(JSON.stringify(snap.plantings)));
    clearSelection(); selMeshRef = null;
    plantingClear();
    batchRecompute(idxs);
  }
  function undo() { if (!S.designMode || histAt <= 0) return false; histAt--; applySnap(hist[histAt]); emitHist(); return true; }
  function redo() { if (!S.designMode || histAt >= hist.length - 1) return false; histAt++; applySnap(hist[histAt]); emitHist(); return true; }

  function exportScenario(name) {
    const T = mixP < 0.5 ? treesA : treesB, trees = [];
    for (const tr of T.trees) { if (tr._del) continue; trees.push({ species: tr.t.species, x: +tr.t.pos[0].toFixed(2), y: +tr.t.pos[1].toFixed(2) }); }
    return { name: name || 'untitled', baseState: stateKey(), trees, note: 'Edited geometry for a real thermal simulation run. Shade previewed via proxy; all five metrics filled in by the sim.' };
  }

  // Full edited design for file export (spec: uploads/export_spec.md) — trees with
  // dims, deletions from the source state, and site bounds for the coordinate transform.
  function exportDesign() {
    const T = mixP < 0.5 ? treesA : treesB, trees = [], removed = [];
    for (const tr of T.trees) {
      if (tr._del) { if (!tr._added) removed.push({ species: tr.t.species, x: +tr.t.pos[0].toFixed(2), y: +tr.t.pos[1].toFixed(2) }); continue; }
      trees.push({ species: tr.t.species, x: +tr.t.pos[0].toFixed(2), y: +tr.t.pos[1].toFixed(2), height: +(+tr.t.height || 10).toFixed(1), radius: +(+tr.t.radius || 2).toFixed(1) });
    }
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const k of ['baseline', 'scenario_01']) {
      const d = D[k];
      for (let i = 0; i < d.n; i++) {
        if (d.x[i] < x0) x0 = d.x[i]; if (d.x[i] > x1) x1 = d.x[i];
        if (d.y[i] < y0) y0 = d.y[i]; if (d.y[i] > y1) y1 = d.y[i];
      }
    }
    return { baseState: stateKey(), trees, removed, bounds: { x0: +x0.toFixed(2), y0: +y0.toFixed(2), x1: +x1.toFixed(2), y1: +y1.toFixed(2) } };
  }

  // ---- design accounting (spec: Costs & Maintenance) --------------------------
  // Net of the CURRENT design vs. the source state: trees added / removed by
  // species, plus per-planting-group breakdown keyed to plantingId. Pure counts —
  // no cost logic lives here (that is a lookup table in the UI layer, deliberately
  // kept out of the engine so it can never be mistaken for a simulated value).
  const PLANTING_LABEL = { row: 'Allée / row', grid: 'Grid planting', stagger: 'Staggered grid', grove: 'Grove' };
  function plantingLabelFor(spec) {
    if (!spec) return 'Planting';
    const base = PLANTING_LABEL[spec.type] || 'Planting';
    const list = spec.rule && spec.rule.list;
    return list && list.length ? base + ' · ' + list.join(' + ') : base;
  }
  function designAccounting() {
    const T = mixP < 0.5 ? treesA : treesB;
    const addedBySpecies = {}, removedBySpecies = {}, groups = {};
    let added = 0, removed = 0;
    for (const tr of T.trees) {
      const sp = tr.t.species;
      if (tr._added) {
        if (tr._del) continue;
        added++; addedBySpecies[sp] = (addedBySpecies[sp] || 0) + 1;
        if (tr._pid) {
          const g = groups[tr._pid] || (groups[tr._pid] = { species: {}, count: 0 });
          g.species[sp] = (g.species[sp] || 0) + 1; g.count++;
        }
      } else if (tr._del) {
        removed++; removedBySpecies[sp] = (removedBySpecies[sp] || 0) + 1;
      }
    }
    const plantings_ = Object.keys(groups).map(id => ({
      id, label: plantingLabelFor(plantings[id]), count: groups[id].count, species: groups[id].species
    })).sort((a, b) => b.count - a.count);
    return { state: stateKey(), added, removed, addedBySpecies, removedBySpecies, plantings: plantings_, plantingCount: plantings_.length };
  }

  // ---- SECTION VIEW (spec: uploads/section_view_spec.md) ----------------------
  // A flat orthographic cut. This returns everything a 2D ink drawing needs — no
  // Three.js cut scene: the section lives in the sketch aesthetic and is cheapest
  // (and most beautiful) drawn on a canvas from these numbers. No new data.
  const _bldH = new WeakMap();
  function buildingHeight(b) {
    if (_bldH.has(b)) return _bldH.get(b);
    let h = 12;
    try { const box = new THREE.Box3().setFromObject(b.mesh); if (isFinite(box.max.y)) h = Math.max(4, box.max.y - Math.max(0, box.min.y)); } catch (e) {}
    _bldH.set(b, h); return h;
  }
  // content-aware default cut: the longest horizontal line through the tree centroid
  // of the given state (never a bare-ground slice). Falls back to the site mid-line.
  function defaultCut(st) {
    const T = st === 'scenario_01' ? treesB : treesA;
    let sy = 0, n = 0;
    for (const tr of T.trees) { if (tr._del) continue; sy += tr.t.pos[1]; n++; }
    const yc = n ? sy / n : (SITE.y0 + SITE.y1) / 2;
    return { ax: SITE.x0 + 4, ay: yc, bx: SITE.x1 - 4, by: yc };
  }
  // authored named cuts — the "plates" of the drawing set, hand-placed to make the
  // project's arguments. Horizontal lines (constant y) sweeping the whole width.
  const AUTHORED_CUTS = [
    { id: 'commons', name: 'Through the new commons', ax: 4, ay: -60, bx: 211, by: -60 },
    { id: 'parking', name: 'Across the parking', ax: 4, ay: -30, bx: 211, by: -30 },
    { id: 'corridor', name: 'Along the path corridor', ax: 4, ay: -95, bx: 211, by: -95 }
  ];
  function sectionCuts() { return AUTHORED_CUTS.map(c => ({ id: c.id, name: c.name })); }
  function sectionCutById(id) { return AUTHORED_CUTS.find(c => c.id === id) || null; }
  // A–A′ cut marker drawn on the ground of the iso/plan model, so the user always sees
  // where the section is cut and can relate the elevation to the plan (spec §3.5).
  var _sectionMarker = null;
  function setSectionMarker(cut, show) {
    if (!_sectionMarker) {
      _sectionMarker = new THREE.Group();
      _sectionMarker.renderOrder = 9;
      scene.add(_sectionMarker);
    }
    while (_sectionMarker.children.length) { const c = _sectionMarker.children.pop(); if (c.geometry) c.geometry.dispose(); }
    _sectionMarker.visible = !!show;
    if (!show || !cut) return;
    const Y = 0.35;
    const ext = 6; // run the marker a little past the site edge, like a real section line
    const dx = cut.bx - cut.ax, dy = cut.by - cut.ay, L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L;
    const ax = cut.ax - ux * ext, ay = cut.ay - uy * ext, bx = cut.bx + ux * ext, by = cut.by + uy * ext;
    // dashed ink line (world coords: x, y_site → three z = -y)
    const seg = [];
    const DASH = 3.2, GAP = 2.2; let d = 0; const total = Math.hypot(bx - ax, by - ay);
    while (d < total) {
      const d2 = Math.min(total, d + DASH);
      seg.push(ax + ux * d, Y, -(ay + uy * d), ax + ux * d2, Y, -(ay + uy * d2));
      d += DASH + GAP;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    const line = fatSeg(g, fatMat(0x8a857b, 2.0, 0.7)); if (line.computeLineDistances) line.computeLineDistances();
    line.material.depthTest = false; line.renderOrder = 9;
    _sectionMarker.add(line);
    // end ticks (perpendicular) marking A and A′
    const px = -uy, py = ux, tick = 4;
    for (const [ex, ey] of [[ax, ay], [bx, by]]) {
      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.Float32BufferAttribute([ex - px * tick, Y, -(ey - py * tick), ex + px * tick, Y, -(ey + py * tick)], 3));
      const tl = fatSeg(tg, fatMat(0x8a857b, 2.2, 0.7)); tl.material.depthTest = false; tl.renderOrder = 9;
      _sectionMarker.add(tl);
    }
  }
  // ---- section CUT PICKER: candidate grid on the ground (renders in BOTH iso and plan
  // because it lives in the 3D scene) + click-to-snap line selection + a look-direction
  // arrow. The user picks the cut here, sets which way it looks, then enters section.
  var _sectionGrid = null, _sectionPickG = null, _pick = null;
  const GRID_Y = [], GRID_X = [];
  for (let y = SITE.y0 + 8; y <= SITE.y1 - 5; y += 7) GRID_Y.push(y);
  for (let x = SITE.x0 + 10; x <= SITE.x1 - 7; x += 11) GRID_X.push(x);
  function sectionGridShow(on) {
    if (!_sectionGrid) {
      _sectionGrid = new THREE.Group(); _sectionGrid.renderOrder = 8; scene.add(_sectionGrid);
      const Y = 0.3, seg = [];
      for (const y of GRID_Y) seg.push(SITE.x0, Y, -y, SITE.x1, Y, -y);
      for (const x of GRID_X) seg.push(x, Y, -SITE.y0, x, Y, -SITE.y1);
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
      const line = fatSeg(g, fatMat(0x17150f, 1.0, 0)); line.material.opacity = 0.26; line.material.transparent = true; line.material.depthTest = false; line.renderOrder = 8;
      _sectionGrid.add(line);
      const bs = [SITE.x0, Y, -SITE.y0, SITE.x1, Y, -SITE.y0, SITE.x1, Y, -SITE.y0, SITE.x1, Y, -SITE.y1, SITE.x1, Y, -SITE.y1, SITE.x0, Y, -SITE.y1, SITE.x0, Y, -SITE.y1, SITE.x0, Y, -SITE.y0];
      const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(bs, 3));
      const bl = fatSeg(bg, fatMat(0x17150f, 1.5, 0)); bl.material.opacity = 0.42; bl.material.transparent = true; bl.material.depthTest = false; bl.renderOrder = 8;
      _sectionGrid.add(bl);
    }
    _sectionGrid.visible = !!on;
    if (!_sectionPickG) { _sectionPickG = new THREE.Group(); _sectionPickG.renderOrder = 10; scene.add(_sectionPickG); }
    _sectionPickG.visible = !!on;
    if (!on) { _pick = null; while (_sectionPickG.children.length) { const c = _sectionPickG.children.pop(); if (c.geometry) c.geometry.dispose(); } }
  }
  function _pickGround(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ptr.x = ((clientX - r.left) / r.width) * 2 - 1; ptr.y = -((clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ptr, activeCam);
    if (!ray.ray.intersectPlane(groundPlane, _hit)) return null;
    return { x: _hit.x, y: -_hit.z };
  }
  function _snapPick(gp) {
    let by = GRID_Y[0], bdy = 1e9; for (const y of GRID_Y) { const d = Math.abs(gp.y - y); if (d < bdy) { bdy = d; by = y; } }
    let bx = GRID_X[0], bdx = 1e9; for (const x of GRID_X) { const d = Math.abs(gp.x - x); if (d < bdx) { bdx = d; bx = x; } }
    return bdy <= bdx ? { orient: 'h', v: by, dist: bdy } : { orient: 'v', v: bx, dist: bdx };
  }
  function _cutFromPick(p) {
    return p.orient === 'h' ? { ax: SITE.x0, ay: p.v, bx: SITE.x1, by: p.v } : { ax: p.v, ay: SITE.y0, bx: p.v, by: SITE.y1 };
  }
  // default look-direction points INTO the site (toward the centre), so the arrow is
  // always on the ground and visible — never off the edge for near-boundary lines.
  function _defaultDir(orient, v) {
    const c = orient === 'h' ? (SITE.y0 + SITE.y1) / 2 : (SITE.x0 + SITE.x1) / 2;
    return v <= c ? 1 : -1;
  }
  function _drawPickLine(p, committed) {
    while (_sectionPickG.children.length) { const c = _sectionPickG.children.pop(); if (c.geometry) c.geometry.dispose(); }
    const Y = 0.42, cut = _cutFromPick(p), col = 0xffffff; // white for both hover and committed
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([cut.ax, Y, -cut.ay, cut.bx, Y, -cut.by], 3));
    const line = fatSeg(g, fatMat(col, committed ? 2.8 : 2.2, 0.95)); line.material.depthTest = false; line.renderOrder = 10; _sectionPickG.add(line);
    // look-direction arrow, perpendicular to the line at its midpoint
    const mx = (cut.ax + cut.bx) / 2, my = (cut.ay + cut.by) / 2;
    let nx = p.orient === 'h' ? 0 : 1, ny = p.orient === 'h' ? 1 : 0; nx *= p.dir; ny *= p.dir;
    const aL = 11, tipx = mx + nx * aL, tipy = my + ny * aL, perpx = -ny, perpy = nx;
    const as = [mx, Y, -my, tipx, Y, -tipy,
      tipx, Y, -tipy, tipx - nx * 3.2 + perpx * 2.6, Y, -(tipy - ny * 3.2 + perpy * 2.6),
      tipx, Y, -tipy, tipx - nx * 3.2 - perpx * 2.6, Y, -(tipy - ny * 3.2 - perpy * 2.6)];
    const ag = new THREE.BufferGeometry(); ag.setAttribute('position', new THREE.Float32BufferAttribute(as, 3));
    const al = fatSeg(ag, fatMat(col, 2.4, 0.95)); al.material.depthTest = false; al.renderOrder = 10; _sectionPickG.add(al);
  }
  function _clearPickPreview() { if (_sectionPickG) { while (_sectionPickG.children.length) { const c = _sectionPickG.children.pop(); if (c.geometry) c.geometry.dispose(); } } }
  function sectionPickHover(clientX, clientY) {
    if (!_sectionPickG || !_sectionPickG.visible || (_pick && _pick.committed)) return null;
    const gp = _pickGround(clientX, clientY); if (!gp) { _clearPickPreview(); return null; }
    const snap = _snapPick(gp);
    // only light up a line when the cursor is genuinely on it (a narrow band), so lines
    // highlight one at a time with clear gaps between — not "nearest line always on".
    const near = snap.dist <= 3.5;
    if (!near) { _clearPickPreview(); return null; }
    _drawPickLine({ orient: snap.orient, v: snap.v, dir: _defaultDir(snap.orient, snap.v) }, false);
    return { orient: snap.orient, over: true };
  }
  function sectionPickSelect(clientX, clientY) {
    const gp = _pickGround(clientX, clientY); if (!gp) return null;
    const snap = _snapPick(gp);
    if (snap.dist > 5) return null; // click must land on a line to place the cut
    _pick = { orient: snap.orient, v: snap.v, dir: _defaultDir(snap.orient, snap.v), committed: true };
    _drawPickLine(_pick, true);
    return { cut: _cutFromPick(_pick), orient: _pick.orient, dir: _pick.dir };
  }
  function sectionPickDir(dir) {
    if (!_pick) return null; _pick.dir = dir < 0 ? -1 : 1; _drawPickLine(_pick, true);
    return { cut: _cutFromPick(_pick), orient: _pick.orient, dir: _pick.dir };
  }
  function sectionPickCurrent() { return _pick ? { cut: _cutFromPick(_pick), orient: _pick.orient, dir: _pick.dir } : null; }
  function sectionPickReset() { _pick = null; if (_sectionPickG) { while (_sectionPickG.children.length) { const c = _sectionPickG.children.pop(); if (c.geometry) c.geometry.dispose(); } } }
  // project (px,py) onto the cut axis; returns { xd: distance along cut, off: perp signed }
  function projOnCut(cut, px, py) {
    const dx = cut.bx - cut.ax, dy = cut.by - cut.ay, L2 = dx * dx + dy * dy || 1;
    const t = ((px - cut.ax) * dx + (py - cut.ay) * dy) / L2;
    const projx = cut.ax + t * dx, projy = cut.ay + t * dy;
    const ox = px - projx, oy = py - projy;
    return { xd: t * Math.sqrt(L2), off: Math.hypot(ox, oy) };
  }
  // main section extract. cut: {ax,ay,bx,by}; band metres; metric key; opts.sample bins.
  function sectionData(cut, band, metricKey, opts2) {
    opts2 = opts2 || {};
    const B = band || 5;
    const m = metricKey || S.metric;
    const metric = METRICS[m] || METRICS.load;
    const isTreeMetric = metric.kind === 'tree';
    const useM = isTreeMetric ? 'load' : m;      // tree metrics have no ground spikes — fall to load
    const mm = METRICS[useM];
    const dom = mm.domain, ramp = mm.ramp;
    const curSt = stateKey();
    const L = Math.hypot(cut.bx - cut.ax, cut.by - cut.ay);
    const edited = !!(ed && ed.st === curSt && ed.added && (ed.added.some(t => !t._del) || (mixP < 0.5 ? treesA : treesB).trees.some(t => !t._added && t._del)));
    // ghost source per §2.1
    let ghostSt = null; // null = no ghost
    if (curSt === 'baseline') ghostSt = edited ? 'baseline' : null;
    else ghostSt = edited ? 'scenario_01' : 'baseline';
    const thermalGrey = isTreeMetric || (edited && (metric.status === 'pending' || metric.status === 'derivable'));

    // spikes — the single ROW OF SENSORS NEAREST the cut line (a true section sample,
    // not a projected band cloud). Bin along the cut; in each bin keep the sensor with
    // the smallest perpendicular offset. One clean spike per grid station along the line.
    const d = D[curSt];
    const spikes = [];
    const covStep = 3; // coverage bins (m) for break-don't-interpolate
    const cov = new Array(Math.ceil(L / covStep) + 1).fill(false);
    const PITCH = 1.9; // ≈ grid spacing — one representative spike per station
    const nb = Math.max(1, Math.ceil(L / PITCH));
    const best = new Array(nb).fill(null); // per bin: closest-to-line sensor
    for (let i = 0; i < d.n; i++) {
      const pr = projOnCut(cut, d.x[i], d.y[i]);
      if (pr.off > B || pr.xd < 0 || pr.xd > L) continue;
      const bi = Math.min(nb - 1, Math.floor(pr.xd / PITCH));
      if (!best[bi] || pr.off < best[bi].off) best[bi] = { i, xd: pr.xd, off: pr.off };
      const cb2 = Math.floor(pr.xd / covStep); if (cb2 >= 0 && cb2 < cov.length) cov[cb2] = true;
    }
    for (const b of best) {
      if (!b) continue;
      const i = b.i;
      const vSolid = metricValue(curSt, useM, i);
      const tSolid = clamp01((vSolid - dom[0]) / (dom[1] - dom[0]));
      let vGhost = null;
      if (ghostSt === curSt) { vGhost = (useM === 'reduction') ? d.red[i] : d.load[i]; }
      else if (ghostSt) { const gi = nearestSensor(ghostSt, d.x[i], d.y[i], 6.0); if (gi >= 0) { const dg = D[ghostSt]; vGhost = (useM === 'reduction') ? dg.red[gi] : dg.load[gi]; } }
      const tGhost = vGhost == null ? null : clamp01((vGhost - dom[0]) / (dom[1] - dom[0]));
      const warn = tGhost != null && tSolid > tGhost + 0.02; // solid taller than ghost = regression
      const c = ramp(tSolid);
      spikes.push({
        xd: +b.xd.toFixed(2), off: +b.off.toFixed(2),
        fade: +(1 - Math.min(1, b.off / B) * 0.4).toFixed(3),
        v: +vSolid.toFixed(1), t: +tSolid.toFixed(4),
        gt: tGhost == null ? null : +tGhost.toFixed(4), gv: vGhost == null ? null : +vGhost.toFixed(1),
        cat: CAT_LABEL[CATS[d.cat[i]]] || '', warn,
        rgb: [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)]
      });
    }
    spikes.sort((a, b) => a.xd - b.xd);

    // trees in band (current state), silhouettes
    const T = curSt === 'scenario_01' ? treesB : treesA;
    const trees = [];
    for (const tr of T.trees) {
      if (tr._del || !tr.piv.visible) continue;
      const pr = projOnCut(cut, tr.t.pos[0], tr.t.pos[1]);
      if (pr.off > B + (tr.t.radius || 2) || pr.xd < -5 || pr.xd > L + 5) continue;
      trees.push({ xd: +pr.xd.toFixed(2), h: +(tr.t.height || 10).toFixed(1), r: +(tr.t.radius || 2).toFixed(1), species: tr.t.species, added: !!tr._added, fade: +(1 - Math.min(1, pr.off / (B + 2)) * 0.6).toFixed(3), off: +pr.off.toFixed(2) });
    }
    trees.sort((a, b) => b.off - a.off); // far first, near last (painter's)

    // buildings in band → profile spans
    const bldSet = curSt === 'baseline' ? buildings : buildings.filter(b => b.shared);
    const blds = [];
    for (const b of bldSet) {
      const bb = b.bbox; // [x0,y0,x1,y1]
      // sample the footprint rectangle against the band: collect xd where corners/edge midpoints land in-band
      const corners = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]];
      let lo = Infinity, hi = -Infinity, any = false, minOff = Infinity;
      // dense edge sampling for a robust span
      const edgePts = [];
      for (let s = 0; s <= 1.0001; s += 0.1) { edgePts.push([bb[0] + (bb[2] - bb[0]) * s, bb[1]], [bb[0] + (bb[2] - bb[0]) * s, bb[3]], [bb[0], bb[1] + (bb[3] - bb[1]) * s], [bb[2], bb[1] + (bb[3] - bb[1]) * s]); }
      for (const [px, py] of edgePts.concat(corners)) {
        const pr = projOnCut(cut, px, py);
        if (pr.off <= B && pr.xd >= 0 && pr.xd <= L) { any = true; lo = Math.min(lo, pr.xd); hi = Math.max(hi, pr.xd); if (pr.off < minOff) minOff = pr.off; }
      }
      if (any && hi - lo > 0.4) { blds.push({ x0: +lo.toFixed(2), x1: +hi.toFixed(2), h: +buildingHeight(b).toFixed(1), shared: !!b.shared, name: b.name || '', off: +minOff.toFixed(2) }); }
    }

    // coverage runs → gaps where the datum + spikes break
    const gaps = [];
    let gs = -1;
    for (let k = 0; k < cov.length; k++) {
      if (!cov[k] && gs < 0) gs = k;
      else if (cov[k] && gs >= 0) { if ((k - gs) >= 2) gaps.push([+(gs * covStep).toFixed(1), +(k * covStep).toFixed(1)]); gs = -1; }
    }
    if (gs >= 0 && (cov.length - gs) >= 2) gaps.push([+(gs * covStep).toFixed(1), +L.toFixed(1)]);

    // look-direction: flip the reading left↔right so the drawing faces the chosen way
    if (opts2.flip) {
      for (const s of spikes) s.xd = +(L - s.xd).toFixed(2);
      spikes.sort((a, b) => a.xd - b.xd);
      for (const t of trees) t.xd = +(L - t.xd).toFixed(2);
      for (const b of blds) { const nx0 = L - b.x1, nx1 = L - b.x0; b.x0 = +nx0.toFixed(2); b.x1 = +nx1.toFixed(2); }
      for (const g of gaps) { const a = +(L - g[1]).toFixed(1), b = +(L - g[0]).toFixed(1); g[0] = a; g[1] = b; }
    }
    return {
      len: +L.toFixed(2), band: B, state: curSt, metric: m, metricLabel: (metric.chip || m),
      units: mm.units || '', edited, ghostState: ghostSt, thermalGrey,
      domain: [dom[0], dom[1]], rampStops: [0, 0.2, 0.4, 0.6, 0.8, 1].map(t => { const c = ramp(t); return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)]; }),
      spikes, trees, buildings: blds, gaps,
      cut: { ax: cut.ax, ay: cut.ay, bx: cut.bx, by: cut.by },
      site: { x0: SITE.x0, y0: SITE.y0, x1: SITE.x1, y1: SITE.y1 }
    };
  }

  // ============================================================================
  // LIVELINESS (spec: uploads/liveliness_spec.md) — static props, tree sway,
  // ambient walkers + cyclists. STRICTLY decorative: nothing here reads the
  // metric field, seeks shade, or reacts to data — wallpaper with legs.
  // Containment by construction: lane splines + prop placements were authored
  // against the surface polygons and verified at 1 m samples (circulation
  // categories only — concrete_path/asphalt_path/asphalt_road/unit_pavers/
  // asphalt_parking — outside building footprints and grove interiors, per
  // design state) by the 2026-07-07 authoring script. Sandbox phase only.
  // ============================================================================
  life = (() => {
    const INK = 0x17150f;
    let on = !(opts.params && opts.params.ambientLife === false); // ambientLife param
    let swayMult = (opts.params && opts.params.swayAmount != null) ? opts.params.swayAmount : 1;
    const MOTION = !RM; // reduced motion: props stay, sway + figures rest
    let sandbox = false;     // S.phase === 'sandbox'
    let leverHold = false;   // figures held out during a design-state lever
    let seedPending = false; // seed figures mid-lane on next update
    const root = new THREE.Group(); root.visible = false; scene.add(root);

    // ---- prop materials: one set per residency so stateMix can crossfade ----
    // fedge = constant screen-weight ink edges (same convention as trees/buildings)
    // so small true-scale props stay legible without cheating their size.
    function matset() {
      return {
        paper: new THREE.MeshBasicMaterial({ color: 0xf6f4ee, transparent: true }),
        mid:   new THREE.MeshBasicMaterial({ color: 0xd8d4c8, transparent: true }),
        ink:   new THREE.MeshBasicMaterial({ color: INK, transparent: true }),
        sage:  new THREE.MeshBasicMaterial({ color: 0xb9c2a4, transparent: true }),
        wood:  new THREE.MeshBasicMaterial({ color: 0xe3d2ae, transparent: true }),
        edge:  new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.9 }),
        fedge: fatMat(INK, 1.9, 0.95)
      };
    }
    const msShared = matset(), msBase = matset(), msScen = matset();
    const gShared = new THREE.Group(), gBase = new THREE.Group(), gScen = new THREE.Group();
    root.add(gShared, gBase, gScen);
    const box = (ms, mat, w, h, d, x, y, z, rx) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), ms[mat]);
      m.position.set(x, y, z); if (rx) m.rotation.x = rx;
      m.add(fatSeg(new THREE.EdgesGeometry(m.geometry, 20), ms.fedge));
      return m;
    };
    const cyl = (ms, mat, r, h, seg, x, y, z) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), ms[mat]);
      m.position.set(x, y, z); return m;
    };
    // prop builders — paper-model white + ink, scale sanity: bench 1.8 m
    const BUILDERS = {
      bench(ms) { const g = new THREE.Group();
        for (let i = 0; i < 3; i++) g.add(box(ms, 'wood', 1.8, 0.045, 0.13, 0, 0.44, -0.15 + i * 0.16)); // seat slats
        for (let i = 0; i < 2; i++) g.add(box(ms, 'wood', 1.8, 0.09, 0.045, 0, 0.58 + i * 0.14, -0.245, -0.12)); // back slats
        g.add(box(ms, 'ink', 0.06, 0.44, 0.42, -0.78, 0.22, 0));
        g.add(box(ms, 'ink', 0.06, 0.44, 0.42, 0.78, 0.22, 0)); return g; },
      picnic(ms) { const g = new THREE.Group();
        for (let i = 0; i < 3; i++) g.add(box(ms, 'wood', 1.8, 0.055, 0.25, 0, 0.72, -0.28 + i * 0.28)); // tabletop planks
        g.add(box(ms, 'wood', 1.8, 0.05, 0.28, 0, 0.44, 0.62));
        g.add(box(ms, 'wood', 1.8, 0.05, 0.28, 0, 0.44, -0.62));
        for (const sx of [-0.65, 0.65]) { // A-frame legs + cross brace
          g.add(box(ms, 'mid', 0.09, 0.78, 0.09, sx, 0.36, 0.33, 0.72));
          g.add(box(ms, 'mid', 0.09, 0.78, 0.09, sx, 0.36, -0.33, -0.72));
          g.add(box(ms, 'mid', 0.07, 0.06, 1.3, sx, 0.42, 0));
        } return g; },
      lamp(ms) { const g = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.07, 4.2, 8), ms.ink);
        pole.position.set(0, 2.1, 0); g.add(pole);
        const pg = new THREE.BufferGeometry();
        pg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 4.2, 0], 3));
        g.add(fatSeg(pg, ms.fedge)); // constant-weight ink pole so it never thins away
        const elbow = box(ms, 'ink', 0.06, 0.06, 0.4, 0, 4.3, 0.16); elbow.rotation.x = -0.6; g.add(elbow);
        g.add(box(ms, 'ink', 0.06, 0.06, 0.34, 0, 4.42, 0.44));
        g.add(box(ms, 'ink', 0.2, 0.1, 0.5, 0, 4.36, 0.5)); // luminaire housing
        const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.42), new THREE.MeshBasicMaterial({ color: 0xf6e7b0, transparent: true }));
        glow.rotation.x = Math.PI / 2; glow.position.set(0, 4.3, 0.5); glow.userData.mvSkip = true; g.add(glow);
        return g; },
      rack(ms) { const g = new THREE.Group();
        for (let i = -1; i <= 1; i++) {
          const h = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.035, 5, 12, Math.PI), ms.ink);
          h.rotation.y = Math.PI / 2; h.position.set(i * 0.7, 0.33, 0); g.add(h);
        } return g; },
      bollard(ms) { const g = new THREE.Group();
        g.add(cyl(ms, 'ink', 0.09, 0.72, 10, 0, 0.36, 0));
        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), ms.ink);
        cap.position.y = 0.72; g.add(cap); return g; },
      bin(ms) { const g = new THREE.Group();
        const bod = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.23, 0.72, 12), ms.mid);
        bod.position.y = 0.36; g.add(bod);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.285, 0.028, 6, 14), ms.ink);
        rim.rotation.x = Math.PI / 2; rim.position.y = 0.74; g.add(rim);
        const lid = new THREE.Mesh(new THREE.SphereGeometry(0.285, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), ms.ink);
        lid.scale.y = 0.55; lid.position.y = 0.75; g.add(lid);
        g.add(box(ms, 'ink', 0.3, 0.09, 0.06, 0, 0.82, 0.24)); // mouth flap
        return g; },
      planter(ms) { const g = new THREE.Group();
        g.add(box(ms, 'paper', 1.25, 0.5, 1.25, 0, 0.25, 0));
        g.add(box(ms, 'sage', 1.05, 0.22, 1.05, 0, 0.56, 0)); return g; }
    };
    // authored placements [kind, x, y, rotDeg, residency S|B|C]. Manifest-driven per site
    // (site.props); King's Road omits them -> the authored King's Road default array below.
    const PROPS = (site && site.props && site.props.length) ? site.props : [
      ['lamp', 105, -88.8, 0, 'S'], ['lamp', 125, -88.8, 0, 'S'], ['lamp', 145, -88.8, 0, 'S'], ['lamp', 165, -88.8, 0, 'S'], ['lamp', 185, -88.8, 0, 'S'], ['lamp', 205, -87.6, 0, 'S'],
      ['lamp', 15, -103.6, 180, 'S'], ['lamp', 35, -105.9, 180, 'S'], ['lamp', 55, -106.4, 180, 'S'], ['lamp', 75, -106.6, 180, 'S'],
      ['lamp', 120, -105.2, 180, 'S'], ['lamp', 160, -104.9, 180, 'S'], ['lamp', 200, -104.9, 180, 'S'],
      ['bench', 118, -92.9, 0, 'S'], ['bench', 142, -92.9, 0, 'S'], ['bench', 168, -92.9, 0, 'S'],
      ['bench', 130, -108.2, 180, 'S'],
      ['bench', 96.5, -45, 270, 'C'], ['bench', 96.5, -62, 270, 'C'],   // facing the new commons
      ['picnic', 62, -52, 20, 'C'], ['picnic', 70, -63, -15, 'C'], ['picnic', 57, -68, 40, 'C'],
      ['rack', 96.5, -35, 90, 'S'], ['rack', 91.5, -116, 90, 'S'],
      ['bollard', 93.2, -106.2, 0, 'S'], ['bollard', 95.6, -105.6, 0, 'S'], ['bollard', 9.3, -105.2, 0, 'S'], ['bollard', 9.3, -107.2, 0, 'S'],
      ['bin', 122, -92.9, 0, 'S'], ['bin', 153, -105.5, 0, 'S'], ['bin', 105.8, -16, 0, 'S'],
      ['planter', 97.5, -109, 0, 'S']
    ];
    for (const P of PROPS) {
      const ms = P[4] === 'B' ? msBase : P[4] === 'C' ? msScen : msShared;
      const parent = P[4] === 'B' ? gBase : P[4] === 'C' ? gScen : gShared;
      const g = BUILDERS[P[0]](ms);
      g.position.set(P[1], 0, -P[2]); g.rotation.y = P[3] * Math.PI / 180;
      parent.add(g);
    }
    function setOpacitySet(ms, k) {
      ms.paper.opacity = ms.mid.opacity = ms.ink.opacity = ms.sage.opacity = ms.wood.opacity = k;
      const ink = MVON ? 0 : 1; // MV walk style: prop ink edges off
      ms.edge.opacity = 0.9 * k * ink; ms.fedge.opacity = 0.95 * k * ink;
    }
    function stateFade(p) {
      setOpacitySet(msShared, 1);
      setOpacitySet(msBase, clamp01(1 - p * 1.6));
      setOpacitySet(msScen, clamp01((p - 0.4) / 0.55));
      gBase.visible = p < 0.95; gScen.visible = p > 0.05;
    }
    stateFade(0);

    // ---- tree sway: canopy micro-oscillation, per-tree phase/period jitter ----
    function sway(now, amp) {
      const t = now / 1000;
      for (const T of [treesA, treesB]) {
        if (!T.grp.visible) continue;
        for (const tr of T.trees) {
          if (!tr.piv.visible) continue;
          let s = tr._sw;
          if (!s) s = tr._sw = { p: Math.random() * 6.283, w: 6.283 / (4 + Math.random() * 3), a: 0.8 + Math.random() * 0.4 };
          const a = amp * s.a;
          tr.piv.rotation.z = Math.sin(t * s.w + s.p) * a;
          tr.piv.rotation.x = Math.sin(t * s.w * 0.77 + s.p * 1.7) * a * 0.6;
        }
      }
    }
    function swayReset() {
      for (const T of [treesA, treesB]) for (const tr of T.trees) { tr.piv.rotation.z = 0; tr.piv.rotation.x = 0; }
    }

    // ---- lanes (authored + verified; see header). states: B, C, or BC ----
    // ambient-prop circulation lanes. Manifest-driven per site (site.lanes); King's Road
    // omits them -> the authored King's Road default array below (byte-identical).
    const LANES = (site && site.lanes && site.lanes.length) ? site.lanes : [
      { kind: 'walk', states: 'B',  pts: [[95, -89], [110, -90.8], [130, -90.8], [150, -90.5], [170, -90.5], [190, -90.3], [200, -89.5], [210, -86]] },
      { kind: 'walk', states: 'C',  pts: [[100, -90.8], [110, -90.8], [130, -90.8], [150, -90.5], [170, -90.5], [190, -90.3], [200, -89.5], [210, -86]] },
      { kind: 'walk', states: 'B',  pts: [[10, -106.2], [20, -104.9], [30, -105.5], [40, -107.4], [55, -108], [78, -108.1]] },
      { kind: 'walk', states: 'C',  pts: [[10, -106.2], [20, -104.9], [30, -105.5], [40, -107.2]] },
      { kind: 'walk', states: 'BC', pts: [[104.2, -1], [103.9, -6], [103.9, -12], [105, -17]] },
      { kind: 'walk', states: 'BC', pts: [[172, -18.35], [190, -18.35], [213, -18.35]] },
      { kind: 'walk', states: 'B',  pts: [[95, -108], [110, -107.8], [130, -107.5], [150, -106.8], [170, -106], [200, -106.1]] },
      { kind: 'walk', states: 'C',  pts: [[117, -107.4], [123, -107.4], [129, -107.4]] },
      { kind: 'walk', states: 'C',  pts: [[136, -106.9], [155, -106.9], [175, -106.8], [195, -106.8], [208, -106.8]] },
      { kind: 'walk', states: 'BC', pts: [[41, -103], [48, -103], [55, -103]] },
      { kind: 'walk', states: 'B',  pts: [[96, -3], [95, -16], [93.5, -30], [93.5, -55], [93.5, -78]] },
      { kind: 'walk', states: 'B',  pts: [[96, -95.2], [94, -105], [93.5, -118]] },
      { kind: 'bike', states: 'BC', pts: [[76, -97], [120, -96], [170, -95], [213, -94]] },
      { kind: 'bike', states: 'BC', pts: [[93, -19], [130, -20], [170, -20], [213, -20]] },
      { kind: 'bike', states: 'BC', pts: [[5, -95], [15, -97.8], [35, -98.2], [55, -98.3], [72, -98.4]] },
      { kind: 'bike', states: 'BC', pts: [[84, -128], [85, -115], [86, -104]] }
    ];
    for (const L of LANES) {
      L.curve = new THREE.CatmullRomCurve3(L.pts.map(p => new THREE.Vector3(p[0], 0, -p[1])), false, 'catmullrom', 0.3);
      L.len = L.curve.getLength();
    }
    const lanesFor = (st, kind) => LANES.filter(L => L.kind === kind && L.states.indexOf(st === 'baseline' ? 'B' : 'C') >= 0);

    // ---- figures ----
    const FCAP = { walk: 14, bike: 5, car: 3 }; // per-kind pool caps — people can't crowd cars out
    const figures = [];
    // figures keep the ink-silhouette convention for limbs/heads, but the torso takes
    // a muted gouache clothing tone — reads human at eye level, stays quiet at iso.
    const FIG_TONES = [0x8c4a36, 0x4f6273, 0x5f6f4a, 0xa87f3d, 0x3a3a38, 0x6b4a5b, 0x7a6a55];
    const figTone = () => new THREE.Color(FIG_TONES[Math.floor(Math.random() * FIG_TONES.length)]);
    const contactDisc = () => {
      const m = new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0, depthWrite: false });
      const gm = new THREE.CircleGeometry(0.42, 10); gm.rotateX(-Math.PI / 2);
      const d = new THREE.Mesh(gm, m); d.position.y = 0.03; d.renderOrder = 5;
      d.userData.mvSkip = true;
      return { mesh: d, mat: m };
    };
    function makeWalker() {
      const body = new THREE.MeshBasicMaterial({ color: figTone(), transparent: true });
      const ink = new THREE.MeshBasicMaterial({ color: INK, transparent: true });
      const g = new THREE.Group();
      const M = (geo2, m, x, y, z) => { const q = new THREE.Mesh(geo2, m); q.position.set(x, y, z); g.add(q); return q; };
      // torso: waist-to-shoulder taper, flattened front-to-back
      const torso = M(new THREE.CylinderGeometry(0.155, 0.1, 0.5, 10), body, 0, 1.2, 0); torso.scale.z = 0.62;
      const shoulders = M(new THREE.SphereGeometry(0.15, 10, 7), body, 0, 1.44, 0); shoulders.scale.set(1, 0.42, 0.6);
      const hips = M(new THREE.SphereGeometry(0.125, 9, 6), ink, 0, 0.93, 0); hips.scale.set(1, 0.55, 0.72);
      M(new THREE.CylinderGeometry(0.034, 0.04, 0.09, 7), ink, 0, 1.5, 0); // neck
      M(new THREE.IcosahedronGeometry(0.104, 1), ink, 0, 1.61, 0); // head
      const mkLeg = (x) => { const lg = new THREE.Group(); lg.position.set(x, 0.9, 0);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.062, 0.84, 8), ink); m.position.y = -0.44; lg.add(m);
        const ft = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 0.2), ink); ft.position.set(0, -0.87, 0.05); lg.add(ft);
        g.add(lg); return lg; };
      const l1 = mkLeg(-0.085), l2 = mkLeg(0.085);
      const mkArm = (x) => { const ag = new THREE.Group(); ag.position.set(x, 1.42, 0);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.048, 0.52, 7), body); m.position.y = -0.27; ag.add(m);
        const hd = new THREE.Mesh(new THREE.SphereGeometry(0.04, 7, 5), ink); hd.position.y = -0.56; ag.add(hd);
        ag.rotation.z = x < 0 ? 0.07 : -0.07; g.add(ag); return ag; };
      const a1 = mkArm(-0.21), a2 = mkArm(0.21);
      g.scale.setScalar(0.92 + Math.random() * 0.16); // build variety
      const cd = contactDisc(); g.add(cd.mesh);
      return { grp: g, mats: [body, ink], discMat: cd.mat, legs: [l1, l2], arms: [a1, a2], wheels: null, kind: 'walk', active: false };
    }
    function makeCyclist() {
      const body = new THREE.MeshBasicMaterial({ color: figTone(), transparent: true });
      const ink = new THREE.MeshBasicMaterial({ color: INK, transparent: true });
      const g = new THREE.Group();
      const M = (geo2, m, x, y, z) => { const q = new THREE.Mesh(geo2, m); q.position.set(x, y, z); g.add(q); return q; };
      const wheel = (z) => { const wg = new THREE.Group(); wg.position.set(0, 0.34, z);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.028, 5, 16), ink); rim.rotation.y = Math.PI / 2; wg.add(rim);
        const sp = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.6, 0.018), ink); wg.add(sp);
        const sp2 = sp.clone(); sp2.rotation.x = Math.PI / 2; wg.add(sp2); g.add(wg); return wg; };
      const w1 = wheel(0.52), w2 = wheel(-0.52);
      // frame tubes
      const tube = (x1, y1, z1, x2, y2, z2, r) => {
        const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1, L = Math.hypot(dx, dy, dz);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L, 6), ink);
        m.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / L, dy / L, dz / L));
        g.add(m); return m; };
      tube(0, 0.34, 0.52, 0, 0.92, 0.42, 0.024);   // head tube + fork
      tube(0, 0.86, 0.38, 0, 0.62, -0.28, 0.026);  // top tube
      tube(0, 0.62, -0.28, 0, 0.34, -0.52, 0.024); // seat stay
      tube(0, 0.62, -0.28, 0, 0.98, -0.34, 0.024); // seat post
      tube(0, 0.42, 0.44, 0, 0.5, -0.3, 0.026);    // down tube
      M(new THREE.BoxGeometry(0.09, 0.045, 0.26), ink, 0, 1.0, -0.34); // saddle
      const bar = M(new THREE.CylinderGeometry(0.02, 0.02, 0.42, 6), ink, 0, 0.96, 0.44); bar.rotation.z = Math.PI / 2; // handlebar
      // rider: forward lean, arms to the bar, bent legs
      const torso = M(new THREE.CylinderGeometry(0.13, 0.095, 0.5, 9), body, 0, 1.16, -0.1);
      torso.scale.z = 0.66; torso.rotation.x = 0.5;
      M(new THREE.IcosahedronGeometry(0.098, 1), ink, 0, 1.42, 0.1); // head
      tube(-0.13, 1.32, 0.02, -0.19, 0.97, 0.42, 0.026); tube(0.13, 1.32, 0.02, 0.19, 0.97, 0.42, 0.026); // arms
      tube(-0.08, 0.98, -0.3, -0.1, 0.68, -0.05, 0.032); tube(-0.1, 0.68, -0.05, -0.09, 0.38, 0.02, 0.028); // left leg
      tube(0.08, 0.98, -0.3, 0.1, 0.58, -0.18, 0.032); tube(0.1, 0.58, -0.18, 0.09, 0.3, -0.06, 0.028);     // right leg
      const cd = contactDisc(); g.add(cd.mesh);
      return { grp: g, mats: [body, ink], discMat: cd.mat, legs: null, wheels: [w1, w2], kind: 'bike', active: false };
    }
    // car — true scale ~4.5 m, profile-extruded body (hood/windshield/roof/trunk +
    // wheel arches), proud glazing band, wheels w/ hubs, mirrors. Sedan + wagon variants.
    function makeCar() {
      const CAR_TONES = [0xf3f1ea, 0x8f9aa4, 0xb0897a, 0x9aa68f];
      const body = new THREE.MeshBasicMaterial({ color: CAR_TONES[Math.floor(Math.random() * CAR_TONES.length)], transparent: true });
      const ink = new THREE.MeshBasicMaterial({ color: INK, transparent: true });
      const glass = new THREE.MeshBasicMaterial({ color: 0x3f4e58, transparent: true }); // deep slate glazing
      const hub = new THREE.MeshBasicMaterial({ color: 0xd8d4c8, transparent: true });
      const fe = fatMat(INK, 1.9, 0.95); fe._mvEdge = true; // hidden while the MV walk style is on
      const g = new THREE.Group();
      const wagon = Math.random() < 0.4;
      // side profile: +x = front; y up. Extruded across width, then rotated so +x → +z
      // (figures drive toward local +z per lane tangent orientation).
      const s = new THREE.Shape();
      s.moveTo(2.24, 0.4);                                   // front bumper lip
      s.quadraticCurveTo(2.3, 0.68, 2.05, 0.76);             // nose
      s.lineTo(0.95, 0.9);                                   // hood
      s.lineTo(0.4, 1.34);                                   // windshield
      if (wagon) { s.lineTo(-1.35, 1.36); s.lineTo(-1.95, 0.92); } // long roof + tailgate
      else { s.quadraticCurveTo(-0.1, 1.42, -0.55, 1.36); s.lineTo(-1.2, 0.98); s.lineTo(-1.95, 0.92); } // roof + backlight + trunk
      s.quadraticCurveTo(-2.26, 0.86, -2.22, 0.55);          // tail
      s.lineTo(-2.18, 0.36); s.lineTo(-1.79, 0.36);          // to rear arch
      s.absarc(-1.37, 0.36, 0.42, Math.PI, 0, true);         // rear wheel arch
      s.lineTo(0.95, 0.36);
      s.absarc(1.37, 0.36, 0.42, Math.PI, 0, true);          // front wheel arch
      s.lineTo(2.24, 0.4);
      const bodyGeo = new THREE.ExtrudeGeometry(s, { depth: 1.68, bevelEnabled: false });
      bodyGeo.rotateY(-Math.PI / 2); bodyGeo.translate(0.84, 0, 0); // center body width on x=0 (matches wheels/mirrors/disc)
      const bod = new THREE.Mesh(bodyGeo, body);
      bod.add(fatSeg(new THREE.EdgesGeometry(bodyGeo, 32), fe));
      g.add(bod);
      // glazing band: slightly wider than the body so windows read from the side
      const gs = new THREE.Shape();
      gs.moveTo(0.52, 0.98); gs.lineTo(0.34, 1.29);
      if (wagon) { gs.lineTo(-1.32, 1.31); gs.lineTo(-1.52, 0.98); }
      else { gs.lineTo(-0.52, 1.31); gs.lineTo(-1.08, 0.98); }
      gs.closePath();
      const glassGeo = new THREE.ExtrudeGeometry(gs, { depth: 1.74, bevelEnabled: false });
      glassGeo.rotateY(-Math.PI / 2); glassGeo.translate(0.87, 0, 0); // center to match body
      g.add(new THREE.Mesh(glassGeo, glass));
      // wheels: ink tire + pale hub
      for (const [x, z] of [[-0.82, 1.37], [0.82, 1.37], [-0.82, -1.37], [0.82, -1.37]]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.2, 12), ink);
        w.rotation.z = Math.PI / 2; w.position.set(x, 0.36, z); g.add(w);
        const h = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.215, 10), hub);
        h.rotation.z = Math.PI / 2; h.position.set(x, 0.36, z); g.add(h);
      }
      for (const x of [-0.9, 0.9]) g.add((() => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.07, 0.1), ink); m.position.set(x, 1.02, 0.52); return m; })()); // mirrors
      const cd = contactDisc(); cd.mesh.scale.set(2.6, 1, 5.8); g.add(cd.mesh);
      return { grp: g, mats: [body, ink, fe, glass, hub], discMat: cd.mat, legs: null, wheels: null, kind: 'car', active: false };
    }
    let nextSpawn = 0, nextCarSpawn = 0;
    function trySpawn(camX, camY, sparse, seedT, kindForce) {
      const st = stateKey();
      const kind = kindForce || (Math.random() < 0.26 ? 'bike' : 'walk');
      const ls = lanesFor(st, kind === 'car' ? 'bike' : kind); // cars ride the road lanes
      if (!ls.length) return false;
      const L = ls[Math.floor(Math.random() * ls.length)];
      const dir = Math.random() < 0.5 ? 1 : -1;
      const s0 = seedT != null ? seedT * L.len : (dir > 0 ? 0 : L.len);
      const gap = kind === 'car' ? 16 : 8;
      for (const o of figures) if (o.active && o.lane === L && Math.abs(o.s - s0) < gap) return false; // spacing guard
      const p = L.curve.getPointAt(clamp01(s0 / L.len));
      if (sparse && Math.hypot(p.x - camX, -p.z - camY) < 25) return false; // spawn suppression near camera
      let f = null;
      for (const o of figures) if (!o.active && o.kind === kind) { f = o; break; }
      if (!f) {
        let pool = 0; for (const o of figures) if (o.kind === kind) pool++;
        if (pool >= FCAP[kind]) return false;
        f = kind === 'car' ? makeCar() : kind === 'bike' ? makeCyclist() : makeWalker();
        figures.push(f); root.add(f.grp);
        if (kind !== 'car') { const vary = 0.86 + Math.random() * 0.26; f.grp.traverse(o => { if (o.isMesh) o._mvVary = vary; }); }
      }
      f.active = true; f.lane = L; f.dir = dir; f.s = s0;
      f.speed = (kind === 'car' ? 7.5 : kind === 'bike' ? 4 : 1.4) * (0.85 + Math.random() * 0.3);
      f.a = 0; f.dying = false; f.grp.visible = true;
      if (MVON) f.grp.traverse(o => mvApply(o, true, MV_PROP_SHADES));
      return true;
    }
    // per-mesh MV recolor: bake flat face-orientation shades of the base hue into vertex
    // colors; darker source materials (ink limbs, tyres, glazing) map to deeper shades of
    // the SAME hue so nothing reads as pure black. Fully reversible.
    function mvApply(o, on, shades) {
      // ink edges off in walk-MV (props read by paper-cut faces, like trees + buildings).
      // NB LineSegments2.isMesh is true, so test lines BEFORE the mesh guard.
      if (o.isLine || o.isLineSegments2) { o.visible = !on; return; }
      if (!o.isMesh) return;
      if (o.userData && o.userData.mvSkip) return;
      const g = o.geometry, m = o.material;
      if (!g || !m || !m.isMeshBasicMaterial) return;
      if (on) {
        if (!m._mvOrig) m._mvOrig = { vc: m.vertexColors, mc: m.color.getHex() };
        if (o._mvCol === undefined) { const ca = g.getAttribute('color'); o._mvCol = ca ? ca.array.slice() : null; }
        const nrm = g.getAttribute('normal'), pos = g.getAttribute('position');
        if (!nrm || !pos) return;
        const mc = m._mvOrig.mc;
        const lum = 0.299 * ((mc >> 16 & 255) / 255) + 0.587 * ((mc >> 8 & 255) / 255) + 0.114 * ((mc & 255) / 255);
        const df = (0.5 + 0.5 * lum) * (o._mvVary || 1); // dark parts stay dark; per-figure variety
        const n = pos.count, arr = new Float32Array(n * 3), na = nrm.array;
        for (let v = 0; v < n; v++) {
          const nx = na[v * 3], ny = na[v * 3 + 1], nz = na[v * 3 + 2];
          let t;
          if (ny > 0.55) t = shades.top;
          else if (ny < -0.4) t = shades.shade;
          else { const dd = Math.abs(nx * MV_SUNW[0] + nz * MV_SUNW[2]); t = dd > 0.5 ? shades.lit : shades.side; }
          arr[v * 3] = Math.min(1, t[0] * df); arr[v * 3 + 1] = Math.min(1, t[1] * df); arr[v * 3 + 2] = Math.min(1, t[2] * df);
        }
        g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
        m.vertexColors = true; m.color.setHex(0xffffff); m.needsUpdate = true;
      } else if (m._mvOrig) {
        m.vertexColors = m._mvOrig.vc; m.color.setHex(m._mvOrig.mc); m.needsUpdate = true;
        if (o._mvCol !== undefined) {
          if (o._mvCol) { const ca = g.getAttribute('color'); if (ca) { ca.array.set(o._mvCol); ca.needsUpdate = true; } }
          else if (g.getAttribute('color')) { if (g.deleteAttribute) g.deleteAttribute('color'); else g.removeAttribute('color'); }
          o._mvCol = undefined;
        }
      }
    }
    function despawnAll(hard) {
      for (const f of figures) { if (!f.active) continue; if (hard) { f.active = false; f.grp.visible = false; } else f.dying = true; }
    }
    function update(dt, now) {
      if (!on || !sandbox || !MOTION) return;
      const sparse = !!(fw.active || walk);
      sway(now, (sparse ? 0.013 : 0.032) * swayMult); // visible breath at iso; softer at eye level
      const cx = activeCam.position.x, cy = -activeCam.position.z;
      const target = leverHold ? 0 : (sparse ? 4 : 13);
      const carTarget = leverHold ? 0 : (sparse ? 1 : 2); // one or two cars, no traffic claims
      if (seedPending && !leverHold) {
        for (let i = 0; i < target * 3; i++) trySpawn(cx, cy, sparse, Math.random()); // phase-offset mid-lane starts
        for (let i = 0; i < carTarget * 3; i++) trySpawn(cx, cy, sparse, Math.random(), 'car');
        seedPending = false;
      }
      let active = 0, cars = 0;
      for (const f of figures) if (f.active) { if (f.kind === 'car') cars++; else active++; }
      if (!leverHold && active < target && now >= nextSpawn) {
        trySpawn(cx, cy, sparse);
        nextSpawn = now + 350 + Math.random() * 900;
      }
      if (!leverHold && cars < carTarget && now >= nextCarSpawn) {
        trySpawn(cx, cy, sparse, null, 'car');
        nextCarSpawn = now + 2500 + Math.random() * 4000;
      }
      let surplus = active - target + Math.max(0, cars - carTarget);
      for (const f of figures) {
        if (!f.active) continue;
        if (surplus > 0 && !f.dying) { f.dying = true; surplus--; }
        f.s += f.speed * dt * f.dir;
        const remain = f.dir > 0 ? f.lane.len - f.s : f.s;
        if (remain <= 0 || (f.dying && f.a < 0.03)) { f.active = false; f.grp.visible = false; continue; }
        const tt = clamp01(f.s / f.lane.len);
        const pt = f.lane.curve.getPointAt(tt);
        const tan = f.lane.curve.getTangentAt(tt);
        f.grp.rotation.y = Math.atan2(tan.x * f.dir, tan.z * f.dir);
        f.a += ((f.dying ? 0 : 1) - f.a) * Math.min(1, dt * 3);
        if (!f.dying && f.a > 0.96) f.a = 1; // snap solid — no lingering translucency
        let op = f.a * clamp01(remain / f.speed); // ~1 s end-of-lane fade, no teleporting
        if (sparse) op *= clamp01((Math.hypot(pt.x - cx, -pt.z - cy) - 6) / 4); // near-camera fade
        for (const m of f.mats) m.opacity = (MVON && m._mvEdge) ? 0 : op;
        f.discMat.opacity = op * 0.16; // soft contact shadow anchors the figure
        let bobY = 0;
        if (f.legs) {
          const ph = f.s * 4.2; // stride scissor + bob from arc distance
          f.legs[0].rotation.x = Math.sin(ph) * 0.5;
          f.legs[1].rotation.x = -Math.sin(ph) * 0.5;
          if (f.arms) { f.arms[0].rotation.x = -Math.sin(ph) * 0.38; f.arms[1].rotation.x = Math.sin(ph) * 0.38; }
          bobY = Math.abs(Math.sin(ph)) * 0.04;
        }
        if (f.wheels) for (const w of f.wheels) w.rotation.x -= (f.speed / 0.33) * dt * f.dir;
        f.grp.position.set(pt.x, bobY, pt.z);
      }
    }
    function setSandbox(v) {
      sandbox = v; root.visible = v && on;
      if (!v) { swayReset(); despawnAll(true); } else seedPending = true;
    }
    function setOn(v) {
      on = !!v; root.visible = sandbox && on;
      if (!on) { swayReset(); despawnAll(true); } else if (sandbox) seedPending = true;
    }
    return {
      update, setSandbox, setOn, stateFade,
      setSway(v) { swayMult = Math.max(0, v); if (swayMult === 0) swayReset(); },
      leverStart() { leverHold = true; despawnAll(false); },
      leverSettled() { leverHold = false; seedPending = true; },
      // ---- Monument-Valley prop recolor (walk style only) ----
      mvStyle(state, shades) { root.traverse(o => mvApply(o, state, shades)); },
      // §RW ink edges off: constant-weight outlines are a sketch signature — on a bench or
      // a bin at two metres they read as cartoon linework, so the rendered walk drops them.
      inkVisible(v) {
        root.traverse(o => { if (o.isLineSegments2 || o.isLine) o.visible = !!v; });
      }
    };
  })();

  // ---- render loop -----------------------------------------------------------------
  let disposed = false;
  let last = performance.now();
  function frame(now) {
    if (disposed) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    // tweens
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      const k = Math.min(1, (now - tw.t0) / tw.dur);
      tw.fn(tw.ease(k));
      if (k >= 1) { tweens.splice(i, 1); if (tw.done) tw.done(); }
    }
    // scene-1 shadow breathing (the only sanctioned idle motion)
    if (S.breathe && !RM) {
      const b = 1 + Math.sin(now / 2600) * 0.02;
      aoPool.scale.setScalar(b);
      aoPool.material.opacity = 0.92 + Math.sin(now / 2600) * 0.08;
    } else { aoPool.scale.setScalar(1); aoPool.material.opacity = 1; }
    // walk
    if (walk && walk.playing) {
      const spd = 1.35 * walk.speed; // m/s
      walkFrame(walk.t + (spd * dt) / walk.len);
      if (walk.t >= 1) walk.playing = false;
    }
    if (fw.active) fwUpdate(dt, now);
    if (sky.visible && !RM) sky.rotation.y += dt * 0.0022; // slow cloud drift
    if (life) life.update(dt, now);
    renderer.render(scene, activeCam);
  }
  requestAnimationFrame(frame);

  // ---- §R REALISTIC RENDERED MODE (illustrative — calibrated to user references) ----
  // A PARALLEL aesthetic the user opts into. Sketch is the default and is never
  // altered: everything here is lazy-built on first toggle and fully reversed on
  // toggle-off (material swaps + visibility flags only; same scene graph, camera,
  // data, and interactions underneath). Look per references: watercolor axo —
  // flat believable material colours, trees as flat-shaded green masses (no
  // leaves), buildings stay pale, paper background stays. ONE lit layer — the
  // rendered ground — receives soft sun shadows (trees/buildings only cast), so
  // when SHOW DATA hides that floor the shadows leave with it automatically and
  // the metric field is the only shade voice (honesty rule).
  const R_COL_KR = {
    // v3 collage-render palette (user refs: sage lawn, LIGHT grey flagstone, warm pale
    // concrete, mid-grey asphalt with the ROAD clearly darkest). Value hierarchy:
    // road ≪ parking < path < stone/concrete. The canvas tiles multiply these.
    grass: '#96a765', concrete_path: '#e0dbcd', asphalt_path: '#a09c93',
    asphalt_road: '#605e59', asphalt_parking: '#93908a', unit_pavers: '#b29c7e',
    stone_landscaping: '#cdcac2'
  };
  // Per-category RENDERED-VIEW material, authorable per site as
  // categories.<key>.render = { base, tile, tones, joint, jointAlpha, jointWidth,
  // cols, rows, rough, nscale }. A site that authors none resolves to the King's
  // Road literals above — by exact category key, then by material family — so
  // King's Road renders unchanged.
  const R_REND = {};
  for (const k of CATS) { const r = site.categories[k] && site.categories[k].render; if (r) R_REND[k] = r; }
  const rFamily = (c) => c.indexOf('grass') >= 0 ? 'grass'
    : c.indexOf('paver') >= 0 ? 'unit_pavers'
    : c.indexOf('concrete') >= 0 ? 'concrete_path'
    : c.indexOf('stone') >= 0 ? 'stone_landscaping'
    : c.indexOf('road') >= 0 ? 'asphalt_road'
    : c.indexOf('parking') >= 0 ? 'asphalt_parking' : 'asphalt_path';
  const rBase = (c) => (R_REND[c] && R_REND[c].base) || R_COL_KR[c] || R_COL_KR[rFamily(c)] || '#b9b3a4';
  const R_GREEN = {
    // natural, slightly deeper range per the user's arch-viz reference
    'Ash': '#729552', 'Silver Maple': '#7ea562', 'Hawthorn': '#61894b', 'Linden': '#88a860',
    'Siberian Elm': '#6d9556', 'Amur Maple': '#96a75a', 'Conical Evergreens': '#4c7449'
  };
  var rBuilt = false, rSun = null, rHemi = null, rSuspended = false;
  var rEnv = null, rTonePrev = null, rExpPrev = null; // §R filmic tone + subtle IBL (reverted on exit)
  // one-time subtle sky environment for the PBR surfaces — a soft daylight gradient so
  // stone/pavers/curbs catch a faint sheen instead of reading matte-dead. Guarded: if
  // PMREM is unavailable the surfaces still light fully from sun + hemisphere.
  function rEnsureEnv() {
    if (rEnv || !THREE.PMREMGenerator) return rEnv;
    try {
      const N = 64, cv = document.createElement('canvas'); cv.width = N * 2; cv.height = N;
      const cx = cv.getContext('2d');
      const gr = cx.createLinearGradient(0, 0, 0, N);
      gr.addColorStop(0, '#e7edf4'); gr.addColorStop(0.5, '#f2efe8'); gr.addColorStop(1, '#d7d2c6');
      cx.fillStyle = gr; cx.fillRect(0, 0, N * 2, N);
      const eq = new THREE.CanvasTexture(cv);
      eq.mapping = THREE.EquirectangularReflectionMapping;
      if (THREE.SRGBColorSpace) eq.colorSpace = THREE.SRGBColorSpace;
      const pmrem = new THREE.PMREMGenerator(renderer);
      rEnv = pmrem.fromEquirectangular(eq).texture;
      pmrem.dispose(); eq.dispose();
    } catch (e) { rEnv = null; }
    return rEnv;
  }
  function rBuildLights() {
    if (rSun) return;
    const q = rQualityEff();
    rSun = new THREE.DirectionalLight(0xfff4e2, 3.1); // warm afternoon sun (filmic tone map balances the mids)
    rSun.position.set(CTR.x + 120, 95, CTR.z + 88); // summer afternoon — soft shadows long enough to read
    rSun.target.position.copy(CTR);
    scene.add(rSun.target);
    rSun.castShadow = q !== 'low';
    if (rSun.castShadow) {
      const sc = rSun.shadow;
      sc.mapSize.set(q === 'high' ? 2048 : 1024, q === 'high' ? 2048 : 1024);
      // cover the FULL site: at 135 King's Road's far corner lost its shadows, and a
      // larger site needs a correspondingly wider frustum
      const half = Math.max(160, Math.max((SITE_B[2] - SITE_B[0]), (SITE_B[3] - SITE_B[1])) / 2 + 20);
      sc.camera.left = -half; sc.camera.right = half; sc.camera.top = half; sc.camera.bottom = -half;
      sc.camera.near = 20; sc.camera.far = 400;
      sc.camera.updateProjectionMatrix(); // property changes never take without this
      sc.bias = -0.0012; sc.normalBias = 0.5; sc.radius = 5; // soft PCF edge, no acne on the raised turf
    }
    rHemi = new THREE.HemisphereLight(0xeaf1f8, 0xd8d2c4, 1.15); // sky fill / warm ground bounce
    scene.add(rSun); scene.add(rHemi);
  }
  let rQuality = (opts.params && opts.params.renderQuality) || 'auto';
  const rGround = {}; // st -> { grp, mats }
  var rWashOn = false; // §R wash mode: mosaic floated over the materials (read, guarded, before init)
  var R_PRIMER = null; // st -> InstancedMesh — white backing under the wash cells so ramp colours
                       // read true over dark asphalt (without it everything muddies to purple)
  const R_WASH_OP = 0.85, R_WASH_Y = 0.85; // wash opacity + lift (above raised turf, under canopies)
  function rWashApply(on) {
    if (on && !R_PRIMER) {
      R_PRIMER = {};
      for (const st of STATES) {
        const src = mosaic[st];
        const pm = new THREE.InstancedMesh(src.geometry, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }), D[st].n);
        pm.instanceMatrix = src.instanceMatrix; // share — cell layout is static
        pm.position.set(0, R_WASH_Y - 0.02, 0);
        pm.renderOrder = 3; pm.visible = false;
        scene.add(pm);
        R_PRIMER[st] = pm;
      }
    }
    for (const st of STATES) {
      mosaic[st].userData.layout(on); // uniform tiling in wash mode, native tessellation otherwise
      mosaic[st].position.y = on ? R_WASH_Y : 0;
      mosaic[st].renderOrder = on ? 4 : 1; // above ground polys (2) + baked shade (3)
      if (R_PRIMER && R_PRIMER[st]) R_PRIMER[st].visible = false; // setFieldOpacity re-shows per lever
    }
    rWashOn = on;
  }
  function rQualityEff() {
    if (rQuality && rQuality !== 'auto') return rQuality;
    const coarse = (typeof matchMedia === 'function') && matchMedia('(pointer:coarse)').matches;
    return coarse ? 'medium' : 'high';
  }
  // §2 procedural ground textures — painterly value-only tiles (the palette stays in
  // R_COL; the canvas multiplies it). ShapeGeometry UVs are raw shape coordinates in
  // METRES, so texture.repeat = 1/tile gives world-locked tiling with zero UV work.
  // 256px per category, drawn once, deterministic — no external assets, phone-cheap.
  const rTexCache = {};
  const rNormCache = {}; // cat -> normal-map texture (derived from the colour tile's luminance)
  // per-category PBR response, calibrated to the arch-viz reference
  const R_ROUGH  = { grass: 0.97, concrete_path: 0.90, unit_pavers: 0.82, stone_landscaping: 0.70, asphalt_road: 0.88, asphalt_path: 0.90, asphalt_parking: 0.88 };
  const R_NSCALE = { grass: 0.45, concrete_path: 0.65, unit_pavers: 1.15, stone_landscaping: 1.00, asphalt_road: 0.80, asphalt_path: 0.85, asphalt_parking: 0.80 };
  // resolve through the site override, then the exact key, then the material family
  const rRough = (c) => (R_REND[c] && R_REND[c].rough != null) ? R_REND[c].rough
    : (R_ROUGH[c] != null ? R_ROUGH[c] : (R_ROUGH[rFamily(c)] != null ? R_ROUGH[rFamily(c)] : 0.88));
  const rNscale = (c) => (R_REND[c] && R_REND[c].nscale != null) ? R_REND[c].nscale
    : (R_NSCALE[c] != null ? R_NSCALE[c] : (R_NSCALE[rFamily(c)] != null ? R_NSCALE[rFamily(c)] : 0.7));
  // luminance → tangent-space normal map (Sobel), so every surface catches real relief
  // under the sun: aggregate on asphalt, blade texture on turf, deep joints on pavers/stone.
  function rNormalFromCanvas(srcCanvas, strength) {
    const N = srcCanvas.width;
    const sd = srcCanvas.getContext('2d').getImageData(0, 0, N, N).data;
    const lum = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) lum[i] = (sd[i * 4] * 0.299 + sd[i * 4 + 1] * 0.587 + sd[i * 4 + 2] * 0.114) / 255;
    const at = (x, y) => lum[((y % N) + N) % N * N + (((x % N) + N) % N)];
    const out = document.createElement('canvas'); out.width = out.height = N;
    const octx = out.getContext('2d'), od = octx.createImageData(N, N), d = od.data;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      let nx = dx, ny = dy, nz = 1; const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
      const i = (y * N + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
    octx.putImageData(od, 0, 0);
    const t = new THREE.CanvasTexture(out); // NoColorSpace (linear) — correct for a normal map
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    return t;
  }
  function rTex(cat) {
    if (rTexCache[cat]) return rTexCache[cat];
    const N = 512, c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d');
    let seed = 7 + cat.length * 13;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const RN = R_REND[cat] || {};
    // FULL-COLOUR painter (v4): every tile is painted in real colour, with layered hue
    // variation instead of flat fill + value noise (that read as a low-res game texture).
    // R_COL supplies the base; the material colour stays white.
    const hex2 = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const css = (t, a) => 'rgba(' + Math.round(t[0]) + ',' + Math.round(t[1]) + ',' + Math.round(t[2]) + ',' + a + ')';
    const mx = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const B = hex2(rBase(cat));
    const DK = mx(B, [14, 13, 10], 0.4), LT = mx(B, [255, 255, 252], 0.35);
    g.fillStyle = css(B, 1); g.fillRect(0, 0, N, N);
    // every mark drawn at 3x3 wrap offsets when near an edge, so the tile stays seamless
    const wrapped = (x, y, r, fn) => {
      for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) {
        if (x + dx > -r && x + dx < N + r && y + dy > -r && y + dy < N + r) fn(x + dx, y + dy);
      }
    };
    const cloud = (n, r0, r1, tones, a0, a1) => { // soft colour clouds: the painterly base
      for (let i = 0; i < n; i++) {
        const x = rnd() * N, y = rnd() * N, r = r0 + rnd() * (r1 - r0);
        const tone = tones[Math.floor(rnd() * tones.length)], a = a0 + rnd() * (a1 - a0);
        wrapped(x, y, r, (px, py) => {
          const gr = g.createRadialGradient(px, py, 0, px, py, r);
          gr.addColorStop(0, css(tone, a)); gr.addColorStop(1, css(tone, 0));
          g.fillStyle = gr; g.beginPath(); g.arc(px, py, r, 0, 7); g.fill();
        });
      }
    };
    const fleck = (n, r0, r1, tones, a) => {
      for (let i = 0; i < n; i++) {
        const x = rnd() * N, y = rnd() * N, r = r0 + rnd() * (r1 - r0);
        g.fillStyle = css(tones[Math.floor(rnd() * tones.length)], a * (0.6 + rnd() * 0.7));
        wrapped(x, y, r, (px, py) => { g.beginPath(); g.arc(px, py, r, 0, 7); g.fill(); });
      }
    };
    let tile = 8; // metres per repeat
    if (cat.indexOf('grass') >= 0) {
      // meadow turf: broad multi-hue drifts (dry / lush / olive), darker clumps, fine
      // blade strokes, sparse pale flecks. 24 m repeat so no visible tiling rhythm.
      tile = 24;
      const drift = ['#a9b56d', '#75904c', '#93ad60', '#b7bd7a', '#7f9a54'].map(hex2);
      cloud(40, 60, 175, drift, 0.13, 0.28);
      cloud(170, 12, 36, ['#6d874a', '#9db268'].map(hex2), 0.07, 0.15); // clumps
      g.lineWidth = 1;
      const bladeD = hex2('#5c7840'), bladeL = hex2('#b8c67f');
      for (let i = 0; i < 2600; i++) {
        const x = rnd() * N, y = rnd() * N, a = rnd() * Math.PI, L = 3 + rnd() * 4;
        g.strokeStyle = css(rnd() < 0.55 ? bladeD : bladeL, 0.15 + rnd() * 0.13);
        wrapped(x, y, L, (px, py) => {
          g.beginPath(); g.moveTo(px - Math.cos(a) * L / 2, py - Math.sin(a) * L / 2);
          g.lineTo(px + Math.cos(a) * L / 2, py + Math.sin(a) * L / 2); g.stroke();
        });
      }
      fleck(320, 0.5, 1.1, ['#d8dda6', '#c2cd8b'].map(hex2), 0.4);
      fleck(46, 0.6, 1.1, ['#eceedd', '#e9e2c2'].map(hex2), 0.5); // sparse meadow flowers
    } else if (cat.indexOf('concrete') >= 0) {
      tile = 6;
      cloud(22, 60, 170, [mx(B, DK, 0.4), mx(B, LT, 0.5), mx(B, hex2('#cfc4ae'), 0.5)], 0.05, 0.1); // trowel clouds
      fleck(1500, 0.4, 0.9, [DK, LT], 0.1);
      g.strokeStyle = css(DK, 0.3); g.lineWidth = 2; // saw-cut control joints every 1.5 m
      for (let k = 0; k <= 4; k++) {
        g.beginPath(); g.moveTo(0, k * (N / 4)); g.lineTo(N, k * (N / 4)); g.stroke();
        g.beginPath(); g.moveTo(k * (N / 4), 0); g.lineTo(k * (N / 4), N); g.stroke();
      }
    } else if (cat.indexOf('paver') >= 0) {
      // running-bond unit pavers. Module + tones + joint are site-authorable so a site
      // can specify its real paver (warm clay brick vs grey concrete unit paver).
      tile = RN.tile != null ? RN.tile : 2.24; // default: 4 bricks x 6 courses (0.56 x 0.373 m)
      const cols = RN.cols || 4, rows = RN.rows || 6;
      const bw = N / cols, bh = N / rows;
      const brickTones = (RN.tones || ['#b8a184', '#a99274', '#bfa98c', '#ab9a80', '#b29c7e']).map(hex2);
      const jGap = RN.jointWidth != null ? RN.jointWidth : 2.4;
      const inset = Math.max(1, jGap * 0.5);
      for (let row = 0; row < rows; row++) {
        const off = (row % 2) * bw * 0.5;
        for (let col = -1; col <= cols; col++) {
          const x = col * bw + off, y = row * bh;
          const t = mx(brickTones[Math.floor(rnd() * brickTones.length)], rnd() < 0.5 ? DK : LT, rnd() * (RN.toneVar != null ? RN.toneVar : 0.14));
          g.fillStyle = css(t, 1);
          g.fillRect(x + inset, y + inset, bw - inset * 2, bh - inset * 2);
        }
      }
      g.strokeStyle = css(hex2(RN.joint || '#7d7264'), RN.jointAlpha != null ? RN.jointAlpha : 0.55);
      g.lineWidth = jGap; // sand joints
      for (let row = 0; row <= rows; row++) { g.beginPath(); g.moveTo(0, row * bh); g.lineTo(N, row * bh); g.stroke(); }
      for (let row = 0; row < rows; row++) {
        const off = (row % 2) * bw * 0.5;
        for (let col = 0; col <= cols; col++) { const x = (col * bw + off) % N; g.beginPath(); g.moveTo(x, row * bh); g.lineTo(x, (row + 1) * bh); g.stroke(); }
      }
      cloud(10, 60, 160, [DK, LT], 0.04, 0.08); // unify with a faint weather wash
      fleck(500, 0.4, 0.8, [DK, LT], 0.09);
    } else if (cat.indexOf('stone') >= 0) {
      // light-grey flagstone at true scale (~0.9 m slabs): jittered lattice, wrapped
      // indices + 3x3 offset draws keep it seamless. Each slab gets its own warm/cool
      // light-grey and a soft diagonal gradient (thickness read), over a darker joint bed.
      tile = 3.6;
      const CELLS = 4, cs = N / CELLS;
      const h2 = (i, j, k) => { const s = Math.sin((i % CELLS) * 127.1 + (j % CELLS) * 311.7 + k * 74.7) * 43758.5453; return s - Math.floor(s); };
      g.fillStyle = '#a7a298'; g.fillRect(0, 0, N, N); // joint bed
      const lx = [], ly = [];
      for (let j = 0; j <= CELLS; j++) {
        lx[j] = []; ly[j] = [];
        for (let i = 0; i <= CELLS; i++) {
          lx[j][i] = i * cs + (h2(i, j, 1) - 0.5) * cs * 0.5;
          ly[j][i] = j * cs + (h2(i, j, 2) - 0.5) * cs * 0.5;
        }
      }
      const warm = hex2('#d3cec2'), cool = hex2('#c6c7c4');
      for (let j = 0; j < CELLS; j++) for (let i = 0; i < CELLS; i++) {
        const corners = [[lx[j][i], ly[j][i]], [lx[j][i + 1], ly[j][i + 1]], [lx[j + 1][i + 1], ly[j + 1][i + 1]], [lx[j + 1][i], ly[j + 1][i]]];
        const cx = (corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4;
        const cy = (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4;
        const inset = corners.map(p => { const dx = cx - p[0], dy = cy - p[1], d = Math.hypot(dx, dy) || 1; const k = Math.min(0.35, 4.5 / d); return [p[0] + dx * k, p[1] + dy * k]; });
        const col = mx(mx(warm, cool, h2(i, j, 4)), h2(i, j, 3) < 0.5 ? [255, 255, 252] : [70, 66, 58], Math.abs(h2(i, j, 3) - 0.5) * 0.22);
        for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) {
          if (cx + ox < -cs || cx + ox > N + cs || cy + oy < -cs || cy + oy > N + cs) continue;
          g.beginPath();
          g.moveTo(inset[0][0] + ox, inset[0][1] + oy);
          for (let k = 1; k < 4; k++) g.lineTo(inset[k][0] + ox, inset[k][1] + oy);
          g.closePath();
          const gr = g.createLinearGradient(cx + ox - cs / 2, cy + oy - cs / 2, cx + ox + cs / 2, cy + oy + cs / 2);
          gr.addColorStop(0, css(mx(col, [255, 255, 252], 0.10), 1));
          gr.addColorStop(1, css(mx(col, [70, 66, 58], 0.08), 1));
          g.fillStyle = gr; g.fill();
          g.strokeStyle = 'rgba(64,60,52,0.24)'; g.lineWidth = 1.5; g.stroke();
        }
      }
      fleck(700, 0.4, 0.9, [hex2('#b7b2a6'), hex2('#e0dcd2')], 0.12);
    } else { // asphalt family: road / path / parking, smooth low-contrast aggregate
      tile = cat === 'asphalt_path' ? 8 : 13;
      cloud(30, 70, 200, [DK, LT, mx(B, hex2('#8a887f'), 0.5)], 0.05, 0.1); // subtle wear
      fleck(5200, 0.4, 1.0, [DK, LT], 0.13);            // fine aggregate
      fleck(320, 0.9, 1.5, [LT, mx(LT, [255, 255, 250], 0.4)], 0.09); // sparse pale chip
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1 / tile, 1 / tile);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    // derived relief: joints recess, aggregate/blades stand proud under the sun
    const nrm = rNormalFromCanvas(c, rNscale(cat) * 2.4);
    nrm.repeat.set(1 / tile, 1 / tile);
    rNormCache[cat] = nrm;
    rTexCache[cat] = tex;
    return tex;
  }
  // §2 user-supplied texture swatches — full-colour tiles that OVERRIDE the
  // procedural canvas + palette for their category. w/h = real-world metres one
  // tile represents (world-locked via the metric UVs, same as the procedural set).
  const R_SWATCH = {
    // (empty) — user direction: no imported material images; everything procedural,
    // calibrated against the arch-viz reference. site:true / w,h semantics kept for
    // any future swatch.
  };
  const R_SITE = siteSpace.bounds
    ? { x0: SITE_B[0], y0: SITE_B[1], w: (SITE_B[2] - SITE_B[0]) || 1, h: (SITE_B[3] - SITE_B[1]) || 1 }
    : { x0: 0, y0: -131, w: 216, h: 131 }; // site extent in shape coords (x, y_site)
  const rSwatchTex = {};
  function rSurfMat(cat) {
    const sw = R_SWATCH[cat];
    if (!sw) return { map: rTex(cat), normalMap: rNormCache[cat] || null, roughness: rRough(cat), nscale: rNscale(cat), color: '#ffffff' }; // colour + relief live in the tile
    if (!rSwatchTex[cat]) {
      const t = new THREE.TextureLoader().load(sw.url);
      if (sw.site) {
        // one un-tiled copy over the full site: uv = (shape coords − origin) / extent
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        t.repeat.set(1 / R_SITE.w, 1 / R_SITE.h);
        t.offset.set(-R_SITE.x0 / R_SITE.w, -R_SITE.y0 / R_SITE.h);
      } else {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(1 / sw.w, 1 / sw.h);
      }
      if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      rSwatchTex[cat] = t;
    }
    return { map: rSwatchTex[cat], color: '#ffffff' }; // swatch carries its own colour
  }
  // §R baked soft shadows — analytic projection along the SUN vector (same light the
  // Lambert faces use), drawn as blurred silhouettes into ONE site-wide canvas per state:
  // tree canopies swept base→tip, building volumes swept by their height, plus a short
  // "turf lip" cast where the raised lawn meets lower paving. Deterministic and identical
  // on every device — the realtime shadow-map path was numerically flaky in this scene.
  const R_SHADOW_TEX = {};
  function rBakeShadows(st) {
    if (R_SHADOW_TEX[st]) return R_SHADOW_TEX[st];
    // Canvas covers the SITE bounds, not a fixed rectangle: sites with negative
    // coordinates or a larger extent used to fall outside a King's Road-sized canvas,
    // which clamped to the edge (a dark strip) and mis-placed the swept silhouettes.
    // A site that declares no space.bounds keeps the original 216x131 / origin-0 window
    // verbatim — King's Road's engine default is 215x130, and deriving from it would
    // shift its bake by ~1 m at the far corner.
    const hasB = !!siteSpace.bounds;
    const SX0 = hasB ? SITE_B[0] : 0, SY1 = hasB ? SITE_B[3] : 0;
    const SW = (hasB ? (SITE_B[2] - SITE_B[0]) : 216) || 1, SH = (hasB ? (SITE_B[3] - SITE_B[1]) : 131) || 1;
    const pxm = Math.max(4, Math.min(8, Math.floor(2200 / Math.max(SW, SH)))); // 8 px/m for King's Road; scaled down on bigger sites to cap texture memory
    const W2 = Math.round(SW * pxm), H2 = Math.round(SH * pxm);
    const CX = (x) => (x - SX0) * pxm, CY = (y) => (SY1 - y) * pxm; // site metres -> canvas px
    const cnv = document.createElement('canvas'); cnv.width = W2; cnv.height = H2;
    const ctx = cnv.getContext('2d');
    // shadow throw per metre of height, from the rendered sun offset (+120,+95,+88):
    // ground shadows run toward (-x,-z) = canvas up-left
    const KX = 120 / 95, KZ = 88 / 95;
    const layer = document.createElement('canvas'); layer.width = W2; layer.height = H2;
    const lc = layer.getContext('2d');
    lc.fillStyle = '#000';
    // buildings: shadow silhouette (union, opaque — overlaps don't double-darken)
    for (const b of (geo[st].buildings || [])) {
      if (hasB) {
        // EXACT projection: every face is projected to the ground along the sun vector
        // using each vertex's OWN height, and the results unioned. The bounding-box sweep
        // below over-covered complex footprints (an L-plan cast as its full rectangle)
        // and cast upper-storey blocks as if they started at grade — which is what read
        // as shadows that were too large or pointing the wrong way.
        const v = b.mesh.v;
        for (const f of b.mesh.f) {
          if (!f || f.length < 3) continue;
          lc.beginPath();
          for (let k = 0; k < f.length; k++) {
            const p = v[f[k]]; if (!p) continue;
            const gx = CX(p[0] - KX * p[2]), gy = CY(p[1] + KZ * p[2]);
            if (k === 0) lc.moveTo(gx, gy); else lc.lineTo(gx, gy);
          }
          lc.closePath(); lc.fill();
        }
      } else {
        const bb = bboxOf(b.mesh);
        let h = 0; for (const p of b.mesh.v) if (p[2] > h) h = p[2];
        const x0 = CX(bb[0]), y0 = CY(bb[3]), w = (bb[2] - bb[0]) * pxm, hh = (bb[3] - bb[1]) * pxm;
        const dx = -KX * h * pxm, dy = -KZ * h * pxm;
        for (let t = 0; t <= 1.001; t += 1 / 7) lc.fillRect(x0 + dx * t, y0 + dy * t, w, hh);
      }
    }
    // trees: canopy discs swept from mid-crown to tip
    for (const t of (geo[st].trees || [])) {
      const r = Math.max(1.1, t.radius) * pxm;
      const bx = CX(t.pos[0]), by = CY(t.pos[1]);
      const dx = -KX * t.height * pxm, dy = -KZ * t.height * pxm;
      for (let k = 0.35; k <= 1.001; k += 0.1625) {
        lc.beginPath(); lc.arc(bx + dx * k * 0.62, by + dy * k * 0.62, r * (1 - 0.18 * k), 0, 7); lc.fill();
      }
    }
    // filter-free blur: downscale → upscale. ctx.filter='blur()' is BOTH unsupported in
    // older Safari AND lazily rasterized in Chromium — the texture upload can read the
    // canvas BEFORE the filtered draw lands (bake looked right via toDataURL, rendered
    // empty in-scene). Bilinear resampling has neither problem.
    const soften = (src, k) => {
      const s = document.createElement('canvas');
      s.width = Math.max(1, Math.round(src.width / k)); s.height = Math.max(1, Math.round(src.height / k));
      s.getContext('2d').drawImage(src, 0, 0, s.width, s.height);
      return s;
    };
    ctx.globalAlpha = 0.38;
    ctx.drawImage(soften(soften(layer, 3), 2), 0, 0, W2, H2); // ~0.8 m penumbra
    // turf lip: the raised lawn drops a short, sharper cast onto its lower neighbours
    const l2 = document.createElement('canvas'); l2.width = W2; l2.height = H2;
    const c2 = l2.getContext('2d');
    const traceGrass = (cc, ox, oy) => {
      cc.beginPath();
      // every turf category this site has (King's Road: 'grass'; Lee: 'short_grass')
      for (const gk of CATS) {
        if (gk.indexOf('grass') < 0) continue;
        for (const surf of (geo[st].surfaces[gk] || [])) {
          for (const loop of [surf.outer].concat(surf.holes || [])) {
            cc.moveTo(CX(loop[0][0]) + ox, CY(loop[0][1]) + oy);
            for (let i = 1; i < loop.length; i++) cc.lineTo(CX(loop[i][0]) + ox, CY(loop[i][1]) + oy);
            cc.closePath();
          }
        }
      }
    };
    traceGrass(c2, -KX * 0.26 * pxm * 2.2, -KZ * 0.26 * pxm * 2.2);
    c2.fillStyle = '#000'; c2.fill('evenodd');
    c2.globalCompositeOperation = 'destination-out';
    traceGrass(c2, 0, 0); c2.fill('evenodd');
    ctx.globalAlpha = 0.3;
    ctx.drawImage(soften(l2, 2.2), 0, 0, W2, H2);
    ctx.globalAlpha = 1;
    ctx.getImageData(0, 0, 1, 1); // force rasterization before the GPU upload reads the canvas
    const tex = new THREE.CanvasTexture(cnv);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    // ShapeGeometry UVs are raw shape coords in metres — map the site extent to [0,1]²
    tex.repeat.set(1 / SW, 1 / SH);
    tex.offset.set(-SX0 / SW, 1 - SY1 / SH);
    tex.anisotropy = 4;
    R_SHADOW_TEX[st] = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    return R_SHADOW_TEX[st];
  }
  const R_GRASS_H = 0.26, R_CURB_W = 0.42, R_CURB_H = 0.34;
  function rBuildGround(st) {
    if (rGround[st]) return rGround[st];
    const src = st === 'baseline' ? groundA : groundB;
    const stGeo = st === 'baseline' ? geo.baseline : geo.scenario_01;
    const grp = new THREE.Group();
    grp.visible = false;
    const mats = [];
    for (const m of src.grp.children) {
      if (!m.userData || !m.userData.cat) continue;
      const cat = m.userData.cat;
      const sm = rSurfMat(cat);
      const mat = new THREE.MeshStandardMaterial({
        color: sm.color, map: sm.map,
        normalMap: sm.normalMap || null,
        normalScale: new THREE.Vector2(sm.nscale != null ? sm.nscale : 0.7, sm.nscale != null ? sm.nscale : 0.7),
        roughness: sm.roughness != null ? sm.roughness : 0.88, metalness: 0.0, envMapIntensity: 0.42,
        transparent: true, opacity: 1
      });
      const mesh = new THREE.Mesh(m.geometry, mat); // shared geometry, own material
      mesh.position.copy(m.position); mesh.rotation.copy(m.rotation); mesh.scale.copy(m.scale);
      mesh.receiveShadow = true;
      mesh.renderOrder = 2;
      mesh.userData = { cat, idx: m.userData.idx }; // cat + per-category index → name-hoverable, maps to sketch twin
      if (cat.indexOf('grass') >= 0) {
        // turf sits PROUD of the hardscape — its edge reads as thickness, not outline
        mesh.position.y += R_GRASS_H;
      }
      grp.add(mesh); mats.push(mat);
      // baked-shadow overlay: same footprint geometry, whisper above the surface
      const ov = new THREE.Mesh(m.geometry, rBakeShadows(st));
      ov.position.copy(mesh.position); ov.position.y += 0.02;
      ov.rotation.copy(m.rotation); ov.scale.copy(m.scale);
      ov.renderOrder = 3;
      ov.userData = { shadowFor: cat };
      grp.add(ov);
    }
    // lawn cut-edge skirt: a darker green vertical ribbon closing the raised turf
    {
      const pos = [];
      for (const surf of surfacesWhere(stGeo, isGrassCat)) {
        for (const loop of [surf.outer].concat(surf.holes || [])) {
          for (let i = 0; i < loop.length; i++) {
            const a = loop[i], b = loop[(i + 1) % loop.length];
            const ax = a[0], az = -a[1], bx = b[0], bz = -b[1];
            pos.push(ax, 0, az, bx, 0, bz, bx, R_GRASS_H, bz,
                     ax, 0, az, bx, R_GRASS_H, bz, ax, R_GRASS_H, az);
          }
        }
      }
      if (pos.length) {
        const gsk = new THREE.BufferGeometry();
        gsk.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        gsk.computeVertexNormals();
        const skMat = new THREE.MeshStandardMaterial({ color: 0x6b7c46, roughness: 0.95, metalness: 0, envMapIntensity: 0.35, transparent: true, opacity: 1, side: THREE.DoubleSide });
        const sk = new THREE.Mesh(gsk, skMat);
        sk.castShadow = true; sk.receiveShadow = true; sk.renderOrder = 2;
        sk.userData = { lawnSkirt: true };
        grp.add(sk); mats.push(skMat);
      }
    }
    // concrete curbs tracing every road edge — instanced boxes, one per boundary segment.
    // Edges where road meets ROAD (drive-lane joints, abutting road polys) get NO curb.
    {
      const roadSurfs = surfacesWhere(stGeo, isRoadCat);
      const inLoop = (loop, x, y) => {
        let inside = false;
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
          const xi = loop[i][0], yi = loop[i][1], xj = loop[j][0], yj = loop[j][1];
          if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
      };
      const inRoad = (x, y) => {
        for (const s of roadSurfs) {
          if (inLoop(s.outer, x, y)) {
            let inHole = false;
            for (const h of (s.holes || [])) if (inLoop(h, x, y)) { inHole = true; break; }
            if (!inHole) return true;
          }
        }
        return false;
      };
      const segs = [];
      for (const surf of roadSurfs) {
        for (const loop of [surf.outer].concat(surf.holes || [])) {
          for (let i = 0; i < loop.length; i++) {
            const a = loop[i], b = loop[(i + 1) % loop.length];
            const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
            if (L < 0.05) continue;
            // sample both sides of the edge at 3 stations — road on BOTH sides everywhere = internal joint, skip
            const nx = -dy / L, ny = dx / L, e = 0.3;
            let internal = true;
            for (const t of [0.25, 0.5, 0.75]) {
              const px = a[0] + dx * t, py = a[1] + dy * t;
              if (!(inRoad(px + nx * e, py + ny * e) && inRoad(px - nx * e, py - ny * e))) { internal = false; break; }
            }
            if (internal) continue;
            segs.push([a[0], a[1], b[0], b[1], L]);
          }
        }
      }
      if (segs.length) {
        const cgeo = new THREE.BoxGeometry(1, 1, 1); cgeo.translate(0, 0.5, 0);
        const cMat = new THREE.MeshStandardMaterial({ color: 0xa8a498, roughness: 0.85, metalness: 0, envMapIntensity: 0.4, transparent: true, opacity: 1 });
        const inst = new THREE.InstancedMesh(cgeo, cMat, segs.length);
        const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), P = new THREE.Vector3(), Sc = new THREE.Vector3();
        segs.forEach((sg, i) => {
          const mx = (sg[0] + sg[2]) / 2, my = (sg[1] + sg[3]) / 2;
          E.set(0, Math.atan2(sg[3] - sg[1], sg[2] - sg[0]), 0); Q.setFromEuler(E);
          P.set(mx, 0, -my); Sc.set(sg[4] + R_CURB_W, R_CURB_H, R_CURB_W); // half-width end overlap closes the mitre gaps
          M.compose(P, Q, Sc); inst.setMatrixAt(i, M);
        });
        inst.castShadow = true; inst.receiveShadow = true; inst.renderOrder = 2;
        inst.frustumCulled = false;
        grp.add(inst); mats.push(cMat);
      }
    }
    grp.position.y = 0.3; // proud of the sketch floor + its ink seams
    mats.push(rBakeShadows(st)); // the overlay material fades with the state lever too
    scene.add(grp);
    rGround[st] = { grp, mats };
    return rGround[st];
  }
  function rBuildLights() {
    if (rSun) return;
    const q = rQualityEff();
    rSun = new THREE.DirectionalLight(0xfff4e2, 3.1); // warm afternoon sun (filmic tone map balances the mids)
    rSun.position.set(CTR.x + 120, 95, CTR.z + 88); // summer afternoon — soft shadows long enough to read
    rSun.target.position.copy(CTR);
    scene.add(rSun.target);
    rSun.castShadow = q !== 'low';
    if (rSun.castShadow) {
      const sc = rSun.shadow;
      sc.mapSize.set(q === 'high' ? 2048 : 1024, q === 'high' ? 2048 : 1024);
      // cover the FULL site: at 135 King's Road's far corner lost its shadows, and a
      // larger site needs a correspondingly wider frustum
      const half = Math.max(160, Math.max((SITE_B[2] - SITE_B[0]), (SITE_B[3] - SITE_B[1])) / 2 + 20);
      sc.camera.left = -half; sc.camera.right = half; sc.camera.top = half; sc.camera.bottom = -half;
      sc.camera.near = 20; sc.camera.far = 400;
      sc.camera.updateProjectionMatrix(); // property changes never take without this
      sc.bias = -0.0012; sc.normalBias = 0.5; sc.radius = 5; // soft PCF edge, no acne on the raised turf
    }
    rHemi = new THREE.HemisphereLight(0xeaf1f8, 0xd8d2c4, 1.15); // sky fill / warm ground bounce
    scene.add(rSun); scene.add(rHemi);
  }
  // trees: species-green masses under REAL light. Each tree gets its OWN lit material
  // with a subtle colour jitter (reference: no two trees read identical), and the
  // vertex bake carries a dappled noise so canopies read as foliage, not plastic.
  var rTreeMatsA = [], rTreeMatsB = [];
  // shared foliage/bark bake: crown greens with height-based AO (dark interior/base,
  // brighter warmer crown) + a distinct bark trunk. Deterministic dapple per geometry.
  function rBakeTreeColors(g, species) {
    const col = g.getAttribute('color'); if (!col) return;
    if (!g._rOrig) g._rOrig = col.array.slice();
    const O = g._rOrig, tm = g._trunkMask, ct = g._crownT;
    const gc = new THREE.Color(R_GREEN[species] || '#729552');
    let s2 = 3 + col.count * 7; const rh = () => (s2 = (s2 * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < col.count; k++) {
      const l = O[k * 3] * 0.35 + O[k * 3 + 1] * 0.5 + O[k * 3 + 2] * 0.15; // facet-light proxy
      if (tm && tm[k] > 0.5) {                       // bark trunk
        const bl = 0.5 + 0.55 * l;
        col.setXYZ(k, 0.315 * bl, 0.255 * bl, 0.205 * bl);
      } else {                                       // foliage
        const h = ct ? ct[k] : 1;                    // 0 = crown underside, 1 = top
        const ao = 0.64 + 0.36 * h;                  // canopy self-shadow toward the base
        const dap = 0.86 + rh() * 0.26;              // leafy dapple
        const sh = (0.74 + 0.32 * l) * dap * ao;
        col.setXYZ(k, gc.r * sh * (1 + 0.10 * h), gc.g * sh, gc.b * sh * (1 - 0.06 * h)); // warmer/lighter up top
      }
    }
    col.needsUpdate = true;
  }
  // swap a tree between its sketch blob geometry and its species crown. The species
  // crown is built once per tree and cached; sketch always shows the original blob.
  function treeUseGeom(tr, species, eye) {
    if (species) {
      if (!tr._blobGeom) tr._blobGeom = tr.mesh.geometry;
      if (eye) {
        if (!tr._eyeGeom) tr._eyeGeom = speciesTreeGeom(tr.t, tr._jit || 1, true);
        if (tr.mesh.geometry !== tr._eyeGeom) tr.mesh.geometry = tr._eyeGeom;
        return;
      }
      if (!tr._speciesGeom) tr._speciesGeom = speciesTreeGeom(tr.t, tr._jit || 1);
      if (tr.mesh.geometry !== tr._speciesGeom) tr.mesh.geometry = tr._speciesGeom;
    } else if (tr._blobGeom && tr.mesh.geometry !== tr._blobGeom) {
      tr.mesh.geometry = tr._blobGeom;
    }
  }
  // §RW leaf texture: a value-only mottle of overlapping leaf shapes. It MULTIPLIES the
  // baked crown colour, so species greens survive and the canopy stops reading as flat
  // facets at eye level. One shared 512² canvas for every tree.
  var _leafTex = null;
  function rLeafTex() {
    if (_leafTex) return _leafTex;
    const N = 512, c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, N, N);
    let sd = 12345; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    const leaf = (x, y, r, a, v, rot) => {
      g.save(); g.translate(x, y); g.rotate(rot);
      g.beginPath(); g.moveTo(0, -r);
      g.quadraticCurveTo(r * 0.68, -r * 0.1, 0, r);
      g.quadraticCurveTo(-r * 0.68, -r * 0.1, 0, -r);
      g.closePath();
      g.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',' + a + ')';
      g.fill(); g.restore();
    };
    for (let i = 0; i < 1500; i++) {
      const x = rnd() * N, y = rnd() * N, r = 5 + rnd() * 13, rot = rnd() * Math.PI * 2;
      const dark = rnd() < 0.55;
      const v = dark ? Math.round(140 + rnd() * 60) : 252;
      const a = dark ? 0.16 + rnd() * 0.22 : 0.14 + rnd() * 0.2;
      for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) {
        if (x + dx > -r && x + dx < N + r && y + dy > -r && y + dy < N + r) leaf(x + dx, y + dy, r, a, v, rot);
      }
    }
    _leafTex = new THREE.CanvasTexture(c);
    _leafTex.wrapS = _leafTex.wrapT = THREE.RepeatWrapping;
    return _leafTex;
  }
  function rTreesApply(on) {
    const doneG = new Set();
    let seedT = 11;
    const rr = () => (seedT = (seedT * 16807) % 2147483647) / 2147483647;
    const eye = on && (!!S.walk || fw.active); // §RW walkthrough canopy
    for (const T of [treesA, treesB]) for (const tr of T.trees) {
      treeUseGeom(tr, on, eye); // species crown in rendered (walk variant at eye level), blob in sketch
      const g = tr.mesh.geometry;
      if (!doneG.has(g)) {
        doneG.add(g);
        if (on && !g.getAttribute('normal')) g.computeVertexNormals();
        const col = g.getAttribute('color');
        if (on) rBakeTreeColors(g, tr.t.species);
        else if (g._rOrig) col.array.set(g._rOrig);
        col.needsUpdate = true;
        col.needsUpdate = true;
      }
      if (on) {
        if (!tr._rMat) {
          tr._rMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, flatShading: true });
          const v = 0.88 + rr() * 0.26;
          tr._rMat.color.setRGB(v * (0.95 + rr() * 0.1), v, v * (0.9 + rr() * 0.16));
          (T === treesA ? rTreeMatsA : rTreeMatsB).push(tr._rMat);
        }
        if (eye && !tr._rMatEye) {
          // leaf-mapped, smooth-shaded, DOUBLE-sided: the board crown is single-sided, so
          // any inverted facet reads as a hole in the canopy from underneath
          tr._rMatEye = new THREE.MeshLambertMaterial({
            vertexColors: true, transparent: true, flatShading: false,
            map: rLeafTex(), side: THREE.DoubleSide
          });
          tr._rMatEye.color.copy(tr._rMat.color);
          tr._rMatEye.shadowSide = THREE.DoubleSide;
          (T === treesA ? rTreeMatsA : rTreeMatsB).push(tr._rMatEye);
        }
        const m = eye ? tr._rMatEye : tr._rMat;
        m.opacity = T.mat.opacity;
        tr.mesh.material = m;
      } else tr.mesh.material = T.mat;
      tr.mesh.castShadow = on;
      tr.mesh.receiveShadow = false; // cast-only: neighbour shadows blacken grove interiors
      for (const c2 of tr.piv.children) if (c2.isLineSegments2 || c2.isLine) c2.visible = !on;
    }
  }
  // apply the rendered tree treatment to ONE freshly-planted tree (design mode now
  // stays rendered, so added trees must match the green-canopy look, not the white
  // sketch material + ink edges). Mirrors rTreesApply's per-tree body.
  function rApplyTree(tr, T) {
    treeUseGeom(tr, true); // planted in rendered mode → species crown
    const g = tr.mesh.geometry;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const col = g.getAttribute('color');
    if (col) rBakeTreeColors(g, tr.t.species);
    if (!tr._rMat) {
      tr._rMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, flatShading: true });
      let s3 = (T === treesA ? 101 : 202) + T.trees.length * 13; const rr = () => (s3 = (s3 * 16807) % 2147483647) / 2147483647;
      const v = 0.88 + rr() * 0.26;
      tr._rMat.color.setRGB(v * (0.95 + rr() * 0.1), v, v * (0.9 + rr() * 0.16));
      (T === treesA ? rTreeMatsA : rTreeMatsB).push(tr._rMat);
    }
    tr._rMat.opacity = T.mat.opacity;
    tr.mesh.material = tr._rMat;
    tr.mesh.castShadow = true; tr.mesh.receiveShadow = false;
    for (const c2 of tr.piv.children) if (c2.isLineSegments2 || c2.isLine) c2.visible = false;
  }
  // buildings: pale warm Lambert volumes under the real sun — they cast + receive
  // soft shadows so they sit IN the scene instead of reading as cardboard cutouts.
  // (v2 sketch buildings carry GRAIN/HATCH maps on BOTH meshes, so the swap must not
  // skip mapped materials — it stores the originals and restores them on toggle-off.)
  function rBuildingsApply(on) {
    for (const b of buildings) {
      if (on && !b._rSwaps) {
        b._rSwaps = [];
        for (const o of b.mesh.children) {
          if (!o.isMesh || o.isLine || o.isLineSegments2) continue; // LineSegments2 reports isMesh—test lines first
          const lam = new THREE.MeshStandardMaterial({ color: 0xf6f3ec, roughness: 0.92, metalness: 0.0, envMapIntensity: 0.35, transparent: true, opacity: o.material.opacity, flatShading: true, side: THREE.DoubleSide }); // sketch winding is pushed \u2014 DoubleSide or the sun lights the interiors
          lam.shadowSide = THREE.DoubleSide; // flipped winding also culls the shadow pass \u2014 without this buildings cast nothing
          if (o.geometry.getAttribute('color')) lam.vertexColors = true;
          if (!o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
          const mi = b.mats.indexOf(o.material);
          b._rSwaps.push({ o, orig: o.material, lam, mi });
        }
      }
      if (!b._rSwaps) continue;
      for (const sw of b._rSwaps) {
        sw.o.material = on ? sw.lam : sw.orig;
        if (on) sw.lam.opacity = sw.orig.opacity;
        if (sw.mi >= 0) b.mats[sw.mi] = on ? sw.lam : sw.orig; // stateMix fades removed buildings via b.mats
        sw.o.castShadow = on;
        sw.o.receiveShadow = on;
      }
    }
  }
  // one visibility/opacity pass — the single source of truth for what rendered mode
  // shows. Reads S.rendered / S.showData / rSuspended. §RW: walk modes now inherit the
  // rendered aesthetic; only the data layer differs (aura plane instead of the wash).
  function syncRendered() {
    // §RW the rendered aesthetic now carries the walkthrough too: at eye level the
    // materials ARE the picture, so rendered is no longer suspended in walk. The
    // difference is the data layer — the aura plane replaces the iso wash.
    const inWalk = !!S.walk || fw.active;
    const active = !!S.rendered && !rSuspended;
    skyRendered(active && inWalk);
    if (!rBuilt && !active) return;
    if (active) {
      rBuild();
      renderer.shadowMap.enabled = false; // §R shadows are BAKED (rBakeShadows) — realtime shadow maps proved flaky here, see NOTES
      // filmic tone + subtle IBL — the realism layer. Stashed + reverted on exit so sketch is untouched.
      if (renderer.toneMapping !== THREE.ACESFilmicToneMapping) { rTonePrev = renderer.toneMapping; rExpPrev = renderer.toneMappingExposure; }
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.18;
      rEnsureEnv(); if (rEnv) scene.environment = rEnv;
      rSun.visible = true; rHemi.visible = true;
      auraMesh.visible = false; // rendered mode uses materials/wash — smooth iso field off
      const dataOff = !S.showData;
      for (const st of STATES) rBuildGround(st);
      for (const st of STATES) for (const m of rGround[st].mats) m.needsUpdate = true; // shadowMap toggle recompiles
      if (inWalk) {
        // §RW eye level: rendered ground materials underfoot; when SHOW DATA is on the
        // aura plane (the walk's own data ground) carries it, not the iso mosaic wash.
        rWashApply(false);
        rLawnEyeLevel(!dataOff ? false : true);
        rInkApply(true);
        setFieldOpacity('baseline', 0); setFieldOpacity('scenario_01', 0);
        groundA.seams.visible = false; groundB.seams.visible = false;
        auraMesh.visible = !dataOff;
        S.fieldOn = !dataOff;
        if (grass3D) grass3D.restyle(); // §RW lit turf blades vs the data-hued sketch stubble
        stateMix(mixP);
        rTreesApply(true);
        rBuildingsApply(true);
        rSlabApply(true);
        curbRendered(true);
        return;
      }
      rLawnEyeLevel(false); // back on the board: the sage lawn returns
      rInkApply(false);     // ...and its linework
      // suppress the sketch data field + ink seams while the picture is up
      if (dataOff) {
        rWashApply(false);
        if (S.relief) setRelief(false);
        setFieldOpacity('baseline', 0); setFieldOpacity('scenario_01', 0);
        groundA.seams.visible = false; groundB.seams.visible = false;
        S.fieldOn = false;
      } else {
        // §R wash (option 1a): the familiar mosaic cells float over the materials at
        // R_WASH_OP — data over the picture, not instead of it. IDENTICAL in VIEW and
        // DESIGN mode: the sketch grid floor never returns; editing happens on the
        // rendered site, and the wash only appears when SHOW DATA is on.
        rWashApply(true);
        if (S.relief) setRelief(false);
        S.fieldOn = true;
        groundA.seams.visible = false; groundB.seams.visible = false;
        setMetric(S.metric); // legend + colours; setGroundDim routes opacity through R_WASH_OP
      }
      stateMix(mixP); // re-apply the crossfade so rendered ground matches the lever
      rTreesApply(true);
      rBuildingsApply(true);
      rSlabApply(true);
    } else {
      if (rSun) { rSun.visible = false; rHemi.visible = false; }
      renderer.shadowMap.enabled = false;
      // revert the filmic tone + IBL so sketch / walk render exactly as before
      if (renderer.toneMapping === THREE.ACESFilmicToneMapping) {
        renderer.toneMapping = rTonePrev != null ? rTonePrev : THREE.NoToneMapping;
        renderer.toneMappingExposure = rExpPrev != null ? rExpPrev : 1;
      }
      scene.environment = null;
      for (const st of STATES) if (rGround[st]) rGround[st].grp.visible = false;
      rWashApply(false);
      groundA.seams.visible = true; groundB.seams.visible = true;
      rTreesApply(false);
      rBuildingsApply(false);
      rSlabApply(false);
      curbRendered(false);
      rLawnEyeLevel(false);
      rInkApply(false);
      S.fieldOn = true;
      if (!S.walk && !fw.active) { setMetric(S.metric); stateMix(mixP); }
    }
  }
  // plinth: in rendered mode the cut slab reads as pale concrete (the 45° hatch is a
  // sketch signature). Nothing outside the model itself changes — page stays paper.
  function rSlabApply(on) {
    const ch = slab.grp.children; // [walls, cap, hatch, edges]
    if (on && !slab._rMats) {
      slab._rMats = {
        walls: ch[0].material, cap: ch[1].material,
        pW: new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
        pC: new THREE.MeshBasicMaterial({ color: 0xf4f2ee, side: THREE.DoubleSide })
      };
    }
    if (!slab._rMats) return;
    ch[0].material = on ? slab._rMats.pW : slab._rMats.walls;
    ch[1].material = on ? slab._rMats.pC : slab._rMats.cap;
    ch[2].visible = !on;
  }
  // §RW at eye level the sage lawn of the isometric board reads too dry to stand on —
  // the walk tints the same turf material down to a believable grass green. The tile,
  // its normal map and the isometric look are untouched.
  // It ALSO drops the lawn nearly flat: the 26 cm proud turf slab is a board device (its
  // edge reads as thickness in axo) but from inside the site it is a green block. At eye
  // level the slab drops to a 14 cm mow lip — level with the curb tops, so the lawn reads
  // as ground rather than a plinth or a trench — its cut skirt goes away, and the dense
  // blades carry the turf instead.
  var rLawnFlat = false;
  const R_LAWN_LIP = 0;      // eye level: the lawn surface sits AT grade
  var rLawnTop = {};         // world y of that surface PER STATE — blades root in it
  // §RW ink suppression: the sketch aesthetic outlines every edge at constant screen
  // weight. On the board that IS the drawing; at eye level a bench, a bin or a building
  // corner traced in ink reads as a cartoon, so the rendered walk hides the linework.
  function rInkApply(on) {
    for (const b of buildings) {
      for (const o of b.mesh.children) if (o.isLineSegments2 || o.isLine) o.visible = !on;
    }
    if (life && life.inkVisible) life.inkVisible(!on);
  }
  function rLawnEyeLevel(on) {
    rLawnFlat = !!on;
    for (const st of STATES) {
      const rg = rGround[st]; if (!rg) continue;
      for (const ch of rg.grp.children) {
        const ud = ch.userData || {};
        if (ud.lawnSkirt) { ch.visible = !on; continue; }
        const cat = ud.cat || ud.shadowFor;
        if (!cat || cat.indexOf('grass') < 0) continue;
        if (ch._raisedY == null) { ch._raisedY = ch.position.y; ch._flatY = ch.position.y - R_GRASS_H + R_LAWN_LIP; }
        ch.position.y = on ? ch._flatY : ch._raisedY;
        if (ud.cat) rLawnTop[st] = ch.position.y; // blades grow out of THIS plane, per state
        if (ud.cat && ch.material && ch.material.color) ch.material.color.setHex(on ? 0xb9c48f : 0xffffff);
      }
    }
  }
  function rBuild() {
    if (rBuilt) { return; }
    rBuilt = true;
    rBuildLights();
    rBuildGround('baseline'); rBuildGround('scenario_01');
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  function setRendered(on) {
    if (!!on === !!S.rendered) return;
    S.rendered = !!on;
    if (on) S.showData = false; // enter rendered on the pure experience — data waits for SHOW DATA (even in design mode)
    syncRendered();
  }
  function setShowData(on) {
    if (!S.rendered) return;
    const was = S.showData;
    S.showData = !!on;
    if (!!on === !!was) { syncRendered(); return; }
    if (on && !S.designMode) {
      // fade the wash into the scene: syncRendered() sets the resting targets, then we
      // start the mosaic + primer transparent and slightly lifted and settle them down.
      syncRendered();
      const RISE = 1.4, tgt = {};
      for (const st of STATES) {
        const mo = mosaic[st] ? mosaic[st].material.opacity : 0;
        const pv = !!(R_PRIMER && R_PRIMER[st] && R_PRIMER[st].visible);
        const po = pv ? R_PRIMER[st].material.opacity : 0;
        const my = mosaic[st] ? mosaic[st].position.y : 0;
        const py = pv ? R_PRIMER[st].position.y : 0;
        tgt[st] = { mo, po, pv, my, py };
        if (mosaic[st]) { mosaic[st].material.opacity = 0; mosaic[st].position.y = my + RISE; }
        if (pv) { R_PRIMER[st].material.opacity = 0; R_PRIMER[st].position.y = py + RISE; }
      }
      tween(620, k => {
        const e = easeOut(k), lift = (1 - e) * RISE;
        for (const st of STATES) {
          const t = tgt[st]; if (!t) continue;
          if (mosaic[st]) { mosaic[st].material.opacity = t.mo * e; mosaic[st].position.y = t.my + lift; }
          if (t.pv) { R_PRIMER[st].material.opacity = t.po * e; R_PRIMER[st].position.y = t.py + lift; }
        }
      }, easeOut, () => { // snap to exact resting values
        for (const st of STATES) {
          const t = tgt[st]; if (!t) continue;
          if (mosaic[st]) { mosaic[st].material.opacity = t.mo; mosaic[st].position.y = t.my; }
          if (t.pv) { R_PRIMER[st].material.opacity = t.po; R_PRIMER[st].position.y = t.py; }
        }
      });
    } else if (!on && !was === false && rWashOn) {
      // fade the wash back out, then commit the sketch/off state
      const cur = {};
      for (const st of STATES) cur[st] = {
        mo: mosaic[st] ? mosaic[st].material.opacity : 0,
        po: (R_PRIMER && R_PRIMER[st]) ? R_PRIMER[st].material.opacity : 0
      };
      tween(360, k => {
        const f = 1 - k;
        for (const st of STATES) {
          if (mosaic[st]) mosaic[st].material.opacity = cur[st].mo * f;
          if (R_PRIMER && R_PRIMER[st]) R_PRIMER[st].material.opacity = cur[st].po * f;
        }
      }, easeIO, () => syncRendered());
    } else {
      syncRendered();
    }
  }

  // ---- public API --------------------------------------------------------------------
  const agg = {
    ghi: GHI,
    baseline: D.baseline.agg,
    scenario: D.scenario_01.agg,
    counts: { points: D.baseline.n + D.scenario_01.n, base: D.baseline.n, sc: D.scenario_01.n, treesBase: geo.baseline.trees.length, treesSc: geo.scenario_01.trees.length }
  };

  try { window.__dtsScene = scene; window.__dtsCam = () => activeCam; } catch (e) {}
  return {
    THREE, metrics: METRICS, agg, routes: ROUTES,
    catLabel: CAT_LABEL,
    playScene(n) { const prev = S.scene; S.scene = n; playScene(n, prev); },
    scrollDrive,
    setPhase(p) {
      S.phase = p;
      if (p !== 'sandbox') { routePreview.hide(); auraMesh.visible = false; }
      life.setSandbox(p === 'sandbox');
      if (p === 'sandbox' && !S.rendered && !S.walk && !fw.active) setMetric(S.metric); // paint the smooth iso field
    },
    setDesignState, peekBaseline, snapshotBaseline, setMetric, setThreshold, setRelief, setPlan,
    setRendered, setShowData,
    clearSelection,
    nudgeLever() { /* handled in DOM */ },
    startWalk, endWalk,
    beginFreeWalk,
    beginFreeWalkAt(clientX, clientY) { const g = fwGroundAt(clientX, clientY); if (!g || !g.walkable) return false; beginFreeWalk(g.px, g.py); return true; },
    freeWalkGroundAt(clientX, clientY) { return fwGroundAt(clientX, clientY); },
    endFreeWalk,
    freeWalkActive() { return fw.active; },
    setDesignMode, editDeleteSelected, editMoveSelected, editAddTree, editSwapSelected, editReset, exportScenario, exportDesign, designAccounting,
    sectionData, sectionCuts, sectionCutById, defaultCut, setSectionMarker,
    sectionGridShow, sectionPickHover, sectionPickSelect, sectionPickDir, sectionPickCurrent, sectionPickReset,
    plantingPreview, plantingClear, plantingCommit, editDeletePlanting,
    plantingSpec, plantingRetune, undo, redo, historyMark,
    clusterInfo, setClusterSelected, setClusterManual,
    clusterThinPreview, clusterThinClear, clusterThinCommit, clusterRemove, clusterReset,
    clusterCount() { return clustersFor(stateKey()).list.length; },
    selectTreeAt, treeAt, designHoverAt, selectAt,
    speciesList() { return Object.keys(speciesSample).length ? Object.keys(speciesSample) : Object.keys(SPECIES); },
    designModeActive() { return !!S.designMode; },
    plantableAt(clientX, clientY) { return fwGroundAt(clientX, clientY); },
    // calibration gate (§2/§7): proxy vs real load on the UNEDITED scene
    calibrateProxy() {
      const st = stateKey(), d = D[st], trees = proxyTrees();
      let sumAbs = 0, sumRel = 0, n = 0, sample = Math.max(1, Math.floor(d.n / 600));
      for (let i = 0; i < d.n; i += sample) {
        const shade = proxyShadeAt(d.x[i], d.y[i], trees);
        const pl = GHI * (1 - Math.max(0, Math.min(0.75, shade)));
        sumAbs += Math.abs(pl - d.load[i]); sumRel += Math.abs(pl - d.load[i]) / Math.max(1, d.load[i]); n++;
      }
      return { meanAbsErr: sumAbs / n, meanRelErr: sumRel / n, samples: n, suns: SUN.length };
    },
    previewRoute(id) { if (S.phase !== 'sandbox' || S.walk) { routePreview.hide(); return; } routePreview.show(id); },
    // Screen anchor for a route's hover label: parks it in the white space OUTSIDE the
    // projected site footprint, on whichever side the route's midpoint sits nearest.
    // Works in plan and iso alike (the site bbox is projected through the live camera).
    routeLabelAnchor(id) {
      if (!ROUTES[id]) return null;
      const raw = ROUTES[id].pts[S.designState] || ROUTES[id].pts.baseline;
      if (!raw || !raw.length) return null;
      const v = new THREE.Vector3();
      const proj = (x, y, h) => { v.set(x, h || 0, -y).project(activeCam); return { x: (v.x * 0.5 + 0.5) * W, y: (1 - (v.y * 0.5 + 0.5)) * H }; };
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const cx of [SITE_B[0], SITE_B[2]]) for (const cy of [SITE_B[1], SITE_B[3]]) for (const h of [0, 16]) {
        const s = proj(cx, cy, h);
        if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x;
        if (s.y < y0) y0 = s.y; if (s.y > y1) y1 = s.y;
      }
      const mid = raw[Math.floor(raw.length / 2)];
      const p = proj(mid[0], mid[1], 1.7);
      const pad = 16;
      const d = { left: Math.abs(p.x - x0), right: Math.abs(x1 - p.x), top: Math.abs(p.y - y0), bottom: Math.abs(y1 - p.y) };
      // prefer a side that actually has room on screen
      const room = { left: x0 - pad, right: W - (x1 + pad), top: y0 - pad, bottom: H - (y1 + pad) };
      let side = null, best = Infinity;
      for (const k of ['left', 'right', 'top', 'bottom']) {
        if (room[k] < 90) continue;
        if (d[k] < best) { best = d[k]; side = k; }
      }
      if (!side) { let r = -Infinity; for (const k of ['right', 'left', 'bottom', 'top']) if (room[k] > r) { r = room[k]; side = k; } }
      let ax, ay;
      if (side === 'left') { ax = x0 - pad; ay = Math.min(Math.max(p.y, y0), y1); }
      else if (side === 'right') { ax = x1 + pad; ay = Math.min(Math.max(p.y, y0), y1); }
      else if (side === 'top') { ay = y0 - pad; ax = Math.min(Math.max(p.x, x0), x1); }
      else { ay = y1 + pad; ax = Math.min(Math.max(p.x, x0), x1); }
      return { x: Math.round(ax), y: Math.round(ay), side, w: W, h: H };
    },
    setMaterialSwap(catId) {
      S.matSwap = catId || null;
      if (METRICS[S.metric] && METRICS[S.metric].kind === 'tree') recolorTrees();
      else activeMosaicColors();
      const bites = (METRICS[S.metric] && METRICS[S.metric].kind === 'tree') || S.metric === 'groundtemp';
      cb.onMaterialSwap && cb.onMaterialSwap({ cat: S.matSwap, affectsActiveTab: bites });
    },
    setPlanValue(v) { applyTilt(Math.max(0, Math.min(1, v))); },
    // §V orbit + zoom
    setOrbitArmed(on) {
      if (on && !orb.armed) orb.planAt = S.plan; // remember plan-vs-iso so EXIT can restore it
      orb.armed = !!on;
      canvas.style.cursor = on ? 'grab' : '';
      if (!on) orbPtr = null;
      return viewState();
    },
    // EXIT: drop the free-look offsets and settle back to the tilt the user armed from
    exitOrbit() {
      orb.armed = false; orbPtr = null; canvas.style.cursor = '';
      orb.az = 0; orb.el = 0; cam.fit = 1;
      const from = S.plan, to = orb.planAt != null ? orb.planAt : S.plan;
      if (Math.abs(from - to) > 0.002) tween(760, k => applyTilt(from + (to - from) * k));
      else applyTilt(S.plan);
      return viewState();
    },
    orbitBy(daz, del) {
      orb.az += daz || 0;
      orb.el = Math.max(ORB_LIM.el[0], Math.min(ORB_LIM.el[1], orb.el + (del || 0)));
      applyTilt(S.plan); return viewState();
    },
    zoomBy(mult) { setFit(cam.fit * mult); return viewState(); },
    resetView() { orb.az = 0; orb.el = 0; cam.fit = 1; applyTilt(S.plan); return viewState(); },
    viewState() { return viewState(); },
    setViewPan(px) { if (px !== viewPanX) { viewPanX = px; applyOrtho(); } },
    // simple top-down plan geometry for the section mini-plan: site bounds, ground
    // surface outlines, and building footprint bboxes — all in site (x,y) coords.
    planShapes(st) {
      const g = geo[st || (mixP < 0.5 ? 'baseline' : 'scenario_01')] || geo.baseline;
      const grounds = [];
      for (const c of CATS) for (const s of (g.surfaces[c] || [])) if (s.outer && s.outer.length) grounds.push(s.outer);
      const builds = [];
      for (const b of (g.buildings || [])) builds.push(bboxOf(b.mesh));
      return { bounds: SITE_B.slice(), grounds, buildings: builds };
    },
    // ---- §B board pack -------------------------------------------------------
    // Vector plan geometry in site coords: ground rings per category (so the SVG can
    // carry one layer per material), building footprints, and live trees per species.
    boardPlan(st) {
      const key = st || (mixP < 0.5 ? 'baseline' : 'scenario_01');
      const g = geo[key] || geo.baseline;
      const hex = (v) => '#' + ('000000' + (v >>> 0).toString(16)).slice(-6);
      const cats = [];
      for (const c of CATS) {
        const rings = [];
        for (const s of (g.surfaces[c] || [])) if (s.outer && s.outer.length > 2) rings.push(s.outer.map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]));
        // CAT_TINT, not CAT_GROUND: every manifest sets ground to #ffffff (the paper
        // base) and carries the real material colour in tint.
        if (rings.length) cats.push({ cat: c, label: CAT_LABEL[c] || c, fill: hex(CAT_TINT[c]), rings });
      }
      const buildings = [];
      for (const b of (g.buildings || [])) buildings.push(bboxOf(b.mesh));
      const trees = [];
      for (const tr of (mixP < 0.5 ? treesA : treesB).trees) {
        if (tr._del) continue;
        trees.push({ species: tr.t.species, x: +tr.t.pos[0].toFixed(2), y: +tr.t.pos[1].toFixed(2), r: +(+tr.t.radius || 2).toFixed(2) });
      }
      return { state: key, bounds: SITE_B.slice(), cats, buildings, trees };
    },
    // One frame rendered off-screen at `scale`x the stage, on a fully transparent
    // ground — the drop-on-any-background PNG the board pack ships. Renders through a
    // render target because the visible canvas has no alpha channel.
    captureTransparent(opts) {
      const o = opts || {};
      const scale = Math.max(1, Math.min(4, o.scale || 3));
      const w = Math.max(2, Math.round(W * scale)), h = Math.max(2, Math.round(H * scale));
      const rt = new THREE.WebGLRenderTarget(w, h, { samples: 4 });
      const prevBg = scene.background, prevAlpha = renderer.getClearAlpha(), prevRT = renderer.getRenderTarget();
      scene.background = null;
      renderer.setClearAlpha(0);
      for (const m of fatMats) m.resolution.set(w, h);
      renderer.setRenderTarget(rt);
      renderer.render(scene, activeCam);
      const buf = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      renderer.setRenderTarget(prevRT);
      scene.background = prevBg;
      renderer.setClearAlpha(prevAlpha);
      for (const m of fatMats) m.resolution.set(W, H);
      rt.dispose();
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(w, h);
      const row = w * 4;
      for (let yy = 0; yy < h; yy++) img.data.set(buf.subarray((h - 1 - yy) * row, (h - 1 - yy) * row + row), yy * row);
      ctx.putImageData(img, 0, 0);
      renderer.render(scene, activeCam); // restore the visible frame
      return { dataURL: cv.toDataURL('image/png'), w, h, aspect: w / h };
    },
    treeDiscs() {
      const out = [];
      const arr = (mixP < 0.5 ? treesA : treesB).trees;
      const v = new THREE.Vector3();
      for (const tr of arr) {
        if (tr.piv && tr.piv.visible === false) continue;
        const px = tr.t.pos[0], pz = -tr.t.pos[1], rr = tr.t.radius || 2;
        v.set(px, 0, pz).project(activeCam);
        if (v.z > 1) continue;
        const sx = (v.x * 0.5 + 0.5) * W, sy = (1 - (v.y * 0.5 + 0.5)) * H;
        v.set(px + rr, 0, pz).project(activeCam);
        const ex = (v.x * 0.5 + 0.5) * W;
        out.push({ x: sx, y: sy, r: Math.max(7, Math.abs(ex - sx) * 1.3) });
      }
      return out;
    },
    walkSetPlaying(v) { if (walk) walk.playing = v; },
    walkScrub(t) { if (walk) { walk.playing = false; walkFrame(t, true); } },
    walkSpeed(v) { if (walk) walk.speed = v; },
    walkProfileValues,
    getState() { return S; },
    debugProject(x, y, z) { const v = new THREE.Vector3(x, y, z); v.project(activeCam); return { x: +v.x.toFixed(3), y: +v.y.toFixed(3) }; },
    debugFlags() { return { hoverLine: hoverLine.visible, hoverCat: hoverSurf ? hoverSurf.cat : null, sel: selLine.visible, selFill: selFill.visible, selEdge: selEdge.visible }; },
    setParams(p) {
      if (p.tessellationLoudness != null && p.tessellationLoudness !== LOUD) {
        LOUD = p.tessellationLoudness;
        mosaic.baseline.userData.layout(); mosaic.scenario_01.userData.layout();
      }
      if (p.reliefExaggeration != null && p.reliefExaggeration !== EXAG) {
        EXAG = p.reliefExaggeration;
        if (S.relief) layoutRelief(S.designState, S.metric, 0);
      }
      if (p.reliefStyle != null && RELIEF_STYLES[p.reliefStyle] && p.reliefStyle !== RSTYLE) {
        RSTYLE = p.reliefStyle;
        if (S.relief) {
          layoutRelief(S.designState, S.metric);
          const R = relief[S.designState];
          if (R.mesh.visible || R.dots.visible) reliefVis(S.designState, 1);
        }
      }
      if (p.devSyntheticTemperature != null) {
        S.devTemp = !!p.devSyntheticTemperature;
        if (METRICS[S.metric] && METRICS[S.metric].kind === 'tree') recolorTrees();
        else activeMosaicColors();
      }
      if (p.ambientLife != null) life.setOn(!!p.ambientLife);
      if (p.renderQuality != null && p.renderQuality !== rQuality) {
        rQuality = p.renderQuality;
        if (rSun) {
          rSun.castShadow = rQualityEff() !== 'low';
          const sz = rQualityEff() === 'high' ? 2048 : 1024;
          rSun.shadow.mapSize.set(sz, sz);
          if (rSun.shadow.map) { rSun.shadow.map.dispose(); rSun.shadow.map = null; }
        }
        if (S.rendered) syncRendered();
      }
      if (p.swayAmount != null) life.setSway(p.swayAmount);
      if (p.walkPropHue != null) {
        MV_PROP_SHADES = mvShadesFrom(new THREE.Color(p.walkPropHue));
        for (const k in walkCurbG) { walkCurbRoot.remove(walkCurbG[k]); delete walkCurbG[k]; } // rebuild curbs in the new prop colour
        if (MVON) showWalkCurbs(true);
        if (MVON && life.mvStyle) life.mvStyle(true, MV_PROP_SHADES);
      }
    },
    resize,
    scene,
    _dbgTick(dt) { life.update(dt, performance.now()); }, // dev-only: advance ambient life when rAF is frozen (hidden doc)
    _dbgCapture(w) { // dev-only: render one frame and return a downscaled JPEG data-URL
      renderer.render(scene, activeCam);
      const src = renderer.domElement;
      const c = document.createElement('canvas');
      const k = (w || 420) / src.width;
      c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.55);
    },
    dispose() {
      disposed = true;
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', fwKeyDown);
      window.removeEventListener('keyup', fwKeyUp);
      for (const off of _domOff) { try { off(); } catch (e) {} }
      _domOff.length = 0;
      renderer.dispose();
    }
  };
}
