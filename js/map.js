// ============================================================
// Ocean Futures — Explorer map (MapLibre GL JS)
// Vector basemap: OpenFreeMap "dark" style (free, no API key).
// MapLibre GL JS was chosen over Leaflet specifically because two
// requested features — a globe projection and toggleable country
// borders — need a vector-tile WebGL renderer; raster XYZ tiles
// can't do either. See map-data.js for full dataset provenance.
//
// Single-select model: exactly one data layer is visible at a
// time, chosen from a collapsible "Select a map" dropdown.
// ============================================================

let map;
let activeLayerKey = null;
let sstFeaturesRaw = null; // real NOAA cells, unscaled
let sstGrid = null; // { lookup: Map, nx, ny } — today's real snapshot, used before timeline data loads
let sealevelIndex = null; // { points, xyz, buckets, cell } — real NOAA tide-gauge stations
let seaiceIndex = null; // { stations, buckets, cellDeg } — real NOAA/NSIDC points, today's snapshot
let phGrid = null; // { lookup: Map, nx, ny } — real GLODAPv2 1° grid
let salinityGrid = null; // { lookup: Map, nx, ny } — real GLODAPv2 1° grid
let aisTimer = null;
let tourStep = -1;
let showingGlobe = false;
let bordersHidden = false;

// ---------------------------------------------------------------
// HISTORICAL TIMELINE state — see the provenance note above
// SST_TIMELINE_URL in map-data.js for what's real per layer. Each
// timeline-capable layer's "year" is always a real historical year
// plus play/pause state; year-specific lookup grids are built lazily
// and cached so scrubbing back to an already-visited year is instant.
// SST's future +2.0°C/+3.0°C projections (WARMING_SCENARIOS) are a
// separate, non-timeline override — see sstScenario below.
// ---------------------------------------------------------------
const TIMELINE_LAYERS = ["sst", "seaice", "sealevel"];
let sstTimeline = null; // { cells, years, values } — fetched on first sst select
let seaiceTimeline = null; // { cells, years, values }
const sstYearGridCache = new Map();
const seaiceYearIndexCache = new Map();
const sealevelYearIndexCache = new Map();
const timelineState = {
  sst: { year: null, playing: false, timer: null },
  seaice: { year: null, playing: false, timer: null },
  sealevel: { year: null, playing: false, timer: null },
};
// SST's +2.0°C / +3.0°C future projections (WARMING_SCENARIOS) are not
// real historical data, so they live outside the timeline entirely —
// their own box next to the legend, toggled independently. null means
// "show the real year from timelineState.sst.year" (the normal case).
let sstScenario = null;

const BORDER_LAYER_IDS = ["boundary_country_z0-4", "boundary_country_z5-"];
const CLIMATE_LAYERS = ["sst", "sealevel", "seaice", "acidity", "salinity"];
const LAYER_LABELS = {
  sst: "Sea Surface Temperature",
  sealevel: "Sea Level Trend",
  seaice: "Sea Ice Concentration",
  acidity: "Ocean Acidity (pH)",
  salinity: "Sea Surface Salinity",
  mpa: "Marine Protected Areas",
  reef: "Coral Reef Extent",
  kelp: "Kelp & Algae Forests",
  mangrove: "Mangroves",
  saltmarsh: "Salt Marshes",
  tidalflat: "Tidal Flats",
  birds: "Birds",
  reptiles: "Reptiles",
  mammals: "Mammals",
  ais: "Live Vessel Positions",
  corridors: "Major Trade Corridors",
};

const loadingEl = () => document.getElementById("mapLoading");
function showLoading(msg) {
  const el = loadingEl();
  if (!el) return;
  el.querySelector(".ml-text").textContent = msg;
  el.classList.add("show");
}
function hideLoading() {
  loadingEl()?.classList.remove("show");
}

// ---------------------------------------------------------------
// INIT
// ---------------------------------------------------------------

function initMap() {
  const mapEl = document.getElementById("oceanMap");
  if (!mapEl || typeof maplibregl === "undefined") return;

  showLoading("Loading ocean data…");

  map = new maplibregl.Map({
    container: "oceanMap",
    style: "https://tiles.openfreemap.org/styles/dark",
    center: [10, 15],
    zoom: 1.4,
    minZoom: 1,
    maxZoom: 9,
    preserveDrawingBuffer: true, // required for the screenshot toolbar button
    attributionControl: false,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
  // MapLibre's compact attribution control (the "i" info button,
  // bottom-left) decides for itself whether to start open based on
  // container width, and re-decides on every resize/load pass — a
  // single removeAttribute() at construction time gets overwritten
  // moments later. Force it closed on load/idle/resize instead, every
  // time, until the user actually clicks it themselves.
  const collapseAttrib = () => {
    const el = mapEl.querySelector(".maplibregl-ctrl-attrib");
    if (el && el.hasAttribute("open") && !el.dataset.userOpened) {
      el.removeAttribute("open");
      el.classList.remove("maplibregl-compact-show");
    }
  };
  mapEl.querySelector(".maplibregl-ctrl-attrib")?.addEventListener("click", (e) => {
    const el = e.currentTarget;
    setTimeout(() => { el.dataset.userOpened = el.hasAttribute("open") ? "1" : ""; }, 0);
  });
  collapseAttrib();
  map.on("resize", collapseAttrib);
  map.on("idle", collapseAttrib);

  map.on("load", async () => {
    await buildAllLayers();
    ["boundary_state", "place_state"].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
    });
    boostBorderVisibility();
    setupPanel();
    setupToolbar();
    openGroupFromQuery();
    hideLoading();
  });
}

// Deep-links from elsewhere on the site (the footer's Maps column
// links to map.html?group=ecosystems etc.) land here with that
// section pre-opened in the "Select a map" dropdown, instead of
// dropping the visitor on a closed menu they have to find themselves.
function openGroupFromQuery() {
  const key = new URLSearchParams(location.search).get("group");
  if (!key) return;
  const group = document.querySelector(`.map-group[data-group="${key}"]`);
  if (!group) return;
  document.getElementById("mapSelect")?.classList.add("open");
  document.querySelectorAll(".map-group").forEach((g) => g.classList.remove("open"));
  group.classList.add("open");
  group.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------
// GEOJSON HELPERS
// ---------------------------------------------------------------

function fc(features) {
  return { type: "FeatureCollection", features };
}
function pt(lon, lat, props) {
  return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props || {} };
}
function areaFC(data, layerKey) {
  const sizes = data.map((d) => d[3]);
  const min = Math.min(...sizes), max = Math.max(...sizes);
  return fc(
    data.map(([name, lat, lon, radiusKm, note]) => {
      const norm = max > min ? (radiusKm - min) / (max - min) : 0.5;
      return pt(lon, lat, { name, note, sizeMult: 0.6 + norm * 1.8, layer: layerKey });
    })
  );
}
function speciesFC(data) {
  return fc(
    data.map(([name, code, lat, lon, note]) => pt(lon, lat, { name, code, note, color: IUCN_COLORS[code], label: IUCN_LABELS[code] }))
  );
}
function areaRadiusExpr() {
  return ["interpolate", ["linear"], ["zoom"], 1, ["*", 4, ["get", "sizeMult"]], 5, ["*", 12, ["get", "sizeMult"]], 9, ["*", 26, ["get", "sizeMult"]]];
}

