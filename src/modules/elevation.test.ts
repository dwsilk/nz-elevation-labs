import { describe, it, expect } from 'vitest';
import { hex2rgb, rgbToHex, colorAt, buildColorExpr, type ColourStop } from './elevation.js';

describe('hex2rgb / rgbToHex', () => {
  it('round-trips canonical hex colours', () => {
    for (const hex of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#4a9e3f']) {
      expect(rgbToHex(hex2rgb(hex))).toBe(hex);
    }
  });

  it('decodes channel values correctly', () => {
    expect(hex2rgb('#0a5c36')).toEqual([0x0a, 0x5c, 0x36]);
    expect(hex2rgb('#ffea46')).toEqual([0xff, 0xea, 0x46]);
  });

  it('zero-pads single-digit channel values when re-encoding', () => {
    // Catch regressions where toString(16) without padStart drops a leading 0.
    expect(rgbToHex([5, 10, 15])).toBe('#050a0f');
  });
});

describe('colorAt', () => {
  const stops: ColourStop[] = [
    { e: 0, c: '#000000' },
    { e: 1000, c: '#808080' },
    { e: 2000, c: '#ffffff' },
  ];

  it('clamps below the lowest stop to the lowest stop colour', () => {
    expect(colorAt(-500, stops)).toEqual([0, 0, 0]);
  });

  it('clamps above the highest stop to the highest stop colour', () => {
    expect(colorAt(5000, stops)).toEqual([255, 255, 255]);
  });

  it('returns the stop colour exactly at a stop boundary', () => {
    expect(colorAt(1000, stops)).toEqual([0x80, 0x80, 0x80]);
  });

  it('interpolates linearly between stops', () => {
    // Half-way between #000000 and #808080 → (64, 64, 64)
    expect(colorAt(500, stops)).toEqual([64, 64, 64]);
    // Half-way between #808080 and #ffffff → (191.5, 191.5, 191.5)
    const mid = colorAt(1500, stops);
    expect(mid[0]).toBeCloseTo(191.5, 5);
    expect(mid[1]).toBeCloseTo(191.5, 5);
    expect(mid[2]).toBeCloseTo(191.5, 5);
  });

  it('sorts the input internally — order-of-stops must not matter', () => {
    const shuffled: ColourStop[] = [
      { e: 2000, c: '#ffffff' },
      { e: 0, c: '#000000' },
      { e: 1000, c: '#808080' },
    ];
    expect(colorAt(500, shuffled)).toEqual([64, 64, 64]);
    expect(colorAt(2500, shuffled)).toEqual([255, 255, 255]);
  });
});

describe('buildColorExpr', () => {
  it('emits MapLibre interpolate-linear with elevation-color pairs', () => {
    const stops: ColourStop[] = [
      { e: 0, c: '#000000' },
      { e: 1000, c: '#ffffff' },
    ];
    expect(buildColorExpr(stops)).toEqual([
      'interpolate',
      ['linear'],
      ['elevation'],
      0,
      '#000000',
      1000,
      '#ffffff',
    ]);
  });

  it('sorts stops by elevation before emitting (URL state can hand us any order)', () => {
    const shuffled: ColourStop[] = [
      { e: 1500, c: '#222222' },
      { e: 0, c: '#000000' },
      { e: 800, c: '#111111' },
    ];
    const expr = buildColorExpr(shuffled);
    // Drop the leading ['interpolate', ['linear'], ['elevation']] and read pairs.
    const pairs = (expr as unknown[]).slice(3);
    const elevations: number[] = [];
    for (let i = 0; i < pairs.length; i += 2) elevations.push(pairs[i] as number);
    expect(elevations).toEqual([0, 800, 1500]);
  });

  it('does not mutate the caller-supplied stops array', () => {
    const stops: ColourStop[] = [
      { e: 1000, c: '#111111' },
      { e: 0, c: '#000000' },
    ];
    const snapshot = stops.map(s => ({ ...s }));
    buildColorExpr(stops);
    expect(stops).toEqual(snapshot);
  });
});
