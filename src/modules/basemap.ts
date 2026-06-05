/**
 * Basemap layer switcher (on-map control) + Labels overlay.
 *
 * Provides four basemap choices that sit beneath everything the side panels
 * render — Aerial Imagery, DEM Hillshade (Igor), DSM Hillshade (Igor), and the
 * Topolite vector basemap from LINZ Basemaps. The Labels overlay is an
 * independent toggle that always stays on top of everything.
 *
 * Layer z-order discipline:
 *   bg
 *   bm-*       basemap layers (this module, just above bg, below mode layers)
 *   <mode base + mode overlays>
 *   lbl-*      labels overlay (this module, always on top via moveLayer)
 *
 * Vector styles (Topolite, Labels) are fetched live from
 * basemaps.linz.govt.nz/v1/styles/*.json — we copy their sources and layers
 * onto our map with `bm-`/`lbl-` prefixes so their IDs can't collide with the
 * app's own sources/layers. The style-level `glyphs` and `sprite` URLs are set
 * to LINZ in main.ts so their text and icons resolve.
 */
import type {
  Map as MaplibreMap, IControl,
  StyleSpecification, LayerSpecification, SourceSpecification,
} from 'maplibre-gl';
import { API, ELEV_URL, DSM_URL } from './config.js';

// ── BASEMAP DEFINITIONS ───────────────────────────────────────────────────────

export type BasemapId = 'none' | 'aerial' | 'hillshade-dem' | 'hillshade-dsm' | 'topolite';

interface BasemapDef {
  id: BasemapId;
  label: string;
  kind: 'none' | 'raster' | 'vector-style';
  /** For 'raster': tile URL template. For 'vector-style': style.json URL. */
  url?: string;
}

const BM_PREFIX  = 'bm-';
const LBL_PREFIX = 'lbl-';
/** Prefix for non-basemap, non-label overlays managed by this module
 *  (currently just the Hillshade Blend tints). Layers here sit ABOVE the
 *  side-panel mode layers but BELOW labels. */
const OV_PREFIX  = 'ov-';

export type HillshadeBlend = 'none' | 'dem' | 'dsm';

const BASEMAPS: BasemapDef[] = [
  { id: 'none',          label: 'None',                kind: 'none' },
  { id: 'aerial',        label: 'Aerial Imagery',     kind: 'raster',
    url: `https://basemaps.linz.govt.nz/v1/tiles/aerial/WebMercatorQuad/{z}/{x}/{y}.webp?api=${API}` },
  { id: 'hillshade-dem', label: 'DEM Hillshade · Igor', kind: 'raster',
    url: `https://basemaps.linz.govt.nz/v1/tiles/hillshade-igor/WebMercatorQuad/{z}/{x}/{y}.webp?api=${API}` },
  { id: 'hillshade-dsm', label: 'DSM Hillshade · Igor', kind: 'raster',
    url: `https://basemaps.linz.govt.nz/v1/tiles/hillshade-igor-dsm/WebMercatorQuad/{z}/{x}/{y}.webp?api=${API}` },
  { id: 'topolite',      label: 'Topolite',            kind: 'vector-style',
    url: `https://basemaps.linz.govt.nz/v1/styles/topolite-v2.json?api=${API}` },
];

const DEFAULT_BASEMAP: BasemapId = 'none';

const LABELS_STYLE_URL = `https://basemaps.linz.govt.nz/v1/styles/labels-v2.json?api=${API}`;

// ── STATE ─────────────────────────────────────────────────────────────────────

let _map: MaplibreMap | null = null;
let _activeBasemap: BasemapId = DEFAULT_BASEMAP;
let _labelsOn = false;
let _hillshadeBlend: HillshadeBlend = 'none';
let _writeHash: (key: string, value: string | null) => void = () => {};
/** Tracks the layer IDs we added for the current basemap and for labels. */
const _basemapLayerIds = new Set<string>();
const _basemapSourceIds = new Set<string>();
const _labelLayerIds = new Set<string>();
const _labelSourceIds = new Set<string>();
const _blendLayerIds = new Set<string>();
const _blendSourceIds = new Set<string>();
/** Loaded style JSONs, cached so re-toggles don't refetch. */
const _styleCache = new Map<string, Promise<StyleSpecification>>();

// ── PUBLIC API ────────────────────────────────────────────────────────────────

