// Geometry + rules engine. Pure functions over GeoJSON (lng/lat), metres via turf.
import * as turf from '@turf/turf';
import {
  ZONE, SOURCES, BUILDING_TYPES, HIGH_RISE_M, VERY_LARGE_M2, BIG_ACCESS_M2,
  roadSetback, regime,
} from './rules.js';

const M = { units: 'meters' };
const BAND_STEP = 2; // metres; height plane is drawn as 2 m steps (conservative)
const LOWRISE_MAX_H = 22.9; // stay under the 23 m high-rise threshold
const SAFETY = 0.3;
const MIN_PLATE = 150; // m²: smallest useful floor plate (core + a few units) // m of headroom under the height plane (buffer arcs are polygonal)

// ---------- small geometry helpers ----------
const fc = (arr) => turf.featureCollection(arr.filter(Boolean));
const area = (f) => (f ? turf.area(f) : 0);

function clean(f) {
  if (!f || !f.geometry) return null;
  if (area(f) < 0.5) return null;
  return f;
}
function subtract(a, b) {
  if (!a) return null;
  if (!b) return a;
  try { return clean(turf.difference(fc([a, b]))); } catch { return a; }
}
function intersect(a, b) {
  if (!a || !b) return null;
  try { return clean(turf.intersect(fc([a, b]))); } catch { return null; }
}
function unionAll(list) {
  const l = list.filter(Boolean);
  if (!l.length) return null;
  if (l.length === 1) return l[0];
  try { return turf.union(fc(l)); } catch { return l.reduce((u, x) => turf.union(fc([u, x]))); }
}
function inset(f, d) {
  if (!f) return null;
  if (d <= 0) return f;
  try { return clean(turf.buffer(f, -d, { ...M, steps: 4 })); } catch { return null; }
}
function largestPart(f) {
  if (!f || f.geometry.type === 'Polygon') return f;
  let best = null, ba = 0;
  for (const coords of f.geometry.coordinates) {
    const p = turf.polygon(coords);
    const a = turf.area(p);
    if (a > ba) { ba = a; best = p; }
  }
  return best;
}
function allCoords(f) {
  const g = f.geometry;
  if (g.type === 'Polygon') return g.coordinates.flat();
  return g.coordinates.flat(2);
}

/** Shrink polygon f until its area is ≤ target (binary search on inset). */
function shrinkToArea(f, target) {
  if (!f) return null;
  if (area(f) <= target) return f;
  let lo = 0, hi = 60, best = null;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const g = inset(f, mid);
    const a = area(g);
    if (!g || a <= target) { hi = mid; if (g) best = g; } else lo = mid;
  }
  return best;
}

export function plotEdges(ring) {
  const edges = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    edges.push({ i, a, b, len: turf.distance(a, b, M) });
  }
  return edges;
}

/** Road boundary line along the frontage edge, extended so distances are
 *  measured perpendicular to the road, not to the edge's end points. */
function frontLine(edge) {
  const brg = turf.bearing(edge.a, edge.b);
  const p1 = turf.destination(edge.a, 1000, brg + 180, M).geometry.coordinates;
  const p2 = turf.destination(edge.b, 1000, brg, M).geometry.coordinates;
  return turf.lineString([p1, p2]);
}

/** Plot minus a strip of width d_i along each edge i. */
function footprintWithin(plot, edges, setbacks) {
  const strips = edges
    .map((e, k) => (setbacks[k] > 0.01
      ? turf.buffer(turf.lineString([e.a, e.b]), setbacks[k], { ...M, steps: 6 })
      : null))
    .filter(Boolean);
  return subtract(plot, unionAll(strips));
}

/** Height-plane bands: region of fp at distance ≥ d_k from the road line,
 *  allowed height 2 × (W + d_k), capped. */
function heightBands(fp, line, W, dStart, hCap, planeOn) {
  const bands = [];
  if (!fp) return bands;
  if (!planeOn) {
    bands.push({ region: fp, d: dStart, h: Number.isFinite(hCap) ? hCap : 300 });
    return bands;
  }
  let prev = fp;
  let d = dStart;
  for (let k = 0; k < 200 && prev; k++) {
    const nextD = d + BAND_STEP;
    const h = Math.min(hCap, 2 * (W + d));
    const farther = subtract(prev, turf.buffer(line, nextD, { ...M, steps: 4 }));
    const band = farther ? subtract(prev, farther) : prev;
    if (band) bands.push({ region: band, d, h, ring: prev });
    // once the cap is reached, everything farther has the same height
    if (h >= hCap && farther) { bands.push({ region: farther, d: nextD, h: hCap, ring: farther }); break; }
    prev = farther;
    d = nextD;
  }
  return bands;
}

