/**
 * Inspect tab — spot-elevation reader + profile / transect tool.
 *
 * Reads elevations via `map.queryTerrainElevation`, which only works when
 * MapLibre's terrain is enabled. While this panel is active we silently
 * enable terrain (at exaggeration 1 — pitch is still 0 so the visual is
 * unchanged) so queries succeed regardless of the user's explicit 3D toggle,
 * then restore the previous terrain state on leave.
 *
 * `queryTerrainElevation` returns elevation × current exaggeration, so we
 * normalise back to real metres in `queryElevation`.
 *
 * Spot tool: panel is always visible and updates lat / lng / elevation live
 * from the mouse cursor. A click pins the position with a marker; subsequent
 * mouse moves don't change the display until "Clear" is pressed.
 *
 * Profile tool: two clicks define a great-circle-ish line; we sample N
 * elevations along it, draw an SVG chart with 100 m gridlines + adaptively
 * spaced labels, and let the user hover the chart to highlight the
 * corresponding map location plus see the live elevation under the cursor.
 *
 * Selecting one tool clears the other's on-map state (marker / line).
 */
import maplibregl, {
  type Map as MaplibreMap, type LngLat, type LngLatLike, type Marker, type GeoJSONSource,
} from 'maplibre-gl';
import type { FeatureCollection, LineString } from 'geojson';
import { INSPECT_LINE_SOURCE, INSPECT_LINE_LAYER, INSPECT_PROFILE_SAMPLES } from './config.js';

type Tool = 'spot' | 'profile';

// ── STATE ─────────────────────────────────────────────────────────────────────

let _map: MaplibreMap | null = null;
let _active = false;
let _tool: Tool = 'spot';

// Spot state
let _spotMarker: Marker | null = null;

// Profile state
let _profileStart: LngLat | null = null;
let _profileEnd: LngLat | null = null;
let _profileStartMarker: Marker | null = null;
let _profileEndMarker: Marker | null = null;
let _profileHoverMarker: Marker | null = null;
let _profileSamples: Array<{ lng: number; lat: number; elev: number | null; distM: number }> = [];

// Terrain state we silently overrode (so we can restore on leave).
let _silentlyEnabledTerrain = false;

// Bound listener references for clean removal.
let _clickHandler: ((e: maplibregl.MapMouseEvent) => void) | null = null;
let _moveHandler:  ((e: maplibregl.MapMouseEvent) => void) | null = null;