export function initBasemap(
  map: MaplibreMap,
  opts: { writeHash?: (key: string, value: string | null) => void } = {},
): void {
  _map = map;
  if (opts.writeHash) _writeHash = opts.writeHash;
  map.addControl(new BasemapControl(), 'bottom-left');
  // Apply the default basemap once the map's style is ready. Labels and the
  // Hillshade Blend are applied on demand by restoreFromHash / control clicks.
  if (map.isStyleLoaded()) void applyBasemap();
  else map.once('style.load', () => void applyBasemap());
}

/** Public setter — called by the UI and by URL-hash restore on load. */
export function setBasemap(id: BasemapId): void {
  if (id === _activeBasemap) return;
  _activeBasemap = id;
  syncBasemapRadios();
  syncLabelsCheckbox(); // Topolite forces labels off / disables the checkbox
  _writeHash('basemap', id === DEFAULT_BASEMAP ? null : id);
  if (_map?.isStyleLoaded()) void applyBasemap();
  // else: the deferred init applyBasemap will pick up the new _activeBasemap.
}

/** Public setter for the Labels overlay. */
export function setLabelsEnabled(on: boolean): void {
  if (on === _labelsOn) return;
  // Topolite has its own labels — block enabling our overlay on top.
  if (on && _activeBasemap === 'topolite') return;
  _labelsOn = on;
  syncLabelsCheckbox();
  _writeHash('overlay', on ? 'labels' : null);
  if (_map?.isStyleLoaded()) void applyLabels();
}

/** Public setter for the Hillshade Blend overlay (one of none / dem / dsm). */
export function setHillshadeBlend(mode: HillshadeBlend): void {
  if (mode === _hillshadeBlend) return;
  _hillshadeBlend = mode;
  syncBlendCheckboxes();
  _writeHash('blend', mode === 'none' ? null : mode);
  if (_map?.isStyleLoaded()) void applyHillshadeBlend();
}

/** Returns true if a layer id was added by this module (basemap or labels). */
export function isBasemapOrLabelLayer(id: string): boolean {
  return id.startsWith(BM_PREFIX) || id.startsWith(LBL_PREFIX);
}

/** Move all label layers to the top of the stack — call after any layer add. */
export function moveLabelsToTop(): void {
  if (!_map || !_labelsOn) return;
  const order = _map.getStyle().layers.map(l => l.id).filter(id => id.startsWith(LBL_PREFIX));
  for (const id of order) _map.moveLayer(id);
}

// ── BASEMAP APPLY ─────────────────────────────────────────────────────────────

async function applyBasemap(): Promise<void> {
  if (!_map) return;
  // Remove whatever basemap is currently mounted, then add the new one.
  for (const id of _basemapLayerIds) if (_map.getLayer(id)) _map.removeLayer(id);
  for (const id of _basemapSourceIds) if (_map.getSource(id)) _map.removeSource(id);
  _basemapLayerIds.clear();
  _basemapSourceIds.clear();

  const def = BASEMAPS.find(b => b.id === _activeBasemap);
  if (!def) return;

  // beforeId for the new basemap: the first layer that isn't bg or basemap.
  // That places basemap above bg but below every mode/overlay/label layer.
  const beforeId = firstNonBasemapLayerId(_map);

  if (def.kind === 'none') {
    // Nothing to mount — leave the bare background visible.
  } else if (def.kind === 'raster') {
    const sid = `${BM_PREFIX}${def.id}-src`;
    const lid = `${BM_PREFIX}${def.id}`;
    _map.addSource(sid, {
      type: 'raster', tiles: [def.url!], tileSize: 256,
      attribution: '© Land Information New Zealand CC BY 4.0',
    });
    _map.addLayer({ id: lid, type: 'raster', source: sid, paint: { 'raster-opacity': 1 } }, beforeId);
    _basemapSourceIds.add(sid);
    _basemapLayerIds.add(lid);
  } else {
    await injectVectorStyle(_map, def.url!, BM_PREFIX, _basemapSourceIds, _basemapLayerIds, beforeId);
  }

  // If labels are on, make sure they remain on top of the new basemap.
  moveLabelsToTop();
}

async function applyLabels(): Promise<void> {
  if (!_map) return;
  // Tear down existing label layers/sources.
  for (const id of _labelLayerIds) if (_map.getLayer(id)) _map.removeLayer(id);
  for (const id of _labelSourceIds) if (_map.getSource(id)) _map.removeSource(id);
  _labelLayerIds.clear();
  _labelSourceIds.clear();

  if (!_labelsOn) return;
  // Labels go on top — no beforeId.
  await injectVectorStyle(_map, LABELS_STYLE_URL, LBL_PREFIX, _labelSourceIds, _labelLayerIds, undefined);
}

