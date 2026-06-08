/**
 * main.ts — application entry point
 * Initialises the MapLibre map, wires all panel tabs, and coordinates
 * between the elevation, contour, and coverage modules.
 */
import type { RasterTileSource, IControl } from 'maplibre-gl';
import { Map as MaplibreMap, NavigationControl, ScaleControl } from 'maplibre-gl';
import {
  API,
  ELEV_URL,
  DSM_URL,
  HS_URLS,
  AERIAL_URL,
  MAP_CENTER,
  MAP_ZOOM,
  DIFF_LAYER,
  DIFF_SOURCE,
  DIFF_URL,
  ANALYSIS_LAYER,
  ANALYSIS_SOURCE,
  ANALYSIS_URLS,
  type DemDsm,
  type HsSource,
  type HsRaster,
  type HsMethod,
  type HsAnalysis,
} from './modules/config.js';
import {
  PRESETS,
  stops,
  activePreset,
  setStops,
  setActivePreset,
  paintCanvas,
  colorAt,
  buildColorExpr,
  rgbToHex,
  type ColourStop,
} from './modules/elevation.js';
import {
  initContourControls,
  addContourLayers,
  removeContourLayers,
  renderThresholds,
  applyCtPreset,
  activeCtPreset,
  setActiveSrc as setContourSrc,
} from './modules/contour.js';
import {
  loadCoverage,
  prefetchCoverage,
  initCoverageControls,
  showCoverageLayers,
  hideCoverageLayers,
  switchCoverageSrc,
} from './modules/coverage.js';
import {
  loadExport,
  initExportControls,
  showExportLayers,
  hideExportLayers,
  switchExportSrc,
} from './modules/export.js';
import { registerDiffProtocol, buildDiffColorExpr } from './modules/diff.js';
import { registerAnalysisProtocol } from './modules/analysis.js';
import {
  initInspectControls,
  attachInspect,
  detachInspect,
  setInspectActiveSrc,
} from './modules/inspect.js';
import {
  initBasemap,
  isBasemapOrLabelLayer,
  moveLabelsToTop,
  setBasemap,
  setLabelsEnabled,
  setHillshadeBlend,
} from './modules/basemap.js';
import { initTerrainPreviews } from './modules/hs-thumbs.js';
import { readHash, setHashParam } from './modules/hash.js';

import './styles/main.css';
import './styles/panel.css';
import './styles/coverage.css';
import './styles/export.css';
import './styles/diff.css';
import './styles/inspect.css';
import './styles/basemap.css';

// Register the diff-dem:// virtual tile protocol once, before any map activity.
registerDiffProtocol();
registerAnalysisProtocol();

// ── HELPERS ───────────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Element #${id} not found`);
  return e as T;
}

// ── URL HASH STATE ────────────────────────────────────────────────────────────
// View state lives in the URL hash as `&`-separated key/value pairs alongside
// MapLibre's own `map=` camera key. A bare key (no `=`) is a present/absent flag
// (used for `terrain`). We write with replaceState so we never fight MapLibre's
// camera writer or spam browser history.

// readHash + setHashParam now live in modules/hash.ts — pulled out so they're
// unit-testable in happy-dom without the rest of the app's side effects.

// Preset identifiers in the hash are human-readable and mode-specific:
// elevation → ramp name slug (e.g. `cividis`), hillshade → `dynamic.<m>` /
// `raster.<m>`, contour → preset name. Coverage has no preset (key omitted).
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function rampSlug(i: number): string | null {
  const p = PRESETS[i];
  return p ? slugify(p.name) : null;
}

function rampIndexFromSlug(slug: string): number {
  return PRESETS.findIndex(p => slugify(p.name) === slug);
}

// `terrain:igor` <-> `dynamic.igor`, `raster:igor` <-> `raster.igor`,
// `analysis:slope` <-> `analysis.slope`.
function hsToken(src: HsSource): string {
  if (src.startsWith('terrain:')) return `dynamic.${src.slice(8)}`;
  if (src.startsWith('analysis:')) return `analysis.${src.slice(9)}`;
  return `raster.${src.slice(7)}`;
}

function tokenToHs(token: string): HsSource | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const kind = token.slice(0, dot),
    method = token.slice(dot + 1);
  const src =
    kind === 'dynamic'
      ? `terrain:${method}`
      : kind === 'raster'
        ? `raster:${method}`
        : kind === 'analysis'
          ? `analysis:${method}`
          : null;
  return src && (HS_SOURCES as string[]).includes(src) ? (src as HsSource) : null;
}

// Contour's internal `topo50` key surfaces in the URL as the visible label.
function ctToken(name: string): string {
  return name === 'topo50' ? 'topographic' : name;
}
function ctFromToken(token: string): string {
  return token === 'topographic' ? 'topo50' : token;
}

function currentPreset(): string | null {
  if (activeTab === 'elevation') return rampSlug(activePreset);
  if (activeTab === 'hillshade') return hsToken(hsSource);
  if (activeTab === 'contour') return ctToken(activeCtPreset);
  return null;
}

function syncPresetHash(): void {
  setHashParam('preset', currentPreset());
}

// ── MAP INIT ─────────────────────────────────────────────────────────────────