// Chart layout constants — keep in one place so onChartMove and renderProfileChart agree.
const CH_W = 300, CH_H = 120, CH_PAD_T = 6, CH_PAD_B = 8, CH_PAD_L = 32, CH_PAD_R = 6;
const CH_INNER_W = CH_W - CH_PAD_L - CH_PAD_R;
const CH_INNER_H = CH_H - CH_PAD_T - CH_PAD_B;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function svgEl(id: string): SVGSVGElement | null {
  return document.getElementById(id) as SVGSVGElement | null;
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────

export function initInspectControls(map: MaplibreMap): void {
  _map = map;
  el<HTMLButtonElement>('insp-tool-spot')?.addEventListener('click', () => setTool('spot'));
  el<HTMLButtonElement>('insp-tool-profile')?.addEventListener('click', () => setTool('profile'));
  el<HTMLButtonElement>('insp-spot-clear')?.addEventListener('click', clearSpot);
  el<HTMLButtonElement>('insp-profile-clear')?.addEventListener('click', clearProfile);

  const chart = svgEl('insp-profile-chart');
  if (chart) {
    chart.addEventListener('mousemove', e => onChartMove(e));
    chart.addEventListener('mouseleave', () => clearHoverMarker());
  }
}

export function attachInspect(map: MaplibreMap, terrainEnabled: boolean): void {
  _map = map;
  _active = true;

  if (!terrainEnabled) {
    map.setTerrain({ source: 'dem', exaggeration: 1 });
    _silentlyEnabledTerrain = true;
  }

  ensureLineLayer(map);

  _clickHandler = (e: maplibregl.MapMouseEvent): void => {
    if (!_active) return;
    if (_tool === 'spot') handleSpotClick(e.lngLat);
    else                  handleProfileClick(e.lngLat);
  };
  _moveHandler = (e: maplibregl.MapMouseEvent): void => {
    if (!_active || _tool !== 'spot' || _spotMarker) return;
    renderSpotDetail(e.lngLat, queryElevation(e.lngLat));
  };
  map.on('click', _clickHandler);
  map.on('mousemove', _moveHandler);

  refreshToolUI();
}

export function detachInspect(map: MaplibreMap, terrainEnabled: boolean): void {
  _active = false;

  if (_clickHandler) { map.off('click', _clickHandler); _clickHandler = null; }
  if (_moveHandler)  { map.off('mousemove', _moveHandler); _moveHandler = null; }

  if (_silentlyEnabledTerrain && !terrainEnabled) map.setTerrain(null);
  _silentlyEnabledTerrain = false;

  clearHoverMarker();
}

// ── ELEVATION QUERY ───────────────────────────────────────────────────────────

// queryTerrainElevation returns elevation × current exaggeration. Normalise so
// the value is correct whether terrain is at our silent exag 1 or the user's
// 3D-mode value of N.
function queryElevation(lngLat: LngLatLike): number | null {
  if (!_map) return null;
  const raw = _map.queryTerrainElevation(lngLat);
  if (raw === null) return null;
  const terrain = _map.getTerrain();
  const exag = terrain?.exaggeration ?? 1;
  return exag > 0 ? raw / exag : raw;
}

// ── TOOL SWITCHING ────────────────────────────────────────────────────────────

function setTool(t: Tool): void {
  if (t === _tool) return;
  // Switching tools clears the other tool's on-map state.
  if (t === 'spot')   clearProfile();
  else                clearSpot();
  _tool = t;
  refreshToolUI();
}

function refreshToolUI(): void {
  el<HTMLButtonElement>('insp-tool-spot')?.classList.toggle('active', _tool === 'spot');
  el<HTMLButtonElement>('insp-tool-profile')?.classList.toggle('active', _tool === 'profile');

  // Spot panel is always shown when the spot tool is active — live readout when
  // unpinned, frozen reading when a marker is dropped.
  const inSpot = _tool === 'spot';
  el<HTMLDivElement>('insp-spot-detail')?.classList.toggle('hidden', !inSpot);
  if (inSpot && !_spotMarker) renderSpotDetail(null, null);

  const hasProfile = _profileStart !== null && _profileEnd !== null;
  const inProfile = _tool === 'profile';
  el<HTMLDivElement>('insp-profile-hint')?.classList.toggle('hidden', !inProfile || hasProfile);
  el<HTMLDivElement>('insp-profile-detail')?.classList.toggle('hidden', !inProfile || !hasProfile);
}

// ── SPOT TOOL ─────────────────────────────────────────────────────────────────

function handleSpotClick(lngLat: LngLat): void {
  if (!_map) return;
  const elev = queryElevation(lngLat);
  if (!_spotMarker) {
    _spotMarker = new maplibregl.Marker({ color: '#0064c8' }).setLngLat(lngLat).addTo(_map);
  } else {
    _spotMarker.setLngLat(lngLat);
  }
  renderSpotDetail(lngLat, elev);
}

function renderSpotDetail(lngLat: LngLat | null, elev: number | null): void {
  const lat = el<HTMLSpanElement>('insp-spot-lat');
  const lng = el<HTMLSpanElement>('insp-spot-lng');
  const ev  = el<HTMLSpanElement>('insp-spot-elev');
  if (lat) lat.textContent = lngLat ? lngLat.lat.toFixed(6) + '°' : '—';
  if (lng) lng.textContent = lngLat ? lngLat.lng.toFixed(6) + '°' : '—';
  if (ev)  ev.textContent  = elev === null ? '—' : `${elev.toFixed(1)} m`;
}

function clearSpot(): void {
  if (_spotMarker) { _spotMarker.remove(); _spotMarker = null; }
  renderSpotDetail(null, null);
}

// ── PROFILE TOOL ──────────────────────────────────────────────────────────────

function handleProfileClick(lngLat: LngLat): void {
  if (!_map) return;
  if (_profileStart && _profileEnd) clearProfile();
  if (!_profileStart) {
    _profileStart = lngLat;
    _profileStartMarker = new maplibregl.Marker({ color: '#0064c8', scale: 0.7 }).setLngLat(lngLat).addTo(_map);
    refreshToolUI();
    return;
  }
  _profileEnd = lngLat;
  _profileEndMarker = new maplibregl.Marker({ color: '#00335b', scale: 0.7 }).setLngLat(lngLat).addTo(_map);
  drawProfileLine();
  sampleAndRenderProfile();
  refreshToolUI();
}

function clearProfile(): void {
  _profileStart = null;
  _profileEnd = null;
  _profileSamples = [];
  if (_profileStartMarker) { _profileStartMarker.remove(); _profileStartMarker = null; }
  if (_profileEndMarker)   { _profileEndMarker.remove();   _profileEndMarker = null; }
  clearHoverMarker();
  setLineData([]);
  el<HTMLDivElement>('insp-profile-detail')?.classList.add('hidden');
  refreshToolUI();
}

function drawProfileLine(): void {
  if (!_profileStart || !_profileEnd) return;
  setLineData([[_profileStart.lng, _profileStart.lat], [_profileEnd.lng, _profileEnd.lat]]);
}

function sampleAndRenderProfile(): void {
  if (!_map || !_profileStart || !_profileEnd) return;
  const N = INSPECT_PROFILE_SAMPLES;
  const s = _profileStart, e = _profileEnd;
  const totalM = haversineMetres(s.lng, s.lat, e.lng, e.lat);
  _profileSamples = new Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const lng = s.lng + (e.lng - s.lng) * t;
    const lat = s.lat + (e.lat - s.lat) * t;
    const elev = queryElevation({ lng, lat });
    _profileSamples[i] = { lng, lat, elev, distM: totalM * t };
  }
  renderProfileChart(totalM);
}

