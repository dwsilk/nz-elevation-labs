/**
 * Export tab — render the bounding box of every STAC Item in the active
 * dataset's STAC Collection, let the user click to select, and link to the
 * source GeoTIFF for download. Items are streamed in as they're fetched
 * (~424 per dataset, ~20 concurrent) so tiles appear progressively.
 */
import type { Map as MaplibreMap, GeoJSONSource, GeoJSONSourceSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import {
  EXP_SOURCE, EXP_FILL, EXP_HOVER, EXP_OUTLINE, EXP_LAYERS,
  STAC_COLLECTIONS, type DemDsm,
} from './config.js';

// ── TYPES ─────────────────────────────────────────────────────────────────────

interface ExportProps {
  /** STAC Item id, e.g. "AS21" */
  id: string;
  start: string;
  end: string;
  downloadUrl: string;
}

interface StacLink { href?: string; rel?: string }
interface StacAsset { href?: string; type?: string }
interface StacItem {
  id?: string;
  bbox?: number[];
  geometry?: { type: string };
  properties?: { start_datetime?: string; end_datetime?: string };
  assets?: Record<string, StacAsset>;
}
interface StacCollection { links?: StacLink[] }

// ── STATE ─────────────────────────────────────────────────────────────────────

let _map: MaplibreMap | null = null;
let _activeSrc: DemDsm = 'dem';
/** Increments on each load() so an in-flight fetch from a stale src can bail. */
let _loadGen = 0;
let _features: Feature<Polygon, ExportProps>[] = [];
let _hoverId: number | null = null;
let _selectedId: number | null = null;
let _eventsBound = false;
let _totalItems = 0;
let _updatePending = false;
/** STAC item id → headers parsed from a HEAD on the asset; absent ⇒ not fetched yet. */
interface ItemMeta { updated: string; size: string }
const _itemMetaCache = new Map<string, ItemMeta>();

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────

export function setExportActiveSrc(src: DemDsm): void { _activeSrc = src; }

export function showExportLayers(map: MaplibreMap): void {
  EXP_LAYERS.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible'); });
}

export function hideExportLayers(map: MaplibreMap): void {
  EXP_LAYERS.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); });
}

export function switchExportSrc(src: DemDsm, map: MaplibreMap, revealOnLoad = false): void {
  if (src === _activeSrc && map.getSource(EXP_SOURCE)) return;
  _activeSrc = src;
  if (map.getSource(EXP_SOURCE)) {
    unloadExport(map);
    loadExport(map, src, revealOnLoad);
  }
}

export function initExportControls(map: MaplibreMap): void {
  _map = map;
  el<HTMLButtonElement>('exp-clear-btn')?.addEventListener('click', () => clearSelection(map));
}

export function loadExport(map: MaplibreMap, src?: DemDsm, revealOnLoad = true): void {
  _map = map;
  const target = src ?? _activeSrc;

  if (map.getSource(EXP_SOURCE)) {
    if (target === _activeSrc) {
      if (revealOnLoad) showExportLayers(map);
      return;
    }
    unloadExport(map);
  }

  _activeSrc = target;
  _features = [];
  _hoverId = null; _selectedId = null;
  _totalItems = 0;
  updateProgress(0, 0);

  map.addSource(EXP_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] } as FeatureCollection,
    promoteId: 'id',
  } as GeoJSONSourceSpecification);

  const initialVisibility: 'visible' | 'none' = revealOnLoad ? 'visible' : 'none';

  map.addLayer({
    id: EXP_FILL, type: 'fill', source: EXP_SOURCE,
    layout: { visibility: initialVisibility },
    paint: {
      'fill-color': '#0064c8',
      'fill-opacity': ['case',
        ['boolean', ['feature-state', 'selected'], false], 0.30,
        ['boolean', ['feature-state', 'hover'],    false], 0.18,
        0.04,
      ],
    },
  });

  map.addLayer({
    id: EXP_HOVER, type: 'line', source: EXP_SOURCE,
    layout: { visibility: initialVisibility },
    paint: {
      'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#00335b', '#0064c8'],
      'line-width': ['case',
        ['boolean', ['feature-state', 'selected'], false], 2.5,
        ['boolean', ['feature-state', 'hover'],    false], 1.8, 0,
      ],
      'line-opacity': ['case',
        ['boolean', ['feature-state', 'selected'], false], 1,
        ['boolean', ['feature-state', 'hover'],    false], 1, 0,
      ],
    },
  });

  map.addLayer({
    id: EXP_OUTLINE, type: 'line', source: EXP_SOURCE,
    layout: { visibility: initialVisibility },
    paint: { 'line-color': 'rgba(0,51,91,0.45)', 'line-width': 0.6 },
  });

  bindEventsOnce(map);

  const gen = ++_loadGen;
  void streamItems(target, gen);
}

