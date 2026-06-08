import { describe, it, expect, beforeEach } from 'vitest';
import { readHash, setHashParam } from './hash.js';

// happy-dom's window.history.replaceState updates window.location.href, so
// readHash() reflects whatever setHashParam() just wrote — these tests run
// the full round-trip rather than mocking either side.
function setLocation(hash: string): void {
  // Use replaceState directly to avoid happy-dom's navigation warning.
  window.history.replaceState(window.history.state, '', `/${hash}`);
}

describe('readHash', () => {
  beforeEach(() => setLocation(''));

  it('returns {} for an empty hash', () => {
    expect(readHash()).toEqual({});
  });

  it('parses k=v pairs separated by &', () => {
    setLocation('#mode=hillshade&preset=dynamic.igor&dataset=dsm');
    expect(readHash()).toEqual({
      mode: 'hillshade', preset: 'dynamic.igor', dataset: 'dsm',
    });
  });

  it('records bare keys (no =) with an empty-string value', () => {
    // The `&terrain` shape carries "on" state without a verbose `=true`. The
    // initial &mode= here also tests that an explicit-empty-value isn't
    // treated specially — only the bare-key form matters.
    setLocation('#mode=hillshade&terrain');
    expect(readHash()).toEqual({ mode: 'hillshade', terrain: '' });
  });

  it('ignores the leading map-camera fragment that MapLibre writes', () => {
    // MapLibre's hash:'map' writes `#zoom/lat/lng` which has no `=`. We rely
    // on it being treated like an unnamed bare key (i.e. dropped or ignored
    // by app-state restoration). The current parser stores it under key
    // `14.3/-41.286/174.776` with empty value — harmless because we never
    // look up that key.
    setLocation('#14.3/-41.286/174.776&mode=hillshade');
    const h = readHash();
    expect(h.mode).toBe('hillshade');
    expect(Object.keys(h)).toContain('14.3/-41.286/174.776');
  });
});

describe('setHashParam', () => {
  beforeEach(() => setLocation(''));

  it('round-trips with readHash', () => {
    setHashParam('mode', 'hillshade');
    setHashParam('preset', 'dynamic.igor');
    expect(readHash()).toEqual({ mode: 'hillshade', preset: 'dynamic.igor' });
  });

  it('serializes empty-string values as bare keys (&terrain not &terrain=)', () => {
    // This is the form that bit the team during URL-restore work — round-trip
    // must round-trip the bare-key form, not promote it to `terrain=`.
    setHashParam('terrain', '');
    expect(window.location.hash).toBe('#terrain');
    expect(readHash()).toEqual({ terrain: '' });
  });

  it('removes a key when called with null', () => {
    setHashParam('mode', 'hillshade');
    setHashParam('dataset', 'dsm');
    setHashParam('mode', null);
    expect(readHash()).toEqual({ dataset: 'dsm' });
  });

  it('strips the hash entirely when the last key is removed', () => {
    setHashParam('mode', 'hillshade');
    setHashParam('mode', null);
    expect(window.location.hash).toBe('');
  });

  it('preserves existing params when setting a new one', () => {
    setLocation('#mode=hillshade&dataset=dsm');
    setHashParam('preset', 'dynamic.igor');
    expect(readHash()).toEqual({ mode: 'hillshade', dataset: 'dsm', preset: 'dynamic.igor' });
  });

  it('overwrites an existing key in place rather than appending a duplicate', () => {
    setHashParam('mode', 'hillshade');
    setHashParam('mode', 'contour');
    const h = readHash();
    expect(h.mode).toBe('contour');
    // No duplicate `mode=...&mode=...` in the serialized form.
    expect(window.location.hash.match(/mode=/g)?.length ?? 0).toBe(1);
  });
});