// ---------------------------------------------------------------
// BUILD ALL SOURCES + LAYERS
// ---------------------------------------------------------------

async function buildAllLayers() {
  await buildEcosystemLayers();
  buildBiodiversityLayers();
  buildCorridorLayer();
  await loadClimateData();
  buildClimateRasterLayers();
  await buildLandMask();
  buildAISLayer();
  bindPopups();
  bindClimateClicks();
}

// The basemap has no full-coverage "land" layer (land is just its dark
// background color; landcover/landuse layers only cover specific
// sub-areas like forests or parks). Without a real opaque land layer,
// the climate rasters' own land/ocean edge — only as precise as the
// source data's 2° grid — showed through as a blocky mismatch against
// the real coastline. This adds real Natural Earth land polygons,
// colored to match the basemap's background exactly, directly above
// the raster layers to mask them with an accurate coastline.
async function buildLandMask() {
  const res = await fetch("data/land_110m.geojson");
  const geojson = await res.json();
  map.addSource("land-mask", { type: "geojson", data: geojson });
  map.addLayer(
    { id: "land-mask", type: "fill", source: "land-mask", paint: { "fill-color": "rgb(12,12,12)", "fill-antialias": true } },
    CLIMATE_BEFORE_ID
  );
}

// The basemap's own country-border lines are faint against colorful
// raster layers — brighten and thicken them so they stay legible over
// any active climate layer.
function boostBorderVisibility() {
  BORDER_LAYER_IDS.forEach((id) => {
    if (!map.getLayer(id)) return;
    map.setPaintProperty(id, "line-color", "rgba(255,255,255,0.55)");
    map.setPaintProperty(id, "line-width", ["interpolate", ["linear"], ["zoom"], 1, 0.6, 5, 1, 9, 1.6]);
  });
}

function addCircleLayer(id, geojson, paint, extraLayout) {
  map.addSource(id, { type: "geojson", data: geojson });
  map.addLayer({
    id,
    type: "circle",
    source: id,
    layout: Object.assign({ visibility: "none" }, extraLayout || {}),
    paint,
  });
}

// MPAs, real traced boundaries where OSM has them (fetched live from
// Overpass — see data/mpa_boundaries.geojson and the provenance note
// atop map-data.js), a representative-extent circle for the rest.
async function buildMpaLayer() {
  let boundaries = { type: "FeatureCollection", features: [] };
  try {
    const res = await fetch(MPA_BOUNDARIES_URL);
    if (res.ok) boundaries = await res.json();
  } catch (e) {
    console.warn("MPA boundaries fetch failed, falling back to circles only", e);
  }
  const tracedNames = new Set(boundaries.features.map((f) => f.properties.name));

  map.addSource("mpa-boundaries", { type: "geojson", data: boundaries });
  map.addLayer({
    id: "mpa-fill", type: "fill", source: "mpa-boundaries",
    layout: { visibility: "none" },
    paint: { "fill-color": "#7BC99A", "fill-opacity": 0.22 },
  });
  map.addLayer({
    id: "mpa-line", type: "line", source: "mpa-boundaries",
    layout: { visibility: "none" },
    paint: { "line-color": "#7BC99A", "line-width": 1.4, "line-opacity": 0.85 },
  });

  const circleOnly = MPA_DATA.filter(([name]) => !tracedNames.has(name));
  addCircleLayer("mpa", areaFC(circleOnly.map(([name, auth, lat, lon, area, year]) => [name, lat, lon, Math.sqrt(area / Math.PI), `${auth} · ${area.toLocaleString()} km² · designated ${year}`]), "mpa"),
    { "circle-radius": areaRadiusExpr(), "circle-color": "#7BC99A", "circle-opacity": 0.22, "circle-stroke-color": "#7BC99A", "circle-stroke-width": 1.3 });
}

async function buildEcosystemLayers() {
  await buildMpaLayer();
  addCircleLayer("reef", areaFC(CORAL_REEF_DATA, "reef"),
    { "circle-radius": areaRadiusExpr(), "circle-color": "#E0836B", "circle-opacity": 0.24, "circle-stroke-color": "#E0836B", "circle-stroke-width": 1.2 });
  addCircleLayer("kelp", areaFC(KELP_FOREST_DATA, "kelp"),
    { "circle-radius": areaRadiusExpr(), "circle-color": "#4FA98C", "circle-opacity": 0.24, "circle-stroke-color": "#4FA98C", "circle-stroke-width": 1.2 });
  addCircleLayer("mangrove", areaFC(MANGROVE_DATA, "mangrove"),
    { "circle-radius": areaRadiusExpr(), "circle-color": "#9C7A4A", "circle-opacity": 0.26, "circle-stroke-color": "#9C7A4A", "circle-stroke-width": 1.2 });
  addCircleLayer("saltmarsh", areaFC(SALTMARSH_DATA, "saltmarsh"),
    { "circle-radius": areaRadiusExpr(), "circle-color": "#C9B24A", "circle-opacity": 0.26, "circle-stroke-color": "#C9B24A", "circle-stroke-width": 1.2 });
  addCircleLayer("tidalflat", areaFC(TIDAL_FLAT_DATA, "tidalflat"),
    { "circle-radius": areaRadiusExpr(), "circle-color": "#8FA6AC", "circle-opacity": 0.26, "circle-stroke-color": "#8FA6AC", "circle-stroke-width": 1.2 });
}

function buildBiodiversityLayers() {
  const radius = ["interpolate", ["linear"], ["zoom"], 1, 3, 5, 6, 9, 10];
  addCircleLayer("birds", speciesFC(BIRD_SPECIES), { "circle-radius": radius, "circle-color": ["get", "color"], "circle-opacity": 0.85, "circle-stroke-color": "#0A2B39", "circle-stroke-width": 1 });
  addCircleLayer("reptiles", speciesFC(REPTILE_SPECIES), { "circle-radius": radius, "circle-color": ["get", "color"], "circle-opacity": 0.85, "circle-stroke-color": "#0A2B39", "circle-stroke-width": 1 });
  addCircleLayer("mammals", speciesFC(MAMMAL_SPECIES), { "circle-radius": radius, "circle-color": ["get", "color"], "circle-opacity": 0.85, "circle-stroke-color": "#0A2B39", "circle-stroke-width": 1 });
}

function buildCorridorLayer() {
  const geojson = fc(
    SHIPPING_ROUTES.map((r) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: r.points.map(([lat, lon]) => [lon, lat]) },
      properties: { name: r.name },
    }))
  );
  map.addSource("corridors", { type: "geojson", data: geojson });
  map.addLayer({
    id: "corridors",
    type: "line",
    source: "corridors",
    layout: { visibility: "none", "line-cap": "round" },
    paint: { "line-color": "#8FA6AC", "line-width": 1.6, "line-opacity": 0.7, "line-dasharray": [1, 2] },
  });
}

// ---------------------------------------------------------------
// CLIMATE — smooth interpolated raster layers. Each is rendered to
// a canvas at 0.5°/pixel and added as a MapLibre image source
// positioned just above the water fill and below every land layer
// in the basemap style, so the vector coastlines (real, precise)
// mask the raster automatically — no separate land mask needed.
// ---------------------------------------------------------------

