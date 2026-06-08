/**
 * Shared DEM tile cache — fetches terrain-RGB tiles from LINZ Basemaps,
 * decodes them to a Float32Array of heights, and caches the result keyed on
 * `(src, z, x, y)`. Used by:
 *   - analysis.ts (slope / aspect Sobel kernel)
 *   - inspect.ts  (spot + profile elevation readouts)
 *
 * Two access patterns:
 *   getDemHeights()  — async; awaits a fetch if the tile isn't cached.
 *   peekDemHeights() — sync;  returns null if the tile isn't already cached.
 *   demHeightAt()    — sync;  returns the elevation at a lng/lat if cached,
 *                     otherwise null AND kicks off a warm-the-cache fetch.
 *
 * The cache is LRU-capped at 100 entries (~25 MB at 256 × 256 floats / tile).
 */
import { ELEV_URL, DSM_URL, type DemDsm } from './config.js';

export const DEM_TILE_SIZE = 256;
const HEIGHTS_CACHE_MAX = 100;

// Each value is the Promise so concurrent callers dedupe; the resolved value
// is the heights Float32Array (or null if the tile 404'd / failed).
const _cache = new Map<string, Promise<Float32Array | null>>();
// Mirror of which keys have already resolved successfully, for the sync peek.
const _resolved = new Map<string, Float32Array>();

function tileUrl(src: DemDsm, z: number, x: number, y: number): string {
  return (src === 'dsm' ? DSM_URL : ELEV_URL)
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

export function getDemHeights(
  src: DemDsm, z: number, x: number, y: number,
  abort?: AbortController,
): Promise<Float32Array | null> {
  const key = `${src}/${z}/${x}/${y}`;
  const hit = _cache.get(key);
  if (hit) return hit;
  const p = decodeHeights(src, z, x, y, abort);
  _cache.set(key, p);
  if (_cache.size > HEIGHTS_CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) {
      _cache.delete(oldest);
      _resolved.delete(oldest);
    }
  }
  p.then(h => { if (h) _resolved.set(key, h); }).catch(() => _cache.delete(key));
  return p;
}

/** Returns the decoded heights array if already in cache, else null. Never fetches. */
export function peekDemHeights(src: DemDsm, z: number, x: number, y: number): Float32Array | null {
  return _resolved.get(`${src}/${z}/${x}/${y}`) ?? null;
}

/**
 * Decode a Mapbox terrain-RGB-encoded RGBA buffer into a Float32 heights array.
 *   h = -10000 + (R*65536 + G*256 + B) * 0.1
 * Pure — pulled out of decodeHeights so it's unit-testable without a Canvas.
 */
export function decodeTerrainRgb(rgba: Uint8ClampedArray | Uint8Array): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    out[p] = (rgba[i]! * 65536 + rgba[i + 1]! * 256 + rgba[i + 2]!) * 0.1 - 10000;
  }
  return out;
}

async function decodeHeights(
  src: DemDsm, z: number, x: number, y: number,
  abort?: AbortController,
): Promise<Float32Array | null> {
  const url = tileUrl(src, z, x, y);
  const init: RequestInit = abort ? { signal: abort.signal } : {};
  const res = await fetch(url, init);
  if (!res.ok) return null;
  const blob = await res.blob();
  const img = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(DEM_TILE_SIZE, DEM_TILE_SIZE);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.drawImage(img, 0, 0);
  const enc = ctx.getImageData(0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE).data;
  return decodeTerrainRgb(enc);
}

// ── LNG/LAT LOOKUP ────────────────────────────────────────────────────────────
// LINZ's LiDAR-derived terrain-RGB stops at z=14; clamp queries above that.
export const MAX_DEM_ZOOM = 14;

export interface TilePixel { z: number; x: number; y: number; px: number; py: number }

export function lngLatToTilePixel(lng: number, lat: number, zoom: number): TilePixel {
  const z = Math.max(0, Math.min(MAX_DEM_ZOOM, Math.round(zoom)));
  const n = Math.pow(2, z);
  const latRad = lat * Math.PI / 180;
  const xFloat = ((lng + 180) / 360) * n;
  const yFloat = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  const x = Math.floor(xFloat);
  const y = Math.floor(yFloat);
  const px = Math.max(0, Math.min(DEM_TILE_SIZE - 1, Math.floor((xFloat - x) * DEM_TILE_SIZE)));
  const py = Math.max(0, Math.min(DEM_TILE_SIZE - 1, Math.floor((yFloat - y) * DEM_TILE_SIZE)));
  return { z, x, y, px, py };
}

/**
 * Synchronously look up the elevation at (lng, lat) for the given dataset.
 * Returns null if the relevant tile isn't yet cached — and kicks off the fetch
 * so a subsequent call (e.g. the next mousemove) will hit cache.
 */
export function demHeightAt(src: DemDsm, lng: number, lat: number, mapZoom: number): number | null {
  const t = lngLatToTilePixel(lng, lat, mapZoom);
  const h = peekDemHeights(src, t.z, t.x, t.y);
  if (h) return h[t.py * DEM_TILE_SIZE + t.px] ?? null;
  // Warm the cache for next time, but don't block.
  void getDemHeights(src, t.z, t.x, t.y);
  return null;
}

/**
 * Async variant — awaits the fetch. Use for one-shot queries (e.g. profile
 * sampling) where blocking is fine.
 */
export async function demHeightAtAsync(src: DemDsm, lng: number, lat: number, mapZoom: number): Promise<number | null> {
  const t = lngLatToTilePixel(lng, lat, mapZoom);
  const h = await getDemHeights(src, t.z, t.x, t.y);
  if (!h) return null;
  return h[t.py * DEM_TILE_SIZE + t.px] ?? null;
}
