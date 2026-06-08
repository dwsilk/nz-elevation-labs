import { describe, it, expect } from 'vitest';
import type { Feature, Geometry, Polygon, MultiPolygon } from 'geojson';
import {
  ringAreaKm2, featureAreaKm2, featureYears,
  type NormalisedCaptureProperties,
} from './coverage.js';

// ── HELPERS ──────────────────────────────────────────────────────────────────

function ring(corners: Array<[number, number]>): number[][] {
  // Coverage area helpers iterate i..n-1 with wrap-around, so the trailing
  // closure point is optional — pass corners verbatim.
  return corners.map(([lng, lat]) => [lng, lat]);
}

function emptyProps(): NormalisedCaptureProperties {
  return {
    startDate: '', endDate: '', year_label: '', age_t: 0,
  };
}

function polygonFeature(
  coords: number[][][],
  props: Partial<NormalisedCaptureProperties> = {},
): Feature<Polygon, NormalisedCaptureProperties> {
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: coords }, properties: { ...emptyProps(), ...props } };
}

function multiPolygonFeature(
  coords: number[][][][],
): Feature<MultiPolygon, NormalisedCaptureProperties> {
  return { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: coords }, properties: emptyProps() };
}

// ── ringAreaKm2 ──────────────────────────────────────────────────────────────

describe('ringAreaKm2', () => {
  it('approximates a 1° × 1° polygon at the equator to ~12,300 km²', () => {
    // Reference: R² * (Δlat·π/180) * (Δlng·π/180) * cos(meanLat) for a small
    // patch on a sphere. At the equator with R=6371 km this is ~12,365 km²;
    // the spherical-excess formula in ringAreaKm2 should land close to that.
    const area = ringAreaKm2(ring([[0, 0], [1, 0], [1, 1], [0, 1]]));
    expect(area).toBeGreaterThan(12_000);
    expect(area).toBeLessThan(12_500);
  });

  it('scales down by cos(latitude) at high latitudes', () => {
    // Wellington latitude ~-41° → cos(41°) ≈ 0.7547. A 1°×1° patch there should
    // be roughly 12,365 × 0.7547 ≈ 9,330 km².
    const area = ringAreaKm2(ring([[174, -42], [175, -42], [175, -41], [174, -41]]));
    expect(area).toBeGreaterThan(9_100);
    expect(area).toBeLessThan(9_500);
  });

  it('is invariant to winding direction (sign collapsed via Math.abs)', () => {
    const cw  = ringAreaKm2(ring([[174, -42], [175, -42], [175, -41], [174, -41]]));
    const ccw = ringAreaKm2(ring([[174, -41], [175, -41], [175, -42], [174, -42]]));
    expect(ccw).toBeCloseTo(cw, 6);
  });

  it('returns 0 for a degenerate (collinear) ring', () => {
    expect(ringAreaKm2(ring([[174, -41], [175, -41], [176, -41]]))).toBeCloseTo(0, 6);
  });
});

// ── featureAreaKm2 ────────────────────────────────────────────────────────────

describe('featureAreaKm2', () => {
  it('subtracts hole rings from the outer ring (Polygon with hole)', () => {
    const outer = ring([[174, -42], [175, -42], [175, -41], [174, -41]]);
    const hole  = ring([[174.25, -41.75], [174.75, -41.75], [174.75, -41.25], [174.25, -41.25]]);
    const outerArea = ringAreaKm2(outer);
    const holeArea  = ringAreaKm2(hole);
    const expected  = outerArea - holeArea;
    expect(featureAreaKm2(polygonFeature([outer, hole]))).toBeCloseTo(expected, 6);
    // Sanity: hole should be ~25% of outer (0.5° × 0.5° inside 1° × 1°).
    expect(holeArea / outerArea).toBeCloseTo(0.25, 1);
  });

  it('clamps to 0 if a polygon\'s holes somehow exceed its outer (degenerate input)', () => {
    // Outer is the small ring, "hole" is the big one — caller error, but the
    // function should not return a negative area.
    const big   = ring([[174, -42], [175, -42], [175, -41], [174, -41]]);
    const small = ring([[174.4, -41.6], [174.6, -41.6], [174.6, -41.4], [174.4, -41.4]]);
    expect(featureAreaKm2(polygonFeature([small, big]))).toBe(0);
  });

  it('sums components of a MultiPolygon', () => {
    const a = ring([[174, -42], [175, -42], [175, -41], [174, -41]]);
    const b = ring([[170, -45], [171, -45], [171, -44], [170, -44]]);
    const feat = multiPolygonFeature([[a], [b]]);
    const expected = ringAreaKm2(a) + ringAreaKm2(b);
    expect(featureAreaKm2(feat)).toBeCloseTo(expected, 6);
  });

  it('returns 0 for non-polygon geometries', () => {
    const lineFeat = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
      properties: emptyProps(),
    } as Feature<Geometry, NormalisedCaptureProperties>;
    expect(featureAreaKm2(lineFeat)).toBe(0);
  });
});

// ── featureYears ──────────────────────────────────────────────────────────────

describe('featureYears', () => {
  function feat(from: string | undefined, to: string | undefined): Feature<Polygon, NormalisedCaptureProperties> {
    return polygonFeature([[[0, 0], [1, 0], [1, 1], [0, 1]]], {
      ...(from !== undefined ? { flown_from: from } : {}),
      ...(to   !== undefined ? { flown_to:   to   } : {}),
    });
  }

  it('returns [yr] when from and to are in the same year', () => {
    expect(featureYears(feat('2023-02-14', '2023-03-09'))).toEqual(['2023']);
  });

  it('inclusively spans every year in the range', () => {
    // Cyclone Gabrielle was Feb 2023; a survey across 2021–2024 should list all four.
    expect(featureYears(feat('2021-11-01', '2024-04-15'))).toEqual(['2021', '2022', '2023', '2024']);
  });

  it('falls back to flown_from when flown_to is missing', () => {
    expect(featureYears(feat('2019-07-22', undefined))).toEqual(['2019']);
  });

  it('returns an empty array when flown_from is missing or unparseable', () => {
    // No flown_from → parseInt('', 10) is NaN → falsy → empty.
    expect(featureYears(feat(undefined, '2020-01-01'))).toEqual([]);
    // Garbage flown_from → parseInt('xxxx', 10) is NaN → empty.
    expect(featureYears(feat('xxxx-01-01', '2020-01-01'))).toEqual([]);
  });

  it('handles flown_from == flown_to to a single year', () => {
    expect(featureYears(feat('2015-01-01', '2015-01-01'))).toEqual(['2015']);
  });
});
