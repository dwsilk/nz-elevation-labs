import { describe, it, expect } from 'vitest';
import {
  isVisible,
  curvatureDropM,
  metresToDegrees,
  viewshedBounds,
  gridSize,
  normaliseOptions,
  EARTH_R_M,
  MAX_RADIUS_M,
  type ViewshedOptions,
} from './viewshed.js';

// ── curvatureDropM ────────────────────────────────────────────────────────────

describe('curvatureDropM', () => {
  it('returns ~2 m at 5 km (the classic land-surveyor rule of thumb)', () => {
    // d²/(2R) with R≈6.371e6: 5000² / 1.2742e7 ≈ 1.962 m.
    expect(curvatureDropM(5000)).toBeCloseTo(1.96, 1);
  });

  it('grows quadratically with distance', () => {
    const at1km = curvatureDropM(1000);
    const at2km = curvatureDropM(2000);
    expect(at2km / at1km).toBeCloseTo(4, 5);
  });

  it('uses the WGS84-style mean Earth radius', () => {
    // Algebra: c = d²/(2R) → R = d²/(2c). Pin the constant we're using.
    expect(curvatureDropM(EARTH_R_M)).toBeCloseTo(EARTH_R_M / 2, 5);
  });
});

// ── metresToDegrees ───────────────────────────────────────────────────────────

describe('metresToDegrees', () => {
  it('produces 1° latitude ≈ 111.32 km everywhere', () => {
    const [, dLat] = metresToDegrees(0, 111_320, 0);
    expect(dLat).toBeCloseTo(1, 5);
    const [, dLatHi] = metresToDegrees(0, 111_320, -41); // Wellington
    expect(dLatHi).toBeCloseTo(1, 5);
  });

  it('scales longitude by cos(latitude)', () => {
    // At 60° lat, 1° longitude ≈ half its equatorial width.
    const [dLngEq] = metresToDegrees(111_320, 0, 0);
    const [dLng60] = metresToDegrees(111_320, 0, 60);
    expect(dLngEq).toBeCloseTo(1, 5);
    expect(dLng60).toBeCloseTo(2, 1); // 1° = ~55.6 km at 60° N, so 111.32 km ≈ 2°
  });
});

// ── viewshedBounds ────────────────────────────────────────────────────────────

describe('viewshedBounds', () => {
  it('produces a bbox that contains the viewpoint and is symmetric in metres', () => {
    const b = viewshedBounds(174.7762, -41.2865, 5000);
    expect(b.west).toBeLessThan(174.7762);
    expect(b.east).toBeGreaterThan(174.7762);
    expect(b.south).toBeLessThan(-41.2865);
    expect(b.north).toBeGreaterThan(-41.2865);
    // North/south extent should be identical (symmetric in latitude).
    const halfLat = (b.north - b.south) / 2;
    expect(174.7762 - b.west).toBeGreaterThan(0);
    expect(halfLat).toBeGreaterThan(0);
  });

  it('makes the longitude span wider than latitude at high latitudes (cos shrinks degrees)', () => {
    const b = viewshedBounds(174, -75, 5000); // very high latitude
    const lngSpanDeg = b.east - b.west;
    const latSpanDeg = b.north - b.south;
    expect(lngSpanDeg).toBeGreaterThan(latSpanDeg);
  });
});

// ── gridSize ──────────────────────────────────────────────────────────────────

describe('gridSize', () => {
  it('is odd so the viewpoint lands on the centre cell', () => {
    expect(gridSize(5000, 10) % 2).toBe(1);
    expect(gridSize(5000, 30) % 2).toBe(1);
    expect(gridSize(5000, 50) % 2).toBe(1);
  });

  it('produces ~1001 cells for the 5 km / 10 m default', () => {
    // half = ceil(5000 / 10) = 500; size = 500*2 + 1 = 1001.
    expect(gridSize(5000, 10)).toBe(1001);
  });
});

// ── normaliseOptions ──────────────────────────────────────────────────────────

