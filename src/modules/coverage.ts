/**
 * Coverage tab — LINZ NZ elevation capture-dates GeoJSON,
 * age-ramp choropleth, hover/click/year-filter UI.
 */
import type { Map as MaplibreMap, ExpressionSpecification, GeoJSONSourceSpecification } from 'maplibre-gl';
import type { FeatureCollection, Feature, Geometry } from 'geojson';
import {
  COV_GEOJSONS, COV_SOURCE, COV_FILL, COV_HOVER,
  COV_OUTLINE, COV_LABELS, COV_LAYERS,
  type DemDsm,
} from './config.js';

// ── TYPES ─────────────────────────────────────────────────────────────────────

/** Raw properties from the LINZ capture-dates GeoJSON */
interface RawCaptureProperties {
  title?: string;
  Title?: string;
  licensor?: string;
  Licensor?: string;
  producer?: string;
  Producer?: string;
  flown_from?: string;
  flown_to?: string;
  [key: string]: unknown;
}

/** Normalised properties added during load */
interface NormalisedCaptureProperties extends RawCaptureProperties {
  startDate: string;
  endDate: string;
  year_label: string;
  age_t: number;
}

// ── FETCH CACHE ───────────────────────────────────────────────────────────────

const covRawCache: Partial<Record<DemDsm, Promise<FeatureCollection<Geometry, RawCaptureProperties>>>> = {};

function fetchRaw(src: DemDsm): Promise<FeatureCollection<Geometry, RawCaptureProperties>> {
  if (!covRawCache[src]) {
    covRawCache[src] = fetch(COV_GEOJSONS[src]).then(r => r.json() as Promise<FeatureCollection<Geometry, RawCaptureProperties>>);
  }
  return covRawCache[src]!;
}

export function prefetchCoverage(): void {
  fetchRaw('dem');
}

// ── STATE ─────────────────────────────────────────────────────────────────────

let covLoaded     = false;
let covActiveSrc: DemDsm = 'dem';
let covHoverId:    number | null = null;
let covSelectedId: number | null = null;
let covMinDate:    Date | null = null;
let covMaxDate:    Date | null = null;
let covAllFeatures: FeatureCollection<Geometry, NormalisedCaptureProperties> | null = null;
let resetYrSlider: (() => void) | null = null;

// ── DATE HELPERS ──────────────────────────────────────────────────────────────

function dateToYMD(d: Date | null): string {
  return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '—';
}