/** Regions at distance ≥ d_k from road with their allowed height, nested. */
function nestedRegions(bands) {
  // bands[k].ring = region at distance ≥ d_k (before splitting)
  return bands.map((b) => ({ region: b.ring || b.region, d: b.d, h: b.h }));
}

function buildEnvelope(ctx, kind) {
  const { plot, edges, front, W, rules } = ctx;
  const line = frontLine(edges[front]);
  const dRoad41 = rules.road ? roadSetback(W) : 0;
  let dRoad, dSide, hCap;
  if (kind === 'high') {
    const hr = rules.hr6 ? 6 : 0;
    dRoad = Math.max(dRoad41, hr);
    dSide = Math.max(hr, rules.side3 ? 3 : 0);
    hCap = Infinity;
  } else {
    dRoad = dRoad41;
    dSide = rules.side3 ? 3 : 0;
    hCap = LOWRISE_MAX_H;
  }
  const setbacks = edges.map((e, k) => (k === front ? dRoad : dSide));
  const fp = footprintWithin(plot, edges, setbacks);
  const bands = heightBands(fp, line, W, dRoad, hCap, rules.plane);
  return { kind, fp, bands, line, dRoad, dSide, hCap, setbacks };
}

// ---------- designs ----------

function gfaCaps(ctx, kind) {
  const { A, rules, bonus, type, reg } = ctx;
  let cap = rules.far ? A * ZONE.far * (1 + bonus) : Infinity;
  const notes = [];
  if (kind === 'low') { cap = Math.min(cap, VERY_LARGE_M2 - 1); notes.push('kept under 10,000 m² (very-large-building threshold)'); }
  if (kind === 'high' && rules.access && !reg.over30kOK) cap = Math.min(cap, BIG_ACCESS_M2);
  if (type.officeCap) cap = Math.min(cap, type.officeCap);
  if (!Number.isFinite(cap)) cap = A * 20;
  return cap;
}

/** Max ground coverage c such that open space rules hold for GFA g. */
function coverageCap(ctx, g) {
  const { A, rules, type } = ctx;
  let c = A;
  if (rules.osr) c = Math.min(c, A - ZONE.osr * g);
  if (rules.open30) c = Math.min(c, type.residential ? A / 1.3 : A / 1.1);
  return Math.max(0, c);
}

function designTower(ctx, env, label, preferSlim, opts = {}) {
  const { type } = ctx;
  const gCap = gfaCaps(ctx, env.kind);
  const regions = nestedRegions(env.bands);
  let best = null;
  for (const r of regions) {
    const floorsMax = Math.floor((r.h - SAFETY) / type.floorH);
    if (floorsMax < 1) continue;
    const ra = area(r.region);
    // coverage depends on g; iterate twice
    let g = Math.min(gCap, ra * floorsMax);
    let a = Math.min(ra, coverageCap(ctx, g));
    g = Math.min(gCap, a * floorsMax);
    a = Math.min(ra, coverageCap(ctx, g), Math.max(gCap / floorsMax, MIN_PLATE));
    if (opts.coverMax) a = Math.min(a, opts.coverMax);
    if (a < 80) continue;
    const floors = Math.min(floorsMax, Math.max(1, Math.floor(gCap / a)));
    g = a * floors;
    const cand = { r, a, floors, g };
    if (!best || g > best.g * 1.001 || (preferSlim && g >= best.g * 0.97 && a < best.a)) best = cand;
  }
  if (!best) return null;
  let poly = shrinkToArea(largestPart(best.r.region), best.a);
  poly = largestPart(poly);
  if (!poly) return null;
  const a = area(poly);
  const floors = Math.min(Math.floor((best.r.h - SAFETY) / type.floorH), Math.max(1, Math.floor(gCap / a)));
  return {
    label,
    kind: env.kind,
    env,
    masses: [{ poly, base: 0, height: floors * type.floorH, floors, plate: a, name: env.kind === 'low' ? 'Block' : 'Tower' }],
  };
}

