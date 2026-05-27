/**
 * main.ts — application entry point
 * Initialises the MapLibre map, wires all panel tabs, and coordinates
 * between the elevation, contour, and coverage modules.
 */
import maplibregl, { Map as MaplibreMap, NavigationControl, ScaleControl, RasterTileSource } from 'maplibre-gl';
import {
  API, ELEV_URL, DSM_URL, HS_URLS, AERIAL_URL,
  COV_HIDDEN_LAYERS, MAP_CENTER, MAP_ZOOM,
  type DemDsm, type HsSource, type HsRaster, type HsMethod,
} from './modules/config.js';
import {
  PRESETS, stops, activePreset, setStops, setActivePreset,
  paintCanvas, colorAt, buildColorExpr, rgbToHex,
  type ColourStop,
} from './modules/elevation.js';
import {
  initContourControls, addContourLayers, renderThresholds,
  setActiveSrc as setContourSrc,
} from './modules/contour.js';
import {
  loadCoverage, initCoverageControls, showCoverageLayers, hideCoverageLayers, switchCoverageSrc,
} from './modules/coverage.js';

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
        id: 'color-relief', type: 'color-relief', source: 'dem',
        paint: { 'color-relief-color': buildColorExpr(stops), 'color-relief-opacity': 1.0 },
      },
      {
        id: 'hillshade', type: 'hillshade', source: 'dem',
        paint: {
          'hillshade-method': 'standard',
          'hillshade-illumination-direction': 315,
          'hillshade-exaggeration': 0.5,
          'hillshade-shadow-color': 'rgba(0,0,0,0.5)',
          'hillshade-highlight-color': 'rgba(255,255,255,0.15)',
        },
      },
      {
        id: 'hillshade-raster-layer', type: 'raster', source: 'hillshade-raster',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.5 },
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
  addContourLayers();
  initContourControls(map);
  initCoverageControls(map);
  init3DButton(map);
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
      renderPresets(); renderStops(); applyRamp();
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
      drawRamp(stops); applyRamp();
    });

    const ei = document.createElement('input');
    ei.type = 'number'; ei.value = String(s.e); ei.min = '-500'; ei.max = '5000'; ei.step = '10';
    ei.setAttribute('aria-label', `Stop ${i + 1} elevation`);
    ei.addEventListener('change', () => {
      stops[stops.findIndex(x => x.e === s.e)]!.e = Number(ei.value);
      drawRamp(stops); applyRamp();
    });

    const unit = Object.assign(document.createElement('span'), { className: 'stop-unit', textContent: 'm' });

    const del = document.createElement('button');
    del.className = 'stop-del'; del.textContent = '×';
    del.disabled = stops.length <= 2;
    del.addEventListener('click', () => {
      if (stops.length > 2) {
        stops.splice(stops.findIndex(x => x.e === s.e), 1);
        renderStops(); drawRamp(stops); applyRamp();
      }
    });

    row.append(ci, ei, unit, del);
    list.appendChild(row);
  });
}

el<HTMLButtonElement>('add-stop').addEventListener('click', () => {
  const s = [...stops].sort((a, b) => a.e - b.e);
  const ne = Math.round((s[s.length - 1]!.e + s[s.length - 2]!.e) / 2);
  stops.push({ e: ne, c: rgbToHex(colorAt(ne, stops)) });
  renderStops(); drawRamp(stops); applyRamp();
});

// ── HILLSHADE CONTROLS ────────────────────────────────────────────────────────

let hsSource: HsSource = 'terrain:standard';

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

el<HTMLInputElement>('tog-hs').addEventListener('change', e => {
  const enabled = (e.target as HTMLInputElement).checked;
  const vis = enabled ? 'visible' : 'none';
  const [type] = hsSource.split(':') as [string];
  map.setLayoutProperty('hillshade', 'visibility', type === 'terrain' ? vis : 'none');
  map.setLayoutProperty('hillshade-raster-layer', 'visibility', type === 'raster' ? vis : 'none');
});