function tryDate(s: string): Date | null {
  try {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

// ── AREA HELPERS ─────────────────────────────────────────────────────────────

const EARTH_R_KM  = 6371;
const NZ_AREA_KM2 = 268_021;
const DEG2RAD     = Math.PI / 180;

function ringAreaKm2(coords: number[][]): number {
  let sum = 0;
  for (let i = 0, n = coords.length; i < n; i++) {
    const c0 = coords[i]!;
    const c1 = coords[(i + 1) % n]!;
    sum += (c1[0]! - c0[0]!) * DEG2RAD * (Math.sin(c0[1]! * DEG2RAD) + Math.sin(c1[1]! * DEG2RAD));
  }
  return Math.abs(sum) * EARTH_R_KM * EARTH_R_KM / 2;
}

function featureAreaKm2(f: Feature<Geometry, NormalisedCaptureProperties>): number {
  const geo = f.geometry;
  if (geo.type === 'Polygon') {
    let a = ringAreaKm2(geo.coordinates[0] as number[][]);
    for (let i = 1; i < geo.coordinates.length; i++) a -= ringAreaKm2(geo.coordinates[i] as number[][]);
    return Math.max(0, a);
  }
  if (geo.type === 'MultiPolygon') {
    return geo.coordinates.reduce((sum, poly) => {
      let a = ringAreaKm2(poly[0] as number[][]);
      for (let i = 1; i < poly.length; i++) a -= ringAreaKm2(poly[i] as number[][]);
      return sum + Math.max(0, a);
    }, 0);
  }
  return 0;
}

// ── AGE EXPRESSION ───────────────────────────────────────────────────────────

export function buildAgeColorExpr(): ExpressionSpecification {
  return ['interpolate', ['linear'], ['get', 'age_t'],
    0, '#7fbf7b',
    0.5, '#f7f7f7',
    1, '#af8dc3',
  ];
}

// ── YEAR RANGE ────────────────────────────────────────────────────────────────

function featureYears(f: Feature<Geometry, NormalisedCaptureProperties>): string[] {
  const from = f.properties.flown_from ?? '';
  const to   = f.properties.flown_to   ?? from;
  const yrFrom = parseInt(from.slice(0, 4), 10);
  const yrTo   = parseInt(to.slice(0, 4),   10);
  if (!yrFrom) return [];
  const years: string[] = [];
  for (let y = yrFrom; y <= (yrTo || yrFrom); y++) years.push(String(y));
  return years;
}

// ── YEAR RANGE SLIDER ─────────────────────────────────────────────────────────

const ROW_H = 22;

function buildYearRangeSlider(
  features: Feature<Geometry, NormalisedCaptureProperties>[],
  map: MaplibreMap,
): void {
  const section = document.getElementById('yr-range-section');
  if (!section) return;

  const counts: Record<string, number> = {};
  features.forEach(f => featureYears(f).forEach(yr => { counts[yr] = (counts[yr] ?? 0) + 1; }));
  const years = Object.keys(counts).sort().reverse();
  if (years.length === 0) return;

  const N = years.length;
  const maxCnt = Math.max(...Object.values(counts));
  const TRACK_H = (N - 1) * ROW_H;

  let topIdx = 0;
  let botIdx = N - 1;

  function applyFilter(): void {
    const all = covAllFeatures;
    if (!all || !map.getSource(COV_SOURCE)) return;
    const maxYr = parseInt(years[topIdx]!, 10);
    const minYr = parseInt(years[botIdx]!, 10);
    const isAll = topIdx === 0 && botIdx === N - 1;
    const filtered = isAll
      ? all.features
      : all.features.filter(f => {
          const from = parseInt(f.properties.flown_from?.slice(0, 4) ?? '0', 10);
          const to   = parseInt(f.properties.flown_to?.slice(0, 4)   ?? '0', 10) || from;
          return to >= minYr && from <= maxYr;
        });
    (map.getSource(COV_SOURCE) as ReturnType<typeof map.getSource> & { setData: (d: unknown) => void })
      .setData(isAll ? all : { ...all, features: filtered });
    clearCovSelection(map);
    const filteredKm2 = filtered.reduce((s, f) => s + featureAreaKm2(f), 0);
    const el = document.getElementById('cov-filtered-val');
    if (el) el.textContent = `${Math.round(filteredKm2).toLocaleString()} km² — ${(filteredKm2 / NZ_AREA_KM2 * 100).toFixed(1)}% of Aotearoa NZ`;
  }

  // ── DOM ──────────────────────────────────────────────────
  section.innerHTML = '';

  const hd = document.createElement('div');
  hd.className = 'yr-range-hd';
  const hdLabel = document.createElement('span');
  hdLabel.className = 'sec-lbl';
  hdLabel.textContent = 'Surveys by year';
  const resetBtn = document.createElement('button');
  resetBtn.className = 'yr-reset-btn';
  resetBtn.textContent = 'Reset';
  resetBtn.addEventListener('click', () => { topIdx = 0; botIdx = N - 1; updateUI(); applyFilter(); });
  hd.append(hdLabel, resetBtn);
  section.appendChild(hd);

  const wrap = document.createElement('div');
  wrap.className = 'yr-wrap';

  // Labels column
  const labelsCol = document.createElement('div');
  labelsCol.className = 'yr-labels';
  const lblEls: HTMLElement[] = [];
  years.forEach(yr => {
    const d = document.createElement('div');
    d.className = 'yr-lbl yr-active';
    d.style.height = ROW_H + 'px';
    d.textContent = yr;
    labelsCol.appendChild(d);
    lblEls.push(d);
  });

  // Slider column
  const trackCol = document.createElement('div');
  trackCol.className = 'yr-track-col';
  trackCol.style.height = N * ROW_H + 'px';

  const trackEl = document.createElement('div');
  trackEl.className = 'yr-track';
  trackEl.style.top = ROW_H / 2 + 'px';
  trackEl.style.height = TRACK_H + 'px';

  const fillEl = document.createElement('div');
  fillEl.className = 'yr-fill';

  const hTop = document.createElement('div');
  hTop.className = 'yr-handle';

  const hBot = document.createElement('div');
  hBot.className = 'yr-handle';

  trackEl.append(fillEl, hTop, hBot);
  trackCol.appendChild(trackEl);

  // Chart column
  const chartCol = document.createElement('div');
  chartCol.className = 'yr-chart';
  const barFillEls: HTMLElement[] = [];
  const barCntEls: HTMLElement[] = [];
  years.forEach(yr => {
    const cnt = counts[yr] ?? 0;
    const row = document.createElement('div');
    row.className = 'yr-bar-row';
    row.style.height = ROW_H + 'px';

    const barTrack = document.createElement('div');
    barTrack.className = 'yr-bar-track';
    barTrack.style.height = '10px';

    const barFill = document.createElement('div');
    barFill.className = 'yr-bar-fill yr-active';
    barFill.style.width = maxCnt > 0 ? `${(cnt / maxCnt * 100).toFixed(1)}%` : '0%';
    barTrack.appendChild(barFill);

    const cntEl = document.createElement('span');
    cntEl.className = 'yr-bar-cnt yr-active';
    cntEl.textContent = String(cnt);

    row.append(barTrack, cntEl);
    chartCol.appendChild(row);
    barFillEls.push(barFill);
    barCntEls.push(cntEl);
  });

  wrap.append(labelsCol, trackCol, chartCol);
  section.appendChild(wrap);

  const filteredHd = Object.assign(document.createElement('div'), { className: 'sec-lbl' });
  filteredHd.textContent = 'Filtered coverage';
  filteredHd.style.marginTop = '12px';
  const filteredVal = Object.assign(document.createElement('div'), { className: 'cov-val', id: 'cov-filtered-val' });
  const initKm2 = features.reduce((s, f) => s + featureAreaKm2(f), 0);
  filteredVal.textContent = `${Math.round(initKm2).toLocaleString()} km² — ${(initKm2 / NZ_AREA_KM2 * 100).toFixed(1)}% of Aotearoa NZ`;
  section.append(filteredHd, filteredVal);

  // ── Update UI ────────────────────────────────────────────
  function updateUI(): void {
    const topPx = N > 1 ? (topIdx / (N - 1)) * TRACK_H : 0;
    const botPx = N > 1 ? (botIdx / (N - 1)) * TRACK_H : 0;
    hTop.style.top = topPx + 'px';
    hBot.style.top = botPx + 'px';
    fillEl.style.top    = topPx + 'px';
    fillEl.style.height = (botPx - topPx) + 'px';
    years.forEach((_, i) => {
      const on = i >= topIdx && i <= botIdx;
      lblEls[i]?.classList.toggle('yr-active', on);
      barFillEls[i]?.classList.toggle('yr-active', on);
      barCntEls[i]?.classList.toggle('yr-active', on);
    });
  }

  updateUI();

  resetYrSlider = (): void => {
    topIdx = 0; botIdx = N - 1;
    updateUI(); applyFilter();
  };

  // ── Drag ─────────────────────────────────────────────────
  let dragging: 'top' | 'bot' | 'range' | null = null;
  let dragStartY = 0;
  let dragStartTop = 0;
  let dragStartBot = 0;
  let trackClickStartY = 0;
  let trackClickActive = false;

  function idxFromClientY(clientY: number): number {
    const rect = trackEl.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (clientY - rect.top) / TRACK_H));
    return Math.round(pct * (N - 1));
  }

  function onHandleMove(clientY: number): void {
    const idx = idxFromClientY(clientY);
    if (dragging === 'top') topIdx = Math.min(idx, botIdx);
    if (dragging === 'bot') botIdx = Math.max(idx, topIdx);
    updateUI(); applyFilter();
  }

  function onRangeMove(clientY: number): void {
    const span = dragStartBot - dragStartTop;
    const deltaIdx = Math.round((clientY - dragStartY) / ROW_H);
    const newTop = Math.max(0, Math.min(N - 1 - span, dragStartTop + deltaIdx));
    topIdx = newTop; botIdx = newTop + span;
    updateUI(); applyFilter();
  }

  hTop.addEventListener('mousedown', e => {
    dragging = 'top'; hTop.classList.add('yr-dragging');
    e.preventDefault(); e.stopPropagation();
  });
  hBot.addEventListener('mousedown', e => {
    dragging = 'bot'; hBot.classList.add('yr-dragging');
    e.preventDefault(); e.stopPropagation();
  });
  fillEl.addEventListener('mousedown', e => {
    dragging = 'range';
    dragStartY = e.clientY; dragStartTop = topIdx; dragStartBot = botIdx;
    fillEl.classList.add('yr-dragging');
    e.preventDefault(); e.stopPropagation();
  });
  trackEl.addEventListener('mousedown', e => {
    trackClickStartY = e.clientY; trackClickActive = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (dragging === 'top' || dragging === 'bot') onHandleMove(e.clientY);
    else if (dragging === 'range') onRangeMove(e.clientY);
    else if (trackClickActive && Math.abs(e.clientY - trackClickStartY) > 4) trackClickActive = false;
  });
  document.addEventListener('mouseup', e => {
    if (dragging) {
      if (dragging === 'top') hTop.classList.remove('yr-dragging');
      else if (dragging === 'bot') hBot.classList.remove('yr-dragging');
      else fillEl.classList.remove('yr-dragging');
      dragging = null;
    }
    if (trackClickActive) {
      trackClickActive = false;
      const idx = idxFromClientY(e.clientY);
      if (idx < topIdx || idx > botIdx) { topIdx = botIdx = idx; updateUI(); applyFilter(); }
    }
  });

  hTop.addEventListener('touchstart', e => { dragging = 'top'; e.preventDefault(); }, { passive: false });
  hBot.addEventListener('touchstart', e => { dragging = 'bot'; e.preventDefault(); }, { passive: false });
  fillEl.addEventListener('touchstart', e => {
    dragging = 'range';
    dragStartY = e.touches[0]?.clientY ?? 0; dragStartTop = topIdx; dragStartBot = botIdx;
    e.preventDefault();
  }, { passive: false });
  trackEl.addEventListener('touchstart', e => {
    trackClickStartY = e.touches[0]?.clientY ?? 0; trackClickActive = true;
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', e => {
    const y = e.touches[0]?.clientY;
    if (y === undefined) return;
    if (dragging === 'top' || dragging === 'bot') { e.preventDefault(); onHandleMove(y); }
    else if (dragging === 'range') { e.preventDefault(); onRangeMove(y); }
    else if (trackClickActive && Math.abs(y - trackClickStartY) > 4) trackClickActive = false;
  }, { passive: false });
  document.addEventListener('touchend', e => {
    if (dragging) { dragging = null; return; }
    if (trackClickActive) {
      trackClickActive = false;
      const touch = e.changedTouches[0];
      if (touch) {
        const idx = idxFromClientY(touch.clientY);
        if (idx < topIdx || idx > botIdx) { topIdx = botIdx = idx; updateUI(); applyFilter(); }
      }
    }
  });
}