const RASTER_W = 720, RASTER_H = 360; // 0.5°/pixel
const RASTER_LAT_MAX = 89.9; // exactly ±90 makes MapLibre's image source bounds math produce Infinity, but anything short of it is fine — 89.9 covers real polar data (e.g. sea ice) almost to the pole instead of clipping it off at the old 85.05° Mercator convention
const RASTER_COORDS = [[-180, RASTER_LAT_MAX], [180, RASTER_LAT_MAX], [180, -RASTER_LAT_MAX], [-180, -RASTER_LAT_MAX]];
const CLIMATE_BEFORE_ID = "landcover_ice_shelf";

// MapLibre's "image" source just warps the bitmap linearly between its 4
// corner coordinates — it does not reproject. A bitmap sampled evenly in
// degrees-latitude therefore lands in the wrong place once the corners
// reach up near the pole, where Mercator's own vertical scale is hugely
// nonlinear vs. latitude (this silently broke sea-ice rendering entirely
// when RASTER_LAT_MAX was raised from 85.05° to 89.9°). Sampling evenly in
// Mercator-Y instead, and inverting back to latitude per row, keeps every
// row aligned with where MapLibre actually places it on screen.
function mercatorY(latDeg) {
  const rad = (latDeg * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + rad / 2));
}
function inverseMercatorY(y) {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}
const RASTER_MERC_MAX = mercatorY(RASTER_LAT_MAX);

async function loadClimateData() {
  const [sstRes, slRes, iceRes, phRes, salRes] = await Promise.all([
    fetch(SST_DATA_URL),
    fetch(SEALEVEL_DATA_URL),
    fetch(SEAICE_DATA_URL),
    fetch(PH_DATA_URL),
    fetch(SALINITY_DATA_URL),
  ]);
  sstFeaturesRaw = await sstRes.json(); // [[lat, lon, anomaly], ...]
  sstGrid = buildSSTGrid(sstFeaturesRaw);
  const stations = await slRes.json(); // [[lat, lon, name, country, trend, startyear, endyear], ...]
  sealevelIndex = buildSphereIndex(stations);
  const iceCells = await iceRes.json(); // [[lat, lon, concentration 0-1], ...] real NOAA/NSIDC G02202 v6
  seaiceIndex = buildSphereIndex(iceCells);
  const phCells = await phRes.json(); // [[lat, lon, pH], ...] real GLODAPv2.2016b surface climatology
  phGrid = buildRegularGrid(phCells, 360, 180);
  const salCells = await salRes.json(); // [[lat, lon, PSU], ...] real GLODAPv2.2016b surface climatology
  salinityGrid = buildRegularGrid(salCells, 360, 180);
}

// ---- SST: regular 2° grid, bilinear interpolation. The source data
// is ocean-only (land cells absent) at a coarse 2° resolution, which
// doesn't align with the real coastline the land-mask layer draws —
// small islands, bays and fjords get miscategorized at that
// resolution. Rather than leave those grid cells transparent (which
// produced blocky black gaps along real coastlines), every missing
// cell is flood-filled with its nearest ocean value up front, so the
// raster is fully opaque everywhere and the separate, real-coastline
// land-mask layer handles 100% of the land/ocean masking. ----
function buildSSTGrid(cells) {
  const nx = 180, ny = 89;
  const grid = new Array(nx * ny).fill(null);
  cells.forEach(([lat, lon, anomaly]) => {
    const i = Math.round((lon + 180) / 2) % nx;
    const j = Math.round((lat + 88) / 2);
    grid[j * nx + i] = anomaly;
  });
  const filled = grid.slice();
  const visited = new Uint8Array(nx * ny);
  const queue = [];
  for (let idx = 0; idx < nx * ny; idx++) {
    if (grid[idx] !== null) { visited[idx] = 1; queue.push(idx); }
  }
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const j = Math.floor(idx / nx), i = idx % nx;
    const neighbors = [[(i - 1 + nx) % nx, j], [(i + 1) % nx, j], [i, j - 1], [i, j + 1]];
    neighbors.forEach(([ni, nj]) => {
      if (nj < 0 || nj >= ny) return;
      const nidx = nj * nx + ni;
      if (!visited[nidx]) {
        visited[nidx] = 1;
        filled[nidx] = filled[idx];
        queue.push(nidx);
      }
    });
  }
  const lookup = new Map();
  for (let idx = 0; idx < nx * ny; idx++) lookup.set((idx % nx) + "_" + Math.floor(idx / nx), filled[idx]);
  return { lookup, nx, ny };
}
function nearestSST(lat, lon, scale, grid) {
  const i = ((Math.round((lon + 180) / 2) % 180) + 180) % 180;
  const j = Math.max(0, Math.min(88, Math.round((lat + 88) / 2)));
  const v = (grid || sstGrid).lookup.get(i + "_" + j);
  return v === undefined ? null : v * scale;
}

// ---- Per-year SST grid, built lazily from the real ERSSTv5 timeline
// (map-data.js SST_TIMELINE_URL) and cached so re-visiting a year
// during scrubbing/playback is instant. Falls back to today's single
// real snapshot (sstGrid) whenever the timeline hasn't loaded yet or
// the requested year isn't one of the real fetched steps. ----
function sstGridForYear(year) {
  if (!sstTimeline) return sstGrid;
  if (sstYearGridCache.has(year)) return sstYearGridCache.get(year);
  const values = sstTimeline.values[String(year)];
  if (!values) return sstGrid;
  const triples = sstTimeline.cells.map((c, i) => [c[0], c[1], values[i]]);
  const grid = buildSSTGrid(triples);
  sstYearGridCache.set(year, grid);
  return grid;
}

