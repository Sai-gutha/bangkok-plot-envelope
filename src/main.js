import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';
import './style.css';
import { analyse } from './engine.js';
import { ZONE, BUILDING_TYPES, RULE_TOGGLES, SOURCES, roadSetback } from './rules.js';

// ---------------- state ----------------
const S = {
  mode: 'idle',         // idle | draw | edit
  draft: [],            // [lng,lat] while drawing
  ring: null,           // closed ring [[lng,lat],...,first]
  front: 0,             // frontage edge index
  W: 12,
  roadName: '',
  roadEstimated: true,
  typeKey: 'condo',
  bonus: 0,
  rules: Object.fromEntries(RULE_TOGGLES.map((r) => [r.id, true])),
  result: null,
  designIdx: 0,
  show: { env: true, design: true, ctx: true, d3: true },
  dragging: null,
};

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const EMPTY = { type: 'FeatureCollection', features: [] };

// ---------------- map ----------------
const VICTORY_MONUMENT = [100.5383, 13.7649];
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [100.5372, 13.7662],
  zoom: 17.2,
  pitch: 55,
  bearing: -20,
  maxPitch: 75,
  antialias: true,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

let buildingLayerIds = [];

map.on('load', () => {
  // existing OSM buildings: lighter, and hide ones standing on the plot
  for (const l of map.getStyle().layers) {
    if (l.type === 'fill-extrusion') {
      buildingLayerIds.push(l.id);
      map.setPaintProperty(l.id, 'fill-extrusion-color', '#d9d6cf');
      map.setPaintProperty(l.id, 'fill-extrusion-opacity', 0.85);
      const h = map.getPaintProperty(l.id, 'fill-extrusion-height');
      if (h !== undefined) map.setPaintProperty(l.id, 'fill-extrusion-height', ['case', ['boolean', ['feature-state', 'onplot'], false], 0, h]);
      const b = map.getPaintProperty(l.id, 'fill-extrusion-base');
      if (b !== undefined) map.setPaintProperty(l.id, 'fill-extrusion-base', ['case', ['boolean', ['feature-state', 'onplot'], false], 0, b]);
    }
  }

  for (const id of ['plot', 'edges', 'verts', 'mids', 'draft', 'env', 'fp', 'design', 'labels']) {
    map.addSource(id, { type: 'geojson', data: EMPTY });
  }
  map.addLayer({ id: 'plot-fill', type: 'fill', source: 'plot', paint: { 'fill-color': '#1f6feb', 'fill-opacity': 0.08 } });
  map.addLayer({ id: 'fp-line', type: 'line', source: 'fp', paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-dasharray': [2, 2] } });
  map.addLayer({
    id: 'env-ext', type: 'fill-extrusion', source: 'env',
    paint: {
      'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'h'], 20, '#9cc3ff', 60, '#5f93f0', 150, '#3b5bdb'],
      'fill-extrusion-height': ['get', 'h'],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.28,
    },
  });
  map.addLayer({
    id: 'design-ext', type: 'fill-extrusion', source: 'design',
    paint: {
      'fill-extrusion-color': ['get', 'color'],
      'fill-extrusion-height': ['get', 'top'],
      'fill-extrusion-base': ['get', 'base'],
      'fill-extrusion-opacity': 0.95,
      'fill-extrusion-vertical-gradient': true,
    },
  });
  map.addLayer({ id: 'edges-hit', type: 'line', source: 'edges', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16 } });
  map.addLayer({
    id: 'edges-line', type: 'line', source: 'edges',
    paint: {
      'line-color': ['case', ['get', 'front'], '#f08c00', '#1f6feb'],
      'line-width': ['case', ['get', 'front'], 5, 2.5],
    },
  });
  map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#1f6feb', 'line-width': 2, 'line-dasharray': [1.5, 1] } });
  map.addLayer({ id: 'mids', type: 'circle', source: 'mids', paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#1f6feb', 'circle-stroke-width': 1.5, 'circle-opacity': 0.9 } });
  map.addLayer({ id: 'verts', type: 'circle', source: 'verts', paint: { 'circle-radius': 6, 'circle-color': '#1f6feb', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({
    id: 'labels-sym', type: 'symbol', source: 'labels',
    layout: { 'text-field': ['get', 't'], 'text-size': 12, 'text-font': ['Noto Sans Regular'], 'text-allow-overlap': true, 'symbol-placement': 'point' },
    paint: { 'text-color': '#1b1b1b', 'text-halo-color': '#fff', 'text-halo-width': 1.6 },
  });

  initUI();
  // Victory Monument marker as a landmark for the zone
  new maplibregl.Marker({ color: '#8a5a2b', scale: 0.7 }).setLngLat(VICTORY_MONUMENT).setPopup(new maplibregl.Popup().setText('Victory Monument — ย.10 surrounds it (BCP 2013 cl. 17)')).addTo(map);
});

// ---------------- drawing ----------------
function setMode(m) {
  S.mode = m;
  map.getCanvas().style.cursor = m === 'draw' ? 'crosshair' : '';
  if (m === 'draw') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
  $('btn-draw').textContent = m === 'draw' ? 'Finish (Enter)' : (S.ring ? 'Redraw plot' : 'Draw plot');
  $('draw-hint').innerHTML = m === 'draw'
    ? 'Click corners on the map. Click the first corner or press <b>Enter</b> to close. <b>Backspace</b> removes the last corner, <b>Esc</b> cancels.'
    : S.ring
      ? 'Drag corners to reshape. Drag a small white dot to add a corner. Right-click a corner to delete it. Click an edge to set the road side.'
      : 'Click <b>Draw plot</b>, then click the corners on the map. Click the first corner (or press Enter) to close.';
}

function startDraw() {
  S.draft = []; S.ring = null; S.result = null;
  clearOnPlot();
  setData('draft', EMPTY);
  renderPlot(); renderResult();
  setMode('draw');
}

function finishDraw() {
  if (S.draft.length < 3) { toast('A plot needs at least 3 corners.'); return; }
  const ring = [...S.draft, S.draft[0]];
  S.draft = [];
  setData('draft', EMPTY);
  setRing(ring, true);
  setMode('edit');
}

function setRing(ring, detectRoad) {
  // keep ring counter-clockwise for consistent geometry
  const poly = turf.polygon([ring]);
  if (turf.booleanClockwise(turf.lineString(ring))) ring = [...ring].reverse();
  if (turf.kinks(poly).features.length) toast('The plot outline crosses itself — results may be wrong. Drag a corner to fix it.');
  S.ring = ring;
  if (S.front >= ring.length - 1) S.front = 0;
  if (detectRoad) detectFrontage();
  renderPlot();
  schedule();
}

map.on('click', (e) => {
  if (S.mode === 'draw') {
    const p = [e.lngLat.lng, e.lngLat.lat];
    if (S.draft.length >= 3) {
      const first = map.project(S.draft[0]);
      if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 14) { finishDraw(); return; }
    }
    S.draft.push(p);
    drawDraft(p);
    return;
  }
  if (S.mode === 'edit' && S.ring) {
    const hitV = map.queryRenderedFeatures(e.point, { layers: ['verts', 'mids'] });
    if (hitV.length) return;
    const hit = map.queryRenderedFeatures(e.point, { layers: ['edges-hit'] });
    if (hit.length) {
      S.front = hit[0].properties.i;
      S.roadName = ''; S.roadEstimated = true;
      guessRoadForEdge(S.front);
      renderPlot(); schedule();
    }
  }
});
map.on('dblclick', (e) => { if (S.mode === 'draw') { e.preventDefault(); if (S.draft.length > 3) S.draft.pop(); finishDraw(); } });
map.on('mousemove', (e) => {
  if (S.mode === 'draw' && S.draft.length) drawDraft([e.lngLat.lng, e.lngLat.lat]);
  if (S.mode === 'edit' && !S.dragging && S.ring) {
    const h = map.queryRenderedFeatures(e.point, { layers: ['verts', 'mids', 'edges-hit'] });
    map.getCanvas().style.cursor = h.length ? (h[0].layer.id === 'edges-hit' ? 'pointer' : 'grab') : '';
  }
});
function drawDraft(cursor) {
  const coords = [...S.draft, cursor];
  setData('draft', { type: 'FeatureCollection', features: [turf.lineString(coords.length > 1 ? coords : [cursor, cursor])] });
  setData('verts', { type: 'FeatureCollection', features: S.draft.map((p, i) => turf.point(p, { i })) });
}

// vertex dragging / inserting / deleting
map.on('mousedown', 'verts', (e) => {
  if (S.mode !== 'edit' || e.originalEvent.button !== 0) return;
  e.preventDefault();
  S.dragging = { i: e.features[0].properties.i };
  map.dragPan.disable();
  map.getCanvas().style.cursor = 'grabbing';
});
map.on('mousedown', 'mids', (e) => {
  if (S.mode !== 'edit' || e.originalEvent.button !== 0) return;
  e.preventDefault();
  const i = e.features[0].properties.i; // insert after vertex i
  const ring = S.ring.slice(0, -1);
  ring.splice(i + 1, 0, [e.lngLat.lng, e.lngLat.lat]);
  if (S.front > i) S.front += 1;
  S.ring = [...ring, ring[0]];
  S.dragging = { i: i + 1 };
  map.dragPan.disable();
});
map.on('mousemove', (e) => {
  if (!S.dragging) return;
  const ring = S.ring.slice(0, -1);
  ring[S.dragging.i] = [e.lngLat.lng, e.lngLat.lat];
  S.ring = [...ring, ring[0]];
  renderPlot();
  schedule();
});
map.on('mouseup', () => {
  if (!S.dragging) return;
  S.dragging = null;
  map.dragPan.enable();
  setRing(S.ring, false);
});
map.on('contextmenu', 'verts', (e) => {
  if (S.mode !== 'edit') return;
  const ring = S.ring.slice(0, -1);
  if (ring.length <= 3) { toast('A plot needs at least 3 corners.'); return; }
  const i = e.features[0].properties.i;
  ring.splice(i, 1);
  if (S.front >= ring.length) S.front = 0;
  setRing([...ring, ring[0]], false);
});
// touch: basic support for dragging vertices
map.on('touchstart', 'verts', (e) => {
  if (S.mode !== 'edit') return;
  e.preventDefault();
  S.dragging = { i: e.features[0].properties.i };
  map.dragPan.disable();
});
map.on('touchmove', (e) => { if (S.dragging) { const ring = S.ring.slice(0, -1); ring[S.dragging.i] = [e.lngLat.lng, e.lngLat.lat]; S.ring = [...ring, ring[0]]; renderPlot(); schedule(); } });
map.on('touchend', () => { if (S.dragging) { S.dragging = null; map.dragPan.enable(); setRing(S.ring, false); } });

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (S.mode === 'draw') {
    if (e.key === 'Enter') finishDraw();
    if (e.key === 'Escape') { S.draft = []; setData('draft', EMPTY); setData('verts', EMPTY); setMode(S.ring ? 'edit' : 'idle'); renderPlot(); }
    if (e.key === 'Backspace') { S.draft.pop(); drawDraft(S.draft[S.draft.length - 1] || [0, 0]); }
  }
});

// ---------------- road detection from OSM ----------------
const ROAD_WIDTH_GUESS = { motorway: 40, trunk: 40, primary: 30, secondary: 20, tertiary: 16, minor: 8, service: 6, track: 4, path: 3 };

function nearestRoad(pt) {
  const px = map.project(pt);
  const r = 60;
  const feats = map.queryRenderedFeatures([[px.x - r, px.y - r], [px.x + r, px.y + r]])
    .filter((f) => (f.sourceLayer === 'transportation' || f.sourceLayer === 'transportation_name') && /Line/.test(f.geometry.type));
  let best = null;
  for (const f of feats) {
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const c of lines) {
      if (c.length < 2) continue;
      const d = turf.pointToLineDistance(turf.point(pt), turf.lineString(c), { units: 'meters' });
      if (!best || d < best.d) best = { d, f };
    }
  }
  if (!best) return null;
  const named = feats.find((f) => f.sourceLayer === 'transportation_name' && f.properties.name && f.properties.class === best.f.properties.class);
  const p = best.f.properties;
  const name = p['name:en'] || p.name_en || p.name || (named && (named.properties['name:en'] || named.properties.name_en || named.properties.name)) || '';
  return { d: best.d, cls: p.class, name };
}

function detectFrontage() {
  const edges = S.ring.slice(0, -1).map((a, i) => [a, S.ring[i + 1]]);
  let best = null;
  edges.forEach(([a, b], i) => {
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const r = nearestRoad(mid);
    if (r && (!best || r.d < best.r.d)) best = { i, r };
  });
  if (best && best.r.d < 40) {
    S.front = best.i;
    applyRoadGuess(best.r);
  } else {
    // fall back to the longest edge
    let li = 0, ll = 0;
    edges.forEach(([a, b], i) => { const l = turf.distance(a, b, { units: 'meters' }); if (l > ll) { ll = l; li = i; } });
    S.front = li; S.roadName = 'no road found nearby — set width by hand';
  }
}
function guessRoadForEdge(i) {
  const a = S.ring[i], b = S.ring[i + 1];
  const r = nearestRoad([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  if (r && r.d < 40) applyRoadGuess(r); else { S.roadName = 'no road found next to this edge'; }
}
function applyRoadGuess(r) {
  S.roadName = `${r.name || 'unnamed road'} · OSM class “${r.cls}”`;
  const w = ROAD_WIDTH_GUESS[r.cls];
  if (w) { S.W = w; S.roadEstimated = true; syncRoadInputs(); }
}

// hide existing OSM buildings that stand on the plot (it's being redeveloped)
let onPlot = [];
function clearOnPlot() {
  for (const f of onPlot) { try { map.setFeatureState(f, { onplot: false }); } catch {} }
  onPlot = [];
}
function markOnPlot() {
  clearOnPlot();
  if (!S.ring || !buildingLayerIds.length) return;
  const plot = turf.polygon([S.ring]);
  const bb = turf.bbox(plot);
  const p1 = map.project([bb[0], bb[1]]), p2 = map.project([bb[2], bb[3]]);
  const feats = map.queryRenderedFeatures([[Math.min(p1.x, p2.x), Math.min(p1.y, p2.y)], [Math.max(p1.x, p2.x), Math.max(p1.y, p2.y)]], { layers: buildingLayerIds });
  for (const f of feats) {
    if (f.id === undefined) continue;
    try {
      const c = turf.centroid(f);
      if (turf.booleanPointInPolygon(c, plot)) {
        const ref = { source: f.source, sourceLayer: f.sourceLayer, id: f.id };
        map.setFeatureState(ref, { onplot: true });
        onPlot.push(ref);
      }
    } catch {}
  }
}

// ---------------- recompute (live) ----------------
let pending = false, lastRun = 0, timer = null;
function schedule() {
  if (pending) return;
  pending = true;
  const wait = Math.max(0, 90 - (performance.now() - lastRun));
  clearTimeout(timer);
  timer = setTimeout(() => requestAnimationFrame(run), wait);
}
function run() {
  pending = false;
  lastRun = performance.now();
  if (!S.ring) { S.result = null; renderResult(); return; }
  try {
    S.result = analyse({ ring: S.ring, front: S.front, W: S.W, typeKey: S.typeKey, bonus: S.bonus, rules: S.rules });
  } catch (err) {
    console.error(err);
    S.result = null;
    toast('That shape could not be processed. Try moving a corner.');
  }
  if (S.result && S.designIdx >= S.result.designs.length) S.designIdx = 0;
  renderResult();
  if (!S.dragging) markOnPlot();
}

// ---------------- rendering: map ----------------
function setData(id, data) { const s = map.getSource(id); if (s) s.setData(data); }

function renderPlot() {
  if (!S.ring) {
    for (const id of ['plot', 'edges', 'verts', 'mids', 'labels']) setData(id, EMPTY);
    return;
  }
  const ring = S.ring;
  setData('plot', turf.featureCollection([turf.polygon([ring])]));
  const edges = [], mids = [], labels = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    const len = turf.distance(a, b, { units: 'meters' });
    edges.push(turf.lineString([a, b], { i, front: i === S.front }));
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    mids.push(turf.point(m, { i }));
    labels.push(turf.point(m, { t: `${len.toFixed(1)} m${i === S.front ? ' · road' : ''}` }));
  }
  setData('edges', turf.featureCollection(edges));
  setData('verts', turf.featureCollection(ring.slice(0, -1).map((p, i) => turf.point(p, { i }))));
  setData('mids', turf.featureCollection(S.mode === 'edit' ? mids : []));
  setData('labels', turf.featureCollection(labels));
}

const MASS_COLORS = { Podium: '#c2b59b', Tower: '#f2efe8' };
function renderMapResult() {
  const r = S.result;
  if (!r) { setData('env', EMPTY); setData('design', EMPTY); setData('fp', EMPTY); return; }
  const bands = r.env.bands.map((b) => ({ ...b.region, properties: { h: Math.min(b.h, 400) } }));
  setData('env', turf.featureCollection(S.show.env ? bands : []));
  const fps = [];
  if (r.envHigh.fp && r.reg.highRiseOK) fps.push({ ...r.envHigh.fp, properties: { color: '#3b5bdb' } });
  if (r.envLow.fp) fps.push({ ...r.envLow.fp, properties: { color: '#2b8a3e' } });
  setData('fp', turf.featureCollection(S.show.env ? fps : []));
  const d = r.designs[S.designIdx];
  const masses = d && S.show.design
    ? d.masses.map((m) => ({ ...m.poly, properties: { base: m.base, top: m.height, color: d.pass ? MASS_COLORS[m.name] || '#eee' : '#e03131' } }))
    : [];
  setData('design', turf.featureCollection(masses));
}

// ---------------- rendering: panel ----------------
function renderResult() {
  renderMapResult();
  const r = S.result;
  for (const id of ['sec-road', 'sec-rules', 'sec-env', 'sec-designs']) $(id).classList.toggle('hidden', !S.ring);
  $('plot-stats').classList.toggle('hidden', !S.ring);
  if (!S.ring || !r) return;

  const rai = r.A / 1600;
  const raiI = Math.floor(rai), ngan = Math.floor((r.A - raiI * 1600) / 400), wah = (r.A - raiI * 1600 - ngan * 400) / 4;
  $('plot-stats').innerHTML = `
    <div><span class="big">${fmt(r.A)}</span> m²</div>
    <div class="muted">${raiI} rai ${ngan} ngan ${fmt(wah, 1)} sq wah · ${r.edges.length} sides · frontage ${fmt(r.frontage, 1)} m</div>`;
  $('road-name').textContent = S.roadName ? `— ${S.roadName}` : '';
  $('road-hint').classList.toggle('warn', S.roadEstimated);

  // rules
  const W = S.W;
  const dRoad = roadSetback(W);
  const rows = [
    ['Zone', `${ZONE.code} ${ZONE.name}`, ZONE.source],
    ['Floor area ratio', `${ZONE.far} : 1 → max ${fmt(r.maxGFA)} m²${S.bonus ? ` (incl. +${S.bonus * 100}% bonus)` : ''}`, SOURCES.far],
    ['Open space ratio', `≥ ${ZONE.osr * 100}% of floor area, half of it planted`, SOURCES.osr],
    ['Road setback', W < 10 ? `${fmt(dRoad, 1)} m from plot edge (6 m from centre of a ${W} m road)` : W <= 20 ? `${fmt(dRoad, 1)} m (1/10 of ${W} m road)` : '2 m (road over 20 m)', SOURCES.roadSetback],
    ['Height', `≤ 2 × distance to far side of road → ${fmt(2 * W, 0)} m at the road edge, rising 2 m per metre set back`, SOURCES.heightPlane],
    ['High-rise (≥ 23 m) or ≥ 10,000 m²', r.reg0.highRiseOK ? `Allowed: road ${W} m ≥ 10, frontage ${fmt(r.frontage, 1)} m ≥ 12. Needs 6 m from all boundaries + 6 m fire lane.${r.reg0.over30kOK ? '' : ' Capped at 30,000 m² (road < 18 m).'}` : `<b>Not allowed</b>: ${W < 10 ? `road ${W} m < 10 m` : `frontage ${fmt(r.frontage, 1)} m < 12 m`}. Building must stay under 23 m and 10,000 m².`, SOURCES.highRiseAccess],
    ['Side setbacks', r.reg0.highRiseOK ? '6 m (high-rise) / 3 m (under 23 m, walls with windows)' : '3 m for walls with windows (9–23 m tall)', `${SOURCES.highRiseSetback}; ${SOURCES.openings}`],
    ['Open space (building law)', BUILDING_TYPES[S.typeKey].residential ? '≥ 30% of largest floor (residential)' : '≥ 10% of largest floor', SOURCES.openSpace],
  ];
  $('rules').innerHTML = `<table class="rules">${rows.map(([k, v, s]) => `<tr><th>${k}</th><td>${v}<div class="src">${s}</div></td></tr>`).join('')}</table>`;

  // envelope summary
  const e = r.env;
  const fpA = e.fp ? turf.area(e.fp) : 0;
  $('env').innerHTML = `
    <div class="kpis">
      <div><div class="k">Max floor area</div><div class="v">${fmt(r.maxGFA)} m²</div></div>
      <div><div class="k">Buildable footprint</div><div class="v">${fmt(fpA)} m²</div><div class="k">${fmt((fpA / r.A) * 100)}% of plot</div></div>
      <div><div class="k">Height allowed</div><div class="v">${r.reg.highRiseOK ? `${fmt(r.minH)}–${fmt(Math.min(r.maxH, 999))} m` : `< 23 m`}</div><div class="k">${r.reg.highRiseOK ? 'front → back' : 'not a high-rise site'}</div></div>
      <div><div class="k">Best design reaches</div><div class="v">${fmt(r.bestGFA)} m²</div><div class="k">${fmt((r.bestGFA / r.maxGFA) * 100)}% of FAR</div></div>
    </div>
    <p class="binding"><b>What limits this plot:</b> ${r.binding}</p>
    <p class="hint small">Blue volume = the space the rules allow (stepped every 2 m back from the road). Dashed lines = buildable footprint: <span class="sw blue"></span> high-rise, <span class="sw green"></span> under 23 m.</p>`;

  // designs
  $('design-tabs').innerHTML = r.designs.map((d, i) => `<button class="tab ${i === S.designIdx ? 'on' : ''}" data-i="${i}"><span class="dot ${d.pass ? 'ok' : 'bad'}"></span>${d.label}</button>`).join('');
  $('design-tabs').querySelectorAll('button').forEach((b) => b.onclick = () => { S.designIdx = +b.dataset.i; renderResult(); });
  const d = r.designs[S.designIdx];
  if (!d) { $('design-body').innerHTML = '<p class="hint">No design fits this plot. It may be too small or too narrow after setbacks.</p>'; return; }
  const t = BUILDING_TYPES[S.typeKey];
  $('design-body').innerHTML = `
    <div class="kpis">
      <div><div class="k">Floor area</div><div class="v">${fmt(d.gfa)} m²</div><div class="k">FAR ${fmt(d.gfa / r.A, 2)}</div></div>
      <div><div class="k">Height</div><div class="v">${fmt(d.H, 1)} m</div><div class="k">${d.masses.map((m) => `${m.name} ${m.floors} fl`).join(' + ')}</div></div>
      <div><div class="k">Ground coverage</div><div class="v">${fmt((d.coverage / r.A) * 100)}%</div><div class="k">${fmt(d.coverage)} m²</div></div>
      <div><div class="k">${d.units != null ? 'Units (est.)' : 'Floor plate'}</div><div class="v">${d.units != null ? fmt(d.units) : fmt(d.masses[d.masses.length - 1].plate) + ' m²'}</div>${d.units != null ? `<div class="k">${t.unitNet} m² avg, ${t.efficiency * 100}% efficient</div>` : ''}</div>
    </div>
    <ul class="checks">${d.checks.map((c) => `<li class="${c.pass ? 'ok' : 'bad'}"><span class="ic">${c.pass ? '✓' : '✗'}</span><div><div>${c.label}</div><div class="val">${c.value}</div><div class="src">${c.src}</div></div></li>`).join('')}</ul>
    <p class="verdict ${d.pass ? 'ok' : 'bad'}">${d.pass ? 'Passes every rule checked.' : 'Fails at least one rule.'}</p>`;
}

// ---------------- UI wiring ----------------
function syncRoadInputs() { $('road-w').value = S.W; $('road-w-num').value = S.W; }

function initUI() {
  $('btype').innerHTML = Object.entries(BUILDING_TYPES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('');
  $('btn-draw').onclick = () => (S.mode === 'draw' ? finishDraw() : startDraw());
  $('btn-clear').onclick = () => { S.ring = null; S.draft = []; clearOnPlot(); setData('draft', EMPTY); setMode('idle'); renderPlot(); schedule(); };
  $('btn-example').onclick = loadExample;
  const onW = (v) => { S.W = Math.max(3, Math.min(80, +v || 3)); S.roadEstimated = false; syncRoadInputs(); schedule(); };
  $('road-w').oninput = (e) => onW(e.target.value);
  $('road-w-num').oninput = (e) => onW(e.target.value);
  $('btype').onchange = (e) => { S.typeKey = e.target.value; schedule(); };
  $('bonus').onchange = (e) => { S.bonus = +e.target.value; schedule(); };
  $('toggles').innerHTML = RULE_TOGGLES.map((r) => `<label class="tog"><input type="checkbox" data-id="${r.id}" checked /> ${r.label} <span class="src">${r.src}</span></label>`).join('');
  $('toggles').querySelectorAll('input').forEach((i) => i.onchange = () => { S.rules[i.dataset.id] = i.checked; schedule(); });

  const chip = (id, key, fn) => { $(id).onclick = () => { S.show[key] = !S.show[key]; $(id).classList.toggle('on', S.show[key]); fn ? fn() : renderMapResult(); }; };
  chip('btn-env', 'env'); chip('btn-design', 'design');
  chip('btn-ctx', 'ctx', () => buildingLayerIds.forEach((id) => map.setLayoutProperty(id, 'visibility', S.show.ctx ? 'visible' : 'none')));
  chip('btn-3d', 'd3', () => map.easeTo({ pitch: S.show.d3 ? 55 : 0, duration: 600 }));
  setMode('idle');
  $('legend').innerHTML = `<span><i style="background:#f08c00"></i>Road edge</span><span><i style="background:#5f93f0;opacity:.5"></i>Allowed space</span><span><i style="background:#c2b59b"></i>Podium</span><span><i style="background:#f2efe8;border:1px solid #bbb"></i>Tower</span><span><i style="background:#e03131"></i>Fails a rule</span>`;
}

function loadExample() {
  // An irregular ~2,600 m² plot just north-west of Victory Monument (zone assumed ย.10).
  const o = [100.53585, 13.76585];
  const dx = 1 / (111320 * Math.cos((o[1] * Math.PI) / 180)), dy = 1 / 110574;
  const pts = [[0, 0], [58, 4], [61, 38], [24, 50], [-4, 33]].map(([x, y]) => [o[0] + x * dx, o[1] - y * dy]);
  S.draft = pts;
  finishDraw();
  map.easeTo({ center: turf.centroid(turf.polygon([S.ring])).geometry.coordinates, zoom: 17.4, pitch: 55, duration: 800 });
}

let toastT;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 3500);
}
