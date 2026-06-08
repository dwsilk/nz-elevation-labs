export const API = 'c01kqdevxwya5r94ycabsfw4snt';

export const ELEV_URL = `https://basemaps.linz.govt.nz/v1/tiles/elevation/WebMercatorQuad/{z}/{x}/{y}.png?api=${API}&pipeline=terrain-rgb`;
export const DSM_URL = `https://basemaps.linz.govt.nz/v1/tiles/elevation-dsm/WebMercatorQuad/{z}/{x}/{y}.png?api=${API}&pipeline=terrain-rgb`;

export type DemDsm = 'dem' | 'dsm';
export type HsMethod = 'standard' | 'basic' | 'igor' | 'combined' | 'multidirectional';
export type HsRaster = 'standard' | 'igor';
export type HsAnalysis = 'slope' | 'aspect';
export type HsSource = `terrain:${HsMethod}` | `raster:${HsRaster}` | `analysis:${HsAnalysis}`;

export const HS_URLS: Record<HsRaster, Record<DemDsm, string>> = {
  standard: {
    dem: `https://basemaps.linz.govt.nz/v1/tiles/hillshade/WebMercatorQuad/{z}/{x}/{y}.webp?api=${API}`,
    dsm: `https://basemaps.linz.govt.nz/v1/tiles/hillshade-dsm/WebMercatorQuad/{z}/{x}/{y}.webp?api=${API}`,
  },
  igor: {
    dem: `https://basemaps.linz.govt.nz/v1/tiles/hillshade-igor/WebMercatorQuad/{z}/{x}/{y}.webp?api=${API}`,
    dsm: `https://basemaps.linz.govt.nz/v1/tiles/hillshade-igor-dsm/WebMercatorQuad/{z}/{x}/{y}.webp?api=${API}`,
  },
};

export const AERIAL_URL = `https://basemaps.linz.govt.nz/v1/tiles/aerial/WebMercatorQuad/{z}/{x}/{y}.webp?api=${API}`;

export const COV_GEOJSONS: Record<DemDsm, string> = {
  dem: 'https://nz-elevation.s3-ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dem_1m/2193/capture-dates.geojson',
  dsm: 'https://nz-elevation.s3-ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dsm_1m/2193/capture-dates.geojson',
};

export const COV_SOURCE = 'coverage' as const;
export const COV_FILL = 'coverage-fill' as const;
export const COV_HOVER = 'coverage-hover' as const;
export const COV_OUTLINE = 'coverage-outline' as const;
export const COV_LABELS = 'coverage-labels' as const;
export const COV_LAYERS = [COV_FILL, COV_HOVER, COV_OUTLINE, COV_LABELS] as const;

export const STAC_COLLECTIONS: Record<DemDsm, string> = {
  dem: 'https://nz-elevation.s3-ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dem_1m/2193/collection.json',
  dsm: 'https://nz-elevation.s3-ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dsm_1m/2193/collection.json',
};

export const DIFF_PROTOCOL = 'diff-dem' as const;
export const DIFF_URL = `${DIFF_PROTOCOL}://{z}/{x}/{y}`;
export const DIFF_SOURCE = 'dem-diff' as const;
export const DIFF_LAYER = 'color-relief-diff' as const;

export const ANALYSIS_PROTOCOL = 'analysis-png' as const;
export const ANALYSIS_SOURCE = 'hillshade-analysis' as const;
export const ANALYSIS_LAYER = 'hillshade-analysis-layer' as const;
export const ANALYSIS_URLS: Record<HsAnalysis, Record<DemDsm, string>> = {
  slope: {
    dem: `${ANALYSIS_PROTOCOL}://slope/dem/{z}/{x}/{y}`,
    dsm: `${ANALYSIS_PROTOCOL}://slope/dsm/{z}/{x}/{y}`,
  },
  aspect: {
    dem: `${ANALYSIS_PROTOCOL}://aspect/dem/{z}/{x}/{y}`,
    dsm: `${ANALYSIS_PROTOCOL}://aspect/dsm/{z}/{x}/{y}`,
  },
};

export const INSPECT_LINE_SOURCE = 'inspect-line' as const;
export const INSPECT_LINE_LAYER = 'inspect-line-layer' as const;
export const INSPECT_PROFILE_SAMPLES = 256;

export const EXP_SOURCE = 'export-items' as const;
export const EXP_FILL = 'export-fill' as const;
export const EXP_HOVER = 'export-hover' as const;
export const EXP_OUTLINE = 'export-outline' as const;
export const EXP_LAYERS = [EXP_FILL, EXP_HOVER, EXP_OUTLINE] as const;

export const MAP_CENTER: [number, number] = [172.0, -42.0];
export const MAP_ZOOM = 5;