// ---- Real scattered point data (tide-gauge stations; reprojected
// NOAA/NSIDC sea-ice cells): bucketed in 3D unit-sphere Cartesian
// space rather than lat/lon, so neighbor search isn't distorted near
// the poles or the antimeridian, where flat lat/lon distance breaks
// down — binning this same polar-projected data onto a flat
// equirectangular grid instead looked badly pixelated near the pole
// (longitude bins get physically tiny there), so both sea level's IDW
// blend and sea ice's nearest-point lookup go through this sphere
// index; buildRasterDataURL's reduced sample-resolution option keeps
// either one fast enough for the play/pause timeline. ----
function toUnitXYZ(lat, lon) {
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  const cl = Math.cos(la);
  return [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)];
}
function buildSphereIndex(points) {
  const cell = 0.05; // bucket size in unit-sphere units
  let minLat = Infinity, maxLat = -Infinity;
  const xyz = points.map((p) => {
    if (p[0] < minLat) minLat = p[0];
    if (p[0] > maxLat) maxLat = p[0];
    return toUnitXYZ(p[0], p[1]);
  });
  const buckets = new Map();
  xyz.forEach(([x, y, z], i) => {
    const key = Math.floor(x / cell) + "," + Math.floor(y / cell) + "," + Math.floor(z / cell);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  });
  return { points, xyz, buckets, cell, minLat, maxLat };
}
// Visits exactly the cells on the surface of the cubic shell at
// bucket-offset radius r around (cx,cy,cz) — O(r^2) cells, not the
// O(r^3) a naive "loop the whole (2r+1)^3 cube and skip interior
// cells" approach costs. That cubic blow-up is cheap at the small
// radii most queries resolve at, but becomes ruinously slow (whole
// seconds per raster) once a search has to expand far — e.g. an
// ocean pixel with no real station anywhere nearby — so both sphere
// searches below share this efficient version instead.
function forEachShellCell(cx, cy, cz, r, visit) {
  if (r === 0) { visit(cx, cy, cz); return; }
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      if (Math.abs(dx) === r || Math.abs(dy) === r) {
        for (let dz = -r; dz <= r; dz++) visit(cx + dx, cy + dy, cz + dz);
      } else {
        visit(cx + dx, cy + dy, cz - r);
        visit(cx + dx, cy + dy, cz + r);
      }
    }
  }
}
// Single-nearest-point search over the same sphere index — used for
// sea ice, where each real measurement is its own value rather than
// something to blend with neighbors.
function nearestOnSphere(lat, lon, index, valueIdx) {
  if (valueIdx === undefined) valueIdx = 4;
  const { points, xyz, buckets, cell, minLat, maxLat } = index;
  if (lat < minLat - 2 || lat > maxLat + 2) return null;
  const [x, y, z] = toUnitXYZ(lat, lon);
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
  let best = -1, bestD = Infinity;
  for (let r = 0; r <= 10; r++) {
    forEachShellCell(cx, cy, cz, r, (bx, by, bz) => {
      const arr = buckets.get(bx + "," + by + "," + bz);
      if (!arr) return;
      arr.forEach((i) => {
        const [px, py, pz] = xyz[i];
        const d = (px - x) * (px - x) + (py - y) * (py - y) + (pz - z) * (pz - z);
        if (d < bestD) { bestD = d; best = i; }
      });
    });
    if (best >= 0 && r >= 1) break;
  }
  return best >= 0 ? points[best][valueIdx] : null;
}
// Blends the k nearest real points by inverse-distance weighting
// instead of taking only the single closest one — used for sea
// level, where 510 tide gauges are too sparse for a nearest-neighbor
// raster to look like anything but a blocky Voronoi mosaic. The
// blended surface is still built entirely from real station values,
// just smoothed between them the same way any continuous field
// derived from point measurements is.
//
// A real station count here never exceeds ~510 (sea level's only
// caller), so this scans every point directly instead of going
// through the bucketed shell search above: it's both simpler and
// faster at this size, and — unlike a radius-capped shell search —
// it always finds the true k nearest stations regardless of how far
// away they are, so coverage is never artificially bounded by
// distance or latitude the way an early-exit cutoff used to leave a
// large blank band over the sparsely-gauged Southern Ocean.
function idwOnSphere(lat, lon, index, k, valueIdx) {
  if (valueIdx === undefined) valueIdx = 4;
  const { points, xyz } = index;
  const n = xyz.length;
  if (n === 0) return null;
  const [x, y, z] = toUnitXYZ(lat, lon);
  // Manual insertion-sorted top-k instead of scoring+sorting all n
  // points per pixel — k is tiny (6), so this is a handful of
  // comparisons per station rather than an allocation-heavy sort,
  // which matters since this runs for every raster pixel.
  const bestD = new Array(k).fill(Infinity);
  const bestI = new Array(k).fill(-1);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const p = xyz[i];
    const dx = p[0] - x, dy = p[1] - y, dz = p[2] - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (count < k || d < bestD[k - 1]) {
      let j = count < k ? count : k - 1;
      while (j > 0 && bestD[j - 1] > d) { bestD[j] = bestD[j - 1]; bestI[j] = bestI[j - 1]; j--; }
      bestD[j] = d; bestI[j] = i;
      if (count < k) count++;
    }
  }
  let wsum = 0, vsum = 0;
  for (let j = 0; j < count; j++) {
    const w = 1 / Math.max(bestD[j], 1e-6);
    wsum += w; vsum += w * points[bestI[j]][valueIdx];
  }
  return vsum / wsum;
}

// ---- Regular 1° grids (real GLODAPv2 pH/salinity climatology):
// same BFS flood-fill pattern as buildSSTGrid above, generalized to
// a configurable grid size, but sampled via nearest-cell lookup (not
// blended) so every rendered pixel is an exact real grid value. Polar
// bands absent from the source climatology are filled from their
// nearest valid neighbor rather than left transparent.----
function buildRegularGrid(cells, nx, ny) {
  const grid = new Array(nx * ny).fill(null);
  cells.forEach(([lat, lon, v]) => {
    const i = ((Math.round(lon + nx / 2 - 0.5) % nx) + nx) % nx;
    const j = Math.round(lat + ny / 2 - 0.5);
    if (j < 0 || j >= ny) return;
    grid[j * nx + i] = v;
  });
  const filled = grid.slice();
  const visited = new Uint8Array(nx * ny);
  const queue = [];
  for (let idx = 0; idx < nx * ny; idx++) {
    if (grid[idx] !== null) { visited[idx] = 1; queue.push(idx); }
  }
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const j = Math.floor(idx / nx), i = idx % nx;
    const neighbors = [[(i - 1 + nx) % nx, j], [(i + 1) % nx, j], [i, j - 1], [i, j + 1]];
    neighbors.forEach(([ni, nj]) => {
      if (nj < 0 || nj >= ny) return;
      const nidx = nj * nx + ni;
      if (!visited[nidx]) {
        visited[nidx] = 1;
        filled[nidx] = filled[idx];
        queue.push(nidx);
      }
    });
  }
  const lookup = new Map();
  for (let idx = 0; idx < nx * ny; idx++) lookup.set((idx % nx) + "_" + Math.floor(idx / nx), filled[idx]);
  return { lookup, nx, ny };
}
function nearestRegularGrid(grid, lat, lon) {
  const { nx, ny, lookup } = grid;
  const i = ((Math.round(lon + nx / 2 - 0.5) % nx) + nx) % nx;
  const j = Math.max(0, Math.min(ny - 1, Math.round(lat + ny / 2 - 0.5)));
  const v = lookup.get(i + "_" + j);
  return v === undefined ? null : v;
}

