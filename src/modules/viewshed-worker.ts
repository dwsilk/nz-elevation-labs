/// <reference lib="webworker" />
/**
 * Viewshed worker — runs the per-cell ray-casting loop off the main thread.
 *
 * Input contract (one message per compute request):
 *   { type: 'compute', payload: ViewshedWorkerInput }
 * Output:
 *   { type: 'done', payload: ViewshedWorkerOutput }   // includes Transferable image buffer
 *   { type: 'error', message: string }
 *
 * Algorithm: for each cell of the output grid, walk a line in DEM-pixel space
 * from the viewpoint's global pixel to the target's global pixel using a
 * Bresenham-style DDA. At each integer pixel along the line, look up the
 * height from the supplied tile data and accumulate the max observer-angle.
 * Decide visibility against the target angle (with optional curvature drop).
 *
 * Working in pixel space keeps the per-sample cost to a Map lookup + a few
 * subtractions — no trig per sample.
 */
import { DEM_TILE_SIZE } from './dem-cache.js';
import { curvatureDropM, isVisible } from './viewshed.js';

export interface PackedTile {
  z: number;
  x: number;
  y: number;
  heights: Float32Array;
}

export interface ViewshedWorkerInput {
  lng: number;
  lat: number;
  radiusM: number;
  gridM: number;
  eyeHeightM: number;
  targetHeightM: number;
  earthCurvature: boolean;
  sourceZoom: number;
  /** Source-pixel stride for the DDA ray-march along each target. 1 = sample
   *  every pixel (sharp); higher = skip pixels (faster but may miss narrow
   *  ridges < stride×pixelMetres wide). */
  ddaStride: number;
  tiles: PackedTile[];
  /** RGBA colour to paint visible cells. Hidden cells stay transparent. */
  visibleRgba: [number, number, number, number];
}

