// Paperball — geo.js (Agent A)
// Geocoding, Overpass loading, and OSM -> WorldData parsing.
// Coordinate system: world meters, Y up, NORTH = -Z, EAST = +X.
//   x = (lon - lon0) * cos(lat0) * 111320,  z = -(lat - lat0) * 111320
// No imports. Nothing here touches window/document/location at module top level.

const M_PER_DEG = 111320;
// Direct-from-browser fallbacks (normally the /api/osm proxy answers first).
// maps.mail.ru is slow (~15 s) but the only consistently working public server as of Oct 2026.
const OVERPASS_MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// ---------------------------------------------------------------- fetch utils

async function fetchJSON(url, opts, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...(opts || {}), signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------- geocode

export async function geocode(query) {
  try {
    const q = String(query == null ? '' : query).trim();
    if (!q) return null;
    const url =
      'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q);
    const arr = await fetchJSON(url, { headers: { Accept: 'application/json' } }, 8000);
    if (!Array.isArray(arr) || !arr.length) return null;
    const r = arr[0];
    const lat = parseFloat(r.lat);
    const lon = parseFloat(r.lon);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    const parts = String(r.display_name || q)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Never show house numbers: drop pure-number parts like "123" or "12B".
    const clean = parts.filter((x) => !/^\d+[a-zA-Z]?$/.test(x));
    const label = clean.slice(0, 3).join(', ') || q.replace(/^\d+[a-zA-Z]?\s+/, '');
    return { lat, lon, label };
  } catch (e) {
    return null;
  }
}

const US_STATES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',
  FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',
  LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',
  MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',
  NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',
  SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',
  WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia',
};
export { US_STATES };

// Structured address search: street / city / state are sent as separate Nominatim fields so the
// geocoder cannot "correct" the address into a different town. Results are rejected unless they
// are in the requested state. Returns { lat, lon, label, precision: 'house'|'street'|'city', found } or null.
// Labels never contain house numbers.
export async function geocodeAddress({ street, city, state }) {
  try {
    const st = String(state || '').trim().toUpperCase();
    const stateName = US_STATES[st] || String(state || '').trim();
    const cityQ = String(city || '').trim();
    const streetQ = String(street || '').trim();
    if (!cityQ || !stateName) return null;
    const num = (streetQ.match(/^(\d+[a-zA-Z]?)\b/) || [])[1] || null;
    const streetOnly = streetQ.replace(/^\d+[a-zA-Z]?\s+/, '');
    const base = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=us&limit=5';
    const enc = encodeURIComponent;
    const inState = (r) => {
      const a = r.address || {};
      return a.state === stateName || a['ISO3166-2-lvl4'] === 'US-' + st;
    };
    const attempts = [];
    if (streetQ) attempts.push(streetQ);
    if (streetQ && streetOnly && streetOnly !== streetQ) attempts.push(streetOnly);
    for (let i = 0; i < attempts.length; i++) {
      const url = base + '&street=' + enc(attempts[i]) + '&city=' + enc(cityQ) + '&state=' + enc(stateName);
      const arr = await fetchJSON(url, { headers: { Accept: 'application/json' } }, 8000);
      const ok = (Array.isArray(arr) ? arr : []).filter(inState);
      if (!ok.length) continue;
      // Prefer an exact house-number match, then anything on the street.
      const exact = num && ok.find((r) => String((r.address || {}).house_number || '').toLowerCase() === num.toLowerCase());
      const r = exact || ok[0];
      const a = r.address || {};
      const town = a.city || a.town || a.village || a.hamlet || cityQ;
      const road = a.road || streetOnly;
      return {
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        label: [road, town, st || stateName].filter(Boolean).join(', '),
        precision: exact ? 'house' : 'street',
        found: String(r.display_name || '').replace(/^\d+[a-zA-Z]?,\s*/, ''),
      };
    }
    // City-level fallback (no street, or street not found): still pinned to the right state.
    const cu = base + '&city=' + enc(cityQ) + '&state=' + enc(stateName);
    const carr = await fetchJSON(cu, { headers: { Accept: 'application/json' } }, 8000);
    const cok = (Array.isArray(carr) ? carr : []).filter(inState);
    if (cok.length && !streetQ) {
      const r = cok[0];
      return { lat: parseFloat(r.lat), lon: parseFloat(r.lon), label: cityQ + ', ' + (st || stateName), precision: 'city', found: r.display_name || '' };
    }
    return null;
  } catch (e) {
    return null;
  }
}

