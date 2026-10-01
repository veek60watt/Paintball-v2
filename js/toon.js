// Paperball — toon.js (Agent B)
// Flat construction-paper cutout look: 3-step toon ramp, inverted-hull outlines, paper grain, flat sky + paper clouds.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const PALETTE = {
  walls: [
    0xfbe7a1, // cream
    0xffd84d, // yellow
    0x6cc3f2, // sky blue
    0x9fd67a, // sage green
    0xff8a7a, // salmon
    0xe8b878, // tan
    0xc9b8f0, // lavender
    0xf6f4ee, // white
    0xd9573b, // brick red
  ],
  roofs: [
    0x6b3f22, // dark brown
    0x3a3d44, // charcoal
    0x3f6fb5, // slate blue
    0xe0602e, // terracotta
    0x2e8a49, // forest green
  ],
  doors: [
    0xd62f2f, // red
    0x1f3a73, // navy
    0x222222, // black
    0x1f9d8f, // teal
    0xf2f2f2, // white
  ],
  trim: 0xffffff,
  outline: 0x1a1a1a,
  glass: 0xa9d8f0,
  brick: 0xb5523b,
  gray: 0x9aa0a6,
  garageDoor: 0xe4e1d8,
  flatRoof: 0x4b4f57,
  grass: 0x6fd14a,
  grassDark: 0x62b043,
  dirt: 0xc9a66b,
  road: 0x4a4a52,
  sidewalk: 0xd2cdc2,
  curb: 0xa8a39a,
  lane: 0xf2c94c,
  laneWhite: 0xffffff,
  sky: 0x7cc8f7,
  skyHorizon: 0xcdeefc,
  cloud: 0xffffff,
  treeLeaves: 0x3fa34d,
  treeLeavesAlt: 0x58b947,
  treeTrunk: 0x6b4a2f,
  signGreen: 0x1f7a4d,
  signPost: 0x7a7f87,
};

// ---------------------------------------------------------------- paper grain
let _paper = null;
export function paperTexture() {
  if (_paper) return _paper;
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  let s = 1234567;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < N * N; i++) {
    const v = 242 + Math.floor(rnd() * 14); // 242..255 : very subtle multiply
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  // short darker fibers (wrapping)
  for (let f = 0; f < 110; f++) {
    let x = rnd() * N, y = rnd() * N;
    const ang = rnd() * Math.PI * 2, len = 4 + rnd() * 10;
    const dx = Math.cos(ang), dy = Math.sin(ang), dark = 228 + Math.floor(rnd() * 10);
    for (let t = 0; t < len; t++) {
      const px = ((Math.floor(x + dx * t) % N) + N) % N, py = ((Math.floor(y + dy * t) % N) + N) % N;
      const k = (py * N + px) * 4;
      data[k] = data[k + 1] = data[k + 2] = dark;
    }
  }
  let tex;
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    img.data.set(data);
    ctx.putImageData(img, 0, 0);
    tex = new THREE.CanvasTexture(c);
  } else {
    tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  }
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(0.5, 0.5); // ~1 tile per 2 m on world-ish UVs
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  tex.needsUpdate = true;
  _paper = tex;
  return tex;
}

// ---------------------------------------------------------------- toon materials
let _grad = null;
function gradientMap() {
  if (_grad) return _grad;
  // 3 flat light steps (shadow / mid / lit)
  const d = new Uint8Array([
    120, 120, 120, 255,
    185, 185, 185, 255,
    255, 255, 255, 255,
  ]);
  _grad = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
  _grad.minFilter = _grad.magFilter = THREE.NearestFilter;
  _grad.generateMipmaps = false;
  _grad.needsUpdate = true;
  return _grad;
}

const _matCache = new Map();
export function toonMaterial(color, opts = {}) {
  const hex = new THREE.Color(color).getHex();
  const mapKey = opts.map === false ? 'nomap' : opts.map ? opts.map.uuid : 'paper';
  const key = [hex, opts.side ?? 0, opts.transparent ? 1 : 0, opts.opacity ?? 1, mapKey].join('|');
  let m = _matCache.get(key);
  if (m) return m;
  m = new THREE.MeshToonMaterial({
    color: hex,
    gradientMap: gradientMap(),
    map: opts.map === false ? null : (opts.map || paperTexture()),
    side: opts.side ?? THREE.FrontSide,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
  });
  _matCache.set(key, m);
  return m;
}

// ---------------------------------------------------------------- outlines (inverted hull)
const _outlineMats = new Map();
function outlineMaterial(thickness) {
  const key = thickness.toFixed(4);
  let m = _outlineMats.get(key);
  if (m) return m;
  m = new THREE.MeshBasicMaterial({ color: PALETTE.outline, side: THREE.BackSide });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      // Scale hull growth with view depth so the ink line stays ~constant on screen (cut-paper look at any range).
      `float olDepth = max(-(modelViewMatrix * vec4(position, 1.0)).z, 0.1);
      vec3 transformed = vec3( position ) + normalize( normal ) * ${thickness.toFixed(5)} * clamp(olDepth / 7.0, 1.0, 14.0);`
    );
  };
  m.customProgramCacheKey = () => 'outline' + key;
  _outlineMats.set(key, m);
  return m;
}

