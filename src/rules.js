// Rule data for one zone (ย.10) of the Bangkok Comprehensive Plan 2013,
// plus the national Building Control Act ministerial regulations that shape
// the buildable envelope. Every number carries its legal source.

export const ZONE = {
  code: 'ย.10',
  latin: 'Y.10',
  name: 'Very high-density residential (brown)',
  far: 8,            // max total floor area : plot area
  osr: 0.04,         // min uncovered open space : total floor area
  plantedShare: 0.5, // at least half the open space must be planted / permeable
  source: 'Bangkok Comprehensive Plan B.E. 2556 (2013), clause 17',
};

export const SOURCES = {
  far: 'BCP 2013 cl. 17(1)',
  osr: 'BCP 2013 cl. 17(2)',
  bonus: 'BCP 2013 cl. 52–57 (combined cap 20%)',
  roadSetback: 'MR 55 (2000) cl. 41',
  heightPlane: 'MR 55 (2000) cl. 44',
  openings: 'MR 55 (2000) cl. 50',
  openSpace: 'MR 55 (2000) cl. 33',
  highRiseDef: 'MR 33 (1992) cl. 1',
  highRiseAccess: 'MR 33 (1992) cl. 2',
  fireLane: 'MR 33 (1992) cl. 3',
  highRiseSetback: 'MR 33 (1992) cl. 4',
};

export const HIGH_RISE_M = 23;        // อาคารสูง: 23 m or taller
export const VERY_LARGE_M2 = 10000;   // อาคารขนาดใหญ่พิเศษ: 10,000 m² or more
export const BIG_ACCESS_M2 = 30000;   // over 30,000 m² needs 18 m roads

export const BUILDING_TYPES = {
  condo: {
    label: 'Condominium (อาคารชุด)',
    residential: true,
    floorH: 3.0,
    unitNet: 35,      // avg sellable m² per unit (assumption)
    efficiency: 0.75, // net sellable / gross (assumption)
  },
  apartment: {
    label: 'Rental apartment (อาคารอยู่อาศัยรวม)',
    residential: true,
    floorH: 3.0,
    unitNet: 30,
    efficiency: 0.72,
  },
  office: {
    label: 'Office (สำนักงาน)',
    residential: false,
    floorH: 4.0,
    officeCap: 10000, // ย.10 prohibits offices over this unless exceptions apply
  },
};

/** MR 55 cl. 41 second paragraph (buildings > 2 storeys or > 8 m),
 *  converted to a distance from the plot's road boundary, assuming the
 *  plot edge sits on the road's boundary line. */
export function roadSetback(W) {
  if (W < 10) return Math.max(0, 6 - W / 2); // 6 m from road centreline
  if (W <= 20) return W / 10;                // 1/10 of width from road boundary
  return 2;                                  // 2 m from road boundary
}

/** Which regime the plot qualifies for. MR 33 cl. 2: a high-rise or a
 *  very large building needs ≥12 m of frontage on a public road ≥10 m wide
 *  (≥18 m if the building is over 30,000 m²). */
export function regime(W, frontage) {
  const highRiseOK = W >= 10 && frontage >= 12;
  const over30kOK = highRiseOK && W >= 18;
  return { highRiseOK, over30kOK };
}

export const RULE_TOGGLES = [
  { id: 'far', label: 'Floor area ratio 8:1', src: SOURCES.far },
  { id: 'osr', label: 'Open space ≥ 4% of floor area', src: SOURCES.osr },
  { id: 'open30', label: 'Open space ≥ 30% of largest floor (residential)', src: SOURCES.openSpace },
  { id: 'road', label: 'Road setback (by road width)', src: SOURCES.roadSetback },
  { id: 'plane', label: 'Height ≤ 2 × distance to far side of road', src: SOURCES.heightPlane },
  { id: 'hr6', label: 'High-rise: 6 m from every boundary', src: SOURCES.highRiseSetback },
  { id: 'side3', label: 'Walls with windows ≥ 3 m from boundary', src: SOURCES.openings },
  { id: 'access', label: 'High-rise needs ≥10 m road, ≥12 m frontage', src: SOURCES.highRiseAccess },
];