export async function resolveCenter(CONFIG) {
  const dflt = (CONFIG && CONFIG.default_center) || { lat: 36.3956, lon: -97.8784, label: 'Enid, OK' };
  try {
    let search = '';
    try {
      search = typeof location !== 'undefined' && location && location.search ? location.search : '';
    } catch (e) {
      search = '';
    }
    const sp = new URLSearchParams(search);
    const latS = sp.get('lat');
    const lonS = sp.get('lon');
    if (latS !== null && lonS !== null && latS.trim() !== '' && lonS.trim() !== '') {
      const lat = Number(latS);
      const lon = Number(lonS);
      if (isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        const label = sp.get('label') || lat.toFixed(4) + ', ' + lon.toFixed(4);
        return { lat, lon, label };
      }
    }
    const q = sp.get('q');
    if (q && q.trim()) {
      const g = await geocode(q);
      if (g) return g;
    }
  } catch (e) {
    /* fall through to default */
  }
  return { lat: dflt.lat, lon: dflt.lon, label: dflt.label || 'Default' };
}

// ----------------------------------------------------------------- loadWorld

function emptyWorld(center, radius, source) {
  return {
    center: { lat: center.lat, lon: center.lon, label: center.label || '' },
    source,
    buildings: [],
    roads: [],
    trees: [],
    bounds: { minX: -radius, maxX: radius, minZ: -radius, maxZ: radius },
  };
}

function validElements(json) {
  return json && typeof json === 'object' && Array.isArray(json.elements);
}