// ---- Generic raster builder ----
// `sampleW`/`sampleH` let an expensive-per-pixel value function (e.g.
// sea level's k-nearest IDW blend) render at a much cheaper resolution
// and get upscaled onto the standard RASTER_W×RASTER_H canvas — the
// underlying field is real but inherently low-frequency/smooth, so a
// coarser sample grid plus canvas smoothing looks effectively
// identical while being tens of times faster per frame, which matters
// once a layer is being redrawn every animation tick.
function buildRasterDataURL(valueColorFn, sampleW, sampleH) {
  const w = sampleW || RASTER_W, h = sampleH || RASTER_H;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let y = 0; y < h; y++) {
    const my = RASTER_MERC_MAX - ((y + 0.5) / h) * (2 * RASTER_MERC_MAX);
    const lat = inverseMercatorY(my);
    for (let x = 0; x < w; x++) {
      const lon = -180 + ((x + 0.5) / w) * 360;
      const rgba = valueColorFn(lat, lon);
      const idx = (y * w + x) * 4;
      data[idx] = rgba[0]; data[idx + 1] = rgba[1]; data[idx + 2] = rgba[2]; data[idx + 3] = rgba[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  if (w === RASTER_W && h === RASTER_H) return canvas.toDataURL("image/png");
  const outCanvas = document.createElement("canvas");
  outCanvas.width = RASTER_W;
  outCanvas.height = RASTER_H;
  const outCtx = outCanvas.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  outCtx.drawImage(canvas, 0, 0, RASTER_W, RASTER_H);
  return outCanvas.toDataURL("image/png");
}

// A real historical year renders directly from that year's real
// ERSSTv5 grid; the two WARMING_SCENARIOS ids (sstScenario, set by
// the projection box) remain a rescale of *today's* real pattern
// since they're future projections with no dataset to fetch.
function sstScaleFor(selector) {
  const scenario = WARMING_SCENARIOS.find((s) => s.id === selector);
  return scenario ? (SST_TODAY_GLOBAL + scenario.deltaGlobal) / SST_TODAY_GLOBAL : 1;
}
function sstRasterURL() {
  const grid = sstScenario ? sstGrid : sstGridForYear(timelineState.sst.year);
  const scale = sstScenario ? sstScaleFor(sstScenario) : 1;
  return buildRasterDataURL((lat, lon) => {
    const v = nearestSST(lat, lon, scale, grid);
    if (v === null) return [0, 0, 0, 0];
    return [...rampColorRGB(v, SST_STOPS), 235];
  });
}
// Cumulative rise (mm) at a real station since its own real
// record-start year — trend_mm_per_yr × elapsed years, both real
// measured numbers already in sealevel_stations.json. Stations whose
// record hasn't started yet at the selected year are left out of
// that year's index entirely, so the map visibly gains stations over
// time as the real global tide-gauge network actually grew.
function sealevelIndexForYear(year) {
  if (sealevelYearIndexCache.has(year)) return sealevelYearIndexCache.get(year);
  const pts = sealevelIndex.points
    .filter((p) => year >= p[5])
    .map((p) => [p[0], p[1], p[2], p[3], p[4] * (year - p[5]), p[5], p[6]]);
  const idx = pts.length ? buildSphereIndex(pts) : null;
  sealevelYearIndexCache.set(year, idx);
  return idx;
}
// Sea level's field comes from only 510 scattered real stations
// blended by k-nearest IDW — inherently smooth/low-frequency, and the
// per-pixel neighbor search is the single most expensive thing this
// map does (12+ seconds at full 720×360 raster resolution, which a
// play/pause timeline needs to redo every ~600ms). Sampling at a
// coarser 240×120 grid and letting buildRasterDataURL upscale it
// looks close to identical — IDW has little fine detail to lose —
// while still cutting the real per-frame cost by roughly 9×.
function sealevelRasterURL() {
  const year = timelineState.sealevel.year;
  const idx = year == null ? sealevelIndex : sealevelIndexForYear(year);
  const stops = year == null ? SEALEVEL_STOPS : SEALEVEL_RISE_STOPS;
  if (!idx) return buildRasterDataURL(() => [0, 0, 0, 0], 240, 120);
  return buildRasterDataURL((lat, lon) => {
    const v = idwOnSphere(lat, lon, idx, 6, 4);
    if (v === null) return [0, 0, 0, 0];
    return [...rampColorRGB(v, stops), 220];
  }, 240, 120);
}
function seaiceIndexForYear(year) {
  if (!seaiceTimeline) return seaiceIndex;
  if (seaiceYearIndexCache.has(year)) return seaiceYearIndexCache.get(year);
  const values = seaiceTimeline.values[String(year)];
  if (!values) return seaiceIndex;
  const points = seaiceTimeline.cells.map((c, i) => [c[0], c[1], values[i]]);
  const idx = buildSphereIndex(points);
  seaiceYearIndexCache.set(year, idx);
  return idx;
}
// Sphere-bucketed nearest-point search (not a flat lat/lon grid — a
// regular grid binning of these reprojected polar-stereographic
// points looked badly pixelated near the pole, where equirectangular
// longitude bins get physically tiny) at a reduced sample resolution
// so a frame stays fast enough for the play/pause timeline.
function seaiceRasterURL() {
  const idx = seaiceIndexForYear(timelineState.seaice.year);
  return buildRasterDataURL((lat, lon) => {
    const c = nearestOnSphere(lat, lon, idx, 2);
    if (c === null || c < 0.08) return [0, 0, 0, 0];
    return [214, 240, 248, Math.round(40 + Math.min(1, c) * 215)];
  }, 160, 80);
}
function acidityRasterURL() {
  return buildRasterDataURL((lat, lon) => [...rampColorRGB(nearestRegularGrid(phGrid, lat, lon), PH_STOPS), 220]);
}
function salinityRasterURL() {
  return buildRasterDataURL((lat, lon) => [...rampColorRGB(nearestRegularGrid(salinityGrid, lat, lon), SALINITY_STOPS), 220]);
}

const CLIMATE_RASTER_BUILDERS = {
  sst: sstRasterURL,
  sealevel: sealevelRasterURL,
  seaice: seaiceRasterURL,
  acidity: acidityRasterURL,
  salinity: salinityRasterURL,
};

function buildClimateRasterLayers() {
  CLIMATE_LAYERS.forEach((key) => {
    const url = CLIMATE_RASTER_BUILDERS[key]();
    map.addSource(key, { type: "image", url, coordinates: RASTER_COORDS });
    map.addLayer(
      { id: key, type: "raster", source: key, layout: { visibility: "none" }, paint: { "raster-opacity": 1, "raster-fade-duration": 0 } },
      CLIMATE_BEFORE_ID
    );
  });
}

function refreshClimateRaster(key) {
  const src = map.getSource(key);
  if (src) src.updateImage({ url: CLIMATE_RASTER_BUILDERS[key]() });
}

// ---------------------------------------------------------------
// TIMELINE — play/pause + slider control shared by every
// timeline-capable layer (TIMELINE_LAYERS above). Fetches each
// layer's real dataset lazily, on first selection.
// ---------------------------------------------------------------

async function ensureTimelineData(key) {
  if (key === "sst" && !sstTimeline) {
    sstTimeline = await (await fetch(SST_TIMELINE_URL)).json();
  } else if (key === "seaice" && !seaiceTimeline) {
    seaiceTimeline = await (await fetch(SEAICE_TIMELINE_URL)).json();
  }
}

function sstTimelineSteps() {
  const years = sstTimeline ? sstTimeline.years : [];
  return years.map((y) => ({ value: y, label: String(y) }));
}
function timelineStepsFor(key) {
  if (key === "sst") return sstTimelineSteps();
  if (key === "seaice") return (seaiceTimeline ? seaiceTimeline.years : []).map((y) => ({ value: y, label: String(y) }));
  if (key === "sealevel") return SEALEVEL_TIMELINE_YEARS.map((y) => ({ value: y, label: String(y) }));
  return [];
}

function initTimelineForLayer(key) {
  const steps = timelineStepsFor(key);
  const bar = document.getElementById("mapTimeline");
  if (!steps.length) {
    bar.classList.remove("show");
    return;
  }
  if (timelineState[key].year == null) {
    const realSteps = steps.filter((s) => typeof s.value === "number");
    timelineState[key].year = realSteps[realSteps.length - 1].value;
  }
  const idx = Math.max(0, steps.findIndex((s) => s.value === timelineState[key].year));
  const slider = document.getElementById("timelineSlider");
  slider.min = 0;
  slider.max = steps.length - 1;
  slider.step = 1;
  slider.value = idx;
  document.getElementById("timelineYearLabel").textContent = steps[idx].label;
  bar.dataset.layer = key;
  bar.classList.add("show");
  bar.querySelector(".timeline-play").classList.toggle("playing", timelineState[key].playing);
}

function refreshTimelineLayer(key) {
  refreshClimateRaster(key);
  if (activeLayerKey === key) updateLegend();
}

function onTimelineSlide(idx) {
  const key = document.getElementById("mapTimeline").dataset.layer;
  const steps = timelineStepsFor(key);
  const step = steps[idx];
  if (!step) return;
  pauseTimeline(key);
  if (key === "sst" && sstScenario) clearSstScenario();
  timelineState[key].year = step.value;
  document.getElementById("timelineYearLabel").textContent = step.label;
  refreshTimelineLayer(key);
}

// Play always restarts the story from the earliest real data point,
// regardless of wherever the slider currently sits, and stops itself
// once it reaches the present rather than looping. Paced at 10 real
// years per second of animation (so a step between consecutive real
// years takes 100ms, two-year steps take 200ms, etc.) rather than a
// fixed per-step delay — otherwise a coarser-grained dataset (real
// years further apart) visibly "jumps" more per tick than a
// finer-grained one even though both play at the same tick rate.
const TIMELINE_YEARS_PER_SECOND = 10;
function playTimeline(key) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const steps = timelineStepsFor(key);
  if (steps.length < 2) return;
  if (key === "sst" && sstScenario) clearSstScenario();
  timelineState[key].playing = true;
  document.getElementById("mapTimeline").querySelector(".timeline-play").classList.add("playing");
  timelineState[key].year = steps[0].value;
  document.getElementById("timelineSlider").value = 0;
  document.getElementById("timelineYearLabel").textContent = steps[0].label;
  refreshTimelineLayer(key);
  const stepYears = steps[1].value - steps[0].value;
  const tickMs = Math.max(30, Math.round((stepYears / TIMELINE_YEARS_PER_SECOND) * 1000));
  timelineState[key].timer = setInterval(() => {
    const liveSteps = timelineStepsFor(key);
    let idx = liveSteps.findIndex((s) => s.value === timelineState[key].year);
    idx = idx + 1;
    if (idx >= liveSteps.length) { pauseTimeline(key); return; }
    timelineState[key].year = liveSteps[idx].value;
    document.getElementById("timelineSlider").value = idx;
    document.getElementById("timelineYearLabel").textContent = liveSteps[idx].label;
    refreshTimelineLayer(key);
    if (idx === liveSteps.length - 1) pauseTimeline(key); // stop at the end rather than loop
  }, tickMs);
}
function pauseTimeline(key) {
  if (!timelineState[key]) return;
  timelineState[key].playing = false;
  clearInterval(timelineState[key].timer);
  timelineState[key].timer = null;
  document.getElementById("mapTimeline")?.querySelector(".timeline-play")?.classList.remove("playing");
}
function toggleTimelinePlay() {
  const key = document.getElementById("mapTimeline").dataset.layer;
  if (!key) return;
  if (timelineState[key].playing) pauseTimeline(key);
  else playTimeline(key);
}

// SST's +2.0°C / +3.0°C projection box, independent of the real-year
// timeline above — selecting a scenario overrides the map with that
// projection; scrubbing or playing the timeline (onTimelineSlide/
// playTimeline above) clears it back to real-year mode.
function setSstScenario(id, skipRefresh) {
  sstScenario = id;
  document.querySelectorAll("#mapScenarioBox .scenario-btn").forEach((b) => b.classList.toggle("active", b.dataset.scenario === id));
  if (!skipRefresh && activeLayerKey === "sst") refreshTimelineLayer("sst");
}
function clearSstScenario() {
  setSstScenario(null, true);
}

function climateValueAt(key, lat, lon) {
  if (key === "sst") {
    return nearestSST(lat, lon, sstScenario ? sstScaleFor(sstScenario) : 1, sstScenario ? sstGrid : sstGridForYear(timelineState.sst.year));
  }
  if (key === "sealevel") {
    const year = timelineState.sealevel.year;
    const idx = year == null ? sealevelIndex : sealevelIndexForYear(year);
    return idx ? idwOnSphere(lat, lon, idx, 6, 4) : null;
  }
  if (key === "seaice") {
    const c = nearestOnSphere(lat, lon, seaiceIndexForYear(timelineState.seaice.year), 2);
    return c === null ? null : c * 100;
  }
  if (key === "acidity") return nearestRegularGrid(phGrid, lat, lon);
  if (key === "salinity") return nearestRegularGrid(salinityGrid, lat, lon);
  return null;
}

function bindClimateClicks() {
  map.on("click", (e) => {
    if (!CLIMATE_LAYERS.includes(activeLayerKey)) return;
    const { lat, lng } = e.lngLat;
    const v = climateValueAt(activeLayerKey, lat, lng);
    if (v === null) return;
    const html = climatePopupHTML(activeLayerKey, v);
    new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(html).addTo(map);
  });
}

function climatePopupHTML(key, v) {
  if (key === "sst") {
    const yearLabel = sstScenario ? WARMING_SCENARIOS.find((s) => s.id === sstScenario)?.label : timelineState.sst.year;
    return `${v >= 0 ? "+" : ""}${v.toFixed(2)}°C anomaly (${yearLabel})<br><span class="popup-faint">NOAA ERSSTv5 · exact value, nearest real grid cell</span>`;
  }
  if (key === "sealevel") {
    const year = timelineState.sealevel.year;
    if (year == null) return `${v >= 0 ? "+" : ""}${v.toFixed(2)} mm/yr<br><span class="popup-faint">NOAA tide gauges, real data, interpolated (IDW, 6 nearest stations)</span>`;
    return `${v >= 0 ? "+" : ""}${v.toFixed(0)} mm risen since record began (as of ${year})<br><span class="popup-faint">Real measured trend × real elapsed years, interpolated (IDW, 6 nearest stations)</span>`;
  }
  if (key === "seaice") return `~${v.toFixed(0)}% concentration (Sep ${timelineState.seaice.year})<br><span class="popup-faint">NOAA/NSIDC Climate Data Record (G02202 v6) · exact value, nearest real measurement</span>`;
  if (key === "acidity") return `pH ${v.toFixed(2)}<br><span class="popup-faint">GLODAPv2 climatology (Lauvset et al. 2016) · exact value, nearest real grid cell</span>`;
  if (key === "salinity") return `${v.toFixed(1)} PSU<br><span class="popup-faint">GLODAPv2 climatology (Lauvset et al. 2016) · exact value, nearest real grid cell</span>`;
  return "";
}

// ---------------- Shipping — live AIS (Digitraffic) ----------------

function buildAISLayer() {
  map.addSource("ais", { type: "geojson", data: fc([]) });
  map.addLayer({
    id: "ais",
    type: "circle",
    source: "ais",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 3, 5, 5, 9, 8],
      "circle-color": ["get", "color"],
      "circle-opacity": 0.9,
      "circle-stroke-color": "#0A2B39",
      "circle-stroke-width": 1,
    },
  });
}

