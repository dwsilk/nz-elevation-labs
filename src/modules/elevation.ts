/**
 * Elevation colour ramp — types, presets, colour helpers,
 * MapLibre expression builder.
 */
import type { ExpressionSpecification } from 'maplibre-gl';

// ── TYPES ─────────────────────────────────────────────────────────────────────

export interface ColourStop {
  /** Elevation in metres */
  e: number;
  /** CSS hex colour e.g. '#4a9e3f' */
  c: string;
}

export interface ColourPreset {
  name: string;
  stops: ColourStop[];
}

// ── PRESETS ───────────────────────────────────────────────────────────────────

export const MAX_ELEV = 3000;

export const PRESETS: ColourPreset[] = [
  {
    name: 'Terrain',
    stops: [
      { e: 0, c: '#0a5c36' },
      { e: 300, c: '#4a9e3f' },
      { e: 800, c: '#c8b56e' },
      { e: 1500, c: '#a07850' },
      { e: 2000, c: '#7a5a3a' },
      { e: 2500, c: '#c8c8c8' },
      { e: 3000, c: '#ffffff' },
    ],
  },
  {
    name: 'Hypsometric',
    stops: [
      { e: 0, c: '#1a6b3c' },
      { e: 400, c: '#8abd5a' },
      { e: 900, c: '#e8d46a' },
      { e: 1600, c: '#c07a30' },
      { e: 2200, c: '#8b5a2b' },
      { e: 3000, c: '#f0ede8' },
    ],
  },
  {
    name: 'Topographic',
    stops: [
      { e: 0, c: '#c8e6b4' },
      { e: 200, c: '#b0d49a' },
      { e: 500, c: '#98c280' },
      { e: 900, c: '#d4b882' },
      { e: 1400, c: '#b89060' },
      { e: 1900, c: '#9e7848' },
      { e: 2400, c: '#d8d0c0' },
      { e: 3000, c: '#f5f5f5' },
    ],
  },
  {
    name: 'Bathymetric',
    stops: [
      { e: 0, c: '#08306b' },
      { e: 200, c: '#08519c' },
      { e: 600, c: '#2171b5' },
      { e: 1000, c: '#4292c6' },
      { e: 1600, c: '#74c476' },
      { e: 2200, c: '#c8b56e' },
      { e: 2700, c: '#d0d0d0' },
      { e: 3000, c: '#ffffff' },
    ],
  },
  {
    name: 'Viridis',
    stops: [
      { e: 0, c: '#440154' },
      { e: 500, c: '#31688e' },
      { e: 1000, c: '#35b779' },
      { e: 1800, c: '#90d743' },
      { e: 3000, c: '#fde725' },
    ],
  },
  {
    name: 'Plasma',
    stops: [
      { e: 0, c: '#0d0887' },
      { e: 600, c: '#7e03a8' },
      { e: 1200, c: '#cc4778' },
      { e: 2000, c: '#f89540' },
      { e: 3000, c: '#f0f921' },
    ],
  },
  {
    name: 'Inferno',
    stops: [
      { e: 0, c: '#000004' },
      { e: 400, c: '#420a68' },
      { e: 900, c: '#932667' },
      { e: 1400, c: '#dd513a' },
      { e: 2000, c: '#fca50a' },
      { e: 3000, c: '#fcffa4' },
    ],
  },
  {
    name: 'Cividis',
    stops: [
      { e: 0, c: '#00204d' },
      { e: 500, c: '#31446b' },
      { e: 1000, c: '#666870' },
      { e: 1500, c: '#958f78' },
      { e: 2000, c: '#c4b86a' },
      { e: 3000, c: '#ffea46' },
    ],
  },
  {
    name: 'Cool-Warm',
    stops: [
      { e: 0, c: '#313695' },
      { e: 600, c: '#4575b4' },
      { e: 1000, c: '#74add1' },
      { e: 1500, c: '#fdae61' },
      { e: 2100, c: '#f46d43' },
      { e: 3000, c: '#a50026' },
    ],
  },
  {
    name: 'Spectral',
    stops: [
      { e: 0, c: '#9e0142' },
      { e: 500, c: '#f46d43' },
      { e: 1000, c: '#fee08b' },
      { e: 1500, c: '#e6f598' },
      { e: 2000, c: '#66c2a5' },
      { e: 3000, c: '#5e4fa2' },
    ],
  },
  {
    name: 'Arctic',
    stops: [
      { e: 0, c: '#1a3a5c' },
      { e: 400, c: '#2e7bb4' },
      { e: 900, c: '#74bcd4' },
      { e: 1500, c: '#c8e8f0' },
      { e: 2200, c: '#e8f4f8' },
      { e: 3000, c: '#ffffff' },
    ],
  },
  {
    name: 'Greyscale',
    stops: [
      { e: 0, c: '#111111' },
      { e: 3000, c: '#ffffff' },
    ],
  },
];

// ── COLOUR HELPERS ────────────────────────────────────────────────────────────

type RGB = [number, number, number];

export function hex2rgb(h: string): RGB {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function colorAt(elev: number, ss: ColourStop[]): RGB {
  const s = [...ss].sort((a, b) => a.e - b.e);
  if (elev <= s[0]!.e) return hex2rgb(s[0]!.c);
  for (let i = 1; i < s.length; i++) {
    if (elev <= s[i]!.e) {
      const t = (elev - s[i - 1]!.e) / (s[i]!.e - s[i - 1]!.e);
      const [r1, g1, b1] = hex2rgb(s[i - 1]!.c);
      const [r2, g2, b2] = hex2rgb(s[i]!.c);
      return [lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t)];
    }
  }
  return hex2rgb(s[s.length - 1]!.c);
}

export function rgbToHex(rgb: RGB): string {
  return '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/** Paint a canvas element with a horizontal colour gradient for the given stops. */
export function paintCanvas(canvas: HTMLCanvasElement, ss: ColourStop[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const s = [...ss].sort((a, b) => a.e - b.e);
  const lo = s[0]!.e;
  const hi = s[s.length - 1]!.e;
  for (let i = 0; i < canvas.width; i++) {
    const [r, g, b] = colorAt(lo + (i / canvas.width) * (hi - lo), s);
    ctx.fillStyle = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
    ctx.fillRect(i, 0, 1, canvas.height);
  }
}

/**
 * Build a MapLibre `color-relief-color` interpolate expression from stops.
 */
export function buildColorExpr(ss: ColourStop[]): ExpressionSpecification {
  const s = [...ss].sort((a, b) => a.e - b.e);
  const expr: ExpressionSpecification = ['interpolate', ['linear'], ['elevation']];
  s.forEach(({ e, c }) => {
    (expr as unknown[]).push(e, c);
  });
  return expr;
}

// ── MUTABLE STATE ─────────────────────────────────────────────────────────────
// Exported as a mutable array so callers can splice/push in place.

export let stops: ColourStop[] = PRESETS[0]!.stops.map(s => ({ ...s }));
export let activePreset = 0;

export function setStops(newStops: ColourStop[]): void {
  stops = newStops;
}
export function setActivePreset(i: number): void {
  activePreset = i;
}
