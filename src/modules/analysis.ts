/**
 * Slope + Aspect analysis — registers a virtual tile protocol
 * `analysis-png://{mode}/{src}/{z}/{x}/{y}` that fetches a single terrain-RGB
 * DEM tile (plus its four cardinal neighbours for seam-free gradients),
 * decodes per-pixel elevation, runs a Sobel gradient, then encodes the result
 * as a coloured PNG.
 *
 * Slope:  green (flat) → yellow (~15°) → red (≥35°), 8-direction Sobel scaled
 *         by the tile's pixel-size in metres (latitude-aware).
 * Aspect: cyclic hue wheel mapped from compass-degrees, with low-slope cells
 *         dimmed toward transparent (aspect is undefined on flat ground).
 *
 * Two caches live here:
 *   _cache         : final coloured PNG per (mode, src, z, x, y) tile key.
 *   _heightsCache  : decoded Float32 heights per (src, z, x, y), shared across
 *                    adjacent analysis tiles so neighbours decode at most once.
 *
 * Output is rendered through MapLibre as a normal raster layer (no terrain-RGB
 * round-trip, no colour ramp expression), so we get the colours baked into the
 * tile and can keep the layer's paint config trivial.
 */
import maplibregl, { type AddProtocolAction } from 'maplibre-gl';
import { ANALYSIS_PROTOCOL, type DemDsm } from './config.js';
import { getDemHeights, DEM_TILE_SIZE as TILE_SIZE } from './dem-cache.js';

const PAD = TILE_SIZE + 2; // 258 — center tile plus 1-pixel apron on each side
const EARTH_CIRC_M = 40075016.686;

let _registered = false;

export function registerAnalysisProtocol(): void {
  if (_registered) return;
  _registered = true;
  maplibregl.addProtocol(ANALYSIS_PROTOCOL, analysisHandler);
}

// Final-output cache. Promise-valued so concurrent requests dedupe.
const _cache = new Map<string, Promise<ArrayBuffer>>();

const analysisHandler: AddProtocolAction = async (req, abort) => {
  const m = req.url.match(/^analysis-png:\/\/(slope|aspect)\/(dem|dsm)\/(\d+)\/(\d+)\/(\d+)$/);
  if (!m) throw new Error(`Bad analysis URL: ${req.url}`);
  const mode = m[1] as 'slope' | 'aspect';
  const src  = m[2] as DemDsm;
  const z = Number(m[3]), x = Number(m[4]), y = Number(m[5]);
  const key = `${mode}/${src}/${z}/${x}/${y}`;
  const hit = _cache.get(key);
  if (hit) return { data: await hit };
  const promise = computeTile(mode, src, z, x, y, abort);
  _cache.set(key, promise);
  try {
    return { data: await promise };
  } catch (err) {
    _cache.delete(key);
    throw err;
  }
};

async function computeTile(
  mode: 'slope' | 'aspect',
  src: DemDsm,
  z: number, x: number, y: number,
  abort: AbortController,
): Promise<ArrayBuffer> {
  const center = await getDemHeights(src, z, x, y, abort);
  if (!center) return transparentTile();

  // Fetch four cardinal neighbours in parallel. Any of them may legitimately
  // not exist (NZ edge, world edge) — we fall back to clamping at those edges.
  const [n, s, w, e] = await Promise.all([
    getDemHeights(src, z, x,     y - 1, abort).catch(() => null),
    getDemHeights(src, z, x,     y + 1, abort).catch(() => null),
    getDemHeights(src, z, x - 1, y,     abort).catch(() => null),
    getDemHeights(src, z, x + 1, y,     abort).catch(() => null),
  ]);
  const padded = buildPadded(center, n, s, w, e);

  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

  const latRad = tileCenterLatRad(y, z);
  const cellM = (EARTH_CIRC_M * Math.cos(latRad)) / (TILE_SIZE * Math.pow(2, z));

  const out = ctx.createImageData(TILE_SIZE, TILE_SIZE);
  if (mode === 'slope') paintSlope(padded, out.data, cellM);
  else                  paintAspect(padded, out.data, cellM);
  ctx.putImageData(out, 0, 0);

  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  return outBlob.arrayBuffer();
}