const map = new MaplibreMap({
  container: 'map',
  style: {
    version: 8,
    transition: { duration: 0, delay: 0 },
    // Use LINZ's font and sprite endpoints so the Topolite vector basemap and
    // the Labels overlay (both LINZ vector styles) can resolve their fonts and
    // icons. Means our own vector labels (contour) must pick a font hosted by
    // LINZ — Open Sans is the digital face there.
    glyphs: `https://basemaps.linz.govt.nz/v1/fonts/{fontstack}/{range}.pbf?api=${API}`,
    sprite: `https://basemaps.linz.govt.nz/v1/sprites/topographic?api=${API}`,
    sources: {
      dem: {
        type: 'raster-dem',
        tiles: [ELEV_URL],
        tileSize: 256,
        encoding: 'mapbox',
        attribution: '© Land Information New Zealand CC BY 4.0',
      },
      'dem-hillshade': {
        type: 'raster-dem',
        tiles: [ELEV_URL],
        tileSize: 256,
        encoding: 'mapbox',
        attribution: '© Land Information New Zealand CC BY 4.0',
      },
      'dem-relief': {
        type: 'raster-dem',
        tiles: [ELEV_URL],
        tileSize: 256,
        encoding: 'mapbox',
        attribution: '© Land Information New Zealand CC BY 4.0',
      },
      'hillshade-raster': {
        type: 'raster',
        tiles: [HS_URLS.standard.dem],
        tileSize: 256,
        attribution: '© Land Information New Zealand CC BY 4.0',
      },
      aerial: {
        type: 'raster',
        tiles: [AERIAL_URL],
        tileSize: 256,
        attribution: '© Land Information New Zealand CC BY 4.0',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },
      {
        id: 'color-relief',
        type: 'color-relief',
        source: 'dem-relief',
        paint: { 'color-relief-color': buildColorExpr(stops), 'color-relief-opacity': 1.0 },
      },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'dem-hillshade',
        paint: {
          'hillshade-method': 'igor',
          'hillshade-illumination-direction': 315,
          'hillshade-exaggeration': 0.5,
          'hillshade-shadow-color': 'rgba(0,0,0,0.5)',
          'hillshade-highlight-color': 'rgba(255,255,255,0.15)',
        },
      },
      {
        id: 'hillshade-raster-layer',
        type: 'raster',
        source: 'hillshade-raster',
        // visibility:'none' (not just opacity 0) so MapLibre doesn't fetch
        // hillshade-raster tiles before teardownBase runs on first mode entry.
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.0 },
      },
      {
        id: 'aerial-layer',
        type: 'raster',
        source: 'aerial',
        layout: { visibility: 'none' },
      },
    ],
  },
  center: MAP_CENTER,
  zoom: MAP_ZOOM,
  maxZoom: 20,
  minZoom: 3,
  fadeDuration: 0,
  scrollZoom: true,
  // Sync camera (zoom/lat/lng/bearing/pitch) to the URL hash as `#map=...`.
  // The string form preserves our own `&mode=…&dataset=…&terrain` keys.
  hash: 'map',
});

// ── MAP CONTROLS ──────────────────────────────────────────────────────────────

map.addControl(new NavigationControl(), 'top-left');

class Btn3DControl implements IControl {
  private _container!: HTMLDivElement;
  onAdd(): HTMLElement {
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const btn = document.createElement('button');
    btn.id = 'btn-3d';
    btn.title = 'Toggle 3D terrain';
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = '2D';
    this._container.appendChild(btn);
    return this._container;
  }
  onRemove(): void {
    this._container.parentNode?.removeChild(this._container);
  }
}

map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right');
map.addControl(new Btn3DControl(), 'top-left');

// ── MAP LOAD ──────────────────────────────────────────────────────────────────

map.on('load', () => {
  drawRamp(stops);
  renderThresholds();
  initContourControls(map);
  initCoverageControls(map);
  initExportControls(map);
  initInspectControls(map);
  initBasemap(map, { writeHash: setHashParam });
  init3DButton(map);
  prefetchCoverage();
  restoreFromHash();
});

// ── ELEVATION RAMP ────────────────────────────────────────────────────────────

function applyRamp(): void {
  if (map.getLayer('color-relief')) {
    map.setPaintProperty('color-relief', 'color-relief-color', buildColorExpr(stops));
  }
  drawRamp(stops);
}

function drawRamp(ss: ColourStop[]): void {
  paintCanvas(el<HTMLCanvasElement>('ramp-cv'), ss);
  const sorted = [...ss].sort((a, b) => a.e - b.e);
  el('ramp-lbl-lo').textContent = sorted[0]!.e + ' m';
  el('ramp-lbl-hi').textContent = sorted[sorted.length - 1]!.e + ' m';
}

function applyElevationPreset(i: number): void {
  const p = PRESETS[i];
  if (!p) return;
  setActivePreset(i);
  setStops(p.stops.map(s => ({ ...s })));
  renderPresets();
  renderStops();
  applyRamp();
  renderRampMarkers();
  syncPresetHash();
}