function designPodiumTower(ctx, env, label) {
  const { type } = ctx;
  const gCap = gfaCaps(ctx, env.kind);
  const podFloors = 3, podH = 4.0;
  // podium: as big as open-space rules allow
  let podArea = Math.min(area(env.fp), coverageCap(ctx, gCap));
  let pod = largestPart(shrinkToArea(env.fp, podArea));
  if (!pod) return null;
  podArea = area(pod);
  const podGFA = Math.min(podArea * podFloors, gCap);
  const remain = gCap - podGFA;
  const regions = nestedRegions(env.bands);
  let best = null;
  for (const r of regions) {
    if (r.h < podFloors * podH + type.floorH) continue;
    const T = intersect(inset(pod, 3), r.region) || intersect(pod, r.region); // tower set 3 m in from podium edge
    const Ta = area(T);
    if (Ta < 200) continue;
    const ntMax = Math.floor((r.h - SAFETY - podFloors * podH) / type.floorH);
    let plate = Math.min(Ta, Math.max(450, remain / Math.max(1, ntMax)));
    plate = Math.min(plate, 1200); // slender residential plate (assumption)
    const nt = Math.min(ntMax, Math.floor(remain / plate));
    if (nt < 1) continue;
    const g = podGFA + nt * plate;
    if (!best || g > best.g * 1.001 || (g >= best.g * 0.97 && nt * plate >= best.nt * best.plate)) best = { T, plate, nt, g, r };
  }
  const masses = [{ poly: pod, base: 0, height: podFloors * podH, floors: podFloors, plate: podArea, name: 'Podium' }];
  if (best) {
    const tw = largestPart(shrinkToArea(largestPart(best.T), best.plate));
    if (tw) {
      const pa = area(tw);
      const nt = Math.min(best.nt, Math.floor(remain / pa));
      if (nt >= 1) masses.push({ poly: tw, base: podFloors * podH, height: podFloors * podH + nt * type.floorH, floors: nt, plate: pa, name: 'Tower' });
    }
  }
  if (masses.length < 2) return null; // no tower fits: not a real podium + tower scheme
  return { label, kind: env.kind, env, masses };
}

// ---------- checks ----------

function checkDesign(ctx, d) {
  const { A, W, edges, front, rules, bonus, type, reg } = ctx;
  const gfa = d.masses.reduce((s, m) => s + m.plate * m.floors, 0);
  const H = Math.max(...d.masses.map((m) => m.height));
  const coverage = Math.max(...d.masses.filter((m) => m.base === 0).map((m) => m.plate));
  const open = A - coverage;
  const isHigh = H >= HIGH_RISE_M || gfa >= VERY_LARGE_M2;
  const line = d.env.line;
  const frontage = edges[front].len;
  const c = [];
  const fmt = (n) => Math.round(n).toLocaleString();

  const farCap = A * ZONE.far * (1 + bonus);
  c.push({ label: `Floor area ≤ ${ZONE.far}${bonus ? ` × ${(1 + bonus).toFixed(2)}` : ''} × plot`, value: `${fmt(gfa)} / ${fmt(farCap)} m²`, pass: gfa <= farCap + 0.5, src: bonus ? `${SOURCES.far}; ${SOURCES.bonus}` : SOURCES.far });
  c.push({ label: 'Open space ≥ 4% of floor area', value: `${fmt(open)} / ${fmt(ZONE.osr * gfa)} m²`, pass: open >= ZONE.osr * gfa - 0.5, src: SOURCES.osr });
  c.push({ label: 'Planted area ≥ 50% of required open space', value: `needs ${fmt(ZONE.osr * gfa * ZONE.plantedShare)} m² of ${fmt(open)} m² open`, pass: open >= ZONE.osr * gfa * ZONE.plantedShare, src: SOURCES.osr });
  const pct = type.residential ? 0.3 : 0.1;
  c.push({ label: `Open space ≥ ${pct * 100}% of largest floor`, value: `${fmt(open)} / ${fmt(pct * coverage)} m²`, pass: open >= pct * coverage - 0.5, src: SOURCES.openSpace });

  // setbacks: every mass inside the envelope footprint for its regime
  const strictEnv = isHigh ? ctx.envHigh : ctx.envLow;
  const inside = d.masses.every((m) => area(subtract(m.poly, strictEnv.fp)) < 1);
  c.push({ label: isHigh ? 'Setbacks: road + 6 m from every boundary' : 'Setbacks: road + 3 m sides', value: `road ${strictEnv.dRoad.toFixed(1)} m, sides ${strictEnv.dSide.toFixed(1)} m`, pass: !!strictEnv.fp && inside, src: isHigh ? `${SOURCES.roadSetback}; ${SOURCES.highRiseSetback}` : `${SOURCES.roadSetback}; ${SOURCES.openings}` });

  // height plane: for each mass, top ≤ 2 × (W + nearest distance to road line)
  let worst = Infinity, worstTxt = '';
  for (const m of d.masses) {
    const dmin = Math.min(...allCoords(m.poly).map((p) => turf.pointToLineDistance(turf.point(p), line, M)));
    const lim = 2 * (W + dmin);
    const margin = lim - m.height;
    if (margin < worst) { worst = margin; worstTxt = `${m.name} ${m.height.toFixed(1)} m vs ${lim.toFixed(1)} m allowed`; }
  }
  c.push({ label: 'Height ≤ 2 × distance to far side of road', value: worstTxt, pass: worst >= -0.01, src: SOURCES.heightPlane });

  if (isHigh) {
    c.push({ label: 'High-rise/very large: road ≥ 10 m, frontage ≥ 12 m', value: `road ${W} m, frontage ${frontage.toFixed(1)} m`, pass: reg.highRiseOK, src: SOURCES.highRiseAccess });
    if (gfa > BIG_ACCESS_M2) c.push({ label: 'Over 30,000 m²: road ≥ 18 m', value: `road ${W} m`, pass: reg.over30kOK, src: SOURCES.highRiseAccess });
    c.push({ label: '6 m clear fire lane around building', value: `${Math.min(strictEnv.dRoad, strictEnv.dSide).toFixed(1)} m clear on every side`, pass: Math.min(strictEnv.dRoad, strictEnv.dSide) >= 6, src: SOURCES.fireLane });
  } else {
    c.push({ label: 'Stays under high-rise thresholds', value: `${H.toFixed(1)} m (< 23), ${fmt(gfa)} m² (< 10,000)`, pass: H < HIGH_RISE_M && gfa < VERY_LARGE_M2, src: SOURCES.highRiseDef });
  }
  if (type.officeCap) c.push({ label: 'ย.10: office ≤ 10,000 m² (wide-road exceptions not modelled)', value: `${fmt(gfa)} m²`, pass: gfa <= type.officeCap, src: 'BCP 2013 cl. 17' });

  const units = type.unitNet ? Math.floor((gfa * type.efficiency) / type.unitNet) : null;
  return { ...d, gfa, H, coverage, open, isHigh, checks: c, pass: c.every((x) => x.pass), units };
}

