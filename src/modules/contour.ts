/**
 * Contour tab — maplibre-contour integration, layer management,
 * threshold UI, presets, and live paint updates.
 */
import maplibregl, { type Map as MaplibreMap } from 'maplibre-gl';
import mlcontour from 'maplibre-contour';
import { ELEV_URL, DSM_URL, type DemDsm } from './config.js';

// ── TYPES ─────────────────────────────────────────────────────────────────────

/** Zoom level → [minorInterval, majorInterval] in metres */
export type ThresholdMap = Record<number, [number, number]>;

export interface ContourConfig {
  minorColor: string;
  majorColor: string;
  minorWidth: number;
  majorWidth: number;
  /** 0–1 */
  opacity: number;
  labelColor: string;
  textSize: number;
  /** 0–1 */
  labelOpacity: number;
  placement: 'line' | 'line-center';
  font: string;
  haloColor: string;
  haloWidth: number;
  haloBlur: number;
  showLabels: boolean;
}

export interface ContourPreset {
  thresholds: ThresholdMap;
  config: ContourConfig;
}

// ── PRESETS ───────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: ThresholdMap = {
  1: [500, 1000], 8: [200, 500], 10: [100, 500],
  11: [50, 200], 12: [20, 100], 13: [10, 50],
};

export const CT_PRESETS: Record<string, ContourPreset> = {
  standard: {
    thresholds: { ...DEFAULT_THRESHOLDS },
    config: {
      minorColor: '#999999', majorColor: '#444444',
      minorWidth: 1, majorWidth: 2, opacity: 0.8,
      labelColor: '#333333', textSize: 11, labelOpacity: 0.9,
      font: 'Open Sans Bold', placement: 'line',
      haloColor: '#ffffff', haloWidth: 2, haloBlur: 0, showLabels: true,
    },
  },
  topo50: {
    thresholds: { ...DEFAULT_THRESHOLDS },
    config: {
      minorColor: '#c8a06e', majorColor: '#b07830',
      minorWidth: 1, majorWidth: 2, opacity: 0.9,
      labelColor: '#7a4a10', textSize: 10, labelOpacity: 1.0,
      font: 'Open Sans Regular', placement: 'line',
      haloColor: '#f0e8d0', haloWidth: 2, haloBlur: 0.5, showLabels: true,
    },
  },
  white: {
    thresholds: { ...DEFAULT_THRESHOLDS },
    config: {
      minorColor: '#cccccc', majorColor: '#ffffff',
      minorWidth: 1, majorWidth: 2, opacity: 0.9,
      labelColor: '#ffffff', textSize: 11, labelOpacity: 0.95,
      font: 'Open Sans Bold', placement: 'line',
      haloColor: '#000000', haloWidth: 2, haloBlur: 0.5, showLabels: true,
    },
  },
  cyan: {
    thresholds: { ...DEFAULT_THRESHOLDS },
    config: {
      minorColor: '#80dfff', majorColor: '#00c8ff',
      minorWidth: 1, majorWidth: 2, opacity: 0.9,
      labelColor: '#00c8ff', textSize: 11, labelOpacity: 0.95,
      font: 'Open Sans Bold', placement: 'line',
      haloColor: '#000000', haloWidth: 2, haloBlur: 0.5, showLabels: true,
    },
  },
};

// ── STATE ─────────────────────────────────────────────────────────────────────

export let ctThresholds: ThresholdMap = { ...DEFAULT_THRESHOLDS };
export let activeCtPreset = 'standard';

let ctLayers: string[] = [];
let demSource: InstanceType<typeof mlcontour.DemSource> | null = null;
let _map: MaplibreMap | null = null;
let _activeSrc: DemDsm = 'dem';

export function setActiveSrc(src: DemDsm): void {
  if (_activeSrc === src) return;
  _activeSrc = src;
  // If contours are currently mounted, rebuild with the new DEM source URL
  // so the lines actually reflect the chosen dataset. Otherwise the next
  // addContourLayers (mode entry / preset click) will pick it up.
  if (ctLayers.length > 0) addContourLayers();
}

// ── CONFIG READER ─────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Element #${id} not found`);
  return e as T;
}