// Build a 258×258 padded heights array: centre tile plus a 1-pixel apron from
// the cardinal neighbours (clamped to centre when a neighbour is unavailable).
// Corners of the apron clamp to the adjacent apron cell — a 4-pixel artifact
// per tile which is invisible in practice.
function buildPadded(
  c: Float32Array,
  n: Float32Array | null,
  s: Float32Array | null,
  w: Float32Array | null,
  e: Float32Array | null,
): Float32Array {
  const padded = new Float32Array(PAD * PAD);
  // Center
  for (let yy = 0; yy < TILE_SIZE; yy++) {
    for (let xx = 0; xx < TILE_SIZE; xx++) {
      padded[(yy + 1) * PAD + (xx + 1)] = c[yy * TILE_SIZE + xx]!;
    }
  }
  // North apron row 0, cols 1..256
  for (let xx = 0; xx < TILE_SIZE; xx++) {
    padded[0 * PAD + (xx + 1)] = n ? n[(TILE_SIZE - 1) * TILE_SIZE + xx]! : c[xx]!;
  }
  // South apron row 257, cols 1..256
  for (let xx = 0; xx < TILE_SIZE; xx++) {
    padded[(PAD - 1) * PAD + (xx + 1)] = s ? s[xx]! : c[(TILE_SIZE - 1) * TILE_SIZE + xx]!;
  }
  // West apron col 0, rows 1..256
  for (let yy = 0; yy < TILE_SIZE; yy++) {
    padded[(yy + 1) * PAD + 0] = w ? w[yy * TILE_SIZE + (TILE_SIZE - 1)]! : c[yy * TILE_SIZE]!;
  }
  // East apron col 257, rows 1..256
  for (let yy = 0; yy < TILE_SIZE; yy++) {
    padded[(yy + 1) * PAD + (PAD - 1)] = e ? e[yy * TILE_SIZE]! : c[yy * TILE_SIZE + (TILE_SIZE - 1)]!;
  }
  // Corners: clamp to nearest apron cell already filled above.
  padded[0]                            = padded[1]!;                                    // NW
  padded[PAD - 1]                      = padded[PAD - 2]!;                              // NE
  padded[(PAD - 1) * PAD]              = padded[(PAD - 1) * PAD + 1]!;                  // SW
  padded[(PAD - 1) * PAD + (PAD - 1)]  = padded[(PAD - 1) * PAD + (PAD - 2)]!;          // SE
  return padded;
}

// Sobel on the padded array at centre-tile coords (x,y in 0..255).
function sobel(p: Float32Array, x: number, y: number, cellM: number): { gx: number; gy: number } {
  // Padded indices are offset by 1 in each axis.
  const at = (xi: number, yi: number): number => p[(yi + 1) * PAD + (xi + 1)]!;
  const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1);
  const d = at(x - 1, y),                       f = at(x + 1, y);
  const g = at(x - 1, y + 1), hh = at(x, y + 1), i = at(x + 1, y + 1);
  const gx = ((c + 2*f + i) - (a + 2*d + g)) / (8 * cellM);
  const gy = ((g + 2*hh + i) - (a + 2*b + c)) / (8 * cellM);
  return { gx, gy };
}

function paintSlope(padded: Float32Array, out: Uint8ClampedArray, cellM: number): void {
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const { gx, gy } = sobel(padded, x, y, cellM);
      const slopeDeg = Math.atan(Math.sqrt(gx*gx + gy*gy)) * (180 / Math.PI);
      const col = slopeColor(slopeDeg);
      const idx = (y * TILE_SIZE + x) * 4;
      out[idx]     = col.r;
      out[idx + 1] = col.g;
      out[idx + 2] = col.b;
      out[idx + 3] = col.a;
    }
  }
}