function applyHillshadeBlend(): void {
  if (!_map) return;
  // Tear down current blend layers/sources.
  for (const id of _blendLayerIds) if (_map.getLayer(id)) _map.removeLayer(id);
  for (const id of _blendSourceIds) if (_map.getSource(id)) _map.removeSource(id);
  _blendLayerIds.clear();
  _blendSourceIds.clear();

  if (_hillshadeBlend === 'none') return;

  // Use MapLibre's `hillshade` layer type (not a raster layer over a
  // pre-rendered hillshade tile). The hillshade layer is mostly transparent,
  // drawing only the shadow/highlight strokes — colours below come through
  // at full strength except where the terrain actually casts shading. A
  // pre-rendered PNG-as-raster wouldn't, since every flat-ground pixel is
  // mid-gray and wash dulls the whole image.
  const sid = `${OV_PREFIX}hillshade-blend-${_hillshadeBlend}-src`;
  const lid = `${OV_PREFIX}hillshade-blend-${_hillshadeBlend}`;
  const tileUrl = _hillshadeBlend === 'dsm' ? DSM_URL : ELEV_URL;
  _map.addSource(sid, {
    type: 'raster-dem', tiles: [tileUrl], tileSize: 256, encoding: 'mapbox',
    attribution: '© Land Information New Zealand CC BY 4.0',
  });
  // Add at the top — moveLabelsToTop below restacks labels above us.
  _map.addLayer({
    id: lid, type: 'hillshade', source: sid,
    paint: {
      'hillshade-method': 'igor',
      'hillshade-illumination-direction': 315,
      'hillshade-illumination-anchor': 'map',
      'hillshade-exaggeration': 0.5,
      'hillshade-shadow-color': 'rgba(0,0,0,0.5)',
      'hillshade-highlight-color': 'rgba(255,255,255,0.15)',
    },
  });
  _blendSourceIds.add(sid);
  _blendLayerIds.add(lid);

  // Keep labels above the new blend.
  moveLabelsToTop();
}

// ── STYLE-JSON INJECTION ──────────────────────────────────────────────────────

async function fetchStyle(url: string): Promise<StyleSpecification> {
  let p = _styleCache.get(url);
  if (!p) {
    p = fetch(url).then(r => {
      if (!r.ok) throw new Error(`Style fetch failed: ${url} (${r.status})`);
      return r.json() as Promise<StyleSpecification>;
    });
    _styleCache.set(url, p);
    p.catch(() => _styleCache.delete(url));
  }
  return p;
}