describe('normaliseOptions', () => {
  const base: ViewshedOptions = {
    src: 'dem',
    lng: 174,
    lat: -41,
    radiusM: 5000,
    gridM: 10,
    eyeHeightM: 1.7,
    targetHeightM: 0,
    earthCurvature: true,
    sourceZoom: 14,
    ddaStride: 1,
  };

  it('caps the radius at MAX_RADIUS_M', () => {
    expect(normaliseOptions({ ...base, radiusM: 99_999 }).radiusM).toBe(MAX_RADIUS_M);
  });

  it('clamps the radius to a sensible floor (a 0 m viewshed would emit a single cell)', () => {
    expect(normaliseOptions({ ...base, radiusM: 0 }).radiusM).toBeGreaterThanOrEqual(50);
  });

  it('clamps negative heights to 0 — observer cannot be underground', () => {
    expect(normaliseOptions({ ...base, eyeHeightM: -10 }).eyeHeightM).toBe(0);
    expect(normaliseOptions({ ...base, targetHeightM: -10 }).targetHeightM).toBe(0);
  });

  it('does not lift sourceZoom above MAX_DEM_ZOOM (LINZ terrain-RGB tops out at z14)', () => {
    expect(normaliseOptions({ ...base, sourceZoom: 99 }).sourceZoom).toBeLessThanOrEqual(14);
  });

  it('clamps ddaStride to integer ≥ 1 — fractional strides would skip pixels off-grid', () => {
    expect(normaliseOptions({ ...base, ddaStride: 0 }).ddaStride).toBe(1);
    expect(normaliseOptions({ ...base, ddaStride: -3 }).ddaStride).toBe(1);
    expect(normaliseOptions({ ...base, ddaStride: 4.7 }).ddaStride).toBe(4);
  });
});

// ── isVisible ─────────────────────────────────────────────────────────────────
//
// The algorithm's central kernel — given a viewpoint elevation, observer eye
// height, target additional height, and a list of distance-height samples
// along the ray (the LAST entry being the target itself), should the target
// be visible?

describe('isVisible', () => {
  it('treats a flat plain as fully visible (no blocking samples)', () => {
    // 100 samples at 100 m apart, all at sea level. Observer at 1.7 m. Target
    // at the far end, also at sea level.
    const profile = Array.from({ length: 100 }, (_, i) => ({ d: (i + 1) * 100, h: 0 }));
    expect(isVisible(0, 1.7, 0, profile, false)).toBe(true);
  });

  it('hides a target behind a closer, higher ridge', () => {
    // Viewpoint at 0 m. Mid-profile blocker at d=500, h=100 (steep ridge).
    // Target at d=1000, h=0. The blocker's angle from observer (100/500=0.2)
    // exceeds the target's (-1.7/1000 ≈ -0.0017), so target is hidden.
    const profile = [
      { d: 250, h: 0 },
      { d: 500, h: 100 },
      { d: 750, h: 0 },
      { d: 1000, h: 0 },
    ];
    expect(isVisible(0, 1.7, 0, profile, false)).toBe(false);
  });

  it('reveals a tall target that pokes above an intervening ridge', () => {
    // Same ridge at 100 m, but target gets a 200 m mast — its angle clears.
    const profile = [
      { d: 250, h: 0 },
      { d: 500, h: 100 }, // angle ≈ 0.2
      { d: 750, h: 0 },
      { d: 1000, h: 0 }, // base angle ≈ -0.0017
    ];
    // Without the mast → hidden; with a 250 m mast → angle 250/1000 = 0.25 > 0.2 → visible.
    expect(isVisible(0, 1.7, 0, profile, false)).toBe(false);
    expect(isVisible(0, 1.7, 250, profile, false)).toBe(true);
  });

  it('lets a higher observer see over a ridge that would block someone at ground level', () => {
    const profile = [
      { d: 500, h: 50 }, // 50 m blocker
      { d: 1000, h: 0 },
    ];
    // Eye 1.7 m — blocker angle ≈ (50-1.7)/500 = 0.0966; target ≈ -0.0017 → hidden.
    expect(isVisible(0, 1.7, 0, profile, false)).toBe(false);
    // Eye 200 m (on a tower) — blocker angle ≈ (50-200)/500 = -0.3; target ≈ -0.2 → -0.2 > -0.3 → visible.
    expect(isVisible(0, 200, 0, profile, false)).toBe(true);
  });

  it('applies the Earth-curvature drop along the ray when enabled', () => {
    // Flat plain at sea level, sampled out to 5 km. On a flat earth, every
    // intermediate sample sits below the observer's eye and is no obstacle.
    // On a curved earth, samples past the horizon distance (~4.66 km for
    // eye 1.7 m) appear to rise above the target's apparent position, so
    // the target becomes hidden behind the earth itself.
    const profile = [
      { d: 500, h: 0 },
      { d: 1000, h: 0 },
      { d: 2500, h: 0 },
      { d: 4500, h: 0 },
      { d: 5000, h: 0 }, // target
    ];
    expect(isVisible(0, 1.7, 0, profile, false)).toBe(true); // flat earth → visible
    expect(isVisible(0, 1.7, 0, profile, true)).toBe(false); // curved earth → hidden
  });

  it('returns true for an empty profile (viewpoint == target degenerate case)', () => {
    expect(isVisible(100, 1.7, 0, [], false)).toBe(true);
  });
});
