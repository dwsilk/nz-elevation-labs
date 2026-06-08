/**
 * Difference map — DSM − DEM, showing surface objects (canopy, buildings).
 *
 * Implemented as a virtual tile protocol (`diff-dem://{z}/{x}/{y}`) registered
 * with MapLibre's addProtocol. For each tile we fetch the matching terrain-RGB
 * DEM and DSM tiles, decode them per-pixel, compute (DSM − DEM) clamped to ≥ 0,
 * and re-encode the result as a terrain-RGB PNG so MapLibre's native
 * `color-relief` layer can render it through a colour ramp. No custom WebGL.
 */
import maplibregl, { type AddProtocolAction } from 'maplibre-gl';
import { DIFF_PROTOCOL, ELEV_URL, DSM_URL } from './config.js';

const TILE_SIZE = 256;

let _registered = false;
let _fallbackTile: Promise<ArrayBuffer> | null = null;

export function registerDiffProtocol(): void {
  if (_registered) return;
  _registered = true;
  maplibregl.addProtocol(DIFF_PROTOCOL, diffHandler);
}

const diffHandler: AddProtocolAction = async (req, abort) => {
  const m = req.url.match(/^diff-dem:\/\/(\d+)\/(\d+)\/(\d+)$/);
  if (!m) throw new Error(`Bad diff-dem URL: ${req.url}`);
  const z = m[1]!,
    x = m[2]!,
    y = m[3]!;
  const sub = (t: string): string => t.replace('{z}', z).replace('{x}', x).replace('{y}', y);

  const [demRes, dsmRes] = await Promise.all([
    fetch(sub(ELEV_URL), { signal: abort.signal }).catch(() => null),
    fetch(sub(DSM_URL), { signal: abort.signal }).catch(() => null),
  ]);

  // If either source is missing for this tile, render no-data (transparent).
  if (!demRes?.ok || !dsmRes?.ok) return { data: await getFallbackTile() };

  const [demBlob, dsmBlob] = await Promise.all([demRes.blob(), dsmRes.blob()]);
  const [demImg, dsmImg] = await Promise.all([
    createImageBitmap(demBlob),
    createImageBitmap(dsmBlob),
  ]);

  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

  ctx.drawImage(demImg, 0, 0);
  const dem = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
  ctx.drawImage(dsmImg, 0, 0);
  const dsm = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;

  const out = ctx.createImageData(TILE_SIZE, TILE_SIZE);
  const o = out.data;
  for (let i = 0; i < dem.length; i += 4) {
    // Mapbox terrain-RGB decode: h = -10000 + (R*65536 + G*256 + B) * 0.1
    const demH = (dem[i]! * 65536 + dem[i + 1]! * 256 + dem[i + 2]!) * 0.1 - 10000;
    const dsmH = (dsm[i]! * 65536 + dsm[i + 1]! * 256 + dsm[i + 2]!) * 0.1 - 10000;
    const diff = Math.max(0, dsmH - demH);
    // Re-encode the diff as a terrain-RGB "elevation" so MapLibre can read it.
    const v = Math.round((diff + 10000) * 10);
    o[i] = (v >> 16) & 0xff;
    o[i + 1] = (v >> 8) & 0xff;
    o[i + 2] = v & 0xff;
    o[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { data: await blob.arrayBuffer() };
};

// A solid black tile encodes terrain-RGB elevation = -10000 m, which our
// colour ramp pins to fully transparent — so missing-data tiles disappear.
function getFallbackTile(): Promise<ArrayBuffer> {
  return (_fallbackTile ??= (async () => {
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return blob.arrayBuffer();
  })());
}

/** Colour ramp keyed on diff height in metres. Reuses the same expression
 * shape as the elevation presets. -10000 + 0 are transparent so both no-data
 * tiles and bare-earth pixels (no canopy/building) let the backdrop show. */
export function buildDiffColorExpr(): unknown[] {
  return [
    'interpolate',
    ['linear'],
    ['elevation'],
    -10000,
    'rgba(0,0,0,0)',
    0,
    'rgba(0,0,0,0)',
    1,
    'rgba(120,200,100,0.40)',
    5,
    'rgba(150,210,80,0.70)',
    15,
    'rgba(240,200,60,0.85)',
    30,
    'rgba(240,120,60,0.95)',
    60,
    'rgba(200,40,40,1.0)',
  ];
}
