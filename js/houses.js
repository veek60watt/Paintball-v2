// Paperball — houses.js (Agent B)
// Builds paper-cutout buildings from WorldData footprints.
//
// COORDINATES / COLLIDER CONVENTION
//  World: north = -Z, east = +X. Every building is built in a LOCAL frame centred on its oriented
//  bounding box (OBB): local +X = OBB long axis u = (ux, uz) in world, local +Z = (-uz, ux) in world.
//  The group is placed with rotation.y = angle where angle = atan2(-uz, ux); THREE's rotation.y = a maps
//  local +X to world (cos a, 0, -sin a) == (ux, 0, uz). Colliders use exactly this angle:
//  { type:'obb', cx, cz, hw (half size along local X), hd (along local Z), angle, height }.
//  Geometry is baked to world space (rotateY(angle) + translate) before merging.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE, toonMaterial, addOutline } from './toon.js';

// ------------------------------------------------------------------ small utils
function hash01(id, salt = 0) {
  let h = (Math.imul((id | 0) ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(salt + 1, 0xc2b2ae35)) | 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
const pick = (arr, r) => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function signedArea(pts) { // in (x, z) plane
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

// Drop points < 0.4 m from previous and (near-)collinear points (turn < 8 deg).
function simplify(pts) {
  let p = pts.map((q) => ({ x: q.x, z: q.z }));
  const cosLim = Math.cos((8 * Math.PI) / 180);
  let changed = true, guard = 0;
  while (changed && p.length > 3 && guard++ < 50) {
    changed = false;
    for (let i = 0; i < p.length && p.length > 3; i++) {
      const prev = p[(i - 1 + p.length) % p.length], cur = p[i], next = p[(i + 1) % p.length];
      const d1x = cur.x - prev.x, d1z = cur.z - prev.z, d2x = next.x - cur.x, d2z = next.z - cur.z;
      const l1 = Math.hypot(d1x, d1z), l2 = Math.hypot(d2x, d2z);
      if (l1 < 0.4 || l2 < 1e-6 || (d1x * d2x + d1z * d2z) / (l1 * l2) > cosLim) {
        p.splice(i, 1); i--; changed = true;
      }
    }
  }
  return p;
}

function convexHull(pts) {
  const s = pts.map((p) => ({ x: p.x, z: p.z })).sort((a, b) => a.x - b.x || a.z - b.z);
  if (s.length < 3) return s;
  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lo = [];
  for (const p of s) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const up = [];
  for (let i = s.length - 1; i >= 0; i--) { const p = s[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  lo.pop(); up.pop();
  return lo.concat(up);
}

// Minimum-area bounding rectangle (rotating calipers over hull edges). Local X is the long axis.
function minAreaRect(pts) {
  const hull = convexHull(pts);
  if (hull.length < 3) throw new Error('degenerate hull');
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    let ux = b.x - a.x, uz = b.z - a.z;
    const l = Math.hypot(ux, uz);
    if (l < 1e-6) continue;
    ux /= l; uz /= l;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const pu = p.x * ux + p.z * uz, pv = -p.x * uz + p.z * ux;
      if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, ux, uz, minU, maxU, minV, maxV };
  }
  if (!best) throw new Error('no obb');
  let { ux, uz, minU, maxU, minV, maxV } = best;
  let hw = (maxU - minU) / 2, hd = (maxV - minV) / 2;
  let cu = (maxU + minU) / 2, cv = (maxV + minV) / 2;
  if (hd > hw) { // make X the long axis: new u = old v-axis (-uz, ux)
    const nux = -uz, nuz = ux;
    // new local coords: u' = old v, v' = -old u
    [hw, hd] = [hd, hw];
    const ncu = cv, ncv = -cu;
    ux = nux; uz = nuz; cu = ncu; cv = ncv;
  }
  const cx = cu * ux - cv * uz, cz = cu * uz + cv * ux; // back to world
  return { cx, cz, hw, hd, ux, uz, area: best.area };
}

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function distToSeg(px, pz, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - a.x) * dx + (pz - a.z) * dz) / l2 : 0;
  t = clamp(t, 0, 1);
  const x = a.x + t * dx, z = a.z + t * dz;
  return { d: Math.hypot(px - x, pz - z), x, z };
}

// Largest all-ones rectangle in a binary grid (histogram + stack). Returns {i,j,w,h} cells or null.
function maxRect(grid, nx, nz) {
  const hts = new Int32Array(nx);
  let best = null, bestA = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) hts[i] = grid[j * nx + i] ? hts[i] + 1 : 0;
    const st = [];
    for (let i = 0; i <= nx; i++) {
      const h = i === nx ? 0 : hts[i];
      let start = i;
      while (st.length && st[st.length - 1].h >= h) {
        const t = st.pop();
        const a = t.h * (i - t.i);
        if (a > bestA) { bestA = a; best = { i: t.i, j: j - t.h + 1, w: i - t.i, h: t.h }; }
        start = t.i;
      }
      st.push({ i: start, h });
    }
  }
  return best;
}