function paintAspect(padded: Float32Array, out: Uint8ClampedArray, cellM: number): void {
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const { gx, gy } = sobel(padded, x, y, cellM);
      const slopeMag = Math.sqrt(gx*gx + gy*gy);
      // Downhill direction is opposite the gradient. atan2(y,x): math angle.
      // Convert to compass degrees: 0 = N, increasing clockwise.
      const compass = ((Math.atan2(-gy, -gx) * 180 / Math.PI) + 450) % 360;
      const col = aspectColor(compass, slopeMag);
      const idx = (y * TILE_SIZE + x) * 4;
      out[idx]     = col.r;
      out[idx + 1] = col.g;
      out[idx + 2] = col.b;
      out[idx + 3] = col.a;
    }
  }
}

interface RGBA { r: number; g: number; b: number; a: number }

// Imhof / Yoeli slope-class ramp. Break points in degrees correspond to:
// gentle (0–2), undulating (2–5), rolling (5–10), hilly (10–15),
// mountainous (15–25), precipitous (25–40), cliff (40–60+). Reserves the
// darkest red for genuine cliff terrain.
const SLOPE_STOPS: Array<[number, RGBA]> = [
  [ 0, { r: 180, g: 230, b: 180, a: 160 }],
  [ 2, { r: 120, g: 210, b: 100, a: 180 }],
  [ 5, { r:  80, g: 200, b:  60, a: 200 }],
  [10, { r: 190, g: 220, b:  50, a: 215 }],
  [15, { r: 240, g: 200, b:  50, a: 225 }],
  [25, { r: 240, g: 130, b:  40, a: 240 }],
  [40, { r: 220, g:  60, b:  30, a: 250 }],
  [60, { r: 140, g:  10, b:  10, a: 255 }],
];

function slopeColor(d: number): RGBA {
  if (d <= SLOPE_STOPS[0]![0]) return SLOPE_STOPS[0]![1];
  for (let i = 1; i < SLOPE_STOPS.length; i++) {
    const [s1, c1] = SLOPE_STOPS[i]!;
    if (d < s1) {
      const [s0, c0] = SLOPE_STOPS[i - 1]!;
      return lerpRGBA(c0, c1, (d - s0) / (s1 - s0));
    }
  }
  return SLOPE_STOPS[SLOPE_STOPS.length - 1]![1];
}

function lerpRGBA(a: RGBA, b: RGBA, t: number): RGBA {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
    a: Math.round(a.a + (b.a - a.a) * t),
  };
}

function hsvRgb(hDeg: number, s: number, v: number): { r: number; g: number; b: number } {
  const h = ((hDeg % 360) + 360) % 360 / 60;
  const c = v * s;
  const xv = c * (1 - Math.abs((h % 2) - 1));
  let r = 0, g = 0, b = 0;
  if      (h < 1) { r = c;  g = xv; }
  else if (h < 2) { r = xv; g = c;  }
  else if (h < 3) {          g = c;  b = xv; }
  else if (h < 4) {          g = xv; b = c;  }
  else if (h < 5) { r = xv;          b = c;  }
  else            { r = c;            b = xv; }
  const m = v - c;
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

function aspectColor(compassDeg: number, slopeMag: number): RGBA {
  // slopeMag is tan(slope). 0.05 ≈ 3°, 0.18 ≈ 10°. Below 3° fade to transparent.
  const a = Math.round(255 * Math.min(1, Math.max(0, (slopeMag - 0.05) / 0.13)));
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const { r, g, b } = hsvRgb(compassDeg, 0.85, 0.95);
  return { r, g, b, a };
}

function tileCenterLatRad(y: number, z: number): number {
  const n = (y + 0.5) / Math.pow(2, z);
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * n)));
}

let _transparentPromise: Promise<ArrayBuffer> | null = null;
function transparentTile(): Promise<ArrayBuffer> {
  return _transparentPromise ??= (async (): Promise<ArrayBuffer> => {
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return blob.arrayBuffer();
  })();
}
