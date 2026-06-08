# NZ Elevation Labs

Interactive, experimental elevation visualisation for Aotearoa New Zealand, built on
[LINZ Basemaps](https://basemaps.linz.govt.nz) `terrain-rgb` tile services.

**Live site**: <https://dwsilk.github.io/nz-elevation-labs/>

## Overview

Seven panels, each switchable from the vertical icon rail on the right:

| Panel           | What it does                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Colour ramp** | Configurable hypsometric tinting of the DEM. 12 presets (Terrain → Viridis → Spectral), live-editable colour stops, opacity.                                                                                                                                        |
| **Hillshade**   | MapLibre's dynamic hillshade with five methods (Standard / Basic / Igor / Combined / Multidirectional), illumination direction, sun anchor; pre-rendered raster hillshades and Slope / Aspect raster previews from the LINZ rendering pipeline.                     |
| **Contours**    | Live contour generation from the DEM via [`maplibre-contour`](https://github.com/onthegomap/maplibre-contour). Per-zoom interval pyramid editor, four presets (Standard / Topographic / White / Cyan), independent per-line, per-label, and master opacity sliders. |
| **Difference**  | DSM − DEM on the fly via a custom `diff-png://` MapLibre protocol — surfaces canopy, building heights and earthworks. Diverging colour ramp with transparency at zero.                                                                                              |
| **Coverage**    | LINZ survey capture-date polygons over the country, age choropleth (newest → oldest), year-range slider, per-survey detail card.                                                                                                                                    |
| **Inspect**     | Click for spot elevation, drag for a transect profile chart. Client-side terrain-RGB decode via a shared DEM tile cache — no 3D terrain mode required.                                                                                                              |
| **Export**      | STAC-driven Item browser per dataset (~424 tiles), click for download link to the source GeoTIFF on S3, size + last-modified date pulled via `HEAD` request.                                                                                                        |

On-map controls cover the basemap (None / Aerial / DEM Hillshade / DSM Hillshade / Topolite), the Labels overlay, and DEM and DSM Hillshade blend overlays for combining with any of the panels above. Everything mode-related (panel, dataset, preset, basemap, overlay, 3D terrain on/off) is serialised into the URL hash, so deep-linking works.

## Tech stack

- **[Vite 6](https://vitejs.dev/)** + **TypeScript**
- **[MapLibre GL JS 5](https://maplibre.org/)** for rendering, terrain, custom protocols
- **[maplibre-contour](https://github.com/onthegomap/maplibre-contour)** for client-side contour generation from `terrain-rgb` tiles
- **Vitest + happy-dom** for unit tests, **ESLint + Prettier + Stylelint** for quality, **husky + lint-staged** for pre-commit hooks
- **GitHub Actions** for CI and Pages deploy

No backend — every panel is computed in the browser, either from MapLibre's primitives or from custom protocols that fetch and decode LINZ `terrain-rgb` tiles on demand.

## Data sources

All data is served by [LINZ Basemaps](https://basemaps.linz.govt.nz) under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):

- **`elevation` + `elevation-dsm`** terrain-RGB tilesets — the DEM (bare-earth) and DSM (surface) raster-encoded as Mapbox terrain tiles. Used directly for colour-relief, dynamic hillshade, and contour generation; decoded client-side for the Inspect panel and slope/aspect maps.
- **`hillshade-igor` + `hillshade-igor-dsm`** pre-rendered raster hillshades.
- **`aerial`** raster aerial imagery basemap.
- **`topographic-v2`** vector tiles + **`topolite-v2`** + **`labels-v2`** styles for the basemap switcher and Labels overlay.
- **NZ Elevation Capture Dates** GeoJSON (Coverage tab) — when each survey was flown.
- **NZ Elevation STAC** Collections (Export tab) — STAC Items pointing at the source COGs on S3.

The elevation, aerial, hillshade and vector basemap layers all require an API key. See [LINZ Basemaps](https://basemaps.linz.govt.nz) if you want your own.

## Running locally

Requires **Node 24+**.

```bash
npm install         # installs deps and runs husky to wire pre-commit hooks
npm run dev         # vite dev server, http://localhost:5173
```

Pre-commit hook auto-formats and lints staged files. To run the same checks manually across the whole tree:

```bash
npm run format         # prettier --write .
npm run lint           # eslint src
npm run lint:css       # stylelint src/**/*.css
npm run typecheck      # tsc --noEmit
npm test               # vitest (watch mode)
```

For CI parity in one command:

```bash
npm run format:check && npm run lint && npm run lint:css && npm run typecheck && npm run test:run
```

## Project structure

```
src/
├── main.ts                     # app entry — map init, tab switching, URL hash state
├── modules/
│   ├── config.ts               # tile URLs, layer/source IDs, constants
│   ├── elevation.ts            # colour-ramp presets + buildColorExpr
│   ├── contour.ts              # maplibre-contour wiring + threshold editor
│   ├── coverage.ts             # capture-date polygons, age choropleth, year filter
│   ├── diff.ts                 # diff-png:// custom protocol (DSM − DEM)
│   ├── analysis.ts             # analysis-png:// custom protocol (slope/aspect)
│   ├── inspect.ts              # spot elevation + transect profile
│   ├── export.ts               # STAC item browser + download links
│   ├── basemap.ts              # on-map basemap switcher + overlays + labels
│   ├── hs-thumbs.ts            # hillshade preset preview thumbnails
│   ├── dem-cache.ts            # shared DEM tile cache (terrain-RGB decode + LRU)
│   └── hash.ts                 # URL hash state (read / write)
└── styles/                     # one CSS file per panel + global tokens
```

Tests are co-located as `*.test.ts` next to the module under test.

## CI / deploy

- **CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `format:check → lint → lint:css → typecheck → test:run` on every PR and every push to `main`. The `test` job is a required status check on `main`.
- **Deploy** ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) re-runs the same gate and then `vite build`s + ships the static bundle to GitHub Pages.

## Attribution

Elevation, hillshade, imagery and vector basemap tiles © [Toitū Te Whenua Land Information New Zealand](https://www.linz.govt.nz/) under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