/** Add every source + layer from a LINZ vector style under a prefix. */
async function injectVectorStyle(
  map: MaplibreMap,
  url: string,
  prefix: string,
  srcRegistry: Set<string>,
  layerRegistry: Set<string>,
  beforeId: string | undefined,
): Promise<void> {
  const style = await fetchStyle(url);

  // Sources first.
  const srcRemap: Record<string, string> = {};
  for (const [origId, src] of Object.entries(style.sources ?? {})) {
    const newId = `${prefix}${origId}`;
    srcRemap[origId] = newId;
    if (!map.getSource(newId)) map.addSource(newId, src as SourceSpecification);
    srcRegistry.add(newId);
  }

  // Then layers, remapping source references and ids.
  for (const layer of style.layers ?? []) {
    if (layer.type === 'background') continue; // we have our own background
    const remapped: LayerSpecification = { ...(layer as LayerSpecification), id: `${prefix}${layer.id}` };
    if ('source' in remapped && remapped.source) {
      const r = srcRemap[remapped.source as string];
      if (r) remapped.source = r;
    }
    if (map.getLayer(remapped.id)) continue;
    map.addLayer(remapped, beforeId);
    layerRegistry.add(remapped.id);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function firstNonBasemapLayerId(map: MaplibreMap): string | undefined {
  for (const l of map.getStyle().layers) {
    if (l.id === 'bg' || l.id.startsWith(BM_PREFIX)) continue;
    return l.id;
  }
  return undefined;
}

// ── ON-MAP CONTROL ────────────────────────────────────────────────────────────

function syncBasemapRadios(): void {
  document.querySelectorAll<HTMLInputElement>('input[name="basemap"]').forEach(input => {
    input.checked = input.value === _activeBasemap;
  });
}

function syncLabelsCheckbox(): void {
  const cb = document.getElementById('bm-labels-input') as HTMLInputElement | null;
  if (!cb) return;
  // Topolite carries its own labels — force ours off and disable the input.
  if (_activeBasemap === 'topolite') {
    if (_labelsOn) {
      _labelsOn = false;
      _writeHash('overlay', null);
      void applyLabels();
    }
    cb.checked = false;
    cb.disabled = true;
  } else {
    cb.disabled = false;
    cb.checked = _labelsOn;
  }
  cb.parentElement?.classList.toggle('disabled', cb.disabled);
}

function syncBlendCheckboxes(): void {
  const dem = document.getElementById('bm-blend-dem') as HTMLInputElement | null;
  const dsm = document.getElementById('bm-blend-dsm') as HTMLInputElement | null;
  if (dem) dem.checked = _hillshadeBlend === 'dem';
  if (dsm) dsm.checked = _hillshadeBlend === 'dsm';
}

class BasemapControl implements IControl {
  private _container!: HTMLDivElement;

  onAdd(): HTMLElement {
    this._container = document.createElement('div');
    // Skip `maplibregl-ctrl-group` — it constrains the children to a fixed
    // square button grid, which clips our pill toggle's background.
    this._container.className = 'maplibregl-ctrl bm-ctrl';

    // Header button toggles the menu visibility.
    const btn = document.createElement('button');
    btn.className = 'bm-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Choose basemap');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 7.5l9-4.5 9 4.5-9 4.5z"/>
        <path d="M3 12l9 4.5L21 12"/>
        <path d="M3 16.5L12 21l9-4.5"/>
      </svg>
      <span>Basemap</span>
    `;
    btn.addEventListener('click', () => this._container.classList.toggle('open'));
    this._container.appendChild(btn);

    // Menu — basemap radio list + labels checkbox.
    const menu = document.createElement('div');
    menu.className = 'bm-menu';

    const groupLabel = document.createElement('div');
    groupLabel.className = 'bm-grp-lbl';
    groupLabel.textContent = 'Basemap';
    menu.appendChild(groupLabel);

    for (const def of BASEMAPS) {
      const opt = document.createElement('label');
      opt.className = 'bm-opt';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'basemap';
      input.value = def.id;
      input.checked = _activeBasemap === def.id;
      input.addEventListener('change', () => { if (input.checked) setBasemap(def.id); });
      const lbl = document.createElement('span');
      lbl.textContent = def.label;
      opt.append(input, lbl);
      menu.appendChild(opt);
    }

    const overlayLabel = document.createElement('div');
    overlayLabel.className = 'bm-grp-lbl';
    overlayLabel.textContent = 'Overlays';
    menu.appendChild(overlayLabel);

    const labelsOpt = document.createElement('label');
    labelsOpt.className = 'bm-opt';
    const lblInput = document.createElement('input');
    lblInput.type = 'checkbox';
    lblInput.id = 'bm-labels-input';
    lblInput.checked = _labelsOn;
    lblInput.disabled = _activeBasemap === 'topolite';
    if (lblInput.disabled) labelsOpt.classList.add('disabled');
    lblInput.addEventListener('change', () => setLabelsEnabled(lblInput.checked));
    const lblText = document.createElement('span');
    lblText.textContent = 'Labels';
    labelsOpt.append(lblInput, lblText);
    menu.appendChild(labelsOpt);

    // Two Hillshade Blend overlays. They're mutually exclusive — selecting
    // one unchecks the other (and ticking nothing clears the blend).
    const makeBlendOpt = (id: 'dem' | 'dsm', label: string, domId: string): HTMLLabelElement => {
      const opt = document.createElement('label');
      opt.className = 'bm-opt';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = domId;
      input.checked = _hillshadeBlend === id;
      input.addEventListener('change', () => setHillshadeBlend(input.checked ? id : 'none'));
      const text = document.createElement('span');
      text.textContent = label;
      opt.append(input, text);
      return opt;
    };
    menu.appendChild(makeBlendOpt('dem', 'DEM Hillshade Blend', 'bm-blend-dem'));
    menu.appendChild(makeBlendOpt('dsm', 'DSM Hillshade Blend', 'bm-blend-dsm'));

    this._container.appendChild(menu);
    return this._container;
  }

  onRemove(): void {
    this._container.parentNode?.removeChild(this._container);
  }
}