export async function loadWorld(center, CONFIG, onStatus, opts = {}) {
  const say = (m) => {
    try {
      if (typeof onStatus === 'function') onStatus(m);
    } catch (e) {
      /* ignore */
    }
  };
  const R = (CONFIG && CONFIG.radius_m) || 260;
  const c = {
    lat: center && isFinite(center.lat) ? center.lat : CONFIG.default_center.lat,
    lon: center && isFinite(center.lon) ? center.lon : CONFIG.default_center.lon,
    label: (center && center.label) || '',
  };

  let reason = 'network';
  const errors = []; // human-readable reasons, surfaced on the start screen if everything fails
  const usable = (json) => {
    if (!validElements(json)) throw new Error('bad response');
    if (json.remark && !json.elements.length) throw new Error('server overloaded');
    return json;
  };

  // 1) Preloaded map baked into the site at deploy time (default location only).
  if (opts.preload) {
    try {
      say('Loading map...');
      const json = usable(await fetchJSON(opts.preload, {}, 8000));
      const pc = json.center && isFinite(json.center.lat) && isFinite(json.center.lon) ? json.center : c;
      const world = parseOSM(json, { lat: pc.lat, lon: pc.lon, label: pc.label || c.label }, CONFIG);
      if (world.buildings.length > 0) { world.source = 'preload'; return world; }
      errors.push('preload: empty');
    } catch (err) {
      errors.push('preload: ' + (err.message || err));
    }
  }

  try {
    const dLat = R / M_PER_DEG;
    const dLon = R / (M_PER_DEG * Math.cos((c.lat * Math.PI) / 180));
    // 4 decimals (~11 m) so repeat visits hit the CDN cache
    const s = (c.lat - dLat).toFixed(4);
    const n = (c.lat + dLat).toFixed(4);
    const w = (c.lon - dLon).toFixed(4);
    const e = (c.lon + dLon).toFixed(4);
    const bb = `${s},${w},${n},${e}`;
    const query =
      `[out:json][timeout:25];(` +
      `way["building"](${bb});relation["building"](${bb});` +
      `way["highway"](${bb});node["natural"="tree"](${bb});` +
      `);out body;>;out skel qt;`;

    // 2) Our own Netlify proxy (server-side fetch + CDN cache). 404s harmlessly on static hosts.
    let proxyEmpty = false;
    try {
      say('Downloading map data (can take ~15 s the first time)...');
      const json = usable(await fetchJSON(`api/osm?s=${s}&w=${w}&n=${n}&e=${e}`, {}, 40000));
      say('Building the neighborhood...');
      const world = parseOSM(json, c, CONFIG);
      if (world.buildings.length > 0) { world.source = 'live'; return world; }
      proxyEmpty = true;
      reason = 'no-buildings';
    } catch (err) {
      errors.push('proxy: ' + (err.name === 'AbortError' ? 'timeout' : err.message || err));
    }

    // 3) Direct to public Overpass mirrors (skipped if the proxy already proved the area is empty).
    for (let i = 0; !proxyEmpty && i < OVERPASS_MIRRORS.length; i++) {
      const host = OVERPASS_MIRRORS[i].split('/')[2];
      say(i === 0 ? 'Trying map servers directly...' : 'Trying backup map server...');
      try {
        const json = usable(await fetchJSON(
          OVERPASS_MIRRORS[i],
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query),
          },
          i === 0 ? 30000 : 12000
        ));
        say('Building the neighborhood...');
        const world = parseOSM(json, c, CONFIG);
        if (world.buildings.length > 0) {
          world.source = 'live';
          return world;
        }
        say('No buildings found there.');
        reason = 'no-buildings';
        break; // empty area: a mirror will not help
      } catch (err) {
        errors.push(host + ': ' + (err.name === 'AbortError' ? 'timeout' : err.message || err));
        if (typeof console !== 'undefined') console.warn('[geo]', host, err);
      }
    }
  } catch (err) {
    errors.push('loader: ' + (err.message || err));
  }

  say('Using the offline sample block...');
  try {
    const json = await fetchJSON('data/fallback_osm.json', {}, 15000);
    const fc = json && json.center && isFinite(json.center.lat) && isFinite(json.center.lon)
      ? { lat: json.center.lat, lon: json.center.lon, label: json.center.label || 'Sample Block (offline)' }
      : c;
    const world = parseOSM(json, fc, CONFIG);
    world.source = 'fallback';
    world.reason = reason;      // 'network' | 'no-buildings'
    world.requested = c;        // what the player actually asked for
    world.errors = errors;
    return world;
  } catch (err) {
    const w = emptyWorld(c, R, 'fallback');
    w.reason = reason;
    w.requested = c;
    w.errors = errors;
    return w;
  }
}

// ------------------------------------------------------------------- parsing

function num(v) {
  if (v === undefined || v === null) return NaN;
  const s = String(v);
  const m = s.replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return NaN;
  let x = parseFloat(m[0]);
  if (/ft|'/.test(s)) x *= 0.3048;
  return x;
}

const COLOR_WORDS = new Set([
  'white', 'black', 'red', 'green', 'blue', 'yellow', 'orange', 'brown', 'grey', 'gray',
  'beige', 'tan', 'pink', 'purple', 'maroon', 'cream', 'silver', 'gold', 'navy', 'teal',
  'olive', 'lime', 'aqua', 'ivory', 'khaki', 'salmon', 'coral', 'crimson', 'darkgreen',
  'darkred', 'darkblue', 'lightgray', 'lightgrey', 'darkgray', 'darkgrey',
]);
function validColor(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return s;
  if (COLOR_WORDS.has(s)) return s;
  return null;
}

// Signed shoelace area on the 2D frame (x, -z). In that frame east is right and
// north is up (standard right-handed), so positive area == CCW viewed from above (+Y).
function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * -q.z - q.x * -p.z;
  }
  return a / 2;
}