function renderPresets(): void {
  const container = el('presets');
  container.innerHTML = '';
  PRESETS.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = 'pre-btn' + (i === activePreset ? ' active' : '');
    btn.title = p.name;
    const sw = document.createElement('canvas');
    sw.className = 'pre-sw';
    sw.width = 120;
    sw.height = 26;
    paintCanvas(sw, p.stops);
    const lbl = Object.assign(document.createElement('span'), {
      className: 'pre-lbl',
      textContent: p.name,
    });
    btn.append(sw, lbl);
    btn.addEventListener('click', () => applyElevationPreset(i));
    container.appendChild(btn);
  });
}

function renderStops(): void {
  const list = el('stop-list');
  list.innerHTML = '';
  [...stops]
    .sort((a, b) => a.e - b.e)
    .forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'stop-row';

      const ci = document.createElement('input');
      ci.type = 'color';
      ci.value = s.c;
      ci.setAttribute('aria-label', `Stop ${i + 1} colour`);
      ci.addEventListener('input', () => {
        stops[stops.findIndex(x => x.e === s.e)]!.c = ci.value;
        applyRamp();
        renderRampMarkers();
      });

      const ei = document.createElement('input');
      ei.type = 'number';
      ei.value = String(s.e);
      ei.min = '-500';
      ei.max = '5000';
      ei.step = '10';
      ei.setAttribute('aria-label', `Stop ${i + 1} elevation`);
      ei.addEventListener('change', () => {
        stops[stops.findIndex(x => x.e === s.e)]!.e = Number(ei.value);
        applyRamp();
        renderRampMarkers();
      });

      const unit = Object.assign(document.createElement('span'), {
        className: 'stop-unit',
        textContent: 'm',
      });

      const del = document.createElement('button');
      del.className = 'stop-del';
      del.textContent = '×';
      del.disabled = stops.length <= 2;
      del.addEventListener('click', () => {
        if (stops.length > 2) {
          stops.splice(
            stops.findIndex(x => x.e === s.e),
            1,
          );
          renderStops();
          applyRamp();
          renderRampMarkers();
        }
      });

      row.append(ci, ei, unit, del);
      list.appendChild(row);
    });
}

el('ramp-bar').addEventListener('dblclick', e => {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const sorted = [...stops].sort((a, b) => a.e - b.e);
  const minE = sorted[0]!.e;
  const maxE = sorted[sorted.length - 1]!.e;
  const newE = Math.round(minE + pct * (maxE - minE));
  if (stops.some(s => s.e === newE)) return;
  stops.push({ e: newE, c: rgbToHex(colorAt(newE, stops)) });
  renderStops();
  applyRamp();
  renderRampMarkers();
});

el<HTMLButtonElement>('add-stop').addEventListener('click', () => {
  const s = [...stops].sort((a, b) => a.e - b.e);
  const ne = Math.round((s[s.length - 1]!.e + s[s.length - 2]!.e) / 2);
  stops.push({ e: ne, c: rgbToHex(colorAt(ne, stops)) });
  renderStops();
  drawRamp(stops);
  applyRamp();
  renderRampMarkers();
});

// ── RAMP HANDLES ─────────────────────────────────────────────────────────────

function renderRampMarkers(): void {
  const container = el('ramp-handles');
  container.innerHTML = '';
  const sorted = [...stops].sort((a, b) => a.e - b.e);
  const minE = sorted[0]!.e;
  const maxE = sorted[sorted.length - 1]!.e;
  const range = maxE - minE || 1;

  sorted.forEach((s, idx) => {
    const isFixed = idx === 0 || idx === sorted.length - 1;
    const handle = document.createElement('div');
    handle.className = 'ramp-handle' + (isFixed ? ' is-fixed' : '');
    handle.style.left = `${((s.e - minE) / range) * 100}%`;
    handle.style.background = s.c;
    handle.title = `${s.e} m`;

    if (!isFixed) {
      handle.addEventListener('pointerdown', e => {
        handle.setPointerCapture(e.pointerId);
        e.preventDefault();
      });

      handle.addEventListener('pointermove', e => {
        if (!handle.hasPointerCapture(e.pointerId)) return;
        const rect = container.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const cur = [...stops].sort((a, b) => a.e - b.e);
        const curMin = cur[0]!.e;
        const curMax = cur[cur.length - 1]!.e;
        const curRange = curMax - curMin || 1;
        let newE = Math.round(curMin + pct * curRange);
        const curIdx = cur.indexOf(s);
        if (curIdx > 0) newE = Math.max(cur[curIdx - 1]!.e + 1, newE);
        if (curIdx < cur.length - 1) newE = Math.min(cur[curIdx + 1]!.e - 1, newE);
        s.e = newE;
        const rowInputs = el('stop-list').querySelectorAll<HTMLInputElement>('input[type=number]');
        if (rowInputs[curIdx]) rowInputs[curIdx].value = String(newE);
        const ns = [...stops].sort((a, b) => a.e - b.e);
        handle.style.left = `${((newE - ns[0]!.e) / (ns[ns.length - 1]!.e - ns[0]!.e || 1)) * 100}%`;
        handle.title = `${newE} m`;
        applyRamp();
      });

      handle.addEventListener('pointerup', () => {
        renderStops();
        renderRampMarkers();
      });
    }

    container.appendChild(handle);
  });
}

// ── HILLSHADE CONTROLS ────────────────────────────────────────────────────────