// Replace normals by position-welded, area-weighted averages so hard-edged merged geometry
// (boxes, extrusions) grows evenly at corners instead of tearing open.
function smoothedClone(geo) {
  const g = geo.clone();
  const pos = g.attributes.position;
  const idx = g.index;
  const triCount = (idx ? idx.count : pos.count) / 3;
  const acc = new Map();
  const keyOf = (i) => {
    const ix = Math.round(pos.getX(i) * 20) + 16384;
    const iy = Math.round(pos.getY(i) * 20) + 16384;
    const iz = Math.round(pos.getZ(i) * 20) + 16384;
    return (ix * 32768 + iy) * 32768 + iz;
  };
  const vi = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
  const keys = new Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = vi(t, 0), b = vi(t, 1), c = vi(t, 2);
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const e1x = pos.getX(b) - ax, e1y = pos.getY(b) - ay, e1z = pos.getZ(b) - az;
    const e2x = pos.getX(c) - ax, e2y = pos.getY(c) - ay, e2z = pos.getZ(c) - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    for (let k = 0; k < 3; k++) {
      const key = keyOf(vi(t, k));
      keys[t * 3 + k] = key;
      let s = acc.get(key);
      if (!s) { s = [0, 0, 0]; acc.set(key, s); }
      s[0] += nx; s[1] += ny; s[2] += nz;
    }
  }
  const nrm = new Float32Array(pos.count * 3);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const s = acc.get(keys[t * 3 + k]);
      const l = Math.hypot(s[0], s[1], s[2]) || 1;
      const v = vi(t, k);
      nrm[v * 3] = s[0] / l; nrm[v * 3 + 1] = s[1] / l; nrm[v * 3 + 2] = s[2] / l;
    }
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

export function addOutline(mesh, thickness = 0.06) {
  const hull = new THREE.Mesh(smoothedClone(mesh.geometry), outlineMaterial(thickness));
  hull.name = 'outline';
  hull.matrixAutoUpdate = false; // identity relative to parent
  hull.renderOrder = mesh.renderOrder;
  mesh.add(hull);
  return hull;
}

// ---------------------------------------------------------------- environment
function buildClouds() {
  const white = [], dark = [];
  let s = 98765;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const CL = 11;
  for (let c = 0; c < CL; c++) {
    const ang = (c / CL) * Math.PI * 2 + rnd() * 0.4;
    const R = 300 + rnd() * 30, y = 95 + rnd() * 50;
    const cx = Math.cos(ang) * R, cz = Math.sin(ang) * R;
    const blobs = 3 + Math.floor(rnd() * 3);
    for (let b = 0; b < blobs; b++) {
      const bx = (b - blobs / 2) * 16 + rnd() * 6, by = rnd() * 4, bz = rnd() * 8;
      const sx = 16 + rnd() * 10, sy = 5 + rnd() * 3, sz = 9 + rnd() * 4;
      for (const [list, grow] of [[white, 1], [dark, 1.07]]) {
        const g = new THREE.SphereGeometry(1, 8, 5);
        g.scale(sx * grow, sy * grow + (grow > 1 ? 0.25 : 0), sz * grow);
        // rotate each cloud to face tangentially, then place
        g.translate(bx, by, bz);
        g.rotateY(-ang + Math.PI / 2);
        g.translate(cx, y, cz);
        list.push(g.index ? g.toNonIndexed() : g);
      }
    }
  }
  const strip = (arr) => arr.map((g) => {
    for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal' && n !== 'uv') g.deleteAttribute(n);
    return g;
  });
  const group = new THREE.Group();
  group.name = 'paper-clouds';
  const outline = new THREE.Mesh(
    mergeGeometries(strip(dark)),
    new THREE.MeshBasicMaterial({ color: PALETTE.outline, fog: false })
  );
  const fill = new THREE.Mesh(
    mergeGeometries(strip(white)),
    new THREE.MeshBasicMaterial({ color: PALETTE.cloud, fog: false })
  );
  // dark shell drawn first, white slightly nearer via polygonOffset => reads as a thick outline
  outline.renderOrder = -10; fill.renderOrder = -9;
  outline.material.depthWrite = false; fill.material.depthWrite = false;
  outline.frustumCulled = fill.frustumCulled = false;
  group.add(outline, fill);
  return group;
}

/**
 * @param fogOpts optional: CONFIG-like { fog_near, fog_far } or { near, far }. Defaults 90 / 320.
 */
export function setupEnvironment(scene, renderer, fogOpts) {
  const near = fogOpts?.fog_near ?? fogOpts?.near ?? 90;
  const far = fogOpts?.fog_far ?? fogOpts?.far ?? 320;

  if (renderer) {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
  }

  scene.background = new THREE.Color(PALETTE.sky);
  scene.fog = new THREE.Fog(PALETTE.sky, near, far);

  const hemi = new THREE.HemisphereLight(0xfdfdff, 0xb7d99a, 1.15);
  hemi.name = 'toon-hemi';
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(80, 140, 50);
  sun.castShadow = false;
  sun.name = 'toon-sun';
  scene.add(sun);

  const clouds = buildClouds();
  scene.add(clouds);
  return { hemi, sun, clouds };
}
