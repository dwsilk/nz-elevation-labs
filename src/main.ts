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
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 1.0 },
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

class LegendControl implements maplibregl.IControl {
  private _wrap!: HTMLDivElement;
  onAdd(): HTMLElement {
    this._wrap = document.createElement('div');
    this._wrap.className = 'maplibregl-ctrl';
    this._wrap.appendChild(el('legend'));
    return this._wrap;
  }
  onRemove(): void { this._wrap.parentNode?.removeChild(this._wrap); }
}

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

map.addControl(new LegendControl(), 'bottom-left');
map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
map.addControl(new Btn3DControl(), 'top-left');

// ── MAP LOAD ──────────────────────────────────────────────────────────────────

map.on('load', () => {
  updateLegend(stops);
  drawRamp(stops);
  renderThresholds();
  initContourControls(map);
  initCoverageControls(map);
  init3DButton(map);
  prefetchCoverage();
});

// ── ELEVATION RAMP ────────────────────────────────────────────────────────────

function applyRamp(): void {
  map.setPaintProperty('color-relief', 'color-relief-color', buildColorExpr(stops));
  updateLegend(stops);
  drawRamp(stops);
}

function updateLegend(ss: ColourStop[]): void {
  paintCanvas(el<HTMLCanvasElement>('leg-bar'), ss);
  const s = [...ss].sort((a, b) => a.e - b.e);
  el('leg-lo').textContent = s[0]!.e + ' m';
  el('leg-hi').textContent = s[s.length - 1]!.e + ' m';
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
    map.setLayoutProperty('hillshade', 'visibility', 'visible');
    map.setLayoutProperty('hillshade-raster-layer', 'visibility', 'none');
  } else {
    (map.getSource('hillshade-raster') as RasterTileSource).setTiles([HS_URLS[method as HsRaster][activeSrc]]);
    map.setPaintProperty('hillshade-raster-layer', 'raster-opacity', 1.0);
    map.setLayoutProperty('hillshade', 'visibility', 'none');
    map.setLayoutProperty('hillshade-raster-layer', 'visibility', 'visible');
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
    map.setLayoutProperty('hillshade', 'visibility', elevHsEnabled ? 'visible' : 'none');
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
  map.setLayoutProperty('color-relief', 'visibility', v === 0 ? 'none' : 'visible');
  if (v > 0) map.setPaintProperty('color-relief', 'color-relief-opacity', v / 100);
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
  (map.getSource('dem') as RasterTileSource).setTiles([url]);
  (map.getSource('dem-hillshade') as RasterTileSource).setTiles([url]);
  (map.getSource('dem-relief') as RasterTileSource).setTiles([url]);
  if (activeTab === 'coverage') {
    (map.getSource('hillshade-raster') as RasterTileSource).setTiles([HS_URLS.igor[src]]);
  } else if (activeTab === 'hillshade' && hsSource.startsWith('raster:')) {
    const method = hsSource.split(':')[1] as HsRaster;
    (map.getSource('hillshade-raster') as RasterTileSource).setTiles([HS_URLS[method][src]]);
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

function enterElevationMode(): void {
  map.setLayoutProperty('color-relief', 'visibility', 'visible');
  map.setPaintProperty('hillshade', 'hillshade-method', 'igor');
  map.setLayoutProperty('hillshade', 'visibility', elevHsEnabled ? 'visible' : 'none');
  map.setLayoutProperty('hillshade-raster-layer', 'visibility', 'none');
  map.setLayoutProperty('aerial-layer', 'visibility', 'none');
}

// ── COVERAGE MODE ─────────────────────────────────────────────────────────────

function enterCoverageMode(): void {
  map.setLayoutProperty('color-relief', 'visibility', 'none');
  (map.getSource('hillshade-raster') as RasterTileSource).setTiles([HS_URLS.igor[activeSrc]]);
  map.setLayoutProperty('hillshade', 'visibility', 'none');
  map.setLayoutProperty('hillshade-raster-layer', 'visibility', 'visible');
  map.setLayoutProperty('aerial-layer', 'visibility', 'none');
  el('leg-elev').classList.add('hidden');
  el('leg-cov').classList.remove('hidden');
  showCoverageLayers(map);
}

function leaveCoverageMode(): void {
  hideCoverageLayers(map);
  el('leg-cov').classList.add('hidden');
  el('leg-elev').classList.remove('hidden');
}

// ── CONTOUR MODE ──────────────────────────────────────────────────────────────

type ContourBackdrop = 'igor-dem' | 'igor-dsm' | 'aerial';
let contourBackdrop: ContourBackdrop = 'igor-dem';

function applyContourBackdrop(bd: ContourBackdrop): void {
  contourBackdrop = bd;
  if (bd === 'aerial') {
    map.setLayoutProperty('hillshade-raster-layer', 'visibility', 'none');
    map.setLayoutProperty('aerial-layer', 'visibility', 'visible');
  } else {
    (map.getSource('hillshade-raster') as RasterTileSource)
      .setTiles([HS_URLS.igor[bd === 'igor-dsm' ? 'dsm' : 'dem']]);
    map.setLayoutProperty('hillshade-raster-layer', 'visibility', 'visible');
    map.setLayoutProperty('aerial-layer', 'visibility', 'none');
  }
}

function enterContourMode(): void {
  addContourLayers();
  map.setLayoutProperty('color-relief', 'visibility', 'none');
  map.setLayoutProperty('hillshade', 'visibility', 'none');
  applyContourBackdrop(contourBackdrop);
}

let hsPreviewed = false;

function enterHillshadeMode(): void {
  map.setLayoutProperty('color-relief', 'visibility', 'none');
  map.setLayoutProperty('aerial-layer', 'visibility', 'none');
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

    if (prev === 'coverage') leaveCoverageMode();
    if (prev === 'contour') removeContourLayers();

    if (next === 'elevation') {
      if (map.loaded()) enterElevationMode();
      else map.once('load', () => enterElevationMode());
    }
    if (next === 'coverage') {
      if (map.loaded()) loadCoverage(map);
      else map.once('load', () => loadCoverage(map));
      enterCoverageMode();
    }
    if (next === 'contour') {
      if (map.loaded()) enterContourMode();
      else map.once('load', () => enterContourMode());
    }
    if (next === 'hillshade') {
      if (map.loaded()) enterHillshadeMode();
      else map.once('load', () => enterHillshadeMode());
    }
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