function renderProfileChart(totalM: number): void {
  const svg = svgEl('insp-profile-chart');
  if (!svg) return;

  const valid = _profileSamples.filter(s => s.elev !== null) as Array<{ elev: number; distM: number }>;
  if (valid.length === 0) {
    svg.innerHTML = `<text x="${CH_W / 2}" y="${CH_H / 2}" text-anchor="middle" font-size="11" fill="#888">No elevation data along this line</text>`;
    return;
  }

  let rawMin = Infinity, rawMax = -Infinity;
  for (const v of valid) { if (v.elev < rawMin) rawMin = v.elev; if (v.elev > rawMax) rawMax = v.elev; }

  // Snap to nearest 100 m below / above.
  let yMin = Math.floor(rawMin / 100) * 100;
  let yMax = Math.ceil (rawMax / 100) * 100;
  if (yMax === yMin) yMax = yMin + 100; // ensure at least one 100 m step
  const yRange = yMax - yMin;

  // Adaptive label spacing — gridlines stay every 100 m, labels thin out as the
  // total range grows so they don't overlap.
  const labelStep = yRange <= 700 ? 100 : yRange <= 1500 ? 200 : yRange <= 3500 ? 500 : 1000;

  const xAt = (distM: number): number => CH_PAD_L + (distM / totalM) * CH_INNER_W;
  const yAt = (elev: number):  number => CH_PAD_T + (1 - (elev - yMin) / yRange) * CH_INNER_H;

  // Gridlines + axis labels.
  let grid = '';
  for (let m = yMin; m <= yMax; m += 100) {
    const y = yAt(m).toFixed(1);
    grid += `<line x1="${CH_PAD_L}" y1="${y}" x2="${CH_PAD_L + CH_INNER_W}" y2="${y}" stroke="#d0d8e0" stroke-width="0.5" stroke-dasharray="2 2"/>`;
    if (m % labelStep === 0) {
      grid += `<text x="${CH_PAD_L - 4}" y="${(yAt(m) + 3).toFixed(1)}" font-size="9" fill="#4a6278" text-anchor="end" font-family="var(--font,sans-serif)">${m}m</text>`;
    }
  }

  // Profile polyline (handle gaps where queryElevation returned null).
  let d = '';
  let gap = true;
  for (const s of _profileSamples) {
    if (s.elev === null) { gap = true; continue; }
    if (gap) { d += `M${xAt(s.distM).toFixed(1)} ${yAt(s.elev).toFixed(1)}`; gap = false; }
    else     { d += ` L${xAt(s.distM).toFixed(1)} ${yAt(s.elev).toFixed(1)}`; }
  }

  // Subtle fill under the curve, anchored at the bottom of the chart.
  const first = valid[0]!, last = valid[valid.length - 1]!;
  const fill = `${d} L${xAt(last.distM).toFixed(1)} ${(CH_PAD_T + CH_INNER_H).toFixed(1)} L${xAt(first.distM).toFixed(1)} ${(CH_PAD_T + CH_INNER_H).toFixed(1)} Z`;

  svg.innerHTML =
    grid +
    `<path d="${fill}" fill="rgba(0,100,200,0.15)"/>` +
    `<path d="${d}" fill="none" stroke="#00335b" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` +
    `<line id="insp-profile-crosshair" x1="0" y1="${CH_PAD_T}" x2="0" y2="${CH_PAD_T + CH_INNER_H}" stroke="#0064c8" stroke-width="1" visibility="hidden"/>` +
    `<text id="insp-profile-crosshair-lbl" font-size="10" font-weight="600" fill="#00335b" font-family="var(--font,sans-serif)" visibility="hidden"></text>`;

  const lenEl   = el<HTMLSpanElement>('insp-profile-len');
  const rangeEl = el<HTMLSpanElement>('insp-profile-range');
  const deltaEl = el<HTMLSpanElement>('insp-profile-delta');
  if (lenEl)   lenEl.textContent   = formatDistance(totalM);
  if (rangeEl) rangeEl.textContent = `${rawMin.toFixed(0)} m / ${rawMax.toFixed(0)} m`;
  if (deltaEl) deltaEl.textContent = `${(rawMax - rawMin).toFixed(0)} m`;
}

