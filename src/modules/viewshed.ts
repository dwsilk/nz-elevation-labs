/**
 * Viewshed (line-of-sight) analysis from a single viewpoint.
 *
 * For each cell on a regular grid around the viewpoint, march a ray from the
 * observer to the target and decide whether the target is visible — i.e. no
 * intervening DEM sample subtends a larger observer-angle than the target
 * itself.
 *
 * Source DEM heights come from the shared dem-cache (terrain-RGB). Output is
 * an ImageData mask sized to the chosen grid resolution; the caller paints it
 * onto a MapLibre `image` source covering the computed bounding box.
 *
 * Compute happens off the main thread in a Web Worker so the panel stays
 * responsive while the ~1 M cell × 250 sample grid (10 m output, 5 km radius)
 * crunches. This module is the orchestrator — fetches the DEM tiles into
 * memory, dispatches to the worker, hands the result back.
 */
import type { ImageSource, Map as MaplibreMap } from 'maplibre-gl';
import type { DemDsm } from './config.js';
import { DEM_TILE_SIZE, getDemHeights, lngLatToTilePixel, MAX_DEM_ZOOM } from './dem-cache.js';
import ViewshedWorker from './viewshed-worker.ts?worker';
import type { ViewshedWorkerInput, ViewshedWorkerOutput } from './viewshed-worker.js';
import { moveLabelsToTop } from './basemap.js';

// ── TYPES ─────────────────────────────────────────────────────────────────────

export interface ViewshedOptions {
  /** DEM (bare-earth) or DSM (surface — includes canopy/buildings as blockers). */
  src: DemDsm;
  /** Viewpoint longitude (degrees). */
  lng: number;
  /** Viewpoint latitude (degrees). */
  lat: number;
  /** Radius in metres. Hard-capped to keep compute bounded. */
  radiusM: number;
  /** Output grid resolution in metres per pixel. Smaller → sharper but slower. */
  gridM: number;
  /** Observer eye height above ground in metres. */
  eyeHeightM: number;
  /** Optional target height — counts a cell as visible if any point up to this
   *  height above its DEM elevation can see the observer. Default 0 (bare-earth). */
  targetHeightM: number;
  /** Subtract spherical-earth drop along the line of sight. Default true. */
  earthCurvature: boolean;
  /** DEM tile zoom level to source heights from. Higher = denser source but
   *  more network. Falls back to MAX_DEM_ZOOM if higher is unavailable. */
  sourceZoom: number;
  /** DDA sampling stride in source pixels. 1 = sample every source pixel along
   *  the ray (sharp but slow); higher values skip pixels to trade narrow-ridge
   *  detection for speed. Used by the "Live preview" mode at 4. Default 1. */
  ddaStride: number;
}

export interface ViewshedBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface ViewshedResult {
  bounds: ViewshedBounds;
  image: ImageData;
  /** Grid dimensions in cells (image.width / image.height). */
  width: number;
  height: number;
  /** Wall-clock milliseconds the compute took (worker time, not including fetch). */
  computeMs: number;
}

// ── CONSTANTS ────────────────────────────────────────────────────────────────

/** Earth radius (mean) in metres — for curvature drop. */
export const EARTH_R_M = 6_371_000;
/** Hard upper bound on viewshed radius — protects against runaway compute. */
export const MAX_RADIUS_M = 5_000;

// ── PURE HELPERS (unit-tested) ───────────────────────────────────────────────

/** Apparent height drop, in metres, at horizontal distance `d` due to Earth's
 *  curvature. Approximation valid for d ≪ R_earth. */
export function curvatureDropM(d: number): number {
  return (d * d) / (2 * EARTH_R_M);
}

/** Convert a metres-offset around a reference (lng, lat) into degrees, using
 *  the local flat-Earth approximation (valid at the 5 km scale). Returns
 *  [Δlng, Δlat] in degrees. */
export function metresToDegrees(dxM: number, dyM: number, lat: number): [number, number] {
  const latRad = (lat * Math.PI) / 180;
  const mPerDegLat = 111_320; // mean meridional length of one degree latitude
  const mPerDegLng = mPerDegLat * Math.cos(latRad);
  return [dxM / mPerDegLng, dyM / mPerDegLat];
}

/**
 * Decide whether a target cell is visible from the viewpoint, given the
 * sampled DEM heights along the ray.
 *
 * `profile` is the list of (distance-from-viewpoint, ground-height) samples
 * along the ray, NOT including the viewpoint itself and ending at the target.
 * The last entry is treated as the target.
 *
 * Heights and distances are in metres. The observer sits at
 * `viewpointGroundH + eyeHeightM`. A blocker at distance `d` with ground
 * height `h` subtends angle `(h - viewpointGroundH - eyeHeightM) / d` from
 * the observer (positive = above observer eye level, negative = below).
 *
 * The cell is visible iff the target's apparent angle is strictly greater
 * than the maximum blocker angle along the way.
 */