let hsSource: HsSource = 'terrain:igor';
let terrainExag = 0.5; // tracks the terrain hillshade-exaggeration independently of raster opacity

function hexToRgba(hex: string, pct: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${(pct / 100).toFixed(2)})`;
}

function updateHsTerrainVis(type: string): void {
  const isTerrain = type === 'terrain';
  el('hs-terrain-illumination').classList.toggle('hidden', !isTerrain);
  el('hs-terrain-colours').classList.toggle('hidden', !isTerrain);
  el('sl-hs-label').textContent = isTerrain ? 'Exaggeration' : 'Opacity';
}

function syncHsSlider(type: string): void {
  const slHs = el<HTMLInputElement>('sl-hs');
  const val = type === 'terrain' ? terrainExag : 1.0;
  slHs.value = String(Math.round(val * 10));
  el('sl-hs-v').textContent = val.toFixed(1);
}

function applyHsPreset(src: HsSource): void {
  hsSource = src;
  const [type, method] = src.split(':') as [string, string];
  updateHsTerrainVis(type);
  syncHsSlider(type);
  document.querySelectorAll('.hs-pre-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`hs-pre-${type}-${method}`)?.classList.add('active');
  if (activeTab !== 'hillshade') return;

  // Each preset family owns one of three render targets. Toggle layer
  // *visibility* (not just opacity) so MapLibre stops fetching tiles for the
  // two inactive sources — opacity:0 keeps the source marked "used".
  const setVis = (id: string, on: boolean): void => {
    map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  };
  if (type === 'terrain') {
    setVis('hillshade', true);
    setVis('hillshade-raster-layer', false);
    setVis(ANALYSIS_LAYER, false);
    map.setPaintProperty('hillshade', 'hillshade-method', method);
    map.setPaintProperty('hillshade', 'hillshade-exaggeration', terrainExag);
  } else if (type === 'raster') {
    setVis('hillshade', false);
    setVis('hillshade-raster-layer', true);
    setVis(ANALYSIS_LAYER, false);
    map
      .getSource<RasterTileSource>('hillshade-raster')!
      .setTiles([HS_URLS[method as HsRaster][activeSrc]]);
    map.setPaintProperty('hillshade-raster-layer', 'raster-opacity', 1.0);
  } else {
    // analysis
    setVis('hillshade', false);
    setVis('hillshade-raster-layer', false);
    setVis(ANALYSIS_LAYER, true);
    map
      .getSource<RasterTileSource>(ANALYSIS_SOURCE)!
      .setTiles([ANALYSIS_URLS[method as HsAnalysis][activeSrc]]);
    map.setPaintProperty(ANALYSIS_LAYER, 'raster-opacity', 1.0);
  }
  syncPresetHash();
}

const HS_SOURCES: HsSource[] = [
  'terrain:standard',
  'terrain:basic',
  'terrain:igor',
  'terrain:combined',
  'terrain:multidirectional',
  'raster:standard',
  'raster:igor',
  'analysis:slope',
  'analysis:aspect',
];

HS_SOURCES.forEach(src => {
  const [type, method] = src.split(':') as [string, string];
  document
    .getElementById(`hs-pre-${type}-${method}`)
    ?.addEventListener('click', () => applyHsPreset(src));
});

// Mirror contour preset selection into the hash (the contour module owns the
// actual apply via its own button listeners).
(['standard', 'topo50', 'white', 'cyan'] as const).forEach(name => {
  document.getElementById(`ct-pre-${name}`)?.addEventListener('click', () => {
    if (activeTab === 'contour') setHashParam('preset', ctToken(name));
  });
});

el<HTMLInputElement>('sl-hs-dir').addEventListener('input', e => {
  const v = Number((e.target as HTMLInputElement).value);
  el('sl-hs-dir-v').textContent = `${v}°`;
  map.setPaintProperty('hillshade', 'hillshade-illumination-direction', v);
});

el<HTMLButtonElement>('btn-hs-map').addEventListener('click', () => {
  map.setPaintProperty('hillshade', 'hillshade-illumination-anchor', 'map');
  el<HTMLButtonElement>('btn-hs-map').classList.add('active');
  el<HTMLButtonElement>('btn-hs-viewport').classList.remove('active');
});

el<HTMLButtonElement>('btn-hs-viewport').addEventListener('click', () => {
  map.setPaintProperty('hillshade', 'hillshade-illumination-anchor', 'viewport');
  el<HTMLButtonElement>('btn-hs-viewport').classList.add('active');
  el<HTMLButtonElement>('btn-hs-map').classList.remove('active');
});

function applyShadowColor(): void {
  const hex = el<HTMLInputElement>('hs-shadow-color').value;
  const op = Number(el<HTMLInputElement>('sl-hs-shadow-op').value);
  map.setPaintProperty('hillshade', 'hillshade-shadow-color', hexToRgba(hex, op));
}

el<HTMLInputElement>('hs-shadow-color').addEventListener('input', applyShadowColor);
el<HTMLInputElement>('sl-hs-shadow-op').addEventListener('input', e => {
  el('sl-hs-shadow-op-v').textContent = `${(e.target as HTMLInputElement).value}%`;
  applyShadowColor();
});

function applyHighlightColor(): void {
  const hex = el<HTMLInputElement>('hs-highlight-color').value;
  const op = Number(el<HTMLInputElement>('sl-hs-highlight-op').value);
  map.setPaintProperty('hillshade', 'hillshade-highlight-color', hexToRgba(hex, op));
}

el<HTMLInputElement>('hs-highlight-color').addEventListener('input', applyHighlightColor);
el<HTMLInputElement>('sl-hs-highlight-op').addEventListener('input', e => {
  el('sl-hs-highlight-op-v').textContent = `${(e.target as HTMLInputElement).value}%`;
  applyHighlightColor();
});

el<HTMLInputElement>('hs-accent-color').addEventListener('input', e => {
  map.setPaintProperty('hillshade', 'hillshade-accent-color', (e.target as HTMLInputElement).value);
});

el<HTMLInputElement>('sl-hs').addEventListener('input', e => {
  const v = Number((e.target as HTMLInputElement).value);
  el('sl-hs-v').textContent = (v / 10).toFixed(1);
  const [type] = hsSource.split(':') as [string];
  // Each preset family targets its own layer — terrain hillshade's
  // exaggeration, the pre-rendered raster overlay's opacity, or the
  // slope/aspect analysis layer's opacity.
  if (type === 'terrain') {
    terrainExag = v / 10;
    map.setPaintProperty('hillshade', 'hillshade-exaggeration', terrainExag);
  } else if (type === 'raster') {
    map.setPaintProperty('hillshade-raster-layer', 'raster-opacity', v / 10);
  } else {
    map.setPaintProperty(ANALYSIS_LAYER, 'raster-opacity', v / 10);
  }
});

// ── COLOUR RAMP OPACITY ───────────────────────────────────────────────────────

el<HTMLInputElement>('sl-op').addEventListener('input', e => {
  const v = Number((e.target as HTMLInputElement).value);
  el('sl-op-v').textContent = v + '%';
  if (map.getLayer('color-relief')) {
    map.setPaintProperty('color-relief', 'color-relief-opacity', v / 100);
    // Toggle visibility too — opacity-0 alone keeps dem-relief tiles fetching.
    map.setLayoutProperty('color-relief', 'visibility', v > 0 ? 'visible' : 'none');
  }
});

// ── DIFFERENCE LAYER OPACITY ──────────────────────────────────────────────────

el<HTMLInputElement>('sl-diff-op').addEventListener('input', e => {
  const v = Number((e.target as HTMLInputElement).value);
  el('sl-diff-op-v').textContent = v + '%';
  if (map.getLayer(DIFF_LAYER)) {
    map.setPaintProperty(DIFF_LAYER, 'color-relief-opacity', v / 100);
    // Same pattern as sl-op — visibility:none stops the DIFF_SOURCE protocol
    // calls (which fetch + decode both DEM and DSM tiles per diff tile).
    map.setLayoutProperty(DIFF_LAYER, 'visibility', v > 0 ? 'visible' : 'none');
  }
});

// ── 3D TERRAIN ────────────────────────────────────────────────────────────────

let is3D = false;
// Assigned by init3DButton; lets restoreFromHash toggle 3D without a click.
let set3D: (on: boolean, animateCamera?: boolean) => void = () => {};

function init3DButton(map: MaplibreMap): void {
  const btn3d = el<HTMLButtonElement>('btn-3d');
  const exagSl = el<HTMLInputElement>('sl-exag');
  const exagWrap = el('exag-wrap');

  set3D = (on: boolean, animateCamera = true): void => {
    is3D = on;
    if (on) {
      map.setTerrain({ source: 'dem', exaggeration: Number(exagSl.value) });
      if (animateCamera) map.easeTo({ pitch: 60, duration: 800 });
      btn3d.textContent = '3D';
      btn3d.classList.add('active');
      btn3d.setAttribute('aria-pressed', 'true');
      exagWrap.classList.remove('hidden');
    } else {
      map.setTerrain(null);
      if (animateCamera) map.easeTo({ pitch: 0, duration: 800 });
      btn3d.textContent = '2D';
      btn3d.classList.remove('active');
      btn3d.setAttribute('aria-pressed', 'false');
      exagWrap.classList.add('hidden');
      exagSl.value = '1';
      el('sl-exag-v').textContent = '1.0x';
    }
    setHashParam('terrain', on ? '' : null);
  };

  btn3d.addEventListener('click', () => set3D(!is3D));

  exagSl.addEventListener('input', e => {
    const v = Number((e.target as HTMLInputElement).value);
    el('sl-exag-v').textContent = v.toFixed(1) + 'x';
    if (is3D) map.setTerrain({ source: 'dem', exaggeration: v });
  });
}

// ── DEM / DSM TOGGLE ─────────────────────────────────────────────────────────

const DESCRIPTIONS: Record<DemDsm, string> = {
  dem: 'Digital Elevation Model — bare earth, vegetation and buildings removed.',
  dsm: 'Digital Surface Model — includes vegetation, buildings and other surface features.',
};

let activeSrc: DemDsm = 'dem';

function switchSource(src: DemDsm): void {
  if (src === activeSrc) return;
  activeSrc = src;
  setContourSrc(src);
  setInspectActiveSrc(src);
  const url = src === 'dsm' ? DSM_URL : ELEV_URL;
  const setTiles = (id: string, tiles: string[]): void => {
    const s = map.getSource<RasterTileSource>(id);
    if (s) s.setTiles(tiles);
  };
  setTiles('dem', [url]);
  setTiles('dem-hillshade', [url]);
  setTiles('dem-relief', [url]);
  if (activeTab === 'coverage') {
    setTiles('hillshade-raster', [HS_URLS.igor[src]]);
  } else if (activeTab === 'hillshade' && hsSource.startsWith('raster:')) {
    const method = hsSource.split(':')[1] as HsRaster;
    setTiles('hillshade-raster', [HS_URLS[method][src]]);
  } else if (activeTab === 'hillshade' && hsSource.startsWith('analysis:')) {
    const method = hsSource.split(':')[1] as HsAnalysis;
    setTiles(ANALYSIS_SOURCE, [ANALYSIS_URLS[method][src]]);
  }
  el('dsm-desc').textContent = DESCRIPTIONS[src];
  el<HTMLButtonElement>('btn-dem').classList.toggle('active', src === 'dem');
  el<HTMLButtonElement>('btn-dsm').classList.toggle('active', src === 'dsm');
  switchCoverageSrc(src, map, activeTab === 'coverage');
  switchExportSrc(src, map, activeTab === 'export');
  setHashParam('dataset', src === 'dsm' ? 'dsm' : null);
}

el<HTMLButtonElement>('btn-dem').addEventListener('click', () => switchSource('dem'));
el<HTMLButtonElement>('btn-dsm').addEventListener('click', () => switchSource('dsm'));

// ── TAB SWITCHING ─────────────────────────────────────────────────────────────

type TabName = 'elevation' | 'contour' | 'hillshade' | 'coverage' | 'export' | 'diff' | 'inspect';
let activeTab: TabName = 'elevation';

// ── BASE LAYER REBUILD ────────────────────────────────────────────────────────
// Each tab owns a fresh set of base raster/DEM sources + layers. Switching tabs
// tears the base down completely (removeSource destroys the tile manager) and
// rebuilds it, so no stale tile/render state can leak between tabs. The `dem`
// source (3D terrain) and the contour/coverage overlay layers are left untouched.

const ATTR = '© Land Information New Zealand CC BY 4.0';
const BASE_LAYER_IDS = [
  'color-relief',
  'hillshade',
  'hillshade-raster-layer',
  'aerial-layer',
  DIFF_LAYER,
  ANALYSIS_LAYER,
];
const BASE_SOURCE_IDS = [
  'dem-hillshade',
  'dem-relief',
  'hillshade-raster',
  'aerial',
  DIFF_SOURCE,
  ANALYSIS_SOURCE,
];

function teardownBase(): void {
  for (const id of BASE_LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of BASE_SOURCE_IDS) if (map.getSource(id)) map.removeSource(id);
}

// The lowest layer that is neither the background nor a base layer — i.e. the
// first overlay (contour/coverage). Base layers are inserted before it so they
// always render beneath the overlays.
function firstOverlayLayerId(): string | undefined {
  for (const l of map.getStyle().layers) {
    if (l.id === 'bg' || BASE_LAYER_IDS.includes(l.id)) continue;
    if (isBasemapOrLabelLayer(l.id)) continue;
    return l.id;
  }
  return undefined;
}

function addBaseLayer(layer: Parameters<typeof map.addLayer>[0]): void {
  map.addLayer(layer, firstOverlayLayerId());
}

type SourceSpec = Parameters<typeof map.addSource>[1];

function demSpec(): SourceSpec {
  return {
    type: 'raster-dem',
    tiles: [activeSrc === 'dsm' ? DSM_URL : ELEV_URL],
    tileSize: 256,
    encoding: 'mapbox',
    attribution: ATTR,
  };
}
function rasterSpec(url: string): SourceSpec {
  return { type: 'raster', tiles: [url], tileSize: 256, attribution: ATTR };
}

function hillshadePaint(method: HsMethod, exaggeration: number): Record<string, unknown> {
  return {
    'hillshade-method': method,
    'hillshade-illumination-direction': Number(el<HTMLInputElement>('sl-hs-dir').value),
    'hillshade-illumination-anchor': el<HTMLButtonElement>('btn-hs-viewport').classList.contains(
      'active',
    )
      ? 'viewport'
      : 'map',
    'hillshade-exaggeration': exaggeration,
    'hillshade-shadow-color': hexToRgba(
      el<HTMLInputElement>('hs-shadow-color').value,
      Number(el<HTMLInputElement>('sl-hs-shadow-op').value),
    ),
    'hillshade-highlight-color': hexToRgba(
      el<HTMLInputElement>('hs-highlight-color').value,
      Number(el<HTMLInputElement>('sl-hs-highlight-op').value),
    ),
    'hillshade-accent-color': el<HTMLInputElement>('hs-accent-color').value,
  };
}

function buildElevationBase(): void {
  // Colour Ramp now sits on top of whatever the user picks in the basemap
  // switcher — no built-in hillshade backdrop.
  map.addSource('dem-relief', demSpec());
  const opPct = Number(el<HTMLInputElement>('sl-op').value);
  addBaseLayer({
    id: 'color-relief',
    type: 'color-relief',
    source: 'dem-relief',
    layout: { visibility: opPct > 0 ? 'visible' : 'none' },
    paint: { 'color-relief-color': buildColorExpr(stops), 'color-relief-opacity': opPct / 100 },
  });
}

function buildHillshadeBase(): void {
  map.addSource('dem-hillshade', demSpec());
  map.addSource('hillshade-raster', rasterSpec(HS_URLS.standard[activeSrc]));
  map.addSource(ANALYSIS_SOURCE, rasterSpec(ANALYSIS_URLS.slope[activeSrc]));
  // All three start hidden — applyHsPreset turns exactly one on. This stops
  // MapLibre from fetching tiles for the two inactive sources (the tile
  // manager only marks a source "used" if a layer references it AND that
  // layer's visibility is not 'none' — opacity:0 alone doesn't stop fetches).
  addBaseLayer({
    id: 'hillshade',
    type: 'hillshade',
    source: 'dem-hillshade',
    layout: { visibility: 'none' },
    paint: hillshadePaint('igor', 0),
  });
  addBaseLayer({
    id: 'hillshade-raster-layer',
    type: 'raster',
    source: 'hillshade-raster',
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0 },
  });
  addBaseLayer({
    id: ANALYSIS_LAYER,
    type: 'raster',
    source: ANALYSIS_SOURCE,
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0 },
  });
}

function enterElevationMode(): void {
  teardownBase();
  buildElevationBase();
}

// ── COVERAGE MODE ─────────────────────────────────────────────────────────────
// The backdrop now comes from the global basemap switcher; coverage just shows
// its own data layers on top.
function enterCoverageMode(): void {
  teardownBase();
  showCoverageLayers(map);
}

function leaveCoverageMode(): void {
  hideCoverageLayers(map);
}

// ── EXPORT MODE ───────────────────────────────────────────────────────────────

function enterExportMode(): void {
  teardownBase();
  showExportLayers(map);
}

function leaveExportMode(): void {
  hideExportLayers(map);
}

// ── DIFFERENCE MODE (DSM − DEM) ───────────────────────────────────────────────

function buildDiffBase(): void {
  map.addSource('dem-hillshade', demSpec());
  map.addSource(DIFF_SOURCE, {
    type: 'raster-dem',
    tiles: [DIFF_URL],
    tileSize: 256,
    encoding: 'mapbox',
    attribution: ATTR,
  });
  const opPct = Number(el<HTMLInputElement>('sl-diff-op').value);
  addBaseLayer({
    id: DIFF_LAYER,
    type: 'color-relief',
    source: DIFF_SOURCE,
    layout: { visibility: opPct > 0 ? 'visible' : 'none' },
    paint: { 'color-relief-color': buildDiffColorExpr(), 'color-relief-opacity': opPct / 100 },
  } as Parameters<typeof map.addLayer>[0]);
  addBaseLayer({
    id: 'hillshade',
    type: 'hillshade',
    source: 'dem-hillshade',
    paint: hillshadePaint('igor', 0.5),
  });
}

function enterDiffMode(): void {
  teardownBase();
  buildDiffBase();
  updateDiffZoomHint();
}

// LINZ DSM tiles aren't published below about z 7.5, so the diff layer is
// effectively blank there. Surface a hint in the panel when that's the case.
const DIFF_MIN_ZOOM = 7.5;
function updateDiffZoomHint(): void {
  const hint = document.getElementById('diff-zoom-hint');
  if (!hint) return;
  const show = activeTab === 'diff' && map.getZoom() < DIFF_MIN_ZOOM;
  hint.classList.toggle('hidden', !show);
}
map.on('zoom', updateDiffZoomHint);

// ── INSPECT MODE ──────────────────────────────────────────────────────────────

function enterInspectMode(): void {
  teardownBase();
  attachInspect(map);
}

function leaveInspectMode(): void {
  detachInspect(map);
}

// ── CONTOUR MODE ──────────────────────────────────────────────────────────────
// The backdrop is now owned by the global basemap switcher, so contour mode
// just tears down whatever base was up and adds its own contour vector layers
// on top. Defer the contour add until the basemap teardown has settled —
// addContourLayers silently fails to request its first tiles otherwise.
function enterContourMode(): void {
  teardownBase();
  // map.once returns a Promise overload in MapLibre 5 even when given a
  // listener — fire-and-forget is the intent here, so explicitly `void` it.
  void map.once('idle', () => {
    if (activeTab === 'contour') addContourLayers();
  });
}

let hsPreviewed = false;

function enterHillshadeMode(): void {
  teardownBase();
  buildHillshadeBase();
  applyHsPreset(hsSource);
  if (!hsPreviewed) {
    hsPreviewed = true;
    initTerrainPreviews().catch(console.warn);
  }
}

// Sentence-case titles shown in the panel header — driven by the active rail disc.
const TAB_TITLES: Record<TabName, string> = {
  elevation: 'Colour ramp',
  hillshade: 'Hillshade',
  contour: 'Contours',
  diff: 'Difference',
  coverage: 'Coverage',
  inspect: 'Inspect',
  export: 'Export',
};

function switchTab(next: TabName): void {
  const prev = activeTab;
  if (prev === next) return;

  document.querySelectorAll<HTMLElement>('.rail-disc').forEach(t => {
    const on = t.dataset['tab'] === next;
    t.classList.toggle('active', on);
    t.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('.pan-body').forEach(b => b.classList.add('hidden'));
  document.getElementById(`tab-${next}`)?.classList.remove('hidden');
  const title = document.getElementById('pnl-title');
  if (title) title.textContent = TAB_TITLES[next];
  activeTab = next;
  setHashParam('mode', next === 'elevation' ? null : next);
  syncPresetHash();
  updateDiffZoomHint();
  // Difference visualises DSM − DEM together, so the dataset switcher is
  // meaningless there. Hide #pan-global on that mode only.
  document.getElementById('pan-global')?.classList.toggle('hidden', next === 'diff');

  const enter = (): void => {
    if (prev === 'coverage') leaveCoverageMode();
    if (prev === 'contour') removeContourLayers();
    if (prev === 'export') leaveExportMode();
    if (prev === 'inspect') leaveInspectMode();

    if (next === 'elevation') enterElevationMode();
    else if (next === 'hillshade') enterHillshadeMode();
    else if (next === 'contour') enterContourMode();
    else if (next === 'coverage') {
      enterCoverageMode();
      loadCoverage(map);
    } else if (next === 'export') {
      enterExportMode();
      loadExport(map, activeSrc);
    } else if (next === 'diff') enterDiffMode();
    else if (next === 'inspect') enterInspectMode();
    // The freshly-added mode-base / overlay layers go on top of bg; if the
    // Labels overlay is on, re-stack it so it stays the topmost group.
    moveLabelsToTop();
  };
  // `isStyleLoaded` instead of `loaded` — the latter is false during any tile
  // fetch, and `map.once('load', ...)` would queue against a one-shot event
  // that's already fired, leaving the tab switch silently dead.
  if (map.isStyleLoaded()) enter();
  else void map.once('style.load', enter);
}

document.querySelectorAll<HTMLButtonElement>('.rail-disc').forEach(disc => {
  disc.addEventListener('click', () => {
    switchTab(disc.dataset['tab'] as TabName);
    // On mobile, the panel collapses to a rail-only strip — tapping a disc
    // should re-expand the panel to show that mode's content.
    if (panelEl.classList.contains('collapsed')) setPanelCollapsed(false);
  });
});

// Apply view state encoded in the URL hash. Camera is restored automatically by
// MapLibre's `hash: 'map'`; here we apply dataset, then mode (so the rebuilt base
// uses the right source), then terrain (without animating the restored camera).
function restoreFromHash(): void {
  const p = readHash();
  if (p['dataset'] === 'dsm') switchSource('dsm');

  // Basemap + Labels overlay (driven by the on-map basemap control).
  const bm = p['basemap'];
  if (
    bm === 'none' ||
    bm === 'aerial' ||
    bm === 'hillshade-dem' ||
    bm === 'hillshade-dsm' ||
    bm === 'topolite'
  ) {
    setBasemap(bm);
  }
  if (p['overlay'] === 'labels') setLabelsEnabled(true);
  const blend = p['blend'];
  if (blend === 'dem' || blend === 'dsm') setHillshadeBlend(blend);

  const mode = p['mode'];
  if (
    mode === 'hillshade' ||
    mode === 'contour' ||
    mode === 'coverage' ||
    mode === 'export' ||
    mode === 'diff' ||
    mode === 'inspect'
  )
    switchTab(mode);

  const preset = p['preset'];
  if (preset) {
    if (activeTab === 'elevation') {
      const i = rampIndexFromSlug(preset);
      if (i >= 0) applyElevationPreset(i);
    } else if (activeTab === 'hillshade') {
      const src = tokenToHs(preset);
      if (src) applyHsPreset(src);
    } else if (activeTab === 'contour') applyCtPreset(ctFromToken(preset));
  }
  // Reconcile the hash with the final applied state (applyCtPreset doesn't write it).
  syncPresetHash();

  if ('terrain' in p) set3D(true, false);
}

// ── PANEL TOGGLE ─────────────────────────────────────────────────────────────

const panelEl = el('panel');
const mapWrapEl = el('map-wrap');
const panelToggleEl = el<HTMLButtonElement>('panel-toggle');

function setPanelCollapsed(collapsed: boolean): void {
  panelEl.classList.toggle('collapsed', collapsed);
  mapWrapEl.classList.toggle('panel-hidden', collapsed);
  panelToggleEl.setAttribute('aria-label', collapsed ? 'Show panel' : 'Hide panel');
  panelToggleEl.setAttribute('aria-expanded', String(!collapsed));
}

panelToggleEl.addEventListener('click', () =>
  setPanelCollapsed(!panelEl.classList.contains('collapsed')),
);
// Mobile X close button — same effect as the desktop chevron's "close" state.
el<HTMLButtonElement>('pnl-close').addEventListener('click', () => setPanelCollapsed(true));
panelEl.addEventListener('transitionend', () => map.resize());

if (window.innerWidth < 768) setPanelCollapsed(true);

// ── INIT ──────────────────────────────────────────────────────────────────────

renderPresets();
renderStops();
drawRamp(stops);
renderRampMarkers();