async function refreshAIS() {
  try {
    const [locRes, vesRes] = await Promise.all([
      fetch(AIS_LOCATIONS_URL, { headers: AIS_REQUEST_HEADERS }),
      fetch(AIS_VESSELS_URL, { headers: AIS_REQUEST_HEADERS }),
    ]);
    const locData = await locRes.json();
    const vesData = await vesRes.json();
    const meta = {};
    vesData.forEach((v) => (meta[v.mmsi] = v));
    const features = (locData.features || []).map((f) => {
      const m = meta[f.properties.mmsi] || {};
      const cat = vesselCategory(m.shipType);
      return pt(f.geometry.coordinates[0], f.geometry.coordinates[1], {
        name: m.name || `MMSI ${f.properties.mmsi}`,
        category: cat,
        color: VESSEL_TYPES[cat].color,
        typeLabel: VESSEL_TYPES[cat].label,
        destination: (m.destination || "").trim() || "—",
        sog: f.properties.sog,
        heading: f.properties.heading,
      });
    });
    const src = map.getSource("ais");
    if (src) src.setData(fc(features));
  } catch (e) {
    console.warn("AIS fetch failed", e);
  }
}
function startAIS() {
  refreshAIS();
  if (aisTimer) return;
  aisTimer = setInterval(refreshAIS, 60000);
}
function stopAIS() {
  if (aisTimer) clearInterval(aisTimer);
  aisTimer = null;
}