// ── DETAIL CARD ───────────────────────────────────────────────────────────────

function renderCovDetail(props: NormalisedCaptureProperties): void {
  const title    = props.title    ?? props.Title    ?? '—';
  const licensor = props.licensor ?? props.Licensor ?? '—';
  const producer = props.producer ?? props.Producer ?? '—';
  const start    = props.startDate;
  const end      = props.endDate;

  const inner = document.getElementById('cov-detail-inner');
  if (!inner) return;
  inner.innerHTML = `
    <div class="cov-row"><span class="cov-lbl">Title</span><span class="cov-val">${title}</span></div>
    <div class="cov-row"><span class="cov-lbl">Licensor</span><span class="cov-val">${licensor}</span></div>
    <div class="cov-row"><span class="cov-lbl">Producer</span><span class="cov-val">${producer}</span></div>
    <div class="cov-row"><span class="cov-lbl">Temporal extent</span><span class="cov-val">${start} → ${end}</span></div>
  `;
  document.getElementById('cov-detail')?.classList.remove('hidden');
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function clearCovSelection(map: MaplibreMap): void {
  if (covSelectedId !== null) {
    map.setFeatureState({ source: COV_SOURCE, id: covSelectedId }, { selected: false });
    covSelectedId = null;
  }
  document.getElementById('cov-detail')?.classList.add('hidden');
}

// ── LOAD ──────────────────────────────────────────────────────────────────────

function unloadCoverage(map: MaplibreMap): void {
  [...COV_LAYERS].reverse().forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
  if (map.getSource(COV_SOURCE)) map.removeSource(COV_SOURCE);
  covLoaded = false; covHoverId = null; covSelectedId = null;
  covMinDate = null; covMaxDate = null; covAllFeatures = null; resetYrSlider = null;
  document.getElementById('yr-range-section')!.innerHTML = '';
  document.getElementById('cov-stats')?.classList.add('hidden');
  document.getElementById('cov-age-section')?.classList.add('hidden');
  document.getElementById('cov-detail')?.classList.add('hidden');
}

export function switchCoverageSrc(src: DemDsm, map: MaplibreMap, revealOnLoad = false): void {
  if (src === covActiveSrc && covLoaded) return;
  covActiveSrc = src;
  if (covLoaded) { unloadCoverage(map); loadCoverage(map, revealOnLoad); }
}

export function loadCoverage(map: MaplibreMap, revealOnLoad = true): void {
  if (covLoaded) return;
  covLoaded = true;

  fetchRaw(covActiveSrc)
    .then(geojson => {
      // Normalise + compute age_t
      const normFeatures = geojson.features.map((f, i) => {
        const p = f.properties ?? {};
        const start = p.flown_from ?? '';
        const end   = p.flown_to   ?? '';
        const yrFrom = parseInt(start.slice(0, 4), 10);
        const yrTo   = parseInt(end.slice(0, 4), 10) || yrFrom;
        const year_label = yrFrom
          ? (yrTo && yrTo !== yrFrom ? `${yrFrom}-${yrTo}` : `${yrFrom}`)
          : '';
        const normProps: NormalisedCaptureProperties = {
          ...p,
          startDate: start ? start.slice(0, 10) : '—',
          endDate:   end   ? end.slice(0, 10)   : '—',
          year_label,
          age_t: 0, // computed below
        };
        return { ...f, id: i, properties: normProps } as Feature<Geometry, NormalisedCaptureProperties>;
      });

      const featureMids = normFeatures.map(f => {
        const s = f.properties.flown_from ? tryDate(f.properties.flown_from)?.getTime() ?? null : null;
        const e = f.properties.flown_to   ? tryDate(f.properties.flown_to)?.getTime()   ?? null : null;
        if (s !== null && e !== null) return (s + e) / 2;
        return e ?? s ?? null;
      });

      const validMids = featureMids.filter((m): m is number => m !== null);
      covMinDate = validMids.length > 0 ? new Date(Math.min(...validMids)) : null;
      covMaxDate = validMids.length > 0 ? new Date(Math.max(...validMids)) : null;

      const minMs = covMinDate?.getTime() ?? 0;
      const maxMs = covMaxDate?.getTime() ?? 1;
      const span  = maxMs - minMs || 1;

      normFeatures.forEach((f, i) => {
        const mid = featureMids[i] ?? maxMs;
        f.properties.age_t = 1 - (mid - minMs) / span;
      });

      const normGeoJSON: FeatureCollection<Geometry, NormalisedCaptureProperties> = {
        type: 'FeatureCollection',
        features: normFeatures,
      };

      // Coverage area stat
      const totalKm2 = normFeatures.reduce((s, f) => s + featureAreaKm2(f), 0);
      const totalStr = `${Math.round(totalKm2).toLocaleString()} km² — ${(totalKm2 / NZ_AREA_KM2 * 100).toFixed(1)}% of Aotearoa NZ`;
      const statsEl = document.getElementById('cov-stats');
      if (statsEl) {
        statsEl.innerHTML =
          `<div class="sec-lbl">Total coverage</div>` +
          `<div class="cov-val">${totalStr}</div>`;
        statsEl.classList.remove('hidden');
      }

      // Update age legend labels
      document.getElementById('cov-age-newest')!.textContent = dateToYMD(covMaxDate);
      document.getElementById('cov-age-oldest')!.textContent = dateToYMD(covMinDate);
      document.getElementById('cov-age-section')?.classList.remove('hidden');

      map.addSource(COV_SOURCE, { type: 'geojson', data: normGeoJSON, promoteId: 'id' } as GeoJSONSourceSpecification);
      covAllFeatures = normGeoJSON;
      buildYearRangeSlider(normFeatures, map);

      const fillOpacity = Number((document.getElementById('cov-opacity') as HTMLInputElement).value) / 100;

      map.addLayer({
        id: COV_FILL, type: 'fill', source: COV_SOURCE,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': buildAgeColorExpr(),
          'fill-opacity': ['case',
            ['boolean', ['feature-state', 'selected'], false], Math.min(fillOpacity + 0.25, 1),
            ['boolean', ['feature-state', 'hover'],    false], Math.min(fillOpacity + 0.15, 1),
            fillOpacity,
          ],
        },
      });

      map.addLayer({
        id: COV_HOVER, type: 'line', source: COV_SOURCE,
        layout: { visibility: 'none' },
        paint: {
          'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#000000', '#555555'],
          'line-width': ['case',
            ['boolean', ['feature-state', 'selected'], false], 2,
            ['boolean', ['feature-state', 'hover'],    false], 1.5, 0,
          ],
          'line-opacity': ['case',
            ['boolean', ['feature-state', 'hover'],    false], 1,
            ['boolean', ['feature-state', 'selected'], false], 1, 0,
          ],
        },
      });

      map.addLayer({
        id: COV_OUTLINE, type: 'line', source: COV_SOURCE,
        layout: { visibility: 'none' },
        paint: { 'line-color': 'rgba(0,0,0,0.2)' },
      });

      map.addLayer({
        id: COV_LABELS, type: 'symbol', source: COV_SOURCE,
        layout: {
          'text-field': ['get', 'year_label'],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 9, 12, 12],
          'text-anchor': 'center',
          'text-max-width': 8,
          'symbol-placement': 'point',
          visibility: 'none',
        },
        paint: {
          'text-color': '#222222',
          'text-halo-color': 'rgba(255,255,255,0.85)',
          'text-halo-width': 1.5,
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 9, 1],
        },
      });

      // Hover
      map.on('mousemove', COV_FILL, e => {
        map.getCanvas().style.cursor = 'pointer';
        const id = (e.features?.[0]?.id ?? null) as number | null;
        if (covHoverId !== null && covHoverId !== id)
          map.setFeatureState({ source: COV_SOURCE, id: covHoverId }, { hover: false });
        covHoverId = id;
        if (covHoverId !== null)
          map.setFeatureState({ source: COV_SOURCE, id: covHoverId }, { hover: true });
      });

      map.on('mouseleave', COV_FILL, () => {
        map.getCanvas().style.cursor = '';
        if (covHoverId !== null)
          map.setFeatureState({ source: COV_SOURCE, id: covHoverId }, { hover: false });
        covHoverId = null;
      });

      // Click on polygon
      let clickedPolygon = false;
      map.on('click', COV_FILL, e => {
        clickedPolygon = true;
        const f = e.features?.[0];
        if (!f) return;
        const id = f.id as number;
        clearCovSelection(map);
        if (covSelectedId !== id) {
          covSelectedId = id;
          map.setFeatureState({ source: COV_SOURCE, id: covSelectedId }, { selected: true });
          renderCovDetail(f.properties as NormalisedCaptureProperties);
        }
      });

      // Click outside polygons — clear selection
      map.on('click', () => {
        if (clickedPolygon) { clickedPolygon = false; return; }
        if (map.getLayoutProperty(COV_FILL, 'visibility') !== 'visible') return;
        clearCovSelection(map);
      });

      // Reveal layers (only when entering Coverage tab directly)
      if (revealOnLoad) {
        COV_LAYERS.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible'); });
      }
    })
    .catch(err => console.error('Coverage load failed:', err));
}