// ── CHART HOVER ───────────────────────────────────────────────────────────────

function onChartMove(e: MouseEvent): void {
  if (!_map || _profileSamples.length === 0) return;
  const svg = e.currentTarget as SVGSVGElement;
  const rect = svg.getBoundingClientRect();
  const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const i = Math.round(t * (_profileSamples.length - 1));
  const sample = _profileSamples[i];
  if (!sample) return;

  // Map hover marker.
  const ll: LngLatLike = { lng: sample.lng, lat: sample.lat };
  if (!_profileHoverMarker) {
    const dot = document.createElement('div');
    dot.style.cssText = 'width:12px;height:12px;border-radius:50%;background:#0064c8;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.3);pointer-events:none';
    _profileHoverMarker = new maplibregl.Marker({ element: dot }).setLngLat(ll).addTo(_map);
  } else {
    _profileHoverMarker.setLngLat(ll);
  }

  // SVG crosshair line + elevation label.
  const x = CH_PAD_L + t * CH_INNER_W;
  const ch  = document.getElementById('insp-profile-crosshair');
  const lbl = document.getElementById('insp-profile-crosshair-lbl');
  if (ch) {
    ch.setAttribute('x1', x.toFixed(1));
    ch.setAttribute('x2', x.toFixed(1));
    ch.setAttribute('visibility', 'visible');
  }
  if (lbl) {
    if (sample.elev !== null) {
      // Flip label sides near the right edge so it doesn't get clipped.
      const flip = t > 0.85;
      lbl.setAttribute('x', flip ? (x - 4).toFixed(1) : (x + 4).toFixed(1));
      lbl.setAttribute('y', (CH_PAD_T + 10).toString());
      lbl.setAttribute('text-anchor', flip ? 'end' : 'start');
      lbl.textContent = `${sample.elev.toFixed(0)} m`;
      lbl.setAttribute('visibility', 'visible');
    } else {
      lbl.setAttribute('visibility', 'hidden');
    }
  }
}

function clearHoverMarker(): void {
  if (_profileHoverMarker) { _profileHoverMarker.remove(); _profileHoverMarker = null; }
  document.getElementById('insp-profile-crosshair')?.setAttribute('visibility', 'hidden');
  document.getElementById('insp-profile-crosshair-lbl')?.setAttribute('visibility', 'hidden');
}

// ── LINE LAYER ────────────────────────────────────────────────────────────────

function ensureLineLayer(map: MaplibreMap): void {
  if (!map.getSource(INSPECT_LINE_SOURCE)) {
    map.addSource(INSPECT_LINE_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] } as FeatureCollection,
    });
  }
  if (!map.getLayer(INSPECT_LINE_LAYER)) {
    map.addLayer({
      id: INSPECT_LINE_LAYER,
      type: 'line',
      source: INSPECT_LINE_SOURCE,
      paint: { 'line-color': '#00335b', 'line-width': 2, 'line-opacity': 0.9 },
    });
  }
}

function setLineData(coords: number[][]): void {
  if (!_map) return;
  const src = _map.getSource(INSPECT_LINE_SOURCE) as GeoJSONSource | undefined;
  if (!src) return;
  if (coords.length < 2) {
    src.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  const line: LineString = { type: 'LineString', coordinates: coords };
  src.setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: line, properties: {} }],
  });
}

// ── GEO HELPERS ───────────────────────────────────────────────────────────────

function haversineMetres(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const R = 6371008.8;
  const toRad = (d: number): number => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function formatDistance(m: number): string {
  if (m < 1000) return `${m.toFixed(0)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}