// ── FETCH + STREAM ────────────────────────────────────────────────────────────

async function streamItems(src: DemDsm, gen: number): Promise<void> {
  const collUrl = STAC_COLLECTIONS[src];
  let coll: StacCollection;
  try {
    coll = await fetch(collUrl).then(r => r.json()) as StacCollection;
  } catch (err) {
    console.error('STAC collection fetch failed:', err);
    return;
  }
  if (gen !== _loadGen) return;

  const itemLinks = (coll.links ?? []).filter(l => l.rel === 'item' && typeof l.href === 'string');
  _totalItems = itemLinks.length;
  updateProgress(0, _totalItems);

  const N = 20;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= itemLinks.length || gen !== _loadGen) return;
      const link = itemLinks[i]!;
      const itemUrl = new URL(link.href!, collUrl).href;
      try {
        const item = await fetch(itemUrl).then(r => r.json()) as StacItem;
        if (gen !== _loadGen) return;
        const feat = itemToFeature(item, itemUrl, i);
        if (feat) {
          _features.push(feat);
          scheduleSourceUpdate();
          updateProgress(_features.length, _totalItems);
        }
      } catch (err) {
        console.warn('STAC item fetch failed:', itemUrl, err);
      }
    }
  };
  await Promise.all(Array.from({ length: N }, worker));
}

function itemToFeature(item: StacItem, itemUrl: string, index: number): Feature<Polygon, ExportProps> | null {
  if (!item.id || !item.geometry || item.geometry.type !== 'Polygon') return null;
  const assets = item.assets ?? {};
  let asset: StacAsset | undefined = assets['visual'];
  if (!asset || !asset.type?.includes('tiff')) {
    asset = Object.values(assets).find(a => a?.type?.includes('tiff'));
  }
  if (!asset?.href) return null;
  return {
    type: 'Feature',
    id: index,
    geometry: item.geometry as Polygon,
    properties: {
      id: item.id,
      start: item.properties?.start_datetime?.slice(0, 10) ?? '',
      end:   item.properties?.end_datetime?.slice(0, 10)   ?? '',
      downloadUrl: new URL(asset.href, itemUrl).href,
    },
  };
}

function scheduleSourceUpdate(): void {
  if (_updatePending || !_map) return;
  _updatePending = true;
  requestAnimationFrame(() => {
    _updatePending = false;
    const src = _map?.getSource(EXP_SOURCE) as GeoJSONSource | undefined;
    if (src) src.setData({ type: 'FeatureCollection', features: _features });
  });
}

function updateProgress(loaded: number, total: number): void {
  const prog = el<HTMLDivElement>('exp-progress');
  if (!prog) return;
  const done = total > 0 && loaded === total;
  prog.classList.toggle('hidden', done);
  const nEl = el<HTMLSpanElement>('exp-progress-n');
  const totalEl = el<HTMLSpanElement>('exp-progress-total');
  if (nEl) nEl.textContent = String(loaded);
  if (totalEl) totalEl.textContent = total > 0 ? String(total) : '…';
}

// ── INTERACTION ───────────────────────────────────────────────────────────────

