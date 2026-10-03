// Paperball — game.js (Agent C)
// Physics (cannon-es), player + controls, paintballs, splats, paper-cutout targets, HUD, win screen.
import * as CANNON from 'cannon-es';
import { addOutline, PALETTE, toonMaterial } from './toon.js';

const PAINT = [0xff2d95, 0x7dff1a, 0xff8a00, 0x1f6bff, 0x9b30ff, 0xffe600]; // hot pink, lime, orange, electric blue, purple, yellow
const SHIRTS = [0xe63946, 0x2a9d8f, 0xf4a261, 0x457b9d, 0x9b5de5, 0xf15bb5, 0x00bbf9, 0xfee440, 0x8ac926, 0xff7f50];
const SKINS = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0x6b4423];
const HAIRS = [0x2b1d0e, 0x6b3e1d, 0xd9a441, 0xb5442a, 0x222222, 0xcfcfcf];
const DEG = Math.PI / 180;

export function createGame({ THREE, scene, camera, renderer, worldData, colliders, spawnPoint, CONFIG, isMobile }) {
  const $ = (id) => document.getElementById(id);
  const rnd = Math.random;
  const R = CONFIG.player_radius;
  const BALL_R = CONFIG.paintball_radius;
  const listeners = [];
  const on = (el, ev, fn, opts) => { if (!el) return; el.addEventListener(ev, fn, opts); listeners.push([el, ev, fn, opts]); };
  const intervals = [];

  // ================================================================ physics world
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, CONFIG.gravity, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.solver.iterations = isMobile ? 6 : 8;
  world.allowSleep = false;
  const matStatic = new CANNON.Material('static');
  const matPlayer = new CANNON.Material('player');
  const matBall = new CANNON.Material('ball');
  world.defaultContactMaterial.friction = 0;
  world.addContactMaterial(new CANNON.ContactMaterial(matPlayer, matStatic, { friction: 0, restitution: 0 }));
  world.addContactMaterial(new CANNON.ContactMaterial(matBall, matStatic, { friction: 0, restitution: 0 }));
  const G_STATIC = 1, G_PLAYER = 2, G_BALL = 4;

  let bodyCount = 0;
  const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: matStatic });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  ground.collisionFilterGroup = G_STATIC;
  world.addBody(ground); bodyCount++;

  const staticBodies = [];
  const obbs = [], cyls = [];
  {
    const budget = CONFIG.max_cannon_bodies - 2 - CONFIG.max_paintballs;
    let skipped = 0, used = 0;
    const list = [...(colliders || [])].sort((a, b) => (a.type === 'obb' ? 0 : 1) - (b.type === 'obb' ? 0 : 1));
    for (const c of list) {
      if (used >= budget) { skipped++; continue; }
      let body;
      if (c.type === 'obb') {
        body = new CANNON.Body({ mass: 0, material: matStatic, shape: new CANNON.Box(new CANNON.Vec3(c.hw, c.height / 2, c.hd)) });
        body.position.set(c.cx, c.height / 2, c.cz);
        body.quaternion.setFromEuler(0, c.angle || 0, 0);
        obbs.push({ cx: c.cx, cz: c.cz, hw: c.hw, hd: c.hd, cos: Math.cos(c.angle || 0), sin: Math.sin(c.angle || 0), rad: Math.hypot(c.hw, c.hd) });
      } else if (c.type === 'cyl') {
        const r = Math.max(c.r, 0.05);
        body = new CANNON.Body({ mass: 0, material: matStatic, shape: new CANNON.Box(new CANNON.Vec3(r, c.height / 2, r)) });
        body.position.set(c.cx, c.height / 2, c.cz);
        cyls.push({ cx: c.cx, cz: c.cz, r, height: c.height });
      } else continue;
      body.collisionFilterGroup = G_STATIC;
      world.addBody(body); staticBodies.push(body); bodyCount++; used++;
    }
    if (skipped) console.warn(`[game] max_cannon_bodies reached; skipped ${skipped} colliders`);
  }

  // ================================================================ player
  const capTop = CONFIG.player_height + 0.1; // capsule top above feet
  const player = new CANNON.Body({ mass: 70, material: matPlayer, fixedRotation: true, linearDamping: 0, angularDamping: 1 });
  player.addShape(new CANNON.Sphere(R), new CANNON.Vec3(0, 0, 0));
  player.addShape(new CANNON.Sphere(R), new CANNON.Vec3(0, capTop - 2 * R, 0));
  player.collisionFilterGroup = G_PLAYER;
  player.collisionFilterMask = G_STATIC;
  player.allowSleep = false;
  // Spawn must be clear of every collision box, not just building footprints: a box that overhangs the
  // sidewalk would otherwise push the player out through the ground (seen live at the White House).
  const insideCollider = (x, z, m) => {
    for (const c of colliders || []) {
      if (c.type === 'obb') {
        const dx = x - c.cx, dz = z - c.cz, ca = Math.cos(c.angle || 0), sa = Math.sin(c.angle || 0);
        const lx = dx * ca - dz * sa, lz = dx * sa + dz * ca; // inverse of rotation.y = angle
        if (Math.abs(lx) < c.hw + m && Math.abs(lz) < c.hd + m) return true;
      } else if (c.type === 'cyl') {
        if (Math.hypot(x - c.cx, z - c.cz) < c.r + m) return true;
      }
    }
    return false;
  };
  const sp0 = spawnPoint && isFinite(spawnPoint.x) && isFinite(spawnPoint.z) ? spawnPoint : { x: 0, z: 0, yaw: 0 };
  const sp = (() => {
    const m = R + 0.4;
    if (!insideCollider(sp0.x, sp0.z, m)) return sp0;
    for (let r = 2; r <= 90; r += 2) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2, x = sp0.x + Math.cos(a) * r, z = sp0.z + Math.sin(a) * r;
        if (!insideCollider(x, z, m)) return { x, z, yaw: sp0.yaw || 0 };
      }
    }
    return sp0;
  })();
  player.position.set(sp.x, R + 0.02, sp.z);
  world.addBody(player); bodyCount++;
  let yaw = sp.yaw || 0, pitch = 0;
  let grounded = false;
  const rayFrom = new CANNON.Vec3(), rayTo = new CANNON.Vec3(), rayRes = new CANNON.RaycastResult();
  const feetY = () => player.position.y - R;

  function checkGround() {
    rayFrom.set(player.position.x, feetY() + 0.1, player.position.z);
    rayTo.set(player.position.x, feetY() - 0.12, player.position.z);
    rayRes.reset();
    world.raycastClosest(rayFrom, rayTo, { collisionFilterMask: G_STATIC, skipBackfaces: true }, rayRes);
    return rayRes.hasHit && player.velocity.y <= 0.5;
  }

  // ================================================================ input state
  const keys = {};
  const joy = { x: 0, y: 0 };
  let jumpHeld = false;
  let running = false, won = false, winTimer = 0;
  let lookTouchId = null, lookX = 0, lookY = 0;
  let autoFire = null;
  const canvas = $('canvas') || (renderer && renderer.domElement);
  const PITCH = 85 * DEG;

  function setupDesktop() {
    on(canvas, 'click', () => { if (running && !won && document.pointerLockElement !== canvas) { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (_) {} } });
    on(document, 'mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      yaw -= e.movementX * CONFIG.mouse_sensitivity;
      pitch -= e.movementY * CONFIG.mouse_sensitivity;
      pitch = Math.max(-PITCH, Math.min(PITCH, pitch));
    });
    on(document, 'mousedown', (e) => {
      if (e.button !== 0 || !running || won) return;
      if (document.pointerLockElement === canvas) fire();
    });
    on(document, 'keydown', (e) => {
      keys[e.code] = true;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    on(document, 'keyup', (e) => { keys[e.code] = false; });
    on(window, 'blur', () => { for (const k in keys) keys[k] = false; });
  }

  function setupMobile() {
    const mc = $('mobile-controls');
    if (mc) mc.classList.remove('hidden');
    const zone = $('joystick-zone');
    if (zone && typeof window !== 'undefined' && window.nipplejs) {
      const mgr = window.nipplejs.create({ zone, mode: 'dynamic', color: 'rgba(255,255,255,0.7)', size: 110, threshold: 0.05, fadeTime: 100 });
      mgr.on('move', (_, d) => {
        if (!d || !d.vector) return;
        const f = Math.min(1, d.force || 1);
        joy.x = d.vector.x * f; joy.y = d.vector.y * f; // nipplejs: +y is up = forward
      });
      mgr.on('end', () => { joy.x = 0; joy.y = 0; });
      listeners.push([{ removeEventListener() { try { mgr.destroy(); } catch (_) {} } }, '', null]);
    }
    const lz = $('look-zone');
    on(lz, 'touchstart', (e) => {
      e.preventDefault();
      if (lookTouchId !== null) return;
      const t = e.changedTouches[0];
      lookTouchId = t.identifier; lookX = t.clientX; lookY = t.clientY;
    }, { passive: false });
    on(lz, 'touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== lookTouchId) continue;
        yaw -= (t.clientX - lookX) * CONFIG.touch_sensitivity;
        pitch -= (t.clientY - lookY) * CONFIG.touch_sensitivity;
        pitch = Math.max(-PITCH, Math.min(PITCH, pitch));
        lookX = t.clientX; lookY = t.clientY;
      }
    }, { passive: false });
    const endLook = (e) => { for (const t of e.changedTouches) if (t.identifier === lookTouchId) lookTouchId = null; };
    on(lz, 'touchend', endLook); on(lz, 'touchcancel', endLook);

    const bf = $('btn-fire');
    const stopAuto = () => { if (autoFire) { clearInterval(autoFire); autoFire = null; } };
    on(bf, 'touchstart', (e) => {
      e.preventDefault();
      if (running && !won) fire();
      stopAuto();
      autoFire = setInterval(() => { if (running && !won) fire(); }, 180);
    }, { passive: false });
    on(bf, 'touchend', (e) => { e.preventDefault(); stopAuto(); }, { passive: false });
    on(bf, 'touchcancel', stopAuto);
    const bj = $('btn-jump');
    on(bj, 'touchstart', (e) => { e.preventDefault(); jumpHeld = true; }, { passive: false });
    on(bj, 'touchend', () => { jumpHeld = false; });
    on(bj, 'touchcancel', () => { jumpHeld = false; });
  }

  // ================================================================ splats
  const splatCache = new Map();
  const Z = new THREE.Vector3(0, 0, 1);
  function hexStr(h) { return '#' + (h & 0xffffff).toString(16).padStart(6, '0'); }
  function splatMaterial(color, variant) {
    const key = color + '_' + variant;
    let m = splatCache.get(key);
    if (m) return m;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const ctx = cv.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, 128, 128);
      ctx.fillStyle = hexStr(color);
      ctx.strokeStyle = 'rgba(20,20,20,0.75)';
      ctx.lineWidth = 3.5;
      ctx.lineJoin = 'round';
      const drops = 4 + (variant % 3) * 2;
      for (let i = 0; i < drops; i++) {
        const a = rnd() * Math.PI * 2, d = 44 + rnd() * 14, r = 3.5 + rnd() * 6;
        ctx.beginPath(); ctx.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      const N = 26 + variant * 4;
      const pts = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const spike = i % 3 === 0 ? 10 + rnd() * 10 : rnd() * 8 - 4;
        const r = 30 + spike;
        pts.push([64 + Math.cos(a) * r, 64 + Math.sin(a) * r]);
      }
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    splatCache.set(key, m);
    return m;
  }
  const splatGeo = new THREE.PlaneGeometry(1, 1);
  const splats = [];
  let splatNext = 0;
  const _q = new THREE.Quaternion(), _qz = new THREE.Quaternion(), _n = new THREE.Vector3();
  function spawnSplat(point, normal, color) {
    const cap = CONFIG.max_splats;
    let mesh;
    if (splats.length < cap) { mesh = new THREE.Mesh(splatGeo, null); mesh.renderOrder = 2; scene.add(mesh); splats.push(mesh); }
    else { mesh = splats[splatNext]; splatNext = (splatNext + 1) % cap; }
    mesh.material = splatMaterial(color, Math.floor(rnd() * 3));
    _n.copy(normal).normalize();
    _q.setFromUnitVectors(Z, _n);
    _qz.setFromAxisAngle(Z, rnd() * Math.PI * 2);
    mesh.quaternion.copy(_q).multiply(_qz);
    if (_n.y > 0.9 && point.y < 0.3) mesh.position.set(point.x, 0.08, point.z); // lie flat above sidewalk/road layers
    else mesh.position.copy(point).addScaledVector(_n, 0.02);
    const s = 0.55 + rnd() * 0.6;
    mesh.scale.set(s, s, 1);
    mesh.visible = true;
    return mesh;
  }

  // ================================================================ paintballs
  const ballGeo = new THREE.SphereGeometry(BALL_R * 1.5, 8, 6);
  const ballMats = new Map();
  const balls = [];
  const removeQueue = [];
  const _dir = new THREE.Vector3(), _eye = new THREE.Vector3();
  const stats = { shots: 0, hits: 0 };

  function killBall(pb) { if (!pb.dead) { pb.dead = true; removeQueue.push(pb); } }
  function flushQueue() {
    while (removeQueue.length) {
      const pb = removeQueue.pop();
      if (pb.body) { world.removeBody(pb.body); bodyCount--; pb.body = null; }
      if (pb.mesh.parent) pb.mesh.parent.remove(pb.mesh);
      const i = balls.indexOf(pb);
      if (i >= 0) balls.splice(i, 1);
    }
  }

  function fire() {
    stats.shots++;
    // evict oldest (outside of world.step, so direct removal is safe)
    while (balls.filter((b) => !b.dead).length >= CONFIG.max_paintballs) {
      const old = balls.find((b) => !b.dead);
      if (!old) break;
      killBall(old);
    }
    flushQueue();
    _dir.set(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    _eye.set(player.position.x, feetY() + CONFIG.player_height, player.position.z);
    const color = PAINT[Math.floor(rnd() * PAINT.length)];
    let mat = ballMats.get(color);
    if (!mat) { mat = new THREE.MeshBasicMaterial({ color }); ballMats.set(color, mat); }
    const mesh = new THREE.Mesh(ballGeo, mat);
    const sx = _eye.x + _dir.x * 0.5, sy = _eye.y - 0.08 + _dir.y * 0.5, sz = _eye.z + _dir.z * 0.5;
    mesh.position.set(sx, sy, sz);
    scene.add(mesh);
    const body = new CANNON.Body({ mass: 0.05, material: matBall, shape: new CANNON.Sphere(BALL_R), linearDamping: 0.01 });
    body.collisionFilterGroup = G_BALL;
    body.collisionFilterMask = G_STATIC;
    body.position.set(sx, sy, sz);
    body.velocity.set(
      _dir.x * CONFIG.paintball_speed + player.velocity.x,
      _dir.y * CONFIG.paintball_speed + player.velocity.y,
      _dir.z * CONFIG.paintball_speed + player.velocity.z
    );
    world.addBody(body); bodyCount++;
    const pb = { mesh, body, color, dead: false, contact: null, age: 0, prev: new THREE.Vector3(_eye.x, _eye.y - 0.08, _eye.z) };
    body.addEventListener('collide', (e) => {
      if (pb.contact || pb.dead) return;
      const c = e.contact;
      const s = c.bi === body ? -1 : 1; // ni points out of bi
      pb.contact = { nx: c.ni.x * s, ny: c.ni.y * s, nz: c.ni.z * s };
    });
    balls.push(pb);
    hudDirty = true;
  }

  // ================================================================ geometry helpers (targets & wandering)
  const buildings = (worldData.buildings || []).map((b) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of b.footprint) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    return { fp: b.footprint, minX, maxX, minZ, maxZ };
  });
  function inPoly(x, z, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
    return inside;
  }
  function insideBuilding(x, z) {
    for (const b of buildings) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (inPoly(x, z, b.fp)) return true;
    }
    return false;
  }
  function insideObb(x, z, pad) {
    for (const o of obbs) {
      const dx = x - o.cx, dz = z - o.cz, rr = o.rad + pad;
      if (dx * dx + dz * dz > rr * rr) continue;
      const lx = dx * o.cos - dz * o.sin, lz = dx * o.sin + dz * o.cos;
      if (Math.abs(lx) < o.hw + pad && Math.abs(lz) < o.hd + pad) return true;
    }
    return false;
  }
  const bnd = worldData.bounds || { minX: -250, maxX: 250, minZ: -250, maxZ: 250 };
  const blocked = (x, z) => x < bnd.minX || x > bnd.maxX || z < bnd.minZ || z > bnd.maxZ || insideObb(x, z, 0.5) || insideBuilding(x, z);

  const roadsAll = worldData.roads || [];
  let walkRoads = roadsAll.filter((r) => ['residential', 'tertiary', 'secondary', 'primary', 'service', 'alley'].includes(r.kind) && r.points && r.points.length >= 2);
  if (!walkRoads.length) walkRoads = roadsAll.filter((r) => r.kind !== 'driveway' && r.points && r.points.length >= 2);
  const roadSegs = [];
  let roadTotal = 0;
  for (const r of walkRoads) {
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i], b = r.points[i + 1], l = Math.hypot(b.x - a.x, b.z - a.z);
      if (l < 0.01) continue;
      roadSegs.push({ a, b, l, hw: (r.width || 6) / 2, kind: r.kind });
      roadTotal += l;
    }
  }
  function nearRoad(x, z) {
    if (!roadSegs.length) return true;
    for (const s of roadSegs) {
      const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z;
      let t = ((x - s.a.x) * dx + (z - s.a.z) * dz) / (s.l * s.l);
      t = Math.max(0, Math.min(1, t));
      if (Math.hypot(x - (s.a.x + dx * t), z - (s.a.z + dz * t)) < s.hw + 4) return true;
    }
    return false;
  }
  function randomRoadPoint() {
    if (!roadSegs.length) return { x: (rnd() - 0.5) * 80, z: (rnd() - 0.5) * 80 };
    let pick = rnd() * roadTotal, seg = roadSegs[0];
    for (const s of roadSegs) { if (pick <= s.l) { seg = s; break; } pick -= s.l; seg = s; }
    const t = rnd() * seg.l, dx = (seg.b.x - seg.a.x) / seg.l, dz = (seg.b.z - seg.a.z) / seg.l;
    const sidewalked = seg.kind !== 'service' && seg.kind !== 'alley';
    const off = (rnd() < 0.5 ? -1 : 1) * (sidewalked ? seg.hw + 1.5 : 0.8 + rnd());
    return { x: seg.a.x + dx * t - dz * off, z: seg.a.z + dz * t + dx * off };
  }

  // ================================================================ targets
  const targets = [];
  const _Y = new THREE.Vector3(0, 1, 0);
  const outlineIt = (m, th = 0.035) => { if (CONFIG.outlines !== false) { try { addOutline(m, th); } catch (_) { /* optional */ } } };
  const mat = (c) => toonMaterial(c);

  function makeTarget(i) {
    const shirt = SHIRTS[Math.floor(rnd() * SHIRTS.length)];
    const skin = SKINS[Math.floor(rnd() * SKINS.length)];
    const hair = HAIRS[Math.floor(rnd() * HAIRS.length)];
    const root = new THREE.Group();
    root.rotation.order = 'YXZ';
    const fig = new THREE.Group();
    root.add(fig);

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.62, 4, 10), mat(shirt));
    body.position.y = 0.6; body.scale.z = 0.8;
    fig.add(body); outlineIt(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 14, 10), mat(skin));
    head.position.y = 1.38;
    fig.add(head); outlineIt(head);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 5), mat(0x111111));
      eye.position.set(sx * 0.085, 1.42, 0.2);
      fig.add(eye);
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.42, 3, 6), mat(shirt));
      arm.position.set(sx * 0.33, 0.78, 0); arm.rotation.z = -sx * 0.18;
      fig.add(arm); outlineIt(arm, 0.025);
      const shoe = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), mat(0x2b2b2b));
      shoe.scale.set(1, 0.6, 1.5); shoe.position.set(sx * 0.12, 0.06, 0.05);
      fig.add(shoe);
    }
    const hat = Math.floor(rnd() * 5);
    const hatColor = SHIRTS[Math.floor(rnd() * SHIRTS.length)];
    if (hat === 0) { // beanie + visor
      const c = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat(hatColor));
      c.position.y = 1.4; fig.add(c); outlineIt(c, 0.03);
      const v = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.03, 0.16), mat(hatColor));
      v.position.set(0, 1.42, 0.23); fig.add(v);
    } else if (hat === 1) { // top hat
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.15, 0.3, 10), mat(0x2d2d34));
      c.position.y = 1.7; fig.add(c); outlineIt(c, 0.03);
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.03, 12), mat(0x2d2d34));
      b.position.y = 1.56; fig.add(b); outlineIt(b, 0.025);
    } else if (hat === 2) { // hair tuft
      for (let k = -1; k <= 1; k++) {
        const t = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.24, 6), mat(hair));
        t.position.set(k * 0.09, 1.65, 0); t.rotation.z = -k * 0.35;
        fig.add(t); outlineIt(t, 0.02);
      }
    } else if (hat === 3) { // bowl of hair
      const c = new THREE.Mesh(new THREE.SphereGeometry(0.245, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2.4), mat(hair));
      c.position.y = 1.4; fig.add(c); outlineIt(c, 0.03);
    } else { // sun hat
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.025, 14), mat(0xf2d27a));
      c.position.y = 1.54; fig.add(c); outlineIt(c, 0.025);
      const d = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.14, 10), mat(hatColor));
      d.position.y = 1.62; fig.add(d); outlineIt(d, 0.025);
    }
    scene.add(root);
    return { id: i, root, fig, body, head, shirt, x: 0, z: 0, yaw: rnd() * Math.PI * 2, painted: false, fallT: 0, wp: null, wpT: 99, phase: rnd() * 10, decals: [] };
  }

  function placeTarget(t, x, z) {
    t.x = x; t.z = z;
    t.root.position.set(x, 0, z);
    t.root.rotation.y = t.yaw;
  }

  function chooseWaypoint(t) {
    for (let k = 0; k < 12; k++) {
      const a = rnd() * Math.PI * 2, d = 8 + rnd() * 12;
      const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
      if (blocked(x, z) || !nearRoad(x, z)) continue;
      if (blocked((t.x + x) / 2, (t.z + z) / 2)) continue;
      t.wp = { x, z }; t.wpT = 0;
      return;
    }
    t.wp = null; t.wpT = 4.5; // stand a moment, retry soon
  }

  function spawnTargets() {
    for (let i = 0; i < CONFIG.target_count; i++) {
      const t = makeTarget(i);
      let p = null;
      for (let k = 0; k < 80 && !p; k++) {
        const c = randomRoadPoint();
        if (blocked(c.x, c.z)) continue;
        if (Math.hypot(c.x - sp.x, c.z - sp.z) < 10 && k < 60) continue;
        p = c;
      }
      if (!p) p = { x: sp.x + 12 + i * 2, z: sp.z + 6 };
      placeTarget(t, p.x, p.z);
      chooseWaypoint(t);
      targets.push(t);
    }
  }

  function lighten(c, f) {
    const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    return (Math.round(r + (255 - r) * f) << 16) | (Math.round(g + (255 - g) * f) << 8) | Math.round(b + (255 - b) * f);
  }

  const _v = new THREE.Vector3();
  function addDecal(t, local, color, size, onHead) {
    const center = onHead ? new THREE.Vector3(0, 1.38, 0) : new THREE.Vector3(0, Math.max(0.35, Math.min(1.05, local.y)), 0);
    const r = onHead ? 0.23 : 0.27;
    const dir = local.clone().sub(center); dir.y = onHead ? dir.y : dir.y * 0.4;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    const m = new THREE.Mesh(splatGeo, splatMaterial(color, Math.floor(rnd() * 3)));
    m.renderOrder = 3;
    m.position.copy(center).addScaledVector(dir, r + 0.015);
    m.quaternion.setFromUnitVectors(Z, dir).multiply(_qz.setFromAxisAngle(Z, rnd() * 6.28));
    m.scale.set(size, size, 1);
    t.fig.add(m);
    t.decals.push(m);
  }

  function paintTarget(t, color, hitPt) {
    t.painted = true;
    t.fallT = 0;
    t.fig.position.y = 0; t.fig.rotation.z = 0;
    t.body.material = mat(color); // swap to painted look
    // hit point in figure-local space (target stands upright when hit)
    _v.copy(hitPt).sub(t.root.position).applyAxisAngle(_Y, -t.root.rotation.y);
    const local = _v.clone();
    const onHead = local.y > 1.22;
    addDecal(t, local, onHead ? color : lighten(color, 0.45), onHead ? 0.34 : 0.5, onHead);
    addDecal(t, new THREE.Vector3((rnd() - 0.5) * 0.4, 0.5 + rnd() * 0.5, 0.3), lighten(color, 0.45), 0.36, false);
    addDecal(t, new THREE.Vector3((rnd() - 0.5) * 0.2, 1.4, 0.25), color, 0.24, true);
  }

  // ================================================================ sweep tests
  // closest approach between segments P(s)=p1+s*d1 and Q(t)=p2+t*d2
  const cl = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  function segSeg(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z, out) {
    const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
    const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
    const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z;
    const f = d2x * rx + d2y * ry + d2z * rz;
    let s, t;
    if (a <= 1e-9) { s = 0; t = e > 1e-9 ? cl(f / e) : 0; }
    else {
      const c = d1x * rx + d1y * ry + d1z * rz;
      if (e <= 1e-9) { t = 0; s = cl(-c / a); }
      else {
        const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
        s = den > 1e-9 ? cl((b * f - c * e) / den) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = cl(-c / a); } else if (t > 1) { t = 1; s = cl((b - c) / a); }
      }
    }
    const cx = p1x + d1x * s - (p2x + d2x * t), cy = p1y + d1y * s - (p2y + d2y * t), cz = p1z + d1z * s - (p2z + d2z * t);
    out.s = s; out.t = t; out.d = Math.hypot(cx, cy, cz);
  }
  const _o = { s: 0, t: 0, d: 0 };
  const TR = 0.45; // target capsule radius; axis y in [0.45, 1.15] => spans 0..1.6

  const _pt = new THREE.Vector3(), _nn = new THREE.Vector3();
  function processBalls(dt) {
    for (const pb of balls) {
      if (pb.dead) continue;
      const bp = pb.body.position;
      pb.mesh.position.set(bp.x, bp.y, bp.z);
      pb.age += dt;
      const p0 = pb.prev, p1x = bp.x, p1y = bp.y, p1z = bp.z;

      // targets (swept)
      let bestS = 2, bestT = null;
      for (const t of targets) {
        if (t.painted) continue;
        segSeg(p0.x, p0.y, p0.z, p1x, p1y, p1z, t.x, 0.45, t.z, t.x, 1.15, t.z, _o);
        if (_o.d <= TR + BALL_R && _o.s < bestS) { bestS = _o.s; bestT = t; }
      }
      // thin static cylinders (posts / trunks) are tunnelling-prone: sweep them too
      let cylHit = null, cylS = 2;
      if (!pb.contact || bestT) {
        const mnx = Math.min(p0.x, p1x) - 1, mxx = Math.max(p0.x, p1x) + 1, mnz = Math.min(p0.z, p1z) - 1, mxz = Math.max(p0.z, p1z) + 1;
        for (const c of cyls) {
          if (c.cx < mnx || c.cx > mxx || c.cz < mnz || c.cz > mxz) continue;
          const dx = p1x - p0.x, dz = p1z - p0.z, l2 = dx * dx + dz * dz;
          let s = l2 > 1e-9 ? ((c.cx - p0.x) * dx + (c.cz - p0.z) * dz) / l2 : 0;
          s = cl(s);
          if (Math.hypot(p0.x + dx * s - c.cx, p0.z + dz * s - c.cz) > c.r + BALL_R) continue;
          const y = p0.y + (p1y - p0.y) * s;
          if (y < 0 || y > c.height) continue;
          if (s < cylS) { cylS = s; cylHit = c; }
        }
      }

      if (bestT && bestS <= cylS) {
        _pt.set(p0.x + (p1x - p0.x) * bestS, p0.y + (p1y - p0.y) * bestS, p0.z + (p1z - p0.z) * bestS);
        paintTarget(bestT, pb.color, _pt);
        stats.hits++;
        flashHit();
        hudDirty = true;
        killBall(pb);
        continue;
      }
      if (cylHit && !pb.contact) {
        _pt.set(p0.x + (p1x - p0.x) * cylS, p0.y + (p1y - p0.y) * cylS, p0.z + (p1z - p0.z) * cylS);
        _nn.set(_pt.x - cylHit.cx, 0, _pt.z - cylHit.cz);
        if (_nn.lengthSq() < 1e-6) _nn.set(0, 0, 1);
        _nn.normalize();
        _pt.x = cylHit.cx + _nn.x * cylHit.r; _pt.z = cylHit.cz + _nn.z * cylHit.r;
        spawnSplat(_pt, _nn, pb.color);
        killBall(pb);
        continue;
      }
      if (pb.contact) {
        _nn.set(pb.contact.nx, pb.contact.ny, pb.contact.nz);
        _pt.set(bp.x, bp.y, bp.z).addScaledVector(_nn, -BALL_R);
        spawnSplat(_pt, _nn, pb.color);
        killBall(pb);
        continue;
      }
      if (pb.age > 5 || bp.y < -3 || Math.abs(bp.x) > 1200 || Math.abs(bp.z) > 1200) killBall(pb);
    }
  }

  // ================================================================ HUD
  const el = {};
  let hudDirty = true, hudTimer = 0, pips = [], elapsed = 0;
  function cacheHud() {
    for (const id of ['stat-shots', 'stat-hits', 'stat-acc', 'stat-targets', 'ammo-bar', 'timer', 'hit-flash', 'hud', 'win-screen', 'win-stats', 'restart-btn']) el[id] = $(id);
    const bar = el['ammo-bar'];
    if (bar) {
      bar.innerHTML = '';
      for (let i = 0; i < 10; i++) { const d = document.createElement('div'); d.className = 'ammo-pip'; bar.appendChild(d); pips.push(d); }
    }
  }
  const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const accPct = () => (stats.shots ? Math.round((stats.hits / stats.shots) * 100) : 0);
  const setText = (e, v) => { if (e && e.textContent !== String(v)) e.textContent = v; };
  function writeHud() {
    setText(el['stat-shots'], stats.shots);
    setText(el['stat-hits'], stats.hits);
    setText(el['stat-acc'], accPct() + '%');
    setText(el['stat-targets'], targets.filter((t) => !t.painted).length);
    setText(el['timer'], fmt(elapsed));
    const live = balls.filter((b) => !b.dead).length;
    const filled = 10 - Math.round((live / CONFIG.max_paintballs) * 10);
    pips.forEach((p, i) => { if (p.classList) p.classList.toggle('empty', i >= filled); });
    hudDirty = false;
  }
  let flashTimeout = null;
  function flashHit() {
    const f = el['hit-flash'];
    if (!f) return;
    f.classList.add('flash');
    f.style.opacity = '1';
    clearTimeout(flashTimeout);
    flashTimeout = setTimeout(() => { f.classList.remove('flash'); f.style.opacity = ''; }, 130);
  }

  function showWin() {
    won = true;
    if (autoFire) { clearInterval(autoFire); autoFire = null; }
    try { if (document.exitPointerLock) document.exitPointerLock(); } catch (_) {}
    writeHud();
    const ws = el['win-stats'];
    if (ws) ws.innerHTML = `Hits: <b>${stats.hits}</b> &nbsp;|&nbsp; Shots: <b>${stats.shots}</b> &nbsp;|&nbsp; Accuracy: <b>${accPct()}%</b><br>Time: <b>${fmt(elapsed)}</b>`;
    const w = el['win-screen'];
    if (w) w.classList.remove('hidden');
  }

  // ================================================================ per-frame
  const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4(), _sph = new THREE.Sphere(new THREE.Vector3(), 1.4);
  function syncCamera() {
    camera.position.set(player.position.x, feetY() + CONFIG.player_height, player.position.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(pitch, yaw, 0);
  }

  function movePlayer() {
    const sprint = keys.ShiftLeft || keys.ShiftRight;
    const speed = CONFIG.move_speed * (sprint ? CONFIG.sprint_multiplier : 1);
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    let f = 0, s = 0;
    if (keys.KeyW || keys.ArrowUp) f += 1;
    if (keys.KeyS || keys.ArrowDown) f -= 1;
    if (keys.KeyD || keys.ArrowRight) s += 1;
    if (keys.KeyA || keys.ArrowLeft) s -= 1;
    f += joy.y; s += joy.x;
    const len = Math.hypot(f, s);
    if (len > 1) { f /= len; s /= len; }
    player.velocity.x = (fx * f + rx * s) * speed;
    player.velocity.z = (fz * f + rz * s) * speed;
    grounded = checkGround();
    if ((keys.Space || jumpHeld) && grounded) { player.velocity.y = CONFIG.jump_speed; grounded = false; }
    // soft world bounds
    const m = 30;
    if (player.position.x < bnd.minX - m) { player.position.x = bnd.minX - m; player.velocity.x = Math.max(0, player.velocity.x); }
    if (player.position.x > bnd.maxX + m) { player.position.x = bnd.maxX + m; player.velocity.x = Math.min(0, player.velocity.x); }
    if (player.position.z < bnd.minZ - m) { player.position.z = bnd.minZ - m; player.velocity.z = Math.max(0, player.velocity.z); }
    if (player.position.z > bnd.maxZ + m) { player.position.z = bnd.maxZ + m; player.velocity.z = Math.min(0, player.velocity.z); }
    // Safety net: anything that throws the player out of the playable volume returns them to the (clear) spawn.
    const pp = player.position;
    if (!(pp.y > -2 && pp.y < 80 && isFinite(pp.x) && isFinite(pp.z))) { pp.set(sp.x, R + 0.05, sp.z); player.velocity.set(0, 0, 0); }
  }

  function updateTargets(dt) {
    camera.updateMatrixWorld();
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    for (const t of targets) {
      if (t.painted) {
        if (t.fallT < 1) {
          t.fallT = Math.min(1, t.fallT + dt / 0.4);
          const e = 1 - (1 - t.fallT) * (1 - t.fallT);
          t.root.rotation.x = -80 * DEG * e;
          t.root.position.y = 0.22 * e;
        }
        continue;
      }
      // wander (cheap, always runs)
      t.wpT += dt;
      if (!t.wp || t.wpT > 6) chooseWaypoint(t);
      let moving = false;
      if (t.wp) {
        const dx = t.wp.x - t.x, dz = t.wp.z - t.z, d = Math.hypot(dx, dz);
        if (d < 0.4) chooseWaypoint(t);
        else {
          const st = CONFIG.target_speed * dt;
          const nx = t.x + (dx / d) * st, nz = t.z + (dz / d) * st;
          if (blocked(nx, nz)) chooseWaypoint(t);
          else { t.x = nx; t.z = nz; moving = true; t.yawGoal = Math.atan2(dx, dz); }
        }
      }
      t.root.position.x = t.x; t.root.position.z = t.z;
      _sph.center.set(t.x, 0.9, t.z);
      if (!_frustum.intersectsSphere(_sph)) continue; // off-screen: skip animation math
      if (moving) {
        let da = t.yawGoal - t.yaw;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        t.yaw += da * Math.min(1, dt * 8);
        t.root.rotation.y = t.yaw;
        t.phase += dt * 8;
        t.fig.position.y = Math.abs(Math.sin(t.phase)) * 0.07;
        t.fig.rotation.z = Math.sin(t.phase) * 0.09;
      }
    }
  }

  function update(dt) {
    dt = Math.min(Math.max(dt || 0, 0), 0.05);
    for (const pb of balls) if (!pb.dead && pb.body) pb.prev.set(pb.body.position.x, pb.body.position.y, pb.body.position.z);
    movePlayer();
    world.step(1 / 60, dt, 3);
    syncCamera();
    processBalls(dt);
    flushQueue();
    updateTargets(dt);

    if (running && !won) {
      elapsed += dt;
      if (targets.length && targets.every((t) => t.painted)) {
        winTimer += dt;
        if (winTimer > 0.8) showWin();
      }
    }
    hudTimer += dt;
    if (hudTimer >= 0.1) { hudTimer = 0; writeHud(); }
  }

  // ================================================================ lifecycle
  cacheHud();
  syncCamera();
  spawnTargets();
  writeHud();
  on(el['restart-btn'], 'click', () => location.reload());

  function start() {
    if (running) return;
    running = true;
    const hud = el['hud']; if (hud) hud.classList.remove('hidden');
    if (isMobile) setupMobile();
    else {
      setupDesktop();
      try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
    }
    writeHud();
  }

  function dispose() {
    running = false;
    for (const [e, ev, fn, opts] of listeners) { try { e.removeEventListener(ev, fn, opts); } catch (_) {} }
    listeners.length = 0;
    if (autoFire) clearInterval(autoFire);
    clearTimeout(flashTimeout);
    try { if (document.exitPointerLock) document.exitPointerLock(); } catch (_) {}
    for (const pb of balls) { killBall(pb); }
    flushQueue();
    for (const b of staticBodies) world.removeBody(b);
    world.removeBody(player); world.removeBody(ground);
    for (const m of splats) scene.remove(m);
    splats.length = 0;
    for (const t of targets) scene.remove(t.root);
    targets.length = 0;
    for (const m of splatCache.values()) { if (m.map) m.map.dispose(); m.dispose(); }
    splatCache.clear();
    splatGeo.dispose(); ballGeo.dispose();
  }

  return {
    start, update, dispose,
    // test/debug hooks (not part of the contract)
    _debug: { targets, stats, balls, player, world, fire, setLook(y, p) { yaw = y; pitch = p; }, get bodyCount() { return bodyCount; } },
  };
}