// ---------- main entry ----------

export function analyse({ ring, front, W, typeKey, bonus, rules }) {
  const plot = turf.polygon([ring]);
  const A = turf.area(plot);
  const edges = plotEdges(ring);
  const type = BUILDING_TYPES[typeKey];
  const frontage = edges[front].len;
  const reg0 = regime(W, frontage);
  const reg = rules.access ? reg0 : { highRiseOK: true, over30kOK: true };
  const ctx = { plot, A, edges, front, W, type, bonus, rules, reg };

  ctx.envLow = buildEnvelope(ctx, 'low');
  ctx.envHigh = buildEnvelope(ctx, 'high');
  const env = reg.highRiseOK ? ctx.envHigh : ctx.envLow;

  const designs = [];
  if (reg.highRiseOK) {
    const t = designTower(ctx, ctx.envHigh, 'A · Slim tower', true);
    if (t) designs.push(t);
    const p = designPodiumTower(ctx, ctx.envHigh, 'B · Podium + tower');
    if (p) designs.push(p);
  }
  const low = designTower(ctx, ctx.envLow, reg.highRiseOK ? 'C · Low-rise (< 23 m)' : 'A · Low-rise (< 23 m)', false);
  if (low) designs.push(low);
  if (!reg.highRiseOK) {
    const lp = designPodiumTower({ ...ctx }, ctx.envLow, 'B · Low-rise podium + block');
    if (lp && lp.masses.length > 1) designs.push(lp);
  }

  if (designs.length < 2) {
    const base = designs[0];
    const cov = base ? Math.min(...base.masses.filter((m) => m.base === 0).map((m) => m.plate)) : A * 0.5;
    const garden = designTower(ctx, ctx.envLow, (designs.length ? 'B' : 'A') + ' · Garden block (more open ground)', false, { coverMax: cov * 0.6 });
    if (garden) designs.push(garden);
  }
  designs.forEach((d, i) => { d.label = `${'ABCD'[i]} · ${d.label.replace(/^[A-D] · /, '')}`; });
  const checked = designs.map((d) => checkDesign(ctx, d));
  const maxGFA = A * ZONE.far * (1 + bonus);
  const maxH = env.bands.length ? Math.max(...env.bands.map((b) => b.h)) : 0;
  const minH = env.bands.length ? Math.min(...env.bands.map((b) => b.h)) : 0;

  // what binds? compare achievable GFA of best design to FAR
  const bestGFA = Math.max(0, ...checked.map((d) => d.gfa));
  let binding;
  if (!reg.highRiseOK) binding = W < 10 ? 'Road narrower than 10 m: no high-rise, under 10,000 m²' : 'Frontage under 12 m: no high-rise, under 10,000 m²';
  else if (bestGFA >= maxGFA * 0.98) binding = 'Floor area ratio (FAR) — the plot can reach its full 8:1';
  else binding = 'Setbacks + height plane — FAR cannot be fully used';

  return {
    A, edges, frontage, W, reg, reg0, env, envLow: ctx.envLow, envHigh: ctx.envHigh,
    maxGFA, maxH, minH, designs: checked, binding, bestGFA,
  };
}