function buildingKind(b, area) {
  switch (b) {
    case 'house': case 'detached': case 'semidetached_house': case 'terrace':
    case 'bungalow': case 'residential':
      return 'house';
    case 'garage': case 'garages': case 'carport':
      return 'garage';
    case 'shed': case 'hut': case 'greenhouse':
      return 'shed';
    case 'apartments': case 'dormitory':
      return 'apartments';
    case 'church': case 'chapel': case 'cathedral':
      return 'church';
    case 'school':
      return 'school';
    case 'retail': case 'commercial': case 'office': case 'industrial':
    case 'warehouse': case 'supermarket':
      return 'commercial';
    case 'yes':
      return area < 350 ? 'house' : 'commercial';
    default:
      return 'other';
  }
}

const DEFAULT_LEVELS = {
  house: 1, garage: 1, shed: 1, apartments: 3, commercial: 1, church: 1, school: 2, other: 1,
};

const ROOF_SHAPES = {
  gabled: 'gabled', hipped: 'hipped', 'half-hipped': 'hipped', flat: 'flat', pyramidal: 'pyramidal',
  skillion: 'flat', dome: 'flat', round: 'flat',
};

function roadKind(tags) {
  const h = tags.highway;
  switch (h) {
    case 'motorway': case 'motorway_link': case 'trunk': case 'trunk_link':
    case 'primary': case 'primary_link':
      return 'primary';
    case 'secondary': case 'secondary_link':
      return 'secondary';
    case 'tertiary': case 'tertiary_link':
      return 'tertiary';
    case 'residential': case 'living_street': case 'unclassified':
      return 'residential';
    case 'service':
      if (tags.service === 'driveway') return 'driveway';
      if (tags.service === 'alley') return 'alley';
      return 'service';
    case 'footway': case 'path': case 'pedestrian': case 'cycleway': case 'steps':
      return 'footway';
    default:
      return 'other';
  }
}

const ROAD_WIDTH = {
  primary: 12, secondary: 10, tertiary: 9, residential: 7.5, service: 5,
  alley: 4, driveway: 3.5, footway: 1.5, other: 5,
};