function bindEventsOnce(map: MaplibreMap): void {
  if (_eventsBound) return;
  _eventsBound = true;

  let clickedTile = false;

  map.on('mousemove', EXP_FILL, e => {
    map.getCanvas().style.cursor = 'pointer';
    const id = (e.features?.[0]?.id ?? null) as number | null;
    if (_hoverId !== null && _hoverId !== id) map.setFeatureState({ source: EXP_SOURCE, id: _hoverId }, { hover: false });
    _hoverId = id;
    if (_hoverId !== null) map.setFeatureState({ source: EXP_SOURCE, id: _hoverId }, { hover: true });
  });

  map.on('mouseleave', EXP_FILL, () => {
    map.getCanvas().style.cursor = '';
    if (_hoverId !== null) map.setFeatureState({ source: EXP_SOURCE, id: _hoverId }, { hover: false });
    _hoverId = null;
  });

  map.on('click', EXP_FILL, e => {
    clickedTile = true;
    const f = e.features?.[0];
    if (!f) return;
    const id = f.id as number;
    if (_selectedId !== null && _selectedId !== id) map.setFeatureState({ source: EXP_SOURCE, id: _selectedId }, { selected: false });
    _selectedId = id;
    map.setFeatureState({ source: EXP_SOURCE, id: _selectedId }, { selected: true });
    renderDetail(f.properties as unknown as ExportProps);
  });

  map.on('click', () => {
    if (clickedTile) { clickedTile = false; return; }
    if (!map.getLayer(EXP_FILL) || map.getLayoutProperty(EXP_FILL, 'visibility') !== 'visible') return;
    clearSelection(map);
  });
}

function renderDetail(p: ExportProps): void {
  const inner = el<HTMLDivElement>('exp-detail-inner');
  if (!inner) return;
  const range = p.start && p.end && p.start !== p.end ? `${p.start} → ${p.end}` : (p.start || p.end || '—');
  const meta = _itemMetaCache.get(p.id);
  inner.innerHTML =
    `<div class="exp-row"><span class="exp-lbl">Tile</span><span class="exp-val">${p.id}</span></div>` +
    `<div class="exp-row"><span class="exp-lbl">Captured</span><span class="exp-val">${range}</span></div>` +
    `<div class="exp-row"><span class="exp-lbl">Updated</span><span class="exp-val" data-last-updated="${p.id}">${meta?.updated ?? '…'}</span></div>` +
    `<div class="exp-row"><span class="exp-lbl">Size</span><span class="exp-val" data-tile-size="${p.id}">${meta?.size ?? '…'}</span></div>`;
  const dl = el<HTMLAnchorElement>('exp-dl-btn');
  if (dl) dl.href = p.downloadUrl;
  el<HTMLDivElement>('exp-detail')?.classList.remove('hidden');
  if (meta === undefined) void fetchItemMeta(p.id, p.downloadUrl);
}

export function formatBytes(n: number): string {
  if (!isFinite(n) || n <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  // Coarser precision as numbers get bigger — "1.23 KB" reads fine, "234.56 MB"
  // is just noise. 1024-based units keep the displayed numbers in line with
  // what S3 / browser dev-tools report.
  const decimals = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(decimals)} ${u[i]}`;
}

async function fetchItemMeta(tileId: string, url: string): Promise<void> {
  let updated = '—';
  let size = '—';
  try {
    const res = await fetch(url, { method: 'HEAD' });
    const lm = res.headers.get('Last-Modified');
    if (lm) {
      const d = new Date(lm);
      if (!isNaN(d.getTime())) updated = d.toISOString().slice(0, 10);
    }
    const cl = res.headers.get('Content-Length');
    if (cl) size = formatBytes(Number(cl));
  } catch (err) {
    console.warn('HEAD request failed:', url, err);
  }
  _itemMetaCache.set(tileId, { updated, size });
  // Only update DOM cells if this tile is still the one displayed (selectors
  // are unique per tile id and disappear when a different tile is selected).
  const updEl  = document.querySelector<HTMLSpanElement>(`[data-last-updated="${CSS.escape(tileId)}"]`);
  if (updEl)  updEl.textContent  = updated;
  const sizeEl = document.querySelector<HTMLSpanElement>(`[data-tile-size="${CSS.escape(tileId)}"]`);
  if (sizeEl) sizeEl.textContent = size;
}

function clearSelection(map: MaplibreMap): void {
  if (_selectedId !== null) {
    map.setFeatureState({ source: EXP_SOURCE, id: _selectedId }, { selected: false });
    _selectedId = null;
  }
  el<HTMLDivElement>('exp-detail')?.classList.add('hidden');
}

function unloadExport(map: MaplibreMap): void {
  [...EXP_LAYERS].reverse().forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
  if (map.getSource(EXP_SOURCE)) map.removeSource(EXP_SOURCE);
  _features = [];
  _hoverId = null;
  _selectedId = null;
}
