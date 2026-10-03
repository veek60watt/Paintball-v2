// Paperball — boot orchestrator. Owned by integrator.
import * as THREE from 'three';
import { CONFIG, IS_MOBILE } from './config.js';
import { resolveCenter, loadWorld, geocodeAddress, US_STATES } from './geo.js';
import { setupEnvironment } from './toon.js';
import { buildHouses } from './houses.js';
import { buildStreets } from './streets.js';
import { createGame } from './game.js';

const $ = (id) => document.getElementById(id);
const status = (msg) => { const el = $('loading-msg'); if (el) el.textContent = msg; };

let renderer, scene, camera, game = null, started = false;
let preview = { cx: 0, cz: 0, r: 70, t: 0 };

function setupRenderer() {
  renderer = new THREE.WebGLRenderer({ canvas: $('canvas'), antialias: !IS_MOBILE, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, CONFIG.pixel_ratio_cap));
  renderer.setSize(innerWidth, innerHeight);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 700);
  camera.position.set(0, 60, 80);
  camera.lookAt(0, 0, 0);
  setupEnvironment(scene, renderer, CONFIG);
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

function wireSearch() {
  // State dropdown (default Enid, OK; restored from the URL after a search)
  const sp = new URLSearchParams(location.search);
  const sel = $('state-input');
  for (const [abbr, name] of Object.entries(US_STATES)) {
    const o = document.createElement('option');
    o.value = abbr; o.textContent = abbr; o.title = name;
    sel.appendChild(o);
  }
  const searched = sp.has('lat') || sp.has('q');
  const d = CONFIG.default_center;
  sel.value = (searched ? sp.get('st') : d.state) || d.state;
  $('city-input').value = (searched ? sp.get('c') : d.city) || '';
  $('street-input').value = (searched ? sp.get('s') : d.street) || '';

  $('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const street = $('street-input').value.trim();
    const city = $('city-input').value.trim();
    const state = $('state-input').value;
    if (!city) { status('Enter a city.'); return; }
    $('search-btn').disabled = true;
    status(`Finding ${street ? street + ', ' : ''}${city}, ${state}…`);
    const hit = await geocodeAddress({ street, city, state });
    if (!hit) {
      status(`Couldn't find "${street}" in ${city}, ${state}. Check the spelling, or try just the street name without the number.`);
      $('search-btn').disabled = false;
      return;
    }
    // Reload with explicit coordinates: bookmarkable, and the geocoder can't re-"correct" it on load.
    const p = new URLSearchParams({
      lat: hit.lat.toFixed(6), lon: hit.lon.toFixed(6), label: hit.label, prec: hit.precision,
      s: street, c: city, st: state,
    });
    location.search = p.toString();
  });
}

async function boot() {
  setupRenderer();
  wireSearch();
  if (IS_MOBILE) {
    $('controls-desktop').classList.add('hidden');
    $('controls-mobile').classList.remove('hidden');
  }
  requestAnimationFrame(loop);

  status('Locating…');
  const center = await resolveCenter(CONFIG);
  const params = new URLSearchParams(location.search);

  status('Fetching your neighborhood from OpenStreetMap…');
  const isDefault = !params.has('lat') && !params.has('q');
  const world = await loadWorld(center, CONFIG, status, isDefault ? { preload: 'data/preload_osm.json' } : {});

  status('Cutting out houses…');
  await nextFrame();
  const houses = buildHouses(scene, world, CONFIG);

  status('Laying streets and planting trees…');
  await nextFrame();
  const streets = buildStreets(scene, world, CONFIG);

  const label = world.source === 'fallback'
    ? `${world.center?.label || 'Sample block'}`
    : (world.center?.label || center.label);
  $('location-label').textContent = label;

  game = createGame({
    THREE, scene, camera, renderer, worldData: world,
    colliders: [...houses.colliders, ...streets.colliders],
    spawnPoint: streets.spawnPoint, CONFIG, isMobile: IS_MOBILE,
  });

  window.__paperball = { game, camera, world }; // read-only hook for the automated smoke test
  preview.cx = streets.spawnPoint?.x ?? 0;
  preview.cz = streets.spawnPoint?.z ?? 0;

  if (world.source === 'fallback') {
    const asked = world.requested?.label || center.label;
    const why = world.reason === 'no-buildings'
      ? `OpenStreetMap has no buildings mapped near "${asked}".`
      : `The map servers didn't answer for "${asked}" (they're often busy).`;
    const el = $('loading-msg');
    el.textContent = '';
    const b = document.createElement('b');
    b.textContent = `Couldn't load ${asked}. `;
    el.append(b, `${why} Showing an offline sample block instead. `);
    const retry = document.createElement('a');
    retry.href = location.href; retry.textContent = 'Retry'; retry.style.cssText = 'font-weight:bold;color:#e63946';
    el.append(retry);
    if (world.errors?.length) {
      const det = document.createElement('div');
      det.style.cssText = 'font-size:12px;opacity:.7;margin-top:6px';
      det.textContent = 'Details: ' + world.errors.join(' · ');
      el.append(det);
    }
  } else {
    const prec = params.get('prec');
    const note = prec === 'street' ? ' · centered on the street (exact house not in OpenStreetMap)'
               : prec === 'city' ? ' · centered on the city' : '';
    status(`${houses.count} houses · ${streets.signCount} street signs · ${label}${note}`);
  }
  const btn = $('start-btn');
  btn.disabled = false;
  btn.textContent = IS_MOBILE ? 'Tap to Play' : 'Play';
  btn.addEventListener('click', startGame, { once: true });
}

function startGame() {
  $('overlay').classList.add('hidden');
  started = true;
  game.start();
}

function nextFrame() { return new Promise((r) => requestAnimationFrame(() => r())); }

const clock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (started && game) {
    game.update(dt);
  } else {
    // Slow orbit over the block behind the start screen.
    preview.t += dt * 0.08;
    camera.position.set(preview.cx + Math.cos(preview.t) * preview.r, 45, preview.cz + Math.sin(preview.t) * preview.r);
    camera.lookAt(preview.cx, 0, preview.cz);
  }
  renderer.render(scene, camera);
}

addEventListener('error', (e) => status(`Error: ${e.message}`));
addEventListener('unhandledrejection', (e) => status(`Error: ${e.reason?.message || e.reason}`));

boot();