function getCtConfig(): ContourConfig {
  // The master "Layer opacity" multiplies through both the per-line and the
  // per-label opacity sliders, so dragging it fades the whole contour layer
  // proportionally while the per-line / per-label sliders stay meaningful.
  const layerOp = Number((el<HTMLInputElement>('ct-layer-opacity')).value) / 100;
  return {
    minorColor:   (el<HTMLInputElement>('ct-minor-color')).value,
    majorColor:   (el<HTMLInputElement>('ct-major-color')).value,
    minorWidth:   Number((el<HTMLInputElement>('ct-minor-width')).value),
    majorWidth:   Number((el<HTMLInputElement>('ct-major-width')).value),
    opacity:      (Number((el<HTMLInputElement>('ct-opacity')).value) / 100) * layerOp,
    labelColor:   (el<HTMLInputElement>('ct-label-color')).value,
    textSize:     Number((el<HTMLInputElement>('ct-text-size')).value),
    labelOpacity: (Number((el<HTMLInputElement>('ct-label-opacity')).value) / 100) * layerOp,
    placement:    (el<HTMLSelectElement>('sel-ct-placement')).value as 'line' | 'line-center',
    font:         (el<HTMLSelectElement>('sel-ct-font')).value,
    haloColor:    (el<HTMLInputElement>('ct-halo-color')).value,
    haloWidth:    Number((el<HTMLInputElement>('ct-halo-width')).value),
    haloBlur:     Number((el<HTMLInputElement>('ct-halo-blur')).value),
    showLabels:   (el<HTMLInputElement>('tog-ct-labels')).checked,
  };
}

// ── LAYER MANAGEMENT ──────────────────────────────────────────────────────────

export function removeContourLayers(): void {
  if (!_map) return;
  ctLayers.forEach(id => { if (_map!.getLayer(id)) _map!.removeLayer(id); });
  if (_map.getSource('contour-source')) _map.removeSource('contour-source');
  ctLayers = [];
}

export function addContourLayers(): void {
  // `map.loaded()` is false while any source is still loading tiles; we only
  // need the style to be parsed to call addSource / addLayer, so check
  // isStyleLoaded() instead. The previous check made addContourLayers bail
  // silently when called immediately after a base rebuild (entering the
  // contour mode), so contours wouldn't appear until a preset click kicked
  // addContourLayers a second time, after the new base tiles had settled.
  if (!_map?.isStyleLoaded()) return;
  removeContourLayers();

  demSource = new mlcontour.DemSource({
    url: _activeSrc === 'dsm' ? DSM_URL : ELEV_URL,
    encoding: 'mapbox',
    maxzoom: 14,
    worker: true,
  });

  // Register the contour/DEM protocol synchronously so it's ready before the
  // source below requests tiles (an async import here races the first render).
  demSource.setupMaplibre(maplibregl);

  const cfg = getCtConfig();

  _map.addSource('contour-source', {
    type: 'vector',
    tiles: [demSource.contourProtocolUrl({
      thresholds: ctThresholds,
      contourLayer: 'contours',
      elevationKey: 'ele',
      levelKey: 'level',
    })],
    maxzoom: 15,
  });

  // visibility:'none' is what makes MapLibre mark contour-source unused and
  // skip tile fetches (and the maplibre-contour worker) — opacity-0 alone
  // still pulls vector tiles in the background.
  const linesVis = cfg.opacity > 0 ? 'visible' : 'none';
  const labelsVis = (cfg.showLabels && cfg.labelOpacity > 0) ? 'visible' : 'none';

  _map.addLayer({
    id: 'contour-lines-minor', type: 'line',
    source: 'contour-source', 'source-layer': 'contours',
    filter: ['all', ['==', ['get', 'level'], 0], ['!=', ['get', 'ele'], 0]],
    layout: { 'line-join': 'round', 'line-cap': 'round', visibility: linesVis },
    paint: { 'line-color': cfg.minorColor, 'line-width': cfg.minorWidth, 'line-opacity': cfg.opacity },
  });

  _map.addLayer({
    id: 'contour-lines-major', type: 'line',
    source: 'contour-source', 'source-layer': 'contours',
    filter: ['all', ['==', ['get', 'level'], 1], ['!=', ['get', 'ele'], 0]],
    layout: { 'line-join': 'round', 'line-cap': 'round', visibility: linesVis },
    paint: { 'line-color': cfg.majorColor, 'line-width': cfg.majorWidth, 'line-opacity': cfg.opacity },
  });

  _map.addLayer({
    id: 'contour-labels', type: 'symbol',
    source: 'contour-source', 'source-layer': 'contours',
    filter: ['all', ['==', ['get', 'level'], 1], ['!=', ['get', 'ele'], 0]],
    layout: {
      'symbol-placement': cfg.placement,
      'text-field': ['concat', ['to-string', ['get', 'ele']], 'm'],
      'text-font': [cfg.font],
      'text-size': cfg.textSize,
      'text-allow-overlap': false,
      visibility: labelsVis,
    },
    paint: {
      'text-color': cfg.labelColor,
      'text-opacity': cfg.labelOpacity,
      'text-halo-color': cfg.haloColor,
      'text-halo-width': cfg.haloWidth,
      'text-halo-blur': cfg.haloBlur,
    },
  });

  ctLayers = ['contour-lines-minor', 'contour-lines-major', 'contour-labels'];
}