el<HTMLSelectElement>('sel-hs-src').addEventListener('change', e => {
  const val = (e.target as HTMLSelectElement).value as HsSource;
  const [type, method] = val.split(':') as [string, string];
  const vis = el<HTMLInputElement>('tog-hs').checked ? 'visible' : 'none';

  if (type === 'terrain') {
    map.setPaintProperty('hillshade', 'hillshade-method', method as HsMethod);
    map.setLayoutProperty('hillshade', 'visibility', vis);
    map.setLayoutProperty('hillshade-raster-layer', 'visibility', 'none');
  } else {
    (map.getSource('hillshade-raster') as RasterTileSource).setTiles([HS_URLS[method as HsRaster][activeSrc]]);
    map.setLayoutProperty('hillshade', 'visibility', 'none');
    map.setLayoutProperty('hillshade-raster-layer', 'visibility', vis);
  }
  hsSource = val;
  updateHsTerrainVis(type === 'terrain');
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
    map.setPaintProperty('hillshade', 'hillshade-exaggeration', v / 10);
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
  (map.getSource('dem') as RasterTileSource).setTiles([src === 'dsm' ? DSM_URL : ELEV_URL]);
  if (activeTab === 'coverage') {
    (map.getSource('hillshade-raster') as RasterTileSource).setTiles([HS_URLS.igor[src]]);
  } else if (activeTab !== 'contour' && hsSource.startsWith('raster:')) {
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

function restoreHillshade(): void {
  const [type, method] = hsSource.split(':') as [string, string];
  const vis = el<HTMLInputElement>('tog-hs').checked ? 'visible' : 'none';
  if (type === 'terrain') {
    map.setPaintProperty('hillshade', 'hillshade-method', method as HsMethod);
    map.setLayoutProperty('hillshade', 'visibility', vis);
    map.setLayoutProperty('hillshade-raster-layer', 'visibility', 'none');
  } else {
    (map.getSource('hillshade-raster') as RasterTileSource).setTiles([HS_URLS[method as HsRaster][activeSrc]]);
    map.setLayoutProperty('hillshade', 'visibility', 'none');
    map.setLayoutProperty('hillshade-raster-layer', 'visibility', vis);
  }
  map.setLayoutProperty('aerial-layer', 'visibility', 'none');
}

// ── COVERAGE MODE ─────────────────────────────────────────────────────────────

let preCoVState: Record<string, string> = {};

function enterCoverageMode(): void {
  COV_HIDDEN_LAYERS.forEach(id => {
    if (map.getLayer(id)) {
      preCoVState[id] = map.getLayoutProperty(id, 'visibility') as string ?? 'visible';
      map.setLayoutProperty(id, 'visibility', 'none');
    }
  });
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
  COV_HIDDEN_LAYERS.forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', preCoVState[id] ?? 'visible');
  });
  preCoVState = {};
  el('leg-cov').classList.add('hidden');
  el('leg-elev').classList.remove('hidden');
  restoreHillshade();
}

// ── CONTOUR MODE ──────────────────────────────────────────────────────────────

type ContourBackdrop = 'igor-dem' | 'igor-dsm' | 'aerial';
let contourBackdrop: ContourBackdrop = 'igor-dem';
let preCtState: Record<string, string> = {};

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
  ['color-relief', 'hillshade'].forEach(id => {
    if (map.getLayer(id)) {
      preCtState[id] = map.getLayoutProperty(id, 'visibility') as string ?? 'visible';
      map.setLayoutProperty(id, 'visibility', 'none');
    }
  });
  applyContourBackdrop(contourBackdrop);
}

function leaveContourMode(): void {
  ['color-relief', 'hillshade'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', preCtState[id] ?? 'visible');
  });
  preCtState = {};
  restoreHillshade();
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
    if (prev === 'contour') leaveContourMode();

    if (next === 'coverage') {
      if (map.loaded()) loadCoverage(map);
      else map.once('load', () => loadCoverage(map));
      enterCoverageMode();
    }
    if (next === 'contour') {
      if (map.loaded()) enterContourMode();
      else map.once('load', () => enterContourMode());
    }
  });
});

// ── INIT ──────────────────────────────────────────────────────────────────────

renderPresets();
renderStops();
drawRamp(stops);
