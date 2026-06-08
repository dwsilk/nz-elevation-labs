/**
 * URL hash state — shared by every panel that wants to round-trip a piece of
 * view state through the URL (mode, dataset, preset, terrain, basemap, etc.).
 *
 * Format: `#k=v&k2=v2`. A param with an empty string value is serialized as a
 * bare key (`&terrain` not `&terrain=`) so toggle-style flags read naturally
 * when the URL is shared. readHash() and setHashParam() round-trip that form.
 *
 * MapLibre's hash:'map' lives at the head of the same hash (e.g.
 * `#14.3/-41.286/174.776`), separated by `&` from our params — the parsers
 * here ignore the leading map fragment because it has no `=` and is harmless
 * as an unnamed bare key.
 */

export function readHash(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of window.location.hash.replace(/^#/, '').split('&')) {
    if (!part) continue;
    const [k, v] = part.split('=');
    if (k) out[k] = v ?? '';
  }
  return out;
}

export function setHashParam(key: string, value: string | null): void {
  const params = readHash();
  if (value === null) delete params[key];
  else params[key] = value;
  const parts = Object.entries(params).map(([k, v]) => (v === '' ? k : `${k}=${v}`));
  const newHash = parts.length ? `#${parts.join('&')}` : '';
  window.history.replaceState(
    window.history.state,
    '',
    window.location.href.replace(/(#.*)?$/, newHash),
  );
}
