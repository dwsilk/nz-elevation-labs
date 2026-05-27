/**
 * main.ts — application entry point
 * Initialises the MapLibre map, wires all panel tabs, and coordinates
 * between the elevation, contour, and coverage modules.
 */
import maplibregl, { Map as MaplibreMap, NavigationControl, ScaleControl, RasterTileSource } from 'maplibre-gl';
import {
  API, ELEV_URL, DSM_URL, HS_URLS, AERIAL_URL,
  MAP_CENTER, MAP_ZOOM,
  type DemDsm, type HsSource, type HsRaster, type HsMethod,
} from './modules/config.js';
import {
  PRESETS, stops, activePreset, setStops, setActivePreset,
  paintCanvas, colorAt, buildColorExpr, rgbToHex,
  type ColourStop,
} from './modules/elevation.js';
import {
  initContourControls, addContourLayers, removeContourLayers, renderThresholds,
  setActiveSrc as setContourSrc,
} from './modules/contour.js';
import {
  loadCoverage, prefetchCoverage, initCoverageControls, showCoverageLayers, hideCoverageLayers, switchCoverageSrc,
} from './modules/coverage.js';
import { initTerrainPreviews } from './modules/hs-thumbs.js';

import './styles/main.css';
import './styles/panel.css';
import './styles/coverage.css';

// ── HELPERS ───────────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Element #${id} not found`);
  return e as T;
}

// ── MAP INIT ─────────────────────────────────────────────────────────────────