export function updateContourPaint(): void {
  if (!_map || !ctLayers.length) return;
  const cfg = getCtConfig();
  // Mirror the visibility logic in addContourLayers: hide layers whose
  // effective opacity is 0 so MapLibre stops loading contour-source tiles
  // (and the maplibre-contour worker stops decoding DEM tiles) when the
  // master / per-line / per-label sliders are pulled to zero.
  const linesVis = cfg.opacity > 0 ? 'visible' : 'none';
  const labelsVis = (cfg.showLabels && cfg.labelOpacity > 0) ? 'visible' : 'none';

  if (_map.getLayer('contour-lines-minor')) {
    _map.setPaintProperty('contour-lines-minor', 'line-color', cfg.minorColor);
    _map.setPaintProperty('contour-lines-minor', 'line-width', cfg.minorWidth);
    _map.setPaintProperty('contour-lines-minor', 'line-opacity', cfg.opacity);
    _map.setLayoutProperty('contour-lines-minor', 'visibility', linesVis);
  }
  if (_map.getLayer('contour-lines-major')) {
    _map.setPaintProperty('contour-lines-major', 'line-color', cfg.majorColor);
    _map.setPaintProperty('contour-lines-major', 'line-width', cfg.majorWidth);
    _map.setPaintProperty('contour-lines-major', 'line-opacity', cfg.opacity);
    _map.setLayoutProperty('contour-lines-major', 'visibility', linesVis);
  }
  if (_map.getLayer('contour-labels')) {
    _map.setPaintProperty('contour-labels', 'text-color', cfg.labelColor);
    _map.setPaintProperty('contour-labels', 'text-opacity', cfg.labelOpacity);
    _map.setPaintProperty('contour-labels', 'text-halo-color', cfg.haloColor);
    _map.setPaintProperty('contour-labels', 'text-halo-width', cfg.haloWidth);
    _map.setPaintProperty('contour-labels', 'text-halo-blur', cfg.haloBlur);
    _map.setLayoutProperty('contour-labels', 'text-size', cfg.textSize);
    _map.setLayoutProperty('contour-labels', 'visibility', labelsVis);
  }
}

// ── THRESHOLD UI ─────────────────────────────────────────────────────────────

export function renderThresholds(): void {
  const list = el<HTMLDivElement>('threshold-list');
  list.innerHTML = '';

  Object.entries(ctThresholds)
    .sort(([a], [b]) => Number(a) - Number(b))
    .forEach(([z, [minor, major]]) => {
      const row = document.createElement('div');
      row.className = 'threshold-row';

      const make = (attrs: Partial<HTMLInputElement>): HTMLInputElement => {
        const el = document.createElement('input');
        Object.assign(el, attrs);
        return el;
      };
      const makeSpan = (cls: string, text: string): HTMLSpanElement => {
        return Object.assign(document.createElement('span'), { className: cls, textContent: text });
      };

      const zIn  = make({ type: 'number', className: 'th-zoom', value: z, min: '0', max: '22', step: '1', title: 'Zoom level' });
      const minIn = make({ type: 'number', value: String(minor), min: '1', max: '5000', step: '1', title: 'Minor interval (m)' });
      const majIn = make({ type: 'number', value: String(major), min: '1', max: '10000', step: '1', title: 'Major interval (m)' });
      const del = Object.assign(document.createElement('button'), { className: 'stop-del', textContent: '×', title: 'Remove' });

      del.addEventListener('click', () => {
        delete ctThresholds[Number(z)];
        renderThresholds();
        addContourLayers();
      });

      const updateThreshold = (): void => {
        const newZ = Number(zIn.value);
        if (newZ !== Number(z)) delete ctThresholds[Number(z)];
        ctThresholds[newZ] = [Number(minIn.value), Number(majIn.value)];
      };

      zIn.addEventListener('change',  () => { updateThreshold(); renderThresholds(); addContourLayers(); });
      minIn.addEventListener('change', () => { updateThreshold(); addContourLayers(); });
      majIn.addEventListener('change', () => { updateThreshold(); addContourLayers(); });

      row.append(makeSpan('th-lbl', 'Z'), zIn, makeSpan('th-lbl', 'minor'), minIn, makeSpan('th-lbl', 'major'), majIn, del);
      list.appendChild(row);
    });
}

// ── PRESET APPLICATION ────────────────────────────────────────────────────────

