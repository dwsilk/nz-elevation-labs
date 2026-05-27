import { Map as MaplibreMap } from 'maplibre-gl';
import { ELEV_URL, type HsMethod } from './config.js';

const CENTER: [number, number] = [170.1, -43.6]; // Southern Alps, Mt Cook area
const ZOOM = 8;
const METHODS: HsMethod[] = ['standard', 'basic', 'igor', 'combined', 'multidirectional'];

function setSwatch(btnId: string, bg: string): void {
  const el = document.getElementById(btnId)?.querySelector<HTMLElement>('.hs-pre-sw');
  if (el) el.style.background = bg;
}

function waitFrames(n: number): Promise<void> {
  return n <= 0
    ? Promise.resolve()
    : new Promise(resolve => requestAnimationFrame(() => waitFrames(n - 1).then(resolve)));
}

export async function initTerrainPreviews(): Promise<void> {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:120px;height:26px';
  document.body.appendChild(wrap);

  const m = new MaplibreMap({
    container: wrap,
    style: {
      version: 8,
      sources: {
        dem: { type: 'raster-dem', tiles: [ELEV_URL], tileSize: 256, encoding: 'mapbox' },
      },
      layers: [{
        id: 'hs', type: 'hillshade', source: 'dem',
        paint: {
          'hillshade-method': 'standard',
          'hillshade-illumination-direction': 315,
          'hillshade-exaggeration': 0.5,
          'hillshade-shadow-color': 'rgba(0,0,0,0.5)',
          'hillshade-highlight-color': 'rgba(255,255,255,0.15)',
        },
      }],
    },
    center: CENTER,
    zoom: ZOOM,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    // needed so getCanvas().toDataURL() can read the WebGL framebuffer
    preserveDrawingBuffer: true,
  } as any);

  try {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 10_000);
      m.once('idle', () => { clearTimeout(timeout); resolve(); });
    });

    for (const method of METHODS) {
      m.setPaintProperty('hs', 'hillshade-method', method);
      await waitFrames(3);
      setSwatch(`hs-pre-terrain-${method}`, `url("${m.getCanvas().toDataURL()}") center/cover`);
    }
  } catch (err) {
    console.warn('Hillshade preview render failed:', err);
  } finally {
    m.remove();
    document.body.removeChild(wrap);
  }
}