// ---------------------------------------------------------------
// POPUPS
// ---------------------------------------------------------------

// Looks up a genus-level common name from the first word of a GBIF
// scientific name (see GENUS_COMMON_NAMES in map-data.js).
function commonNameFor(scientificName) {
  const genus = (scientificName || "").split(" ")[0];
  return GENUS_COMMON_NAMES[genus] || null;
}

// Every record's own "note" is written as "Real <source>, <place>,
// <year>" (see note_for in the data-build scripts) — split that back
// into a source line and a place/year line so the popup can show them
// at different sizes instead of one run-on sentence. Falls back to
// treating the whole note as the source line if it doesn't match.
function splitSourceNote(note) {
  const cleaned = (note || "").replace(/^Real\s+/, "");
  const idx = cleaned.indexOf(",");
  if (idx === -1) return { source: cleaned, meta: "" };
  return { source: cleaned.slice(0, idx).trim(), meta: cleaned.slice(idx + 1).trim() };
}

function speciesPopupHTML(name, note) {
  const common = commonNameFor(name);
  const { source, meta } = splitSourceNote(note);
  return `<span class="popup-title">${name}${common ? ` <span class="popup-common">(${common})</span>` : ""}</span>` +
    (meta ? `<span class="popup-meta">${meta}</span>` : "") +
    (source ? `<span class="popup-source">${source}</span>` : "");
}

function bindPopups() {
  const areaLayers = ["reef", "kelp", "mangrove", "saltmarsh", "tidalflat"];
  areaLayers.forEach((id) => {
    map.on("click", id, (e) => {
      const p = e.features[0].properties;
      new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(speciesPopupHTML(p.name, p.note)).addTo(map);
    });
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  });

  ["mpa", "mpa-fill"].forEach((id) => {
    map.on("click", id, (e) => {
      const p = e.features[0].properties;
      new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(`<span class="popup-title">${p.name}</span><span class="popup-meta">${p.note}</span>`).addTo(map);
    });
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  });

  ["birds", "reptiles", "mammals"].forEach((id) => {
    map.on("click", id, (e) => {
      const p = e.features[0].properties;
      const { source, meta } = splitSourceNote(p.note);
      new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(
        `<span class="popup-title">${p.name}</span>` +
        `<span class="popup-meta">${p.label} &middot; ${meta}</span>` +
        (source ? `<span class="popup-source">${source}</span>` : "")
      ).addTo(map);
    });
  });


  map.on("click", "ais", (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(`<b>${p.name}</b><br>${p.typeLabel} · dest. ${p.destination}<br>Speed: ${p.sog ?? "—"} kn · Heading: ${p.heading ?? "—"}°<br><span class="popup-faint">Live AIS: Digitraffic</span>`).addTo(map);
  });

  map.on("click", "corridors", (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(`<b>${p.name}</b><br>Major trade corridor (reference route)`).addTo(map);
  });
}

// ---------------------------------------------------------------
// LEGEND — bottom center, only for the active layer's own scale
// ---------------------------------------------------------------

