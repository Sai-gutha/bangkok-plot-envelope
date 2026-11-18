# Bangkok Plot Envelope (zone ย.10)

Draw a plot on a map of Bangkok and see, in 3D among the real surrounding buildings:

- the rules that apply (floor area ratio, open space, setbacks, height)
- the space a building is allowed to fill
- concept designs that fit, each with a pass/fail checklist citing the clause

**Scope:** one zone, ย.10 (very high-density residential, brown) of the Bangkok Comprehensive Plan B.E. 2556 (2013), plus the national Building Control Act regulations that shape the envelope (MR 33 and MR 55).

## Rules modelled

| Rule | Value | Source |
|---|---|---|
| Floor area ratio | ≤ 8 : 1 (+ up to 20% bonus) | BCP 2013 cl. 17, 52–57 |
| Open space ratio | ≥ 4% of floor area, half planted | BCP 2013 cl. 17 |
| Road setback | <10 m road: 6 m from centreline; 10–20 m: 1/10 of width; >20 m: 2 m | MR 55 cl. 41 |
| Height | ≤ 2 × horizontal distance to far side of road | MR 55 cl. 44 |
| Open space (building law) | ≥ 30% of largest floor (residential), 10% otherwise | MR 55 cl. 33 |
| Walls with openings | ≥ 3 m from boundary (9–23 m tall) | MR 55 cl. 50 |
| High-rise (≥ 23 m) / very large (≥ 10,000 m²) | needs ≥ 12 m frontage on a ≥ 10 m road (≥ 18 m if > 30,000 m²), 6 m from all boundaries, 6 m fire lane | MR 33 cl. 1–4 |

## Run

```
npm install
npm run dev      # local dev server
npm test         # engine sanity tests
npm run build && npm start   # production build + server (uses $PORT)
```

## Stack

MapLibre GL JS + OpenFreeMap vector tiles (OpenStreetMap buildings in 3D, no API key), Turf.js for geometry, Vite. Everything runs in the browser.
