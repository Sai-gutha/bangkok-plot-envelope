// Sanity tests for the rules engine: run with `npm test`.
import assert from 'node:assert/strict';
import { analyse } from '../src/engine.js';

const o = [100.54, 13.764];
const dx = 1 / (111320 * Math.cos((o[1] * Math.PI) / 180)), dy = 1 / 110574;
const ring = [[0, 0], [50, 0], [55, 35], [20, 45], [-3, 30]].map(([x, y]) => [o[0] + x * dx, o[1] + y * dy]);
ring.push(ring[0]);
const rules = { far: 1, osr: 1, open30: 1, road: 1, plane: 1, hr6: 1, side3: 1, access: 1 };

for (const W of [8, 12, 30]) {
  const r = analyse({ ring, front: 0, W, typeKey: 'condo', bonus: 0, rules });
  assert.ok(r.designs.length >= 2, `W=${W}: at least two designs`);
  for (const d of r.designs) {
    assert.ok(d.pass, `W=${W} ${d.label} should pass: ${d.checks.filter((c) => !c.pass).map((c) => c.label).join(', ')}`);
    assert.ok(d.gfa <= r.maxGFA + 1, 'within FAR');
  }
  if (W < 10) {
    assert.equal(r.reg.highRiseOK, false, 'no high-rise on a road under 10 m');
    for (const d of r.designs) assert.ok(d.H < 23 && d.gfa < 10000);
  }
  console.log(`W=${W} m ok: best ${Math.round(r.bestGFA)} m² of ${Math.round(r.maxGFA)} m²`);
}