function legendDot(color, label) {
  return `<div class="map-legend-row"><span class="map-legend-swatch" style="background:${color}"></span>${label}</div>`;
}
function iucnLegend() {
  return Object.keys(IUCN_LABELS).map((code) => legendDot(IUCN_COLORS[code], IUCN_LABELS[code])).join("");
}
function gradientFromStops(stops) {
  const min = stops[0][0], max = stops[stops.length - 1][0];
  const parts = stops.map(([v, c]) => `rgb(${c[0]},${c[1]},${c[2]}) ${(((v - min) / (max - min)) * 100).toFixed(1)}%`);
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}
function legendBar(title, stops, fmt) {
  const min = stops[0][0], max = stops[stops.length - 1][0];
  return `<div class="map-legend-block">
    <span class="map-legend-title">${title}</span>
    <div class="map-legend-bar">
      <span class="map-legend-val">${fmt(min)}</span>
      <span class="map-legend-grad" style="background:${gradientFromStops(stops)}"></span>
      <span class="map-legend-val">${fmt(max)}</span>
    </div>
  </div>`;
}
function updateLegend() {
  const legend = document.getElementById("mapLegend");
  let html = "";
  if (activeLayerKey === "sst") {
    const label = sstScenario ? WARMING_SCENARIOS.find((s) => s.id === sstScenario)?.label : timelineState.sst.year;
    html = legendBar(`SST anomaly: ${label}`, SST_STOPS, (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}°C`);
  } else if (activeLayerKey === "sealevel") {
    const year = timelineState.sealevel.year;
    html = year == null
      ? legendBar("Sea level trend", SEALEVEL_STOPS, (v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)} mm/yr`)
      : legendBar(`Sea level risen since record began (${year})`, SEALEVEL_RISE_STOPS, (v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}mm`);
  } else if (activeLayerKey === "seaice") {
    html = `<div class="map-legend-block"><span class="map-legend-title">Ice concentration, September ${timelineState.seaice.year}</span><div class="map-legend-bar"><span class="map-legend-val">0%</span><span class="map-legend-grad" style="background:linear-gradient(90deg,rgba(214,240,248,0.15),rgb(214,240,248));"></span><span class="map-legend-val">100%</span></div></div>`;
  } else if (activeLayerKey === "acidity") {
    html = legendBar("Surface pH climatology (GLODAPv2)", PH_STOPS, (v) => v.toFixed(2));
  } else if (activeLayerKey === "salinity") {
    html = legendBar("Salinity", SALINITY_STOPS, (v) => `${v.toFixed(0)} PSU`);
  } else if (["birds", "reptiles", "mammals"].includes(activeLayerKey)) {
    html = `<div class="map-legend-block map-legend-iucn">${iucnLegend()}</div>`;
  } else if (activeLayerKey === "ais") {
    html = `<div class="map-legend-block map-legend-iucn">${Object.values(VESSEL_TYPES).map((t) => legendDot(t.color, t.label)).join("")}</div>`;
  }
  legend.innerHTML = html;
  legend.classList.toggle("show", !!html);
}

// ---------------------------------------------------------------
// SELECTION — exactly one layer visible at a time
// ---------------------------------------------------------------

// MPAs render as two coupled layers sharing one panel entry: a fill
// + outline for the MPAs with a real traced OSM boundary, plus the
// circle layer (filtered to just the MPAs with no boundary yet) for
// everything else — see buildEcosystemLayers. Every other key maps
// to just itself.
function layerIdsFor(key) {
  return key === "mpa" ? ["mpa", "mpa-fill", "mpa-line"] : [key];
}

async function selectLayer(key) {
  if (!map.getLayer(key)) return;
  if (activeLayerKey && activeLayerKey !== key) {
    layerIdsFor(activeLayerKey).forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", "none"));
    if (activeLayerKey === "ais") stopAIS();
    if (TIMELINE_LAYERS.includes(activeLayerKey)) pauseTimeline(activeLayerKey);
    if (activeLayerKey === "sst") setSstScenario(null, true);
  }
  activeLayerKey = key;
  layerIdsFor(key).forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", "visible"));
  if (key === "ais") startAIS();

  document.getElementById("mapSelectLabel").textContent = LAYER_LABELS[key] || key;
  document.querySelectorAll(".map-option").forEach((o) => o.classList.toggle("active", o.dataset.layer === key));
  closeDropdown();

  document.getElementById("mapScenarioBox").classList.toggle("show", key === "sst");

  if (TIMELINE_LAYERS.includes(key)) {
    document.getElementById("mapTimeline").classList.remove("show");
    await ensureTimelineData(key);
    initTimelineForLayer(key);
    refreshClimateRaster(key);
  } else {
    document.getElementById("mapTimeline").classList.remove("show");
  }
  updateLegend();
}

function openDropdown() {
  document.getElementById("mapSelect").classList.add("open");
}
function closeDropdown() {
  document.getElementById("mapSelect").classList.remove("open");
}

// ---------------------------------------------------------------
// PANEL — pill + single-open-group accordion + single-select options
// ---------------------------------------------------------------

function setupPanel() {
  const selectEl = document.getElementById("mapSelect");
  const pill = document.getElementById("mapSelectPill");

  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    selectEl.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!selectEl.contains(e.target)) selectEl.classList.remove("open");
  });

  document.querySelectorAll(".map-group-head").forEach((head) => {
    head.addEventListener("click", (e) => {
      e.stopPropagation();
      const group = head.closest(".map-group");
      const wasOpen = group.classList.contains("open");
      document.querySelectorAll(".map-group").forEach((g) => g.classList.remove("open"));
      if (!wasOpen) group.classList.add("open");
    });
  });

  document.querySelectorAll(".map-option").forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      selectLayer(opt.dataset.layer);
    });
  });

  const timelinePlay = document.querySelector("#mapTimeline .timeline-play");
  const timelineSlider = document.getElementById("timelineSlider");
  timelinePlay?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTimelinePlay();
  });
  timelineSlider?.addEventListener("input", (e) => {
    e.stopPropagation();
    onTimelineSlide(parseInt(e.target.value, 10));
  });
  timelineSlider?.addEventListener("click", (e) => e.stopPropagation());

  document.querySelectorAll("#mapScenarioBox .scenario-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      pauseTimeline("sst");
      setSstScenario(sstScenario === btn.dataset.scenario ? null : btn.dataset.scenario);
    });
  });
}

// ---------------------------------------------------------------
// TOOLBAR — screenshot / adjust view / zoom (bottom right)
// ---------------------------------------------------------------

function setupToolbar() {
  document.getElementById("zoomInBtn")?.addEventListener("click", () => map.zoomIn());
  document.getElementById("zoomOutBtn")?.addEventListener("click", () => map.zoomOut());

  document.getElementById("screenshotBtn")?.addEventListener("click", () => {
    map.once("idle", () => {
      const url = map.getCanvas().toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = "ocean-explorer-map.png";
      a.click();
    });
    map.triggerRepaint();
  });

  const flyout = document.getElementById("adjustViewFlyout");
  const adjustBtn = document.getElementById("adjustViewBtn");
  adjustBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = flyout.classList.toggle("show");
    adjustBtn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => {
    if (!flyout.contains(e.target) && e.target !== adjustBtn && !adjustBtn.contains(e.target)) {
      flyout.classList.remove("show");
    }
  });

  document.getElementById("toggleProjectionBtn")?.addEventListener("click", () => {
    showingGlobe = !showingGlobe;
    map.setProjection({ type: showingGlobe ? "globe" : "mercator" });
    document.getElementById("toggleProjectionLabel").textContent = showingGlobe ? "Show map view" : "Show globe view";
  });

  document.getElementById("toggleBordersBtn")?.addEventListener("click", () => {
    bordersHidden = !bordersHidden;
    BORDER_LAYER_IDS.forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", bordersHidden ? "none" : "visible");
    });
    document.getElementById("toggleBordersLabel").textContent = bordersHidden ? "Show country borders" : "Hide country borders";
  });

  document.getElementById("tourBtn")?.addEventListener("click", () => {
    document.getElementById("adjustViewFlyout").classList.remove("show");
    startTour();
  });
  document.getElementById("tourSkipBtn")?.addEventListener("click", endTour);
  document.getElementById("tourNextBtn")?.addEventListener("click", tourNext);
}

// ---------------------------------------------------------------
// QUICK TOUR — scripted flyTo sequence
// ---------------------------------------------------------------

const TOUR_STEPS = [
  { center: [-30, 55], zoom: 3, layer: "sst", text: "Real NOAA sea surface temperature data: the North Atlantic \"warming hole\" shows up as a real, measured cool patch south of Greenland." },
  { center: [147.7, -18.28], zoom: 4, layer: "reef", text: "The Great Barrier Reef, one of ten major coral reef systems mapped under Ecosystems." },
  { center: [20, 60], zoom: 4, layer: "ais", text: "Live vessel positions over the Baltic Sea, refreshed from a real public AIS feed, genuinely real-time, not simulated." },
  { center: [10, 60], zoom: 3, layer: "sealevel", text: "Real NOAA tide-gauge trends: most stations show rising seas; a few in high-latitude regions still show post-glacial land rebound." },
  { center: [10, 15], zoom: 1.4, layer: null, text: "That's the tour. Pick any map from the panel to keep exploring." },
];

function startTour() {
  tourStep = -1;
  document.getElementById("tourCaption").classList.add("show");
  tourNext();
}
function tourNext() {
  tourStep++;
  if (tourStep >= TOUR_STEPS.length) return endTour();
  const step = TOUR_STEPS[tourStep];
  map.flyTo({ center: step.center, zoom: step.zoom, duration: 1400 });
  if (step.layer) selectLayer(step.layer);
  document.getElementById("tourText").textContent = step.text;
  document.getElementById("tourNextBtn").textContent = tourStep === TOUR_STEPS.length - 1 ? "Done" : "Next";
}
function endTour() {
  document.getElementById("tourCaption").classList.remove("show");
  tourStep = -1;
}

window.addEventListener("DOMContentLoaded", initMap);