// Decompose a (local-frame) polygon into <=3 rectangles. Returns [{cx,cz,hw,hd}] in local coords.
function decompose(poly, hwB, hdB, polyArea) {
  const c = Math.max(0.5, (Math.max(hwB, hdB) * 2) / 70);
  const nx = Math.max(1, Math.ceil((hwB * 2) / c)), nz = Math.max(1, Math.ceil((hdB * 2) / c));
  const grid = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    grid[j * nx + i] = pointInPoly(-hwB + (i + 0.5) * c, -hdB + (j + 0.5) * c, poly) ? 1 : 0;
  }
  const rects = [];
  let covered = 0;
  for (let k = 0; k < 3; k++) {
    const r = maxRect(grid, nx, nz);
    if (!r) break;
    const area = r.w * r.h * c * c;
    if (Math.min(r.w, r.h) * c < 2.0 || area < 8) break;
    if (k === 0 && area < polyArea * 0.4) return [];
    if (k > 0 && area < polyArea * 0.08) break;
    for (let j = r.j; j < r.j + r.h; j++) for (let i = r.i; i < r.i + r.w; i++) grid[j * nx + i] = 0;
    const x0 = -hwB + r.i * c, z0 = -hdB + r.j * c;
    rects.push({ cx: x0 + (r.w * c) / 2, cz: z0 + (r.h * c) / 2, hw: (r.w * c) / 2, hd: (r.h * c) / 2 });
    covered += area;
    if (covered > polyArea * 0.9) break;
  }
  return rects;
}

// ------------------------------------------------------------------ geometry helpers
function norm(geo) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal' && n !== 'uv') g.deleteAttribute(n);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
}

// box with grain-friendly uvs, rotated about Y by `ry`, centred at (x,y,z)
function boxG(w, h, d, x, y, z, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const k = Math.max(w, h, d);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k, uv.getY(i) * k);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return norm(g);
}

// closed convex solid from triangles (verts: [[x,y,z]...], tris: [[a,b,c]...]); auto-orients outward
function solid(verts, tris, onlyIdx) {
  let cx = 0, cy = 0, cz = 0;
  for (const v of verts) { cx += v[0]; cy += v[1]; cz += v[2]; }
  cx /= verts.length; cy /= verts.length; cz /= verts.length;
  const out = [];
  const list = onlyIdx ? onlyIdx.map((i) => tris[i]) : tris;
  for (const t of list) {
    let [a, b, c] = t.map((i) => verts[i]);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (Math.hypot(n[0], n[1], n[2]) < 1e-8) continue;
    const m = [(a[0] + b[0] + c[0]) / 3 - cx, (a[1] + b[1] + c[1]) / 3 - cy, (a[2] + b[2] + c[2]) / 3 - cz];
    if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 0) [b, c] = [c, b];
    out.push(a, b, c);
  }
  const pos = new Float32Array(out.length * 3), uv = new Float32Array(out.length * 2);
  out.forEach((v, i) => { pos.set(v, i * 3); uv[i * 2] = v[0]; uv[i * 2 + 1] = v[2] + v[1] * 0.5; });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// Extrude local-frame footprint (CONTRACT: Shape uses (x, -z), then rotateX(-PI/2))
function extrudeFootprint(pts, depth, y0 = 0) {
  const shape = new THREE.Shape();
  pts.forEach((p, i) => (i ? shape.lineTo(p.x, -p.z) : shape.moveTo(p.x, -p.z)));
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  if (y0) g.translate(0, y0, 0);
  return norm(g);
}