export function parseOSM(json, center, CONFIG) {
  const R = (CONFIG && CONFIG.radius_m) || 260;
  const maxB = (CONFIG && CONFIG.max_buildings) || 450;
  const maxT = (CONFIG && CONFIG.max_trees) || 400;
  const lat0 = center.lat;
  const lon0 = center.lon;
  const kx = Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG;
  const cut = 1.4 * R;

  const nodes = new Map(); // id -> {x, z, tags}
  const ways = new Map(); // id -> way element
  const rels = [];
  const els = json && Array.isArray(json.elements) ? json.elements : [];

  for (const el of els) {
    if (!el) continue;
    if (el.type === 'node') {
      if (typeof el.lat !== 'number' || typeof el.lon !== 'number') continue;
      nodes.set(el.id, {
        x: (el.lon - lon0) * kx,
        z: -(el.lat - lat0) * M_PER_DEG,
        tags: el.tags || null,
      });
    } else if (el.type === 'way') {
      ways.set(el.id, el);
    } else if (el.type === 'relation') {
      rels.push(el);
    }
  }

  const dist = (p) => Math.hypot(p.x, p.z);
  const entirelyBeyond = (pts) => {
    for (const p of pts) if (dist(p) <= cut) return false;
    return true;
  };

  // Resolve a way's node refs -> unique projected points (missing nodes dropped).
  const ringPoints = (refs) => {
    const seen = new Set();
    const pts = [];
    for (const r of refs || []) {
      if (seen.has(r)) continue; // dedupes repeats, including the closing duplicate
      seen.add(r);
      const nd = nodes.get(r);
      if (nd) pts.push({ x: nd.x, z: nd.z });
    }
    return pts;
  };
  const isClosed = (w) => w.nodes && w.nodes.length >= 4 && w.nodes[0] === w.nodes[w.nodes.length - 1];

  // ---------------------------------------------------------------- buildings
  const bCands = [];
  const usedWayIds = new Set();

  const addBuilding = (id, refs, tags) => {
    const pts = ringPoints(refs);
    if (pts.length < 3) return;
    let area = signedArea(pts);
    if (Math.abs(area) < 8) return;
    if (area < 0) pts.reverse(); // force CCW in the (x, -z) frame
    area = Math.abs(area);
    if (entirelyBeyond(pts)) return;

    const kind = buildingKind(String(tags.building), area);
    const lv = num(tags['building:levels']);
    const levels = isFinite(lv) ? Math.min(30, Math.max(1, lv)) : DEFAULT_LEVELS[kind] || 1;

    const rhTag = num(tags['roof:height']);
    const roofHeight = isFinite(rhTag) && rhTag > 0 ? rhTag : null;
    const hTag = num(tags.height);
    let height;
    if (isFinite(hTag) && hTag > 0) {
      const sub = roofHeight !== null ? roofHeight : kind === 'house' ? 2.5 : 0;
      height = Math.max(2.4, hTag - sub);
    } else if (kind === 'garage' || kind === 'shed') {
      height = 2.6;
    } else {
      height = levels * 3.0;
    }

    let cx = 0, cz = 0;
    for (const p of pts) { cx += p.x; cz += p.z; }
    cx /= pts.length; cz /= pts.length;

    bCands.push({
      d: Math.hypot(cx, cz),
      b: {
        id,
        kind,
        footprint: pts,
        height,
        levels,
        roofShape: ROOF_SHAPES[tags['roof:shape']] || null,
        roofHeight,
        wallColor: validColor(tags['building:colour']),
        roofColor: validColor(tags['roof:colour']),
        name: kind !== 'house' && tags.name ? String(tags.name) : null,
      },
    });
  };

  for (const w of ways.values()) {
    const t = w.tags;
    if (!t || !t.building || t.building === 'no') continue;
    if (!isClosed(w)) continue;
    usedWayIds.add(w.id);
    addBuilding(w.id, w.nodes, t);
  }
  for (const rel of rels) {
    const rt = rel.tags;
    if (!rt || !rt.building || rt.building === 'no') continue;
    for (const m of rel.members || []) {
      if (m.type !== 'way' || m.role !== 'outer') continue;
      const w = ways.get(m.ref);
      if (!w || usedWayIds.has(w.id) || !isClosed(w)) continue;
      usedWayIds.add(w.id);
      addBuilding(w.id, w.nodes, { ...(w.tags || {}), ...rt });
    }
  }
  bCands.sort((a, b) => a.d - b.d);
  const buildings = bCands.slice(0, maxB).map((c) => c.b);

  // -------------------------------------------------------------------- roads
  const roads = [];
  for (const w of ways.values()) {
    const t = w.tags;
    if (!t || !t.highway) continue;
    const pts = [];
    for (const r of w.nodes || []) {
      const nd = nodes.get(r);
      if (nd) pts.push({ x: nd.x, z: nd.z });
    }
    if (pts.length < 2) continue;
    if (entirelyBeyond(pts)) continue;
    const kind = roadKind(t);
    const wt = num(t.width);
    roads.push({
      id: w.id,
      name: t.name ? String(t.name) : null,
      kind,
      width: isFinite(wt) && wt > 0 ? wt : ROAD_WIDTH[kind],
      points: pts,
    });
  }

  // -------------------------------------------------------------------- trees
  const tCands = [];
  for (const nd of nodes.values()) {
    if (!nd.tags || nd.tags.natural !== 'tree') continue;
    const d = dist(nd);
    if (d > cut) continue;
    tCands.push({ d, p: { x: nd.x, z: nd.z } });
  }
  tCands.sort((a, b) => a.d - b.d);
  const trees = tCands.slice(0, maxT).map((c) => c.p);

  // ------------------------------------------------------------------- bounds
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const grow = (p) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  };
  for (const b of buildings) b.footprint.forEach(grow);
  for (const r of roads) r.points.forEach(grow);
  trees.forEach(grow);
  const bounds = isFinite(minX)
    ? { minX, maxX, minZ, maxZ }
    : { minX: -R, maxX: R, minZ: -R, maxZ: R };

  return {
    center: { lat: lat0, lon: lon0, label: center.label || '' },
    source: 'live',
    buildings,
    roads,
    trees,
    bounds,
  };
}

// ------------------------------------------------------------------ geometry

// Standard ray cast on the x/z plane.
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}
