import { describe, it, expect } from 'vitest';
import { decodeTerrainRgb, lngLatToTilePixel, MAX_DEM_ZOOM, DEM_TILE_SIZE } from './dem-cache.js';

// Mapbox terrain-RGB encoding:
//   h = -10000 + (R*65536 + G*256 + B) * 0.1
// Helper: produce an RGBA buffer where every pixel encodes the same height.
function rgbaForHeight(h: number, pixelCount: number): Uint8ClampedArray {
  const raw = Math.round((h + 10000) / 0.1);  // (R<<16)|(G<<8)|B
  const r = (raw >> 16) & 0xff;
  const g = (raw >> 8) & 0xff;
  const b = raw & 0xff;
  const buf = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 255;
  }
  return buf;
}

describe('decodeTerrainRgb', () => {
  it('decodes all-zero RGB as the encoding floor (-10000 m)', () => {
    const rgba = new Uint8ClampedArray(4 * 4);  // 4 pixels, all (0,0,0,0)
    const h = decodeTerrainRgb(rgba);
    expect(h.length).toBe(4);
    for (const v of h) expect(v).toBe(-10000);
  });

  it('round-trips a representative elevation (Aoraki ≈ 3724 m) within encoding precision', () => {
    const rgba = rgbaForHeight(3724, 1);
    const h = decodeTerrainRgb(rgba);
    expect(h[0]).toBeCloseTo(3724, 1);  // encoding resolution is 0.1 m
  });

  it('decodes sea level (0 m) exactly', () => {
    const rgba = rgbaForHeight(0, 1);
    expect(decodeTerrainRgb(rgba)[0]).toBeCloseTo(0, 5);
  });

  it('returns one Float32 per pixel (length = rgba.length / 4)', () => {
    const rgba = new Uint8ClampedArray(DEM_TILE_SIZE * DEM_TILE_SIZE * 4);
    expect(decodeTerrainRgb(rgba).length).toBe(DEM_TILE_SIZE * DEM_TILE_SIZE);
  });
});

describe('lngLatToTilePixel', () => {
  it('maps (0,0) at z=0 to tile (0,0), pixel (128,128) — the tile centre', () => {
    const t = lngLatToTilePixel(0, 0, 0);
    expect(t).toEqual({ z: 0, x: 0, y: 0, px: 128, py: 128 });
  });

  it('maps Wellington CBD (174.7762, -41.2865) at z=14 to its known tile', () => {
    // Verified against the asinh-form slippy-map formula:
    //   floor((1 - asinh(tan(lat_rad)) / π) / 2 * 2^z)
    const t = lngLatToTilePixel(174.7762, -41.2865, 14);
    expect(t.z).toBe(14);
    expect(t.x).toBe(16146);
    expect(t.y).toBe(10258);
    expect(t.px).toBeGreaterThanOrEqual(0);
    expect(t.px).toBeLessThan(DEM_TILE_SIZE);
    expect(t.py).toBeGreaterThanOrEqual(0);
    expect(t.py).toBeLessThan(DEM_TILE_SIZE);
  });

  it('clamps zoom above MAX_DEM_ZOOM (LINZ terrain-RGB stops at z14)', () => {
    expect(lngLatToTilePixel(174.7762, -41.2865, 18).z).toBe(MAX_DEM_ZOOM);
    expect(lngLatToTilePixel(174.7762, -41.2865, 99).z).toBe(MAX_DEM_ZOOM);
  });

  it('clamps zoom below 0', () => {
    expect(lngLatToTilePixel(0, 0, -3).z).toBe(0);
  });

  it('keeps px/py inside [0, DEM_TILE_SIZE)', () => {
    // Sample a handful of NZ-ish coordinates and confirm the pixel offsets
    // never escape the tile.
    const samples: Array<[number, number]> = [
      [166.5, -46.5], [172.6, -43.5], [174.78, -41.29], [175.3, -39.5], [178.0, -37.6],
    ];
    for (const [lng, lat] of samples) {
      const t = lngLatToTilePixel(lng, lat, 14);
      expect(t.px).toBeGreaterThanOrEqual(0);
      expect(t.px).toBeLessThan(DEM_TILE_SIZE);
      expect(t.py).toBeGreaterThanOrEqual(0);
      expect(t.py).toBeLessThan(DEM_TILE_SIZE);
    }
  });
});