// Pitched roof pieces for one rect (local frame). Returns {parts:[{geo,kind:'roof'|'wall'}], H, top(z)}
function pitchedRoof(rect, eaveY, shape, Hover) {
  const alongX = rect.hw >= rect.hd;
  const Lh = alongX ? rect.hw : rect.hd, s = alongX ? rect.hd : rect.hw;
  const ov = 0.4;
  const H = Hover > 0 ? Hover : clamp(0.29 * 2 * s, 1.2, 4);
  const tan = H / s, alpha = Math.atan(tan);
  const parts = [];
  const place = (g) => { if (!alongX) g.rotateY(Math.PI / 2); g.translate(rect.cx, 0, rect.cz); return norm(g); };
  if (shape === 'gabled') {
    const thick = 0.2, slabLen = (s + ov) / Math.cos(alpha);
    for (const sign of [1, -1]) {
      const g = new THREE.BoxGeometry(2 * (Lh + ov), thick, slabLen);
      const k = Math.max(Lh, slabLen);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * k, uv.getY(i) * 2 * k);
      g.rotateX(sign * alpha);
      // top-surface midpoint of slab = apex + (slabLen/2) * d ; shift down by thick/2 along normal
      const dz = sign * Math.cos(alpha), dy = -Math.sin(alpha);
      const nz = sign * Math.sin(alpha), ny = Math.cos(alpha);
      g.translate(0, eaveY + H + (slabLen / 2) * dy - (thick / 2) * ny, (slabLen / 2) * dz - (thick / 2) * nz);
      parts.push({ geo: place(g), kind: 'roof' });
    }
    // gable end triangles in wall colour (slightly below the slab top plane)
    const gap = (0.5 * thick) / Math.cos(alpha);
    const sp = s * (1 - gap / H), ht = H - gap;
    const verts = [
      [-Lh, eaveY, -sp], [-Lh, eaveY, sp], [-Lh, eaveY + ht, 0],
      [Lh, eaveY, -sp], [Lh, eaveY, sp], [Lh, eaveY + ht, 0],
    ];
    const g = solid(verts, [[0, 1, 2], [3, 4, 5], [0, 1, 4], [0, 4, 3], [0, 2, 5], [0, 5, 3], [1, 2, 5], [1, 5, 4]], [0, 1]);
    parts.push({ geo: place(g), kind: 'wall' });
  } else { // hipped / pyramidal
    const A = Lh + ov, B = s + ov;
    const y0 = eaveY - ov * tan, yt = eaveY + H;
    let rl = shape === 'pyramidal' ? 0 : Math.max(0, Lh - s);
    if (rl < 0.05) rl = 0;
    const verts = [[-A, y0, -B], [A, y0, -B], [A, y0, B], [-A, y0, B], [-rl, yt, 0], [rl, yt, 0]];
    const tris = [[3, 2, 5], [3, 5, 4], [0, 1, 5], [0, 5, 4], [1, 2, 5], [0, 3, 4], [0, 1, 2], [0, 2, 3]];
    parts.push({ geo: place(solid(verts, tris)), kind: 'roof' });
  }
  return { parts, H, Lh, s, alongX };
}

