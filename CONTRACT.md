# Paperball — Module Contract (source of truth for all agents)

Zero build steps. ES modules loaded via the importmap in `index.html`:
- `three` → three@0.156.1 (`import * as THREE from 'three'`)
- `three/addons/` → three@0.156.1/examples/jsm/ (e.g. `import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'`)
- `cannon-es` → cannon-es@0.20.0 (`import * as CANNON from 'cannon-es'`)
- `nipplejs` is a classic global (`window.nipplejs`), loaded before modules.

No other libraries. No TypeScript. No npm. Every file must run as-is in Chrome/Safari 16.4+.

## Ownership (do NOT edit files you don't own)
| File | Owner |
|---|---|
| index.html, style.css, js/config.js, js/main.js, CONTRACT.md | Opus (integrator) |
| js/geo.js, data/fallback_osm.json | Agent A |
| js/toon.js, js/houses.js | Agent B |
| js/streets.js, js/game.js | Agent C |

## Coordinate system (MANDATORY — the old build mirrored north/south; do not repeat)
- World units = meters. Y is up. Ground at y = 0.
- North is **-Z**, East is **+X** (Three.js default camera looks down -Z = north).
- Projection (geo.js only): `x = (lon - lon0) * cos(lat0·π/180) * 111320`, `z = -(lat - lat0) * 111320`.
- All downstream modules receive **already-projected** `{x, z}` points and never touch lat/lon.
- When building a `THREE.Shape` from a footprint for `ExtrudeGeometry` followed by `geo.rotateX(-Math.PI/2)`, you MUST use `shape.moveTo(p.x, -p.z)` (negate z). Rotating −90° about X maps shape-Y → −world-Z, so negating restores the correct z. Verify by checking the resulting geometry's bounding box matches the footprint's z range.

## Style direction
Flat "construction-paper cutout" cartoon look: flat saturated colors, 2–3 step toon shading, thick dark outlines (inverted hull), slightly wobbly/hand-cut edges where cheap, paper grain texture. **Do NOT** reference, name, or imitate any TV show, its characters, logos, fonts, or town signs. Targets are original paper-cutout figures. **No house numbers anywhere** — never read or render `addr:housenumber`. Street NAME signs are wanted.

## Shared types

```js
// WorldData — produced by geo.parseOSM
{
  center: { lat, lon, label },          // label = human string, e.g. "Enid, OK" or the searched address
  source: 'live' | 'fallback',
  buildings: [{
    id: Number,
    kind: 'house' | 'garage' | 'shed' | 'apartments' | 'commercial' | 'church' | 'school' | 'other',
    footprint: [{ x, z }],              // ≥3 unique pts, CCW when viewed from above (+Y), NOT closed (last != first)
    height: Number,                     // wall height in m (eave height for pitched roofs)
    levels: Number,                     // ≥1
    roofShape: 'gabled' | 'hipped' | 'flat' | 'pyramidal' | null,   // null = let houses.js infer
    roofHeight: Number | null,
    wallColor: String | null,           // CSS color if OSM tagged building:colour
    roofColor: String | null,           // CSS color if OSM tagged roof:colour
    name: String | null                 // e.g. church/school name; NEVER the house number
  }],
  roads: [{
    id: Number,
    name: String | null,                // OSM name, e.g. "W Maple Ave"
    kind: 'primary' | 'secondary' | 'tertiary' | 'residential' | 'service' | 'driveway' | 'footway' | 'alley' | 'other',
    width: Number,                      // carriageway width in m
    points: [{ x, z }]                  // ≥2 pts polyline
  }],
  trees: [{ x, z }],                    // natural=tree nodes
  bounds: { minX, maxX, minZ, maxZ }    // of everything kept
}

// Collider — produced by houses.js and streets.js, consumed by game.js
{ type: 'obb', cx, cz, hw, hd, angle, height }   // oriented box: half-width along local X, half-depth along local Z,
                                                  // angle = rotation about +Y in radians (THREE convention),
                                                  // spans y ∈ [0, height]
{ type: 'cyl', cx, cz, r, height }                // e.g. tree trunks, sign posts
```

## Module APIs

### js/geo.js (Agent A)
```js
export async function geocode(query)            // → { lat, lon, label } | null   (Nominatim, 8s timeout, User-Agent not settable in browsers — use &email= not required; just call)
export async function resolveCenter(CONFIG)     // URL ?lat=&lon= → ?q= (geocode) → CONFIG.default_center. → { lat, lon, label }
export async function loadWorld(center, CONFIG, onStatus)
  // Tries Overpass (POST, 15s AbortController timeout, 2 mirrors: overpass-api.de then overpass.kumi.systems).
  // On any failure/empty → fetch('data/fallback_osm.json') and use ITS center (stored in the JSON as "center": {lat, lon, label}).
  // Returns WorldData (parsed). onStatus(string) for loading messages.
export function parseOSM(json, center, CONFIG)  // → WorldData (pure, exported for testing)
export function pointInPolygon(p, poly)         // utility, {x,z} vs [{x,z}]
```

### js/toon.js (Agent B)
```js
export const PALETTE                            // { walls: [...], roofs: [...], doors: [...], trim, outline, grass, road, sidewalk, sky, ... } hex numbers
export function toonMaterial(color, opts?)      // cached MeshToonMaterial with shared gradient map + paper grain; opts {side, transparent, map}
export function addOutline(mesh, thickness=0.06)// inverted-hull back-face outline child; returns outline mesh. Works on merged geometries.
export function setupEnvironment(scene, renderer) // sky (flat gradient or flat color + paper clouds), lights tuned for toon, fog, renderer settings
export function paperTexture()                  // shared subtle grain CanvasTexture
```

### js/houses.js (Agent B)
```js
export function buildHouses(scene, worldData, CONFIG)
  // → { group: THREE.Group, colliders: Collider[], count: Number }
  // Merges geometry per material to keep draw calls < ~60 for 400 houses.
```

### js/streets.js (Agent C)
```js
export function buildStreets(scene, worldData, CONFIG)
  // → { group, colliders: Collider[], spawnPoint: {x, z, yaw}, signCount }
  // spawnPoint = on a residential road near center, yaw facing along the road.
```

### js/game.js (Agent C)
```js
export function createGame({ THREE, scene, camera, renderer, worldData, colliders, spawnPoint, CONFIG, isMobile })
  // → { start(), update(dt), dispose() }
  // Owns: cannon world, player, controls (desktop pointer-lock + mobile nipplejs/touch-look/buttons),
  // paintballs, splats, targets, HUD updates, win screen. main.js calls update(dt) every frame after start().
```

### js/main.js (Opus)
Boot: renderer/scene/camera → toon.setupEnvironment → start screen with address search → geo.loadWorld → houses + streets → game.createGame → render loop.

## DOM ids that exist in index.html (owned by Opus — use, don't add markup)
`#canvas`, `#hud`, `#stat-shots`, `#stat-hits`, `#stat-acc`, `#stat-targets`, `#ammo-bar`, `#timer`, `#crosshair`, `#hit-flash`, `#location-label`,
`#mobile-controls` > `#joystick-zone`, `#look-zone`, `#btn-fire`, `#btn-jump`,
`#overlay`, `#overlay-title`, `#overlay-sub`, `#search-form`, `#search-input`, `#search-btn`, `#start-btn`, `#loading-msg`, `#controls-desktop`, `#controls-mobile`,
`#win-screen`, `#win-stats`, `#restart-btn`.
game.js may set `.hidden` class / textContent on these. CSS class `.hidden { display:none !important }` exists.