export function isVisible(
  viewpointGroundH: number,
  eyeHeightM: number,
  targetHeightM: number,
  profile: ReadonlyArray<{ d: number; h: number }>,
  earthCurvature: boolean,
): boolean {
  if (profile.length === 0) return true; // pathological — viewpoint IS the target
  const eyeAbsH = viewpointGroundH + eyeHeightM;
  let maxBlockerAngle = -Infinity;
  for (let i = 0; i < profile.length - 1; i++) {
    const s = profile[i]!;
    const sH = earthCurvature ? s.h - curvatureDropM(s.d) : s.h;
    const angle = (sH - eyeAbsH) / s.d;
    if (angle > maxBlockerAngle) maxBlockerAngle = angle;
  }
  const target = profile[profile.length - 1]!;
  const targetH = earthCurvature ? target.h - curvatureDropM(target.d) : target.h;
  const targetAngle = (targetH + targetHeightM - eyeAbsH) / target.d;
  return targetAngle > maxBlockerAngle;
}

/**
 * Given a viewpoint (lng, lat) and radius in metres, compute the local
 * bounding box in degrees. Square-in-metres around the viewpoint, which
 * becomes a rectangle in degrees because lng-degrees-per-metre depends on
 * latitude.
 */
export function viewshedBounds(lng: number, lat: number, radiusM: number): ViewshedBounds {
  const [dLng, dLat] = metresToDegrees(radiusM, radiusM, lat);
  return {
    west: lng - dLng,
    east: lng + dLng,
    south: lat - dLat,
    north: lat + dLat,
  };
}

/**
 * Number of cells in each grid axis for a given radius and resolution. Always
 * odd so the viewpoint sits exactly on the centre cell.
 */
export function gridSize(radiusM: number, gridM: number): number {
  const half = Math.ceil(radiusM / gridM);
  return half * 2 + 1;
}

// ── ORCHESTRATION (will dispatch to worker in Phase B) ───────────────────────

/**
 * Validate options + clamp anything that would otherwise blow up compute.
 * Returned options are guaranteed safe for the worker to consume.
 */
export function normaliseOptions(opts: ViewshedOptions): ViewshedOptions {
  return {
    ...opts,
    radiusM: Math.max(50, Math.min(MAX_RADIUS_M, opts.radiusM)),
    gridM: Math.max(1, opts.gridM),
    eyeHeightM: Math.max(0, opts.eyeHeightM),
    targetHeightM: Math.max(0, opts.targetHeightM),
    sourceZoom: Math.max(0, Math.min(MAX_DEM_ZOOM, opts.sourceZoom)),
    ddaStride: Math.max(1, Math.floor(opts.ddaStride)),
  };
}

/**
 * Identify the (z, x, y) of every DEM tile intersecting the viewshed bbox at
 * the chosen source zoom. Returned as a deduplicated array.
 */
export function tilesForBounds(
  bounds: ViewshedBounds,
  zoom: number,
): Array<{ z: number; x: number; y: number }> {
  const nw = lngLatToTilePixel(bounds.west, bounds.north, zoom);
  const se = lngLatToTilePixel(bounds.east, bounds.south, zoom);
  const out: Array<{ z: number; x: number; y: number }> = [];
  for (let y = nw.y; y <= se.y; y++) {
    for (let x = nw.x; x <= se.x; x++) out.push({ z: nw.z, x, y });
  }
  return out;
}

/** Fetch every DEM tile covering the viewshed bbox; resolves once all are decoded. */
export async function prefetchDemBounds(
  src: DemDsm,
  bounds: ViewshedBounds,
  zoom: number,
): Promise<Array<{ z: number; x: number; y: number; heights: Float32Array }>> {
  const tiles = tilesForBounds(bounds, zoom);
  const heights = await Promise.all(tiles.map(t => getDemHeights(src, t.z, t.x, t.y)));
  // A tile that 404'd / failed comes back null — treat it as a flat-zero plate
  // so the worker can still produce output rather than crashing on the row of
  // nulls. (Likely no LiDAR coverage there; the user will see a blank wedge.)
  const TILE_PX = DEM_TILE_SIZE * DEM_TILE_SIZE;
  return tiles.map((t, i) => ({
    ...t,
    heights: heights[i] ?? new Float32Array(TILE_PX),
  }));
}

// ── PUBLIC ENTRY POINT ────────────────────────────────────────────────────────

/**
 * End-to-end viewshed compute: fetch the DEM tiles for the bounding box, hand
 * them to a Web Worker, get the painted ImageData back.
 *
 * The caller is responsible for placing the resulting image on a MapLibre
 * `image` source spanning `bounds`. Recomputing means calling this again with
 * a new viewpoint / settings and replacing the source data.
 */