// ── ENTER / LEAVE ─────────────────────────────────────────────────────────────

export function showCoverageLayers(map: MaplibreMap): void {
  COV_LAYERS.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible'); });
}

export function hideCoverageLayers(map: MaplibreMap): void {
  COV_LAYERS.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); });
  resetYrSlider?.();
}

// ── PANEL CONTROLS ────────────────────────────────────────────────────────────

export function initCoverageControls(map: MaplibreMap): void {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  el<HTMLInputElement>('cov-opacity').addEventListener('input', e => {
    const v = Number((e.target as HTMLInputElement).value);
    el<HTMLSpanElement>('cov-opacity-v').textContent = v + '%';
    if (!map.getLayer(COV_FILL)) return;
    const op = v / 100;
    map.setPaintProperty(COV_FILL, 'fill-opacity', ['case',
      ['boolean', ['feature-state', 'selected'], false], Math.min(op + 0.25, 1),
      ['boolean', ['feature-state', 'hover'],    false], Math.min(op + 0.15, 1),
      op,
    ]);
  });

  el<HTMLInputElement>('tog-cov-labels').addEventListener('change', e => {
    if (!map.getLayer(COV_LABELS)) return;
    map.setLayoutProperty(COV_LABELS, 'visibility', (e.target as HTMLInputElement).checked ? 'visible' : 'none');
  });

  el<HTMLInputElement>('tog-cov-outline').addEventListener('change', e => {
    if (!map.getLayer(COV_OUTLINE)) return;
    map.setLayoutProperty(COV_OUTLINE, 'visibility', (e.target as HTMLInputElement).checked ? 'visible' : 'none');
  });

  el<HTMLButtonElement>('cov-clear-btn').addEventListener('click', () => clearCovSelection(map));
}