const map = new MaplibreMap({
  container: 'map',
  style: {
    version: 8,
    transition: { duration: 0, delay: 0 },
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
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
        id: 'color-relief', type: 'color-relief', source: 'dem-relief',
        paint: { 'color-relief-color': buildColorExpr(stops), 'color-relief-opacity': 1.0 },
      },
      {
        id: 'hillshade', type: 'hillshade', source: 'dem-hillshade',
        paint: {
          'hillshade-method': 'igor',
          'hillshade-illumination-direction': 315,
          'hillshade-exaggeration': 0.5,
          'hillshade-shadow-color': 'rgba(0,0,0,0.5)',
          'hillshade-highlight-color': 'rgba(255,255,255,0.15)',
        },
      },
      {
        id: 'hillshade-raster-layer', type: 'raster', source: 'hillshade-raster',
        paint: { 'raster-opacity': 0.0 },
      },
      {
        id: 'aerial-layer', type: 'raster', source: 'aerial',
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
});

// ── MAP CONTROLS ──────────────────────────────────────────────────────────────

map.addControl(new NavigationControl(), 'top-left');

class Btn3DControl implements maplibregl.IControl {
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
  onRemove(): void { this._container.parentNode?.removeChild(this._container); }
}

map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
map.addControl(new Btn3DControl(), 'top-left');

// ── MAP LOAD ──────────────────────────────────────────────────────────────────

map.on('load', () => {
  drawRamp(stops);
  renderThresholds();
  initContourControls(map);
  initCoverageControls(map);
  init3DButton(map);
  prefetchCoverage();
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

function renderPresets(): void {
  const container = el('presets');
  container.innerHTML = '';
  PRESETS.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = 'pre-btn' + (i === activePreset ? ' active' : '');
    btn.title = p.name;
    const sw = document.createElement('canvas');
    sw.className = 'pre-sw'; sw.width = 120; sw.height = 26;
    paintCanvas(sw, p.stops);
    const lbl = Object.assign(document.createElement('span'), { className: 'pre-lbl', textContent: p.name });
    btn.append(sw, lbl);
    btn.addEventListener('click', () => {
      setActivePreset(i);
      setStops(p.stops.map(s => ({ ...s })));
      renderPresets(); renderStops(); applyRamp(); renderRampMarkers();
    });
    container.appendChild(btn);
  });
}

function renderStops(): void {
  const list = el('stop-list');
  list.innerHTML = '';
  [...stops].sort((a, b) => a.e - b.e).forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'stop-row';

    const ci = document.createElement('input');
    ci.type = 'color'; ci.value = s.c;
    ci.setAttribute('aria-label', `Stop ${i + 1} colour`);
    ci.addEventListener('input', () => {
      stops[stops.findIndex(x => x.e === s.e)]!.c = ci.value;
      applyRamp(); renderRampMarkers();
    });

    const ei = document.createElement('input');
    ei.type = 'number'; ei.value = String(s.e); ei.min = '-500'; ei.max = '5000'; ei.step = '10';
    ei.setAttribute('aria-label', `Stop ${i + 1} elevation`);
    ei.addEventListener('change', () => {
      stops[stops.findIndex(x => x.e === s.e)]!.e = Number(ei.value);
      applyRamp(); renderRampMarkers();
    });

    const unit = Object.assign(document.createElement('span'), { className: 'stop-unit', textContent: 'm' });

    const del = document.createElement('button');
    del.className = 'stop-del'; del.textContent = '×';
    del.disabled = stops.length <= 2;
    del.addEventListener('click', () => {
      if (stops.length > 2) {
        stops.splice(stops.findIndex(x => x.e === s.e), 1);
        renderStops(); applyRamp(); renderRampMarkers();
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
  renderStops(); applyRamp(); renderRampMarkers();
});

el<HTMLButtonElement>('add-stop').addEventListener('click', () => {
  const s = [...stops].sort((a, b) => a.e - b.e);
  const ne = Math.round((s[s.length - 1]!.e + s[s.length - 2]!.e) / 2);
  stops.push({ e: ne, c: rgbToHex(colorAt(ne, stops)) });
  renderStops(); drawRamp(stops); applyRamp(); renderRampMarkers();
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
    handle.style.left = `${(s.e - minE) / range * 100}%`;
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
        if (rowInputs[curIdx]) rowInputs[curIdx]!.value = String(newE);
        const ns = [...stops].sort((a, b) => a.e - b.e);
        handle.style.left = `${(newE - ns[0]!.e) / (ns[ns.length - 1]!.e - ns[0]!.e || 1) * 100}%`;
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

let elevHsEnabled = true;
let hsSource: HsSource = 'terrain:igor';
let terrainExag = 0.5; // tracks the terrain hillshade-exaggeration independently of raster opacity

function hexToRgba(hex: string, pct: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${(pct / 100).toFixed(2)})`;
}

function updateHsTerrainVis(isTerrainSource: boolean): void {
  el('hs-terrain-illumination').classList.toggle('hidden', !isTerrainSource);
  el('hs-terrain-colours').classList.toggle('hidden', !isTerrainSource);
  el('sl-hs-label').textContent = isTerrainSource ? 'Exaggeration' : 'Opacity';
}

function syncHsSlider(type: string): void {
  const slHs = el<HTMLInputElement>('sl-hs');
  const val  = type === 'terrain' ? terrainExag : 1.0;
  slHs.value = String(Math.round(val * 10));
  el('sl-hs-v').textContent = val.toFixed(1);
}

function applyHsPreset(src: HsSource): void {
  hsSource = src;
  const [type, method] = src.split(':') as [string, string];
  updateHsTerrainVis(type === 'terrain');
  syncHsSlider(type);
  document.querySelectorAll('.hs-pre-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`hs-pre-${type}-${method}`)?.classList.add('active');
  if (activeTab !== 'hillshade') return;
  if (type === 'terrain') {
    map.setPaintProperty('hillshade', 'hillshade-method', method as HsMethod);
    map.setPaintProperty('hillshade', 'hillshade-exaggeration', terrainExag);
    map.setPaintProperty('hillshade-raster-layer', 'raster-opacity', 0);
  } else {
    (map.getSource('hillshade-raster') as RasterTileSource).setTiles([HS_URLS[method as HsRaster][activeSrc]]);
    map.setPaintProperty('hillshade', 'hillshade-exaggeration', 0);
    map.setPaintProperty('hillshade-raster-layer', 'raster-opacity', 1.0);
  }
}

(['terrain:standard', 'terrain:basic', 'terrain:igor', 'terrain:combined', 'terrain:multidirectional',
  'raster:standard', 'raster:igor'] as HsSource[]).forEach(src => {
  const [type, method] = src.split(':') as [string, string];
  document.getElementById(`hs-pre-${type}-${method}`)
    ?.addEventListener('click', () => applyHsPreset(src));
});

el<HTMLInputElement>('tog-elev-hs').addEventListener('change', e => {
  elevHsEnabled = (e.target as HTMLInputElement).checked;
  if (activeTab === 'elevation') {
    map.setPaintProperty('hillshade', 'hillshade-exaggeration', elevHsEnabled ? 0.5 : 0);
  }
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
  if (type === 'terrain') {
    terrainExag = v / 10;
    map.setPaintProperty('hillshade', 'hillshade-exaggeration', terrainExag);
  } else {
    map.setPaintProperty('hillshade-raster-layer', 'raster-opacity', v / 10);
  }
});

// ── COLOUR RAMP OPACITY ───────────────────────────────────────────────────────

el<HTMLInputElement>('sl-op').addEventListener('input', e => {
  const v = Number((e.target as HTMLInputElement).value);
  el('sl-op-v').textContent = v + '%';
  if (map.getLayer('color-relief')) {
    map.setPaintProperty('color-relief', 'color-relief-opacity', v / 100);
  }
});

// ── 3D TERRAIN ────────────────────────────────────────────────────────────────

let is3D = false;

function init3DButton(map: MaplibreMap): void {
  const btn3d    = el<HTMLButtonElement>('btn-3d');
  const exagSl   = el<HTMLInputElement>('sl-exag');
  const exagWrap = el('exag-wrap');

  btn3d.addEventListener('click', () => {
    is3D = !is3D;
    if (is3D) {
      map.setTerrain({ source: 'dem', exaggeration: Number(exagSl.value) });
      map.easeTo({ pitch: 60, duration: 800 });
      btn3d.textContent = '3D';
      btn3d.classList.add('active');
      btn3d.setAttribute('aria-pressed', 'true');
      exagWrap.classList.remove('hidden');
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, duration: 800 });
      btn3d.textContent = '2D';
      btn3d.classList.remove('active');
      btn3d.setAttribute('aria-pressed', 'false');
      exagWrap.classList.add('hidden');
      exagSl.value = '1';
      el('sl-exag-v').textContent = '1.0x';
    }
  });

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
  const url = src === 'dsm' ? DSM_URL : ELEV_URL;
  const setTiles = (id: string, tiles: string[]): void => {
    const s = map.getSource(id) as RasterTileSource | undefined;
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
  }
  el('dsm-desc').textContent = DESCRIPTIONS[src];
  el<HTMLButtonElement>('btn-dem').classList.toggle('active', src === 'dem');
  el<HTMLButtonElement>('btn-dsm').classList.toggle('active', src === 'dsm');
  switchCoverageSrc(src, map, activeTab === 'coverage');
}

el<HTMLButtonElement>('btn-dem').addEventListener('click', () => switchSource('dem'));
el<HTMLButtonElement>('btn-dsm').addEventListener('click', () => switchSource('dsm'));

// ── TAB SWITCHING ─────────────────────────────────────────────────────────────

type TabName = 'elevation' | 'contour' | 'hillshade' | 'coverage';
let activeTab: TabName = 'elevation';

// ── BASE LAYER REBUILD ────────────────────────────────────────────────────────
// Each tab owns a fresh set of base raster/DEM sources + layers. Switching tabs
// tears the base down completely (removeSource destroys the tile manager) and
// rebuilds it, so no stale tile/render state can leak between tabs. The `dem`
// source (3D terrain) and the contour/coverage overlay layers are left untouched.

const ATTR = '© Land Information New Zealand CC BY 4.0';
const BASE_LAYER_IDS = ['color-relief', 'hillshade', 'hillshade-raster-layer', 'aerial-layer'];
const BASE_SOURCE_IDS = ['dem-hillshade', 'dem-relief', 'hillshade-raster', 'aerial'];

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
    return l.id;
  }
  return undefined;
}

function addBaseLayer(layer: Parameters<typeof map.addLayer>[0]): void {
  map.addLayer(layer, firstOverlayLayerId());
}

type SourceSpec = Parameters<typeof map.addSource>[1];

function demSpec(): SourceSpec {
  return { type: 'raster-dem', tiles: [activeSrc === 'dsm' ? DSM_URL : ELEV_URL], tileSize: 256, encoding: 'mapbox', attribution: ATTR } as SourceSpec;
}
function rasterSpec(url: string): SourceSpec {
  return { type: 'raster', tiles: [url], tileSize: 256, attribution: ATTR } as SourceSpec;
}

function hillshadePaint(method: HsMethod, exaggeration: number): Record<string, unknown> {
  return {
    'hillshade-method': method,
    'hillshade-illumination-direction': Number(el<HTMLInputElement>('sl-hs-dir').value),
    'hillshade-illumination-anchor': el<HTMLButtonElement>('btn-hs-viewport').classList.contains('active') ? 'viewport' : 'map',
    'hillshade-exaggeration': exaggeration,
    'hillshade-shadow-color': hexToRgba(el<HTMLInputElement>('hs-shadow-color').value, Number(el<HTMLInputElement>('sl-hs-shadow-op').value)),
    'hillshade-highlight-color': hexToRgba(el<HTMLInputElement>('hs-highlight-color').value, Number(el<HTMLInputElement>('sl-hs-highlight-op').value)),
    'hillshade-accent-color': el<HTMLInputElement>('hs-accent-color').value,
  };
}

function buildElevationBase(): void {
  map.addSource('dem-relief', demSpec());
  map.addSource('dem-hillshade', demSpec());
  const opPct = Number(el<HTMLInputElement>('sl-op').value);
  addBaseLayer({
    id: 'color-relief', type: 'color-relief', source: 'dem-relief',
    paint: { 'color-relief-color': buildColorExpr(stops), 'color-relief-opacity': opPct / 100 },
  } as Parameters<typeof map.addLayer>[0]);
  addBaseLayer({
    id: 'hillshade', type: 'hillshade', source: 'dem-hillshade',
    paint: hillshadePaint('igor', elevHsEnabled ? 0.5 : 0),
  } as Parameters<typeof map.addLayer>[0]);
}

function buildHillshadeBase(): void {
  map.addSource('dem-hillshade', demSpec());
  map.addSource('hillshade-raster', rasterSpec(HS_URLS.standard[activeSrc]));
  addBaseLayer({
    id: 'hillshade', type: 'hillshade', source: 'dem-hillshade',
    paint: hillshadePaint('igor', 0),
  } as Parameters<typeof map.addLayer>[0]);
  addBaseLayer({
    id: 'hillshade-raster-layer', type: 'raster', source: 'hillshade-raster',
    paint: { 'raster-opacity': 0 },
  } as Parameters<typeof map.addLayer>[0]);
}

function buildContourBase(): void {
  map.addSource('hillshade-raster', rasterSpec(HS_URLS.igor[activeSrc]));
  map.addSource('aerial', rasterSpec(AERIAL_URL));
  addBaseLayer({
    id: 'hillshade-raster-layer', type: 'raster', source: 'hillshade-raster',
    paint: { 'raster-opacity': 1 },
  } as Parameters<typeof map.addLayer>[0]);
  addBaseLayer({
    id: 'aerial-layer', type: 'raster', source: 'aerial',
    layout: { visibility: 'none' },
  } as Parameters<typeof map.addLayer>[0]);
}

function buildCoverageBase(): void {
  map.addSource('hillshade-raster', rasterSpec(HS_URLS.igor[activeSrc]));
  addBaseLayer({
    id: 'hillshade-raster-layer', type: 'raster', source: 'hillshade-raster',
    paint: { 'raster-opacity': 1 },
  } as Parameters<typeof map.addLayer>[0]);
}

function enterElevationMode(): void {
  teardownBase();
  buildElevationBase();
}

// ── COVERAGE MODE ─────────────────────────────────────────────────────────────

function enterCoverageMode(): void {
  teardownBase();
  buildCoverageBase();
  showCoverageLayers(map);
}

function leaveCoverageMode(): void {
  hideCoverageLayers(map);
}

// ── CONTOUR MODE ──────────────────────────────────────────────────────────────

type ContourBackdrop = 'igor-dem' | 'igor-dsm' | 'aerial';
let contourBackdrop: ContourBackdrop = 'igor-dem';

function applyContourBackdrop(bd: ContourBackdrop): void {
  contourBackdrop = bd;
  if (bd === 'aerial') {
    map.setPaintProperty('hillshade-raster-layer', 'raster-opacity', 0);
    map.setLayoutProperty('aerial-layer', 'visibility', 'visible');
  } else {
    (map.getSource('hillshade-raster') as RasterTileSource)
      .setTiles([HS_URLS.igor[bd === 'igor-dsm' ? 'dsm' : 'dem']]);
    map.setPaintProperty('hillshade-raster-layer', 'raster-opacity', 1.0);
    map.setLayoutProperty('aerial-layer', 'visibility', 'none');
  }
}

function enterContourMode(): void {
  teardownBase();
  buildContourBase();
  applyContourBackdrop(contourBackdrop);
  addContourLayers();
}

let hsPreviewed = false;

function enterHillshadeMode(): void {
  teardownBase();
  buildHillshadeBase();
  applyHsPreset(hsSource);
  if (!hsPreviewed) { hsPreviewed = true; initTerrainPreviews().catch(console.warn); }
}

el<HTMLSelectElement>('sel-ct-backdrop').addEventListener('change', e => {
  const bd = (e.target as HTMLSelectElement).value as ContourBackdrop;
  contourBackdrop = bd;
  if (activeTab === 'contour') applyContourBackdrop(bd);
});

document.querySelectorAll<HTMLButtonElement>('.pan-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const prev = activeTab;
    const next = tab.dataset['tab'] as TabName;
    if (prev === next) return;

    document.querySelectorAll('.pan-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.pan-body').forEach(b => b.classList.add('hidden'));
    tab.classList.add('active');
    document.getElementById(`tab-${next}`)?.classList.remove('hidden');
    activeTab = next;

    const enter = (): void => {
      if (prev === 'coverage') leaveCoverageMode();
      if (prev === 'contour') removeContourLayers();

      if (next === 'elevation') enterElevationMode();
      else if (next === 'hillshade') enterHillshadeMode();
      else if (next === 'contour') enterContourMode();
      else if (next === 'coverage') { enterCoverageMode(); loadCoverage(map); }
    };
    if (map.loaded()) enter();
    else map.once('load', enter);
  });
});

// ── PANEL TOGGLE ─────────────────────────────────────────────────────────────

const panelEl       = el('panel');
const mapWrapEl     = el('map-wrap');
const panelToggleEl = el<HTMLButtonElement>('panel-toggle');

function setPanelCollapsed(collapsed: boolean): void {
  panelEl.classList.toggle('collapsed', collapsed);
  mapWrapEl.classList.toggle('panel-hidden', collapsed);
  panelToggleEl.setAttribute('aria-label', collapsed ? 'Show panel' : 'Hide panel');
  panelToggleEl.setAttribute('aria-expanded', String(!collapsed));
}

panelToggleEl.addEventListener('click', () => setPanelCollapsed(!panelEl.classList.contains('collapsed')));
panelEl.addEventListener('transitionend', () => map.resize());

if (window.innerWidth < 768) setPanelCollapsed(true);

// ── INIT ──────────────────────────────────────────────────────────────────────

renderPresets();
renderStops();
drawRamp(stops);
renderRampMarkers();