export interface ViewshedWorkerOutput {
  width: number;
  height: number;
  imageBuffer: ArrayBuffer; // Uint8ClampedArray-backed
  computeMs: number;
  visibleCells: number;
  totalCells: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lngLatToGlobalPixel(lng: number, lat: number, z: number): { gpx: number; gpy: number } {
  const n = Math.pow(2, z);
  const latRad = (lat * Math.PI) / 180;
  const xFloat = ((lng + 180) / 360) * n;
  const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  // Global pixel = tile coord * tile size + pixel-within-tile.
  return { gpx: xFloat * DEM_TILE_SIZE, gpy: yFloat * DEM_TILE_SIZE };
}

/** Metres per DEM pixel at the given zoom and latitude (Web Mercator). */
function pixelMetres(z: number, lat: number): number {
  const C = 156_543.034; // equatorial metres per pixel at z=0 for a 256-px tile
  return (C * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z);
}

/** Pack the tiles into a Map<"z/x/y", Float32Array> for O(1) lookup. */
function indexTiles(tiles: ReadonlyArray<PackedTile>): Map<string, Float32Array> {
  const m = new Map<string, Float32Array>();
  for (const t of tiles) m.set(`${t.z}/${t.x}/${t.y}`, t.heights);
  return m;
}

/** Look up the DEM height at an integer global pixel; returns null if the tile
 *  isn't in our packed set (off-bbox or unloaded). */
function heightAtGlobalPixel(
  gpx: number,
  gpy: number,
  z: number,
  tileIdx: Map<string, Float32Array>,
): number | null {
  if (gpx < 0 || gpy < 0) return null;
  const tileX = Math.floor(gpx / DEM_TILE_SIZE);
  const tileY = Math.floor(gpy / DEM_TILE_SIZE);
  const heights = tileIdx.get(`${z}/${tileX}/${tileY}`);
  if (!heights) return null;
  const px = gpx - tileX * DEM_TILE_SIZE;
  const py = gpy - tileY * DEM_TILE_SIZE;
  return heights[py * DEM_TILE_SIZE + px] ?? null;
}

// ── Core compute ──────────────────────────────────────────────────────────────

function computeViewshedImage(input: ViewshedWorkerInput): ViewshedWorkerOutput {
  const t0 = performance.now();
  const {
    lng,
    lat,
    radiusM,
    gridM,
    eyeHeightM,
    targetHeightM,
    earthCurvature,
    sourceZoom,
    ddaStride,
    tiles,
    visibleRgba,
  } = input;
  const stride = Math.max(1, Math.floor(ddaStride));

  const half = Math.ceil(radiusM / gridM);
  const size = half * 2 + 1;
  const totalCells = size * size;

  // Map a Mercator pixel index → tile-local height.
  const tileIdx = indexTiles(tiles);

  // Viewpoint in global pixel coords.
  const { gpx: vGpx, gpy: vGpy } = lngLatToGlobalPixel(lng, lat, sourceZoom);
  const vGpxInt = Math.round(vGpx);
  const vGpyInt = Math.round(vGpy);
  const viewpointGroundH = heightAtGlobalPixel(vGpxInt, vGpyInt, sourceZoom, tileIdx) ?? 0;

  // Metres-per-pixel at the viewpoint latitude. For 5 km radius the value is
  // constant enough across the bbox to treat as a single scalar.
  const pxM = pixelMetres(sourceZoom, lat);
  // Pixels per output-grid-cell.
  const pixelsPerCell = gridM / pxM;

  // Output image buffer (RGBA).
  const buffer = new ArrayBuffer(totalCells * 4);
  const px = new Uint8ClampedArray(buffer);
  const [r, g, b, a] = visibleRgba;

  let visibleCells = 0;
  const profile: Array<{ d: number; h: number }> = [];

  // Iterate over the output grid. (gx, gy) in [-half, +half] map to (target_gpx,
  // target_gpy) by adding pixel offsets to the viewpoint pixel position. Cells
  // outside the circular radius are skipped (left transparent).
  const radiusCells = half;
  const radiusCellsSq = radiusCells * radiusCells;
  for (let gy = -half; gy <= half; gy++) {
    const gyOffsetPx = gy * pixelsPerCell;
    const targetGpyF = vGpy + gyOffsetPx;
    for (let gx = -half; gx <= half; gx++) {
      // Only compute inside the circular footprint.
      if (gx * gx + gy * gy > radiusCellsSq) continue;
      if (gx === 0 && gy === 0) {
        // The viewpoint cell is trivially visible. Paint it for completeness.
        const out = ((gy + half) * size + (gx + half)) * 4;
        px[out] = r;
        px[out + 1] = g;
        px[out + 2] = b;
        px[out + 3] = a;
        visibleCells++;
        continue;
      }

      const targetGpxF = vGpx + gx * pixelsPerCell;
      const targetGpx = Math.round(targetGpxF);
      const targetGpy = Math.round(targetGpyF);
      const targetH = heightAtGlobalPixel(targetGpx, targetGpy, sourceZoom, tileIdx);
      if (targetH === null) continue; // off-map / no LiDAR coverage — leave transparent

      // DDA over the major axis from viewpoint pixel to target pixel.
      profile.length = 0;
      const dx = targetGpx - vGpxInt;
      const dy = targetGpy - vGpyInt;
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (steps === 0) continue;
      const sx = dx / steps;
      const sy = dy / steps;
      const rayPx = Math.sqrt(dx * dx + dy * dy);
      // Iterate at `stride` source-pixel granularity. stride=1 samples every
      // pixel (sharp), stride=4 samples every 4th pixel (4× fewer height
      // lookups per ray — used by the Live preview path).
      for (let i = stride; i < steps; i += stride) {
        const ipx = Math.round(vGpxInt + sx * i);
        const ipy = Math.round(vGpyInt + sy * i);
        const h = heightAtGlobalPixel(ipx, ipy, sourceZoom, tileIdx);
        if (h === null) continue; // skip gaps; preserves visibility through unloaded patches
        const d = (i / steps) * rayPx * pxM;
        profile.push({ d, h });
      }
      // Always include the target itself as the last sample, regardless of
      // stride — it's the cell we're deciding visibility for.
      profile.push({ d: rayPx * pxM, h: targetH });

      // Curvature drop is handled INSIDE isVisible, so we pass raw heights.
      if (isVisible(viewpointGroundH, eyeHeightM, targetHeightM, profile, earthCurvature)) {
        const out = ((gy + half) * size + (gx + half)) * 4;
        px[out] = r;
        px[out + 1] = g;
        px[out + 2] = b;
        px[out + 3] = a;
        visibleCells++;
      }
    }
  }

  // Silence the unused-variable warning for curvatureDropM — it's referenced
  // transitively through isVisible. Re-exporting keeps the module surface
  // explicit if a caller ever wants to reuse the curvature helper directly.
  void curvatureDropM;

  return {
    width: size,
    height: size,
    imageBuffer: buffer,
    computeMs: performance.now() - t0,
    visibleCells,
    totalCells,
  };
}

// ── Worker plumbing ───────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<{ type: 'compute'; payload: ViewshedWorkerInput }>) => {
  if (e.data.type !== 'compute') return;
  try {
    const result = computeViewshedImage(e.data.payload);
    // Transfer the image buffer back without copying.
    (self as DedicatedWorkerGlobalScope).postMessage({ type: 'done', payload: result }, [
      result.imageBuffer,
    ]);
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