export function applyCtPreset(name: string): void {
  const p = CT_PRESETS[name];
  if (!p) return;
  activeCtPreset = name;
  ctThresholds = { ...p.thresholds };

  const { config: c } = p;
  (el<HTMLInputElement>('ct-minor-color')).value         = c.minorColor;
  (el<HTMLInputElement>('ct-minor-width')).value         = String(c.minorWidth);
  (el<HTMLSpanElement>('ct-minor-width-v')).textContent  = c.minorWidth + 'px';
  (el<HTMLInputElement>('ct-major-color')).value         = c.majorColor;
  (el<HTMLInputElement>('ct-major-width')).value         = String(c.majorWidth);
  (el<HTMLSpanElement>('ct-major-width-v')).textContent  = c.majorWidth + 'px';
  (el<HTMLInputElement>('ct-opacity')).value             = String(c.opacity * 100);
  (el<HTMLSpanElement>('ct-opacity-v')).textContent      = (c.opacity * 100) + '%';
  (el<HTMLInputElement>('ct-label-color')).value         = c.labelColor;
  (el<HTMLInputElement>('ct-text-size')).value           = String(c.textSize);
  (el<HTMLSpanElement>('ct-text-size-v')).textContent    = c.textSize + 'px';
  (el<HTMLInputElement>('ct-label-opacity')).value       = String(c.labelOpacity * 100);
  (el<HTMLSpanElement>('ct-label-opacity-v')).textContent = (c.labelOpacity * 100) + '%';
  (el<HTMLSelectElement>('sel-ct-font')).value           = c.font;
  (el<HTMLSelectElement>('sel-ct-placement')).value      = c.placement;
  (el<HTMLInputElement>('ct-halo-color')).value          = c.haloColor;
  (el<HTMLInputElement>('ct-halo-width')).value          = String(c.haloWidth);
  (el<HTMLSpanElement>('ct-halo-width-v')).textContent   = c.haloWidth + 'px';
  (el<HTMLInputElement>('ct-halo-blur')).value           = String(c.haloBlur);
  (el<HTMLSpanElement>('ct-halo-blur-v')).textContent    = c.haloBlur + 'px';
  (el<HTMLInputElement>('tog-ct-labels')).checked        = c.showLabels;

  renderThresholds();
  document.querySelectorAll('.ct-pre-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`ct-pre-${name}`)?.classList.add('active');
  addContourLayers();
}

// ── CONTROLS ─────────────────────────────────────────────────────────────────

export function initContourControls(map: MaplibreMap): void {
  _map = map;

  el<HTMLInputElement>('tog-ct-labels').addEventListener('change', updateContourPaint);

  (['ct-minor-color', 'ct-major-color', 'ct-label-color', 'ct-halo-color'] as const).forEach(id => {
    el<HTMLInputElement>(id).addEventListener('input', () => {
      document.querySelectorAll('.ct-pre-btn').forEach(b => b.classList.remove('active'));
      updateContourPaint();
    });
  });

  ([ ['ct-layer-opacity', 'ct-layer-opacity-v', (v: string) => v + '%'],
     ['ct-minor-width',   'ct-minor-width-v',   (v: string) => v + 'px'],
     ['ct-major-width',   'ct-major-width-v',   (v: string) => v + 'px'],
     ['ct-opacity',       'ct-opacity-v',       (v: string) => v + '%'],
     ['ct-text-size',     'ct-text-size-v',     (v: string) => v + 'px'],
     ['ct-label-opacity', 'ct-label-opacity-v', (v: string) => v + '%'],
     ['ct-halo-width',    'ct-halo-width-v',    (v: string) => v + 'px'],
     ['ct-halo-blur',     'ct-halo-blur-v',     (v: string) => v + 'px'],
  ] as [string, string, (v: string) => string][]).forEach(([id, valId, fmt]) => {
    el<HTMLInputElement>(id).addEventListener('input', e => {
      el<HTMLSpanElement>(valId).textContent = fmt((e.target as HTMLInputElement).value);
      updateContourPaint();
    });
  });

  (['sel-ct-placement', 'sel-ct-font'] as const).forEach(id => {
    el<HTMLSelectElement>(id).addEventListener('change', updateContourPaint);
  });

  el<HTMLButtonElement>('add-threshold').addEventListener('click', () => {
    const zooms = Object.keys(ctThresholds).map(Number).sort((a, b) => a - b);
    const next = zooms.length > 0 ? (zooms[zooms.length - 1]! + 1) : 10;
    ctThresholds[next] = [10, 50];
    renderThresholds();
    addContourLayers();
  });

  el<HTMLButtonElement>('ct-pre-standard').addEventListener('click', () => applyCtPreset('standard'));
  el<HTMLButtonElement>('ct-pre-topo50').addEventListener('click',   () => applyCtPreset('topo50'));
  el<HTMLButtonElement>('ct-pre-white').addEventListener('click',    () => applyCtPreset('white'));
  el<HTMLButtonElement>('ct-pre-cyan').addEventListener('click',     () => applyCtPreset('cyan'));
}