export async function computeViewshed(opts: ViewshedOptions): Promise<ViewshedResult> {
  const o = normaliseOptions(opts);
  const bounds = viewshedBounds(o.lng, o.lat, o.radiusM);
  const tiles = await prefetchDemBounds(o.src, bounds, o.sourceZoom);

  const workerInput: ViewshedWorkerInput = {
    lng: o.lng,
    lat: o.lat,
    radiusM: o.radiusM,
    gridM: o.gridM,
    eyeHeightM: o.eyeHeightM,
    targetHeightM: o.targetHeightM,
    earthCurvature: o.earthCurvature,
    sourceZoom: o.sourceZoom,
    ddaStride: o.ddaStride,
    tiles,
    // Translucent green for visible cells.
    visibleRgba: [80, 220, 100, 130],
  };

  const result = await runWorker(workerInput);
  const imageBytes = new Uint8ClampedArray(result.imageBuffer);
  const image = new ImageData(imageBytes, result.width, result.height);
  return {
    bounds,
    image,
    width: result.width,
    height: result.height,
    computeMs: result.computeMs,
  };
}

// ── MAP OVERLAY ───────────────────────────────────────────────────────────────

const VIEWSHED_SOURCE = 'viewshed';
const VIEWSHED_LAYER = 'viewshed-layer';

/** Whether a viewshed overlay is currently mounted on the given map. */
export function hasViewshedOverlay(map: MaplibreMap): boolean {
  return map.getLayer(VIEWSHED_LAYER) !== undefined;
}

/**
 * Mount (or refresh) the viewshed image as a MapLibre `image` source +
 * `raster` layer covering the result's geographic bounds. Sits above the
 * basemap, below the Labels overlay (we call moveLabelsToTop afterwards).
 */
export function mountViewshedOverlay(map: MaplibreMap, result: ViewshedResult): void {
  const url = imageDataToDataURL(result.image);
  const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
    [result.bounds.west, result.bounds.north], // top-left
    [result.bounds.east, result.bounds.north], // top-right
    [result.bounds.east, result.bounds.south], // bottom-right
    [result.bounds.west, result.bounds.south], // bottom-left
  ];
  const existing = map.getSource<ImageSource>(VIEWSHED_SOURCE);
  if (existing) {
    existing.updateImage({ url, coordinates });
  } else {
    map.addSource(VIEWSHED_SOURCE, { type: 'image', url, coordinates });
    map.addLayer({
      id: VIEWSHED_LAYER,
      type: 'raster',
      source: VIEWSHED_SOURCE,
      paint: {
        // Sharp cell edges instead of MapLibre's default linear blur — this is
        // a categorical visible/hidden mask, not a continuous raster.
        'raster-resampling': 'nearest',
        'raster-opacity': 1,
        'raster-fade-duration': 0,
      },
    });
  }
  // Keep labels above us.
  moveLabelsToTop();
}

export function unmountViewshedOverlay(map: MaplibreMap): void {
  if (map.getLayer(VIEWSHED_LAYER)) map.removeLayer(VIEWSHED_LAYER);
  if (map.getSource(VIEWSHED_SOURCE)) map.removeSource(VIEWSHED_SOURCE);
}

/** Render an ImageData into a data: URL — MapLibre's image source needs a URL. */
function imageDataToDataURL(image: ImageData): string {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/** One worker per compute — short-lived, cheap to spawn, no shared state. */
function runWorker(input: ViewshedWorkerInput): Promise<ViewshedWorkerOutput> {
  return new Promise((resolve, reject) => {
    const worker = new ViewshedWorker();
    worker.onmessage = (
      e: MessageEvent<{ type: string; payload?: ViewshedWorkerOutput; message?: string }>,
    ) => {
      if (e.data.type === 'done' && e.data.payload) {
        resolve(e.data.payload);
      } else if (e.data.type === 'error') {
        reject(new Error(e.data.message ?? 'viewshed worker failed'));
      }
      worker.terminate();
    };
    worker.onerror = (err: ErrorEvent) => {
      reject(new Error(err.message || 'viewshed worker errored'));
      worker.terminate();
    };
    // Clone tile heights before transferring. dem-cache holds the canonical
    // Float32Array references; if we transferred those directly, their backing
    // ArrayBuffers would be detached on the main thread, and the NEXT compute
    // (recompute, dataset toggle, fresh click) would fail with DataCloneError
    // when it pulls the same buffers out of the cache and tries to re-transfer
    // an already-detached buffer. The clone costs ~2 MB memcpy per compute and
    // keeps the cache reusable.
    const clonedTiles = input.tiles.map(t => ({ ...t, heights: new Float32Array(t.heights) }));
    const transferableInput: ViewshedWorkerInput = { ...input, tiles: clonedTiles };
    const transfers = clonedTiles.map(t => t.heights.buffer);
    worker.postMessage({ type: 'compute', payload: transferableInput }, transfers);
  });
}
