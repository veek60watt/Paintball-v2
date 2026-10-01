// Paperball — boot orchestrator. Owned by integrator.
import * as THREE from 'three';
import { CONFIG, IS_MOBILE } from './config.js';
import { resolveCenter, loadWorld, geocode } from './geo.js';
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
  $('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('search-input').value.trim();
    if (!q) return;
    $('search-btn').disabled = true;
    status(`Finding "${q}"…`);
    const hit = await geocode(q);
    if (!hit) {
      status(`Couldn't find "${q}". Try street + city, e.g. "Maple Ave, Enid OK".`);
      $('search-btn').disabled = false;
      return;
    }
    // Clean reload keeps state simple and makes the location shareable/bookmarkable.
    const p = new URLSearchParams({ lat: hit.lat.toFixed(6), lon: hit.lon.toFixed(6), label: hit.label });
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
  if (params.get('q') || params.get('label')) $('search-input').value = params.get('label') || params.get('q');

  status('Fetching your neighborhood from OpenStreetMap…');
  const world = await loadWorld(center, CONFIG, status);

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
  } else {
    status(`${houses.count} houses · ${streets.signCount} street signs · ${label}`);
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