// ------------------------------------------------------------------ main
export function buildHouses(scene, worldData, CONFIG) {
  const group = new THREE.Group();
  group.name = 'houses';
  const colliders = [];
  const buckets = new Map(); // key -> {color, outline, geos}
  let skipped = 0, built = 0;

  const colorHex = (c) => new THREE.Color(c).getHex();
  const add = (color, outline, geo) => {
    const key = color + (outline ? 'o' : '');
    let b = buckets.get(key);
    if (!b) { b = { color, outline, geos: [] }; buckets.set(key, b); }
    b.geos.push(geo);
  };

  const buildings = worldData.buildings || [];
  const roads = worldData.roads || [];
  const customWall = new Set(), customRoof = new Set();

  // road lookup
  const roadSegs = (pred) => {
    const out = [];
    for (const r of roads) {
      if (!pred(r) || !r.points) continue;
      for (let i = 0; i < r.points.length - 1; i++) out.push([r.points[i], r.points[i + 1]]);
    }
    return out;
  };
  const prefSegs = roadSegs((r) => r.kind !== 'footway' && r.kind !== 'driveway');
  const allSegs = roadSegs(() => true);
  const nearest = (segs, px, pz) => {
    let best = null;
    for (const [a, b] of segs) {
      const r = distToSeg(px, pz, a, b);
      if (!best || r.d < best.d) best = r;
    }
    return best;
  };

  // ---- pass 1: footprint prep + colors
  const prep = [];
  for (const b of buildings) {
    try {
      if (!b.footprint || b.footprint.length < 3) throw new Error('footprint');
      let fp = simplify(b.footprint);
      if (fp.length < 3) fp = b.footprint.map((p) => ({ x: p.x, z: p.z }));
      // normalise to CCW in the (x,-z) plane => signed area in (x,z) negative
      if (signedArea(fp) > 0) fp.reverse();
      let gx = 0, gz = 0;
      for (const p of fp) { gx += p.x; gz += p.z; }
      prep.push({ b, fp, gx: gx / fp.length, gz: gz / fp.length });
    } catch (e) { skipped++; }
  }

  const snap = (hex, palette, set) => {
    if (set.has(hex) || set.size < 6) { set.add(hex); return hex; }
    const c = new THREE.Color(hex);
    let best = palette[0], bd = Infinity;
    for (const p of palette) {
      const q = new THREE.Color(p), d = (c.r - q.r) ** 2 + (c.g - q.g) ** 2 + (c.b - q.b) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  const cssOK = (s) => { try { new THREE.Color(s); return true; } catch (e) { return false; } };
  const housesColors = [];
  for (const it of prep) {
    const b = it.b;
    if (b.kind === 'garage') continue;
    let wc;
    if (b.wallColor && cssOK(b.wallColor)) wc = snap(colorHex(b.wallColor), PALETTE.walls, customWall);
    else wc = pick(PALETTE.walls, hash01(b.id, 1));
    it.wall = wc;
    if (b.kind === 'house') housesColors.push({ x: it.gx, z: it.gz, c: wc });
  }
  for (const it of prep) {
    const b = it.b;
    if (b.kind !== 'garage') continue;
    if (b.wallColor && cssOK(b.wallColor)) { it.wall = snap(colorHex(b.wallColor), PALETTE.walls, customWall); continue; }
    let bd = 25, c = null;
    for (const h of housesColors) { const d = Math.hypot(h.x - it.gx, h.z - it.gz); if (d < bd) { bd = d; c = h.c; } }
    it.wall = c ?? pick(PALETTE.walls, hash01(b.id, 1));
  }

  // ---- pass 2: build
  for (const it of prep) {
    const b = it.b;
    try {
      buildOne(it);
      built++;
    } catch (e) {
      skipped++;
      if (typeof console !== 'undefined' && skipped <= 1) console.debug?.('[houses] first skip:', e);
    }
  }

  function buildOne(it) {
    const b = it.b;
    const fpW = it.fp; // world-space simplified CCW footprint
    const obb = minAreaRect(fpW);
    const angle = Math.atan2(-obb.uz, obb.ux);
    const ex = [obb.ux, obb.uz], ez = [-obb.uz, obb.ux];
    // local polygon
    const P = fpW.map((p) => {
      const dx = p.x - obb.cx, dz = p.z - obb.cz;
      return { x: dx * ex[0] + dz * ex[1], z: dx * ez[0] + dz * ez[1] };
    });
    const polyArea = Math.abs(signedArea(P));
    const obbArea = 4 * obb.hw * obb.hd;
    const rectangularity = polyArea / Math.max(obbArea, 1e-6);
    const toWorldXZ = (lx, lz) => [obb.cx + lx * ex[0] + lz * ez[0], obb.cz + lx * ex[1] + lz * ez[1]];

    const kind = b.kind || 'other';
    const wallH = clamp(b.height > 0 ? b.height : (kind === 'shed' ? 2.4 : kind === 'garage' ? 2.8 : 3.2), 2.4, 60);
    const levels = Math.max(1, b.levels || 1);
    const wallColor = it.wall ?? pick(PALETTE.walls, hash01(b.id, 1));
    let roofColor;
    if (b.roofColor && cssOK(b.roofColor)) roofColor = snap(colorHex(b.roofColor), PALETTE.roofs, customRoof);
    else roofColor = pick(PALETTE.roofs, hash01(b.id, 2));
    let doorColor = pick(PALETTE.doors, hash01(b.id, 3));
    if (doorColor === wallColor) doorColor = PALETTE.doors[2];

    // final geometry transform: local -> world
    const toWorld = (g) => { g.rotateY(angle); g.translate(obb.cx, 0, obb.cz); return g; };
    const addW = (color, outline, g) => add(color, outline, toWorld(g));

    // ---- degenerate -> plain box
    if (Math.min(obb.hw, obb.hd) * 2 < 1.5) {
      addW(wallColor, true, boxG(obb.hw * 2, wallH, obb.hd * 2, 0, wallH / 2, 0));
      colliders.push({ type: 'obb', cx: obb.cx, cz: obb.cz, hw: obb.hw, hd: obb.hd, angle, height: wallH });
      return;
    }

    // ---- roof type
    const pitchedKind = kind === 'house' || kind === 'garage' || kind === 'church' || kind === 'shed';
    const aspect = obb.hw / Math.max(obb.hd, 1e-6);
    let shape = b.roofShape || null;
    if (!shape) {
      if (pitchedKind) shape = rectangularity > 0.8 ? (aspect > 1.4 ? 'gabled' : 'hipped') : 'gabled';
      else shape = 'flat';
    }
    let rects = null; // decomposition rects (local)
    if (shape !== 'flat' && rectangularity <= 0.8) {
      rects = decompose(P, obb.hw, obb.hd, polyArea);
      if (!rects.length) shape = 'flat';
      else if (shape === 'pyramidal') shape = 'hipped';
    }

    // ---- walls
    addW(wallColor, true, extrudeFootprint(P, wallH));

    // ---- roof
    let roofH = 0.6;
    let mainRoof = null;
    if (shape === 'flat') {
      addW(PALETTE.flatRoof, true, extrudeFootprint(P, 0.14, wallH));
      for (let i = 0; i < P.length; i++) {
        const p = P[i], q = P[(i + 1) % P.length];
        const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot(dx, dz);
        if (len < 0.5) continue;
        const phi = Math.atan2(-dz, dx);
        const nxv = -dz / len, nzv = dx / len; // outward
        // parapet slightly inside the edge
        addW(wallColor, true, boxG(len + 0.2, 0.6, 0.28, (p.x + q.x) / 2 - nxv * 0.12, wallH + 0.3, (p.z + q.z) / 2 - nzv * 0.12, phi));
      }
      if (kind === 'commercial' && pointInPoly(0, 0, P) && Math.min(obb.hw, obb.hd) > 3) {
        addW(PALETTE.gray, false, boxG(2.2, 1.3, 1.8, 0, wallH + 0.14 + 0.65, 0));
        roofH = 1.5;
      }
    } else {
      const list = rects || [{ cx: 0, cz: 0, hw: obb.hw, hd: obb.hd }];
      const roofShape = shape === 'pyramidal' && list.length > 1 ? 'hipped' : shape;
      list.forEach((r, i) => {
        const pr = pitchedRoof(r, wallH, roofShape, b.roofHeight > 0 ? b.roofHeight : 0);
        if (i === 0) mainRoof = { ...pr, rect: r };
        roofH = Math.max(roofH, pr.H);
        for (const part of pr.parts) addW(part.kind === 'wall' ? wallColor : roofColor, true, part.geo);
      });
      if (!rects) roofH = mainRoof.H + 0.1;
    }

    // ---- front direction (nearest road)
    const roadHit = (() => {
      let r = nearest(prefSegs, it.gx, it.gz);
      if (r && r.d <= 60) return r;
      r = nearest(allSegs, it.gx, it.gz);
      if (r && r.d <= 60) return r;
      return null;
    })();
    let target; // world point
    if (roadHit) target = [roadHit.x, roadHit.z];
    else {
      // fall back: longest edge's normal toward map centre (0,0) -> simply aim at the map centre
      target = [0, 0];
    }
    const tdx = target[0] - obb.cx, tdz = target[1] - obb.cz;
    const T = { x: tdx * ex[0] + tdz * ex[1], z: tdx * ez[0] + tdz * ez[1] }; // local target
    let front = null;
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length];
      const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot(dx, dz);
      if (len < 1.2) continue;
      const nx = -dz / len, nz = dx / len;
      const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
      let score;
      if (roadHit) {
        const vx = T.x - mx, vz = T.z - mz, vl = Math.hypot(vx, vz) || 1;
        score = (nx * vx + nz * vz) / vl + len * 0.004 - vl * 0.003; // ties: edge nearest the road
      } else { // no road within 60 m: longest edge whose normal faces the map centre
        const cxl = -(obb.cx * ex[0] + obb.cz * ex[1]), czl = -(obb.cx * ez[0] + obb.cz * ez[1]);
        const cl = Math.hypot(cxl, czl) || 1;
        score = (nx * cxl + nz * czl) / cl + len * 0.02;
      }
      if (!front || score > front.score) front = { score, p, q, len, nx, nz, mx, mz, tx: dx / len, tz: dz / len };
    }

    // ---- details
    if (front && kind !== 'shed') {
      const phi = Math.atan2(-front.tz, front.tx); // box local X -> tangent, local Z -> outward normal
      const at = (t, off) => [front.p.x + front.tx * t + front.nx * off, front.p.z + front.tz * t + front.nz * off];
      const fh = wallH / levels;
      const wsz = clamp(fh * 0.42, 0.8, 1.2);
      const addWindow = (t, off, y, ry, nxv, nzv, tx, tz, base) => {
        const px = base.x + tx * t + nxv * off, pz = base.z + tz * t + nzv * off;
        addW(PALETTE.outline, false, boxG(wsz + 0.24, wsz + 0.24, 0.05, px + nxv * 0.025, y, pz + nzv * 0.025, ry));
        addW(PALETTE.trim, false, boxG(wsz + 0.12, wsz + 0.12, 0.07, px + nxv * 0.035, y, pz + nzv * 0.035, ry));
        addW(PALETTE.glass, false, boxG(wsz - 0.1, wsz - 0.1, 0.09, px + nxv * 0.045, y, pz + nzv * 0.045, ry));
      };
      const fl = front.len;
      if (kind === 'garage') {
        const gw = clamp(fl - 1.2, 1.8, 5.0), gh = Math.min(2.2, wallH - 0.3);
        const [gx, gz] = at(fl / 2, 0);
        addW(PALETTE.outline, false, boxG(gw + 0.2, gh + 0.1, 0.05, gx + front.nx * 0.025, (gh + 0.1) / 2, gz + front.nz * 0.025, phi));
        addW(PALETTE.garageDoor, false, boxG(gw, gh, 0.1, gx + front.nx * 0.05, gh / 2, gz + front.nz * 0.05, phi));
        for (let k = 1; k < 4; k++) // panel lines
          addW(PALETTE.gray, false, boxG(gw, 0.04, 0.12, gx + front.nx * 0.05, (gh * k) / 4, gz + front.nz * 0.05, phi));
      } else {
        const doorH = Math.min(2.1, wallH - 0.4);
        const shift = fl > 9 ? (hash01(b.id, 4) - 0.5) * fl * 0.3 : 0;
        const dt = clamp(fl / 2 + shift, 0.9, Math.max(0.9, fl - 0.9));
        const [dx0, dz0] = at(dt, 0);
        addW(PALETTE.outline, false, boxG(1.24, doorH + 0.14, 0.06, dx0 + front.nx * 0.03, (doorH + 0.14) / 2, dz0 + front.nz * 0.03, phi));
        addW(doorColor, false, boxG(1.0, doorH, 0.1, dx0 + front.nx * 0.05, doorH / 2, dz0 + front.nz * 0.05, phi));
        // knob
        addW(PALETTE.lane, false, boxG(0.08, 0.08, 0.06, dx0 + front.nx * 0.1 + front.tx * 0.35, 1.0, dz0 + front.nz * 0.1 + front.tz * 0.35, phi));
        // step
        const [sx, sz] = at(dt, 0.4);
        addW(PALETTE.sidewalk, false, boxG(1.6, 0.18, 0.8, sx, 0.09, sz, phi));
        // windows flanking
        for (const sgn of [-1, 1]) {
          const wt = dt + sgn * 2.1;
          if (wt > 0.9 && wt < fl - 0.9 && fl > 4.6) {
            for (let lv = 0; lv < levels; lv++) addWindow(wt, 0, lv * fh + fh * 0.55 + (lv === 0 ? 0.1 : 0), phi, front.nx, front.nz, front.tx, front.tz, front.p);
          }
        }
        for (let lv = 1; lv < levels; lv++) // upper floor above door
          addWindow(dt, 0, lv * fh + fh * 0.55, phi, front.nx, front.nz, front.tx, front.tz, front.p);
      }
      // side windows (non-front edges, max 4)
      let sideN = 0;
      for (let i = 0; i < P.length && sideN < 4 && kind !== 'garage'; i++) {
        const p = P[i], q = P[(i + 1) % P.length];
        if (p === front.p) continue;
        const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot(dx, dz);
        if (len < 3) continue;
        const nx = -dz / len, nz = dx / len, tx = dx / len, tz = dz / len;
        const ry = Math.atan2(-tz, tx);
        for (let lv = 0; lv < levels; lv++) addWindow(len / 2, 0, lv * fh + fh * 0.55 + (lv === 0 ? 0.1 : 0), ry, nx, nz, tx, tz, p);
        sideN++;
      }
      // church tower
      if (kind === 'church') {
        const tw = clamp(Math.min(obb.hd, obb.hw) * 0.5, 1.6, 3.2);
        const tcx = front.mx - front.nx * (tw / 2 + 0.2), tcz = front.mz - front.nz * (tw / 2 + 0.2);
        const th = wallH + 3.5;
        addW(wallColor, true, boxG(tw, th, tw, tcx, th / 2, tcz, phi));
        const pr = pitchedRoof({ cx: tcx, cz: tcz, hw: tw / 2, hd: tw / 2 }, th, 'pyramidal', Math.max(3.5, tw * 1.8));
        for (const part of pr.parts) {
          // rotate tower roof to match the front wall orientation
          part.geo.translate(-tcx, 0, -tcz); part.geo.rotateY(phi); part.geo.translate(tcx, 0, tcz);
          addW(roofColor, true, part.geo);
        }
        roofH = Math.max(roofH, th - wallH + pr.H);
      }
    }

    // ---- chimney (~40% of houses, deterministic)
    if (mainRoof && (kind === 'house') && hash01(b.id, 5) < 0.4 && mainRoof.parts.length) {
      const { Lh, s, alongX, rect, H } = mainRoof;
      const ox = (hash01(b.id, 6) - 0.5) * Lh * 0.9, oz = (hash01(b.id, 7) < 0.5 ? -1 : 1) * s * 0.4;
      const topY = wallH + H + 0.8, botY = wallH + H * 0.45;
      const lx = alongX ? ox : oz, lz = alongX ? oz : ox;
      addW(PALETTE.brick, false, boxG(0.7, topY - botY, 0.7, rect.cx + lx, (topY + botY) / 2, rect.cz + lz));
      addW(PALETTE.outline, false, boxG(0.82, 0.12, 0.82, rect.cx + lx, topY, rect.cz + lz));
      roofH = Math.max(roofH, H + 0.8);
    }

    // ---- colliders
    const height = wallH + roofH;
    if (rectangularity < 0.6 && rects && rects.length) {
      for (const r of rects) {
        const [wx, wz] = toWorldXZ(r.cx, r.cz);
        colliders.push({ type: 'obb', cx: wx, cz: wz, hw: r.hw, hd: r.hd, angle, height });
      }
    } else {
      colliders.push({ type: 'obb', cx: obb.cx, cz: obb.cz, hw: obb.hw, hd: obb.hd, angle, height });
    }
  }

  // ---- merge per colour bucket
  for (const bk of buckets.values()) {
    if (!bk.geos.length) continue;
    const merged = mergeGeometries(bk.geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, toonMaterial(bk.color));
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    if (bk.outline && CONFIG?.outlines !== false) addOutline(mesh, 0.05);
    bk.geos.length = 0;
  }

  if (skipped > 0 && typeof console !== 'undefined') console.warn(`[houses] skipped ${skipped} building(s) due to errors`);
  if (scene) scene.add(group);
  return { group, colliders, count: built };
}
