// Paperball — streets.js (Agent C)
// Ground, roads, sidewalks, curbs, lane lines, street-name signs, trees. Few merged draw calls.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE, toonMaterial, addOutline } from './toon.js';

const P = PALETTE || {};
const COL = {
  grass: P.grass ?? 0x7ec850,
  road: P.road ?? 0x4a4a52,
  sidewalk: P.sidewalk ?? 0xd2cdc2,
  curb: P.curb ?? 0xa8a39a,
  lane: P.lane ?? 0xf2c94c,
  outline: P.outline ?? 0x1a1a1a,
  driveway: 0xcfc9b8,
  footway: 0xe6dfcb,
  trunk: P.treeTrunk ?? 0x6b4a2f,
  signGreen: P.signGreen ?? 0x1f7a4d,
  signPost: P.signPost ?? 0x7a7f87,
  leaves: [P.treeLeaves ?? 0x3fa34d, P.treeLeavesAlt ?? 0x58b947, 0x2f8f46, 0x6bc450],
};

const DEFAULT_WIDTH = { primary: 12, secondary: 10, tertiary: 8, residential: 7, service: 4, driveway: 3, alley: 4, footway: 1.5, other: 5 };
const PAVED = new Set(['primary', 'secondary', 'tertiary', 'residential', 'service', 'alley', 'other']);
const SIDEWALKED = new Set(['primary', 'secondary', 'tertiary', 'residential']);
const DASHED = new Set(['primary', 'secondary', 'tertiary']);
const UVS = 0.2; // world-planar uv scale (paper grain)

// ------------------------------------------------------------------ helpers
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distPtSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function pip(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function cleanPts(pts) {
  const out = [];
  for (const p of pts) {
    if (!p || !isFinite(p.x) || !isFinite(p.z)) continue;
    const l = out[out.length - 1];
    if (!l || Math.hypot(p.x - l.x, p.z - l.z) > 0.05) out.push({ x: p.x, z: p.z });
  }
  return out;
}

// Per-point lateral unit "right" vector (-dz, dx) with clamped miter scale.
function miters(pts) {
  const n = pts.length;
  const dirs = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x, dz = pts[i + 1].z - pts[i].z;
    const l = Math.hypot(dx, dz) || 1;
    dirs.push({ x: dx / l, z: dz / l });
  }
  const res = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) res.push({ rx: -dirs[0].z, rz: dirs[0].x, s: 1 });
    else if (i === n - 1) res.push({ rx: -dirs[n - 2].z, rz: dirs[n - 2].x, s: 1 });
    else {
      const r0x = -dirs[i - 1].z, r0z = dirs[i - 1].x, r1x = -dirs[i].z, r1z = dirs[i].x;
      let mx = r0x + r1x, mz = r0z + r1z;
      const ml = Math.hypot(mx, mz);
      if (ml < 1e-4) res.push({ rx: r0x, rz: r0z, s: 1 });
      else {
        mx /= ml; mz /= ml;
        const c = mx * r0x + mz * r0z;
        res.push({ rx: mx, rz: mz, s: Math.min(1 / Math.max(c, 0.2), 2.2) });
      }
    }
  }
  return res;
}

function offsetLine(pts, off) {
  const m = miters(pts);
  return pts.map((p, i) => ({ x: p.x + m[i].rx * off * m[i].s, z: p.z + m[i].rz * off * m[i].s }));
}

function resample(pts, step) {
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(l / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

class Builder {
  constructor() { this.p = []; this.n = []; this.u = []; this.i = []; this.vc = 0; }
  v(x, y, z, nx, ny, nz) { this.p.push(x, y, z); this.n.push(nx, ny, nz); this.u.push(x * UVS, z * UVS); return this.vc++; }
  ribbon(pts, width, y) {
    pts = cleanPts(pts);
    if (pts.length < 2) return;
    const m = miters(pts), hw = width / 2;
    const base = this.vc;
    for (let k = 0; k < pts.length; k++) {
      const o = hw * m[k].s;
      this.v(pts[k].x - m[k].rx * o, y, pts[k].z - m[k].rz * o, 0, 1, 0);
      this.v(pts[k].x + m[k].rx * o, y, pts[k].z + m[k].rz * o, 0, 1, 0);
    }
    for (let k = 0; k < pts.length - 1; k++) {
      const a0 = base + 2 * k, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
      this.i.push(a0, b0, a1, b0, b1, a1);
    }
  }
  // Raised box strip: top + two side walls (double-sided material expected).
  boxRibbon(pts, width, height) {
    pts = cleanPts(pts);
    if (pts.length < 2) return;
    this.ribbon(pts, width, height);
    const m = miters(pts), hw = width / 2;
    for (const side of [-1, 1]) {
      const base = this.vc;
      for (let k = 0; k < pts.length; k++) {
        const o = hw * m[k].s * side;
        const x = pts[k].x + m[k].rx * o, z = pts[k].z + m[k].rz * o;
        this.v(x, 0, z, m[k].rx * side, 0, m[k].rz * side);
        this.v(x, height, z, m[k].rx * side, 0, m[k].rz * side);
      }
      for (let k = 0; k < pts.length - 1; k++) {
        const b0 = base + 2 * k, t0 = b0 + 1, b1 = b0 + 2, t1 = b0 + 3;
        this.i.push(b0, b1, t0, t0, b1, t1);
      }
    }
  }
  disc(cx, cz, r, y, seg = 20) {
    const c = this.v(cx, y, cz, 0, 1, 0);
    const first = this.vc;
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      this.v(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r, 0, 1, 0);
    }
    for (let k = 0; k < seg; k++) this.i.push(c, first + ((k + 1) % seg), first + k); // faces +Y
  }
  geometry() {
    if (!this.vc) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

function layerMaterial(color, layer, opts) {
  const base = toonMaterial(color, opts);
  const m = base.clone(); // never mutate the shared cached material
  m.polygonOffset = true;
  m.polygonOffsetFactor = -layer;
  m.polygonOffsetUnits = -layer;
  return m;
}

const ABBR = [
  [/\bAvenue\b/gi, 'Ave'], [/\bStreet\b/gi, 'St'], [/\bBoulevard\b/gi, 'Blvd'], [/\bRoad\b/gi, 'Rd'],
  [/\bDrive\b/gi, 'Dr'], [/\bLane\b/gi, 'Ln'], [/\bCourt\b/gi, 'Ct'], [/\bPlace\b/gi, 'Pl'],
  [/\bCircle\b/gi, 'Cir'], [/\bParkway\b/gi, 'Pkwy'], [/\bHighway\b/gi, 'Hwy'], [/\bTerrace\b/gi, 'Ter'],
  [/\bTrail\b/gi, 'Trl'], [/\bNorth\b/gi, 'N'], [/\bSouth\b/gi, 'S'], [/\bEast\b/gi, 'E'], [/\bWest\b/gi, 'W'],
];
function abbreviate(name) {
  if (name.length <= 13) return name;
  let s = name;
  for (const [re, r] of ABBR) s = s.replace(re, r);
  return s;
}

// ------------------------------------------------------------------ sign atlas
const CELL_W = 512, CELL_H = 128, ATLAS_W = 1024, ATLAS_H = 2048, CELLS_PER_PAGE = 32;
function makeAtlas() {
  const labels = [];
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W; canvas.height = ATLAS_H;
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const page = { canvas, tex, labels, blades: [] };
  page.draw = () => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, ATLAS_W, ATLAS_H);
    labels.forEach((label, idx) => {
      const x0 = (idx % 2) * CELL_W, y0 = Math.floor(idx / 2) * CELL_H;
      ctx.fillStyle = '#' + COL.signGreen.toString(16).padStart(6, '0');
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 5;
      const r = 26, x = x0 + 4, y = y0 + 4, w = CELL_W - 8, h = CELL_H - 8;
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      let size = 76;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      for (; size > 22; size -= 4) {
        ctx.font = `bold ${size}px "Patrick Hand", "Arial Black", Arial, sans-serif`;
        if (ctx.measureText(label).width <= CELL_W - 64) break;
      }
      ctx.fillText(label, x0 + CELL_W / 2, y0 + CELL_H / 2 + 4);
    });
    tex.needsUpdate = true;
  };
  return page;
}

// ------------------------------------------------------------------ main
export function buildStreets(scene, worldData, CONFIG) {
  const group = new THREE.Group();
  group.name = 'streets';
  const colliders = [];
  const roads = (worldData.roads || []).map((r) => ({
    ...r,
    kind: r.kind || 'other',
    width: r.width > 0 ? r.width : (DEFAULT_WIDTH[r.kind] ?? 5),
    points: cleanPts(r.points || []),
  })).filter((r) => r.points.length >= 2);
  const buildings = (worldData.buildings || []).map((b) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of b.footprint) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    return { fp: b.footprint, minX, maxX, minZ, maxZ };
  });

  // bounds
  let bounds = worldData.bounds;
  if (!bounds || ![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(isFinite)) {
    bounds = { minX: -100, maxX: 100, minZ: -100, maxZ: 100 };
    for (const r of roads) for (const p of r.points) {
      bounds.minX = Math.min(bounds.minX, p.x); bounds.maxX = Math.max(bounds.maxX, p.x);
      bounds.minZ = Math.min(bounds.minZ, p.z); bounds.maxZ = Math.max(bounds.maxZ, p.z);
    }
  }

  // ---- ground
  {
    const w = bounds.maxX - bounds.minX + 300, d = bounds.maxZ - bounds.minZ + 300;
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    g.translate((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
    const pos = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) * UVS, pos.getZ(i) * UVS);
    const ground = new THREE.Mesh(g, toonMaterial(COL.grass));
    ground.name = 'ground';
    group.add(ground);
  }

  // ---- pavement lookup (for clipping sidewalks / lines / trees)
  const pave = roads.filter((r) => PAVED.has(r.kind)).map((r) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of r.points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    const pad = r.width / 2 + 6;
    return { r, minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
  });
  const sameRoad = (a, b) => a === b || (a.name && b.name && a.name === b.name);
  function nearOther(road, x, z, extra) {
    for (const e of pave) {
      if (sameRoad(e.r, road)) continue;
      if (x < e.minX || x > e.maxX || z < e.minZ || z > e.maxZ) continue;
      const lim = e.r.width / 2 + extra, pts = e.r.points;
      for (let i = 0; i < pts.length - 1; i++) {
        if (distPtSeg(x, z, pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z) < lim) return true;
      }
    }
    return false;
  }

  const bRoad = new Builder(), bDrive = new Builder(), bFoot = new Builder();
  const bWalk = new Builder(), bCurb = new Builder(), bLane = new Builder();

  // ---- per-road ribbons, sidewalks, curbs, lane lines
  for (const road of roads) {
    try {
      const k = road.kind;
      if (k === 'footway') { bFoot.ribbon(road.points, Math.max(1.2, road.width), 0.04); continue; }
      if (k === 'driveway') { bDrive.ribbon(road.points, road.width, 0.025); continue; }
      bRoad.ribbon(road.points, road.width, 0.02);

      if (SIDEWALKED.has(k)) {
        const rs = resample(road.points, 2);
        const specs = [[road.width / 2 + 1.5, 1.4, 0.8, bWalk, null], [road.width / 2 + 0.05, 0.2, 0.3, bCurb, 0.15]];
        for (const side of [-1, 1]) {
          for (const [off, w, extra, builder, h] of specs) {
            const line = offsetLine(rs, off * side);
            let run = [];
            const flush = () => {
              if (run.length >= 2) { if (h) builder.boxRibbon(run, w, h); else builder.ribbon(run, w, 0.06); }
              run = [];
            };
            for (let i = 0; i < line.length - 1; i++) {
              const mx = (line[i].x + line[i + 1].x) / 2, mz = (line[i].z + line[i + 1].z) / 2;
              if (nearOther(road, mx, mz, extra)) { flush(); continue; }
              if (!run.length) run.push(line[i]);
              run.push(line[i + 1]);
            }
            flush();
          }
        }
      }

      if (DASHED.has(k)) {
        let s = 0;
        const DASH = 3;
        for (let i = 0; i < road.points.length - 1; i++) {
          const a = road.points[i], b = road.points[i + 1];
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          let t = 0;
          while (t < len - 1e-6) {
            const phase = Math.floor((s + t) / DASH);
            const nextB = (phase + 1) * DASH - s;
            const t1 = Math.min(len, nextB);
            if (phase % 2 === 0 && t1 - t > 0.3) {
              const p0 = { x: a.x + ((b.x - a.x) * t) / len, z: a.z + ((b.z - a.z) * t) / len };
              const p1 = { x: a.x + ((b.x - a.x) * t1) / len, z: a.z + ((b.z - a.z) * t1) / len };
              if (!nearOther(road, (p0.x + p1.x) / 2, (p0.z + p1.z) / 2, 0.1)) bLane.ribbon([p0, p1], 0.18, 0.03);
            }
            t = t1;
          }
          s += len;
        }
      }
    } catch (e) {
      console.warn('[streets] road skipped', road.id, e && e.message);
    }
  }

  // ---- intersection discs
  const vmap = new Map();
  const vkey = (p) => Math.round(p.x * 10) + '_' + Math.round(p.z * 10);
  roads.forEach((r, ri) => {
    if (!PAVED.has(r.kind)) return;
    r.points.forEach((p, idx) => {
      const key = vkey(p);
      let e = vmap.get(key);
      if (!e) { e = { x: p.x, z: p.z, list: [], maxW: 0 }; vmap.set(key, e); }
      e.list.push({ ri, idx });
      e.maxW = Math.max(e.maxW, r.width);
    });
  });
  for (const e of vmap.values()) {
    try {
      if (e.list.length >= 2 && e.list.some((q) => roads[q.ri].kind !== 'service' && roads[q.ri].kind !== 'alley' && roads[q.ri].kind !== 'other')) {
        bRoad.disc(e.x, e.z, e.maxW / 2, 0.02);
      }
    } catch (_) { /* ignore */ }
  }

  const addMesh = (builder, color, layer, opts, name) => {
    const g = builder.geometry();
    if (!g) return null;
    const m = new THREE.Mesh(g, layerMaterial(color, layer, opts));
    m.name = name;
    group.add(m);
    return m;
  };
  addMesh(bRoad, COL.road, 1, undefined, 'roads');
  addMesh(bDrive, COL.driveway, 2, undefined, 'driveways');
  addMesh(bFoot, COL.footway, 2, undefined, 'footways');
  addMesh(bLane, COL.lane, 3, undefined, 'lanes');
  addMesh(bWalk, COL.sidewalk, 4, undefined, 'sidewalks');
  addMesh(bCurb, COL.curb, 5, { side: THREE.DoubleSide }, 'curbs');

  // ---- street name signs
  const signs = []; // {x,z, blades:[{label, dx, dz}]}
  try {
    const dirOut = (ri, idx) => {
      const pts = roads[ri].points;
      const a = pts[idx], b = idx < pts.length - 1 ? pts[idx + 1] : pts[idx - 1];
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
      return { x: dx / l, z: dz / l };
    };
    const cands = [];
    for (const e of vmap.values()) {
      const byName = new Map();
      for (const q of e.list) {
        const r = roads[q.ri];
        if (!r.name) continue;
        if (!byName.has(r.name)) byName.set(r.name, q);
      }
      if (byName.size < 2) continue;
      const names = [...byName.keys()].sort();
      for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) {
        cands.push({ e, qa: byName.get(names[a]), qb: byName.get(names[b]), na: names[a], nb: names[b], w: roads[byName.get(names[a]).ri].width + roads[byName.get(names[b]).ri].width });
      }
    }
    cands.sort((p, q) => q.w - p.w);
    const placed = [];
    for (const c of cands) {
      if (signs.length >= 60) break;
      const key = c.na + '|' + c.nb;
      if (placed.some((p) => p.key === key && Math.hypot(p.x - c.e.x, p.z - c.e.z) < 25)) continue;
      placed.push({ key, x: c.e.x, z: c.e.z });
      const ra = roads[c.qa.ri], rb = roads[c.qb.ri];
      const da = dirOut(c.qa.ri, c.qa.idx), db = dirOut(c.qb.ri, c.qb.idx);
      const x = c.e.x + da.x * (rb.width / 2 + 2) + db.x * (ra.width / 2 + 2);
      const z = c.e.z + da.z * (rb.width / 2 + 2) + db.z * (ra.width / 2 + 2);
      signs.push({ x, z, blades: [{ label: abbreviate(c.na), dx: da.x, dz: da.z }, { label: abbreviate(c.nb), dx: db.x, dz: db.z }] });
    }
    // names with no intersection sign: one sign at the midpoint, right side
    const covered = new Set();
    for (const c of placed) { const [a, b] = c.key.split('|'); covered.add(a); covered.add(b); }
    const longest = new Map();
    const rlen = (r) => { let L = 0; for (let i = 0; i < r.points.length - 1; i++) L += Math.hypot(r.points[i + 1].x - r.points[i].x, r.points[i + 1].z - r.points[i].z); return L; };
    for (const r of roads) {
      if (!r.name || !PAVED.has(r.kind)) continue;
      const L = rlen(r);
      if (!longest.has(r.name) || longest.get(r.name).L < L) longest.set(r.name, { r, L });
    }
    for (const [name, { r, L }] of longest) {
      if (signs.length >= 60) break;
      if (covered.has(name)) continue;
      let t = L / 2;
      for (let i = 0; i < r.points.length - 1; i++) {
        const a = r.points[i], b = r.points[i + 1], l = Math.hypot(b.x - a.x, b.z - a.z);
        if (t <= l || i === r.points.length - 2) {
          const f = Math.min(1, t / (l || 1)), dx = (b.x - a.x) / (l || 1), dz = (b.z - a.z) / (l || 1);
          const off = r.width / 2 + 2;
          signs.push({ x: a.x + (b.x - a.x) * f - dz * off, z: a.z + (b.z - a.z) * f + dx * off, blades: [{ label: abbreviate(name), dx, dz }] });
          break;
        }
        t -= l;
      }
    }
  } catch (e) {
    console.warn('[streets] sign placement failed', e && e.message);
  }

  const pages = [];
  const cellOf = (label) => {
    for (const pg of pages) { const i = pg.labels.indexOf(label); if (i >= 0) return { pg, i }; }
    let pg = pages[pages.length - 1];
    if (!pg || pg.labels.length >= CELLS_PER_PAGE) { pg = makeAtlas(); pages.push(pg); }
    pg.labels.push(label);
    return { pg, i: pg.labels.length - 1 };
  };
  const postGeos = [];
  const tmpM = new THREE.Matrix4(), tmpR = new THREE.Matrix4(), tmpT = new THREE.Matrix4();
  for (const s of signs) {
    try {
      const post = new THREE.CylinderGeometry(0.05, 0.06, 2.8, 8);
      post.translate(s.x, 1.4, s.z);
      postGeos.push(post);
      colliders.push({ type: 'cyl', cx: s.x, cz: s.z, r: 0.08, height: 2.8 });
      s.blades.forEach((bl, bi) => {
        const { pg, i } = cellOf(bl.label);
        const col = i % 2, row = Math.floor(i / 2);
        const u0 = col * 0.5, v1 = 1 - (row * CELL_H) / ATLAS_H, v0 = v1 - CELL_H / ATLAS_H;
        const theta = Math.atan2(-bl.dz, bl.dx);
        const y = 2.55 - bi * 0.34;
        for (const back of [false, true]) {
          const g = new THREE.PlaneGeometry(1.2, 0.3);
          const uv = g.attributes.uv;
          for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) * 0.5, v0 + uv.getY(k) * (v1 - v0));
          tmpM.makeTranslation(s.x, y, s.z);
          tmpR.makeRotationY(theta);
          tmpM.multiply(tmpR);
          tmpT.makeTranslation(0, 0, back ? -0.015 : 0.015);
          tmpM.multiply(tmpT);
          if (back) { tmpR.makeRotationY(Math.PI); tmpM.multiply(tmpR); }
          g.applyMatrix4(tmpM);
          pg.blades.push(g);
        }
      });
    } catch (e) {
      console.warn('[streets] sign skipped', e && e.message);
    }
  }
  if (postGeos.length) {
    const posts = new THREE.Mesh(mergeGeometries(postGeos, false), toonMaterial(COL.signPost));
    posts.name = 'sign-posts';
    group.add(posts);
    try { addOutline(posts, 0.03); } catch (_) { /* optional */ }
  }
  for (const pg of pages) {
    pg.draw();
    const mesh = new THREE.Mesh(
      mergeGeometries(pg.blades, false),
      new THREE.MeshBasicMaterial({ map: pg.tex, transparent: true, alphaTest: 0.5 })
    );
    mesh.name = 'sign-blades';
    group.add(mesh);
  }
  if (pages.length && typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
    const redraw = () => pages.forEach((pg) => pg.draw());
    try {
      if (document.fonts.load) document.fonts.load('bold 60px "Patrick Hand"').catch(() => {});
      document.fonts.ready.then(redraw).catch(() => {});
    } catch (_) { /* ignore */ }
  }

  // ---- trees
  const treePts = (worldData.trees || []).filter((t) => isFinite(t.x) && isFinite(t.z)).map((t) => ({ x: t.x, z: t.z }));
  try {
    let paveLen = 0;
    for (const r of roads) if (SIDEWALKED.has(r.kind)) paveLen += rlenSimple(r.points);
    const need = Math.ceil(paveLen / 25) - treePts.length;
    const cap = Math.max(0, (CONFIG && CONFIG.max_trees ? CONFIG.max_trees : 400) - treePts.length);
    if (need > 0 && cap > 0) {
      const rnd = mulberry32(1234567);
      const fills = [];
      const drives = roads.filter((r) => r.kind === 'driveway' || r.kind === 'footway');
      for (const road of roads) {
        if (road.kind !== 'residential') continue;
        let walked = 5 + rnd() * 10, side = rnd() < 0.5 ? -1 : 1;
        for (let i = 0; i < road.points.length - 1; i++) {
          const a = road.points[i], b = road.points[i + 1];
          const l = Math.hypot(b.x - a.x, b.z - a.z);
          if (l < 1e-6) continue;
          const dx = (b.x - a.x) / l, dz = (b.z - a.z) / l;
          for (let t = (22 - (walked % 22)) % 22; t < l; t += 22) {
            side = -side;
            const off = side * (road.width / 2 + 3.4);
            const x = a.x + dx * t - dz * off, z = a.z + dz * t + dx * off;
            fills.push({ x, z, road });
          }
          walked += l;
        }
      }
      // deterministic shuffle
      for (let i = fills.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [fills[i], fills[j]] = [fills[j], fills[i]]; }
      const chosen = [];
      for (const f of fills) {
        if (chosen.length >= Math.min(need, cap)) break;
        if (nearOther(f.road, f.x, f.z, 2)) continue;
        let bad = false;
        for (const d of drives) {
          const lim = d.kind === 'driveway' ? 4 + d.width / 2 : 1.5 + d.width / 2;
          for (let i = 0; i < d.points.length - 1 && !bad; i++) if (distPtSeg(f.x, f.z, d.points[i].x, d.points[i].z, d.points[i + 1].x, d.points[i + 1].z) < lim) bad = true;
          if (bad) break;
        }
        if (bad) continue;
        for (const b of buildings) {
          if (f.x < b.minX - 2.5 || f.x > b.maxX + 2.5 || f.z < b.minZ - 2.5 || f.z > b.maxZ + 2.5) continue;
          if (pip(f.x, f.z, b.fp)) { bad = true; break; }
          for (let i = 0; i < b.fp.length; i++) {
            const p = b.fp[i], q = b.fp[(i + 1) % b.fp.length];
            if (distPtSeg(f.x, f.z, p.x, p.z, q.x, q.z) < 2.5) { bad = true; break; }
          }
          if (bad) break;
        }
        if (bad) continue;
        if (treePts.some((t) => Math.hypot(t.x - f.x, t.z - f.z) < 4) || chosen.some((t) => Math.hypot(t.x - f.x, t.z - f.z) < 8)) continue;
        chosen.push({ x: f.x, z: f.z });
      }
      treePts.push(...chosen);
    }
  } catch (e) {
    console.warn('[streets] tree fill failed', e && e.message);
  }

  if (treePts.length) buildTrees(group, treePts, colliders);

  // ---- spawn point
  const spawnPoint = findSpawn(roads, pave, buildings, nearOther);

  scene.add(group);
  return { group, colliders, spawnPoint, signCount: signs.length };
}

function rlenSimple(pts) {
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
  return L;
}

// ------------------------------------------------------------------ trees (instanced, outlined)
function buildTrees(group, pts, colliders) {
  const rnd = mulberry32(98765);
  const n = pts.length;
  // Canopy sits above head height (eye = 1.7 m) so walking past a tree never puts the camera in the leaves.
  const trunkG = new THREE.CylinderGeometry(0.17, 0.24, 3.6, 7);
  trunkG.translate(0, 1.8, 0);
  const trunkOutG = trunkG.clone();
  { const p = trunkOutG.attributes.position; for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * 1.4, p.getY(i) * 1.03 + (p.getY(i) < 1 ? -0.03 : 0.04), p.getZ(i) * 1.4); }
  const blobG = new THREE.IcosahedronGeometry(1, 0);
  const blobOutG = blobG.clone(); blobOutG.scale(1.13, 1.13, 1.13);

  const outlineMat = new THREE.MeshBasicMaterial({ color: COL.outline, side: THREE.BackSide });
  const trunks = new THREE.InstancedMesh(trunkG, toonMaterial(COL.trunk), n);
  const trunksO = new THREE.InstancedMesh(trunkOutG, outlineMat, n);
  const leafMat = toonMaterial(0xffffff);
  const blobDefs = [
    { ox: 0, oy: 4.5, oz: 0, s: 1.5 },     // lowest blob edge ~2.5 m even at max tree scale
    { ox: 0.85, oy: 3.95, oz: 0.4, s: 1.05 },
    { ox: -0.7, oy: 4.05, oz: -0.55, s: 1.15 },
  ];
  const blobs = blobDefs.map(() => new THREE.InstancedMesh(blobG, leafMat, n));
  const blobsO = blobDefs.map(() => new THREE.InstancedMesh(blobOutG, outlineMat, n));
  const base = new THREE.Matrix4(), m = new THREE.Matrix4(), loc = new THREE.Matrix4();
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(), ps = new THREE.Vector3();
  const color = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const s = 0.8 + rnd() * 0.45, rot = rnd() * Math.PI * 2;
    q.setFromAxisAngle(up, rot);
    base.compose(ps.set(pts[i].x, 0, pts[i].z), q, sc.set(s, s, s));
    trunks.setMatrixAt(i, base); trunksO.setMatrixAt(i, base);
    color.setHex(COL.leaves[Math.floor(rnd() * COL.leaves.length)]);
    blobDefs.forEach((b, k) => {
      const j = 0.9 + rnd() * 0.2;
      loc.compose(ps.set(b.ox, b.oy, b.oz), new THREE.Quaternion().setFromAxisAngle(up, rnd() * 3), sc.set(b.s * j, b.s * j * 0.92, b.s * j));
      m.multiplyMatrices(base, loc);
      blobs[k].setMatrixAt(i, m); blobsO[k].setMatrixAt(i, m);
      blobs[k].setColorAt(i, color);
    });
    colliders.push({ type: 'cyl', cx: pts[i].x, cz: pts[i].z, r: 0.25, height: 3.6 });
  }
  const all = [trunks, trunksO, ...blobs, ...blobsO];
  all.forEach((im) => { im.frustumCulled = false; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; group.add(im); });
  trunks.name = 'tree-trunks';
}

// ------------------------------------------------------------------ spawn
function findSpawn(roads, pave, buildings, nearOther) {
  const fallback = { x: 0, z: 0, yaw: 0 };
  try {
    const cands = [];
    for (const r of roads) {
      if (r.kind !== 'residential' && r.kind !== 'tertiary' && r.kind !== 'secondary' && r.kind !== 'primary') continue;
      for (let i = 0; i < r.points.length - 1; i++) {
        const a = r.points[i], b = r.points[i + 1];
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        if (l < 1e-6) continue;
        const dx = (b.x - a.x) / l, dz = (b.z - a.z) / l;
        const steps = Math.max(1, Math.ceil(l / 4));
        for (let k = 0; k <= steps; k++) {
          const t = (k / steps) * l;
          for (const side of [1, -1]) {
            const off = side * (r.width / 2 + 1.5);
            const x = a.x + dx * t - dz * off, z = a.z + dz * t + dx * off;
            cands.push({ x, z, d: Math.hypot(x, z) + (r.kind === 'residential' ? 0 : 15), dx, dz, r });
          }
        }
      }
    }
    cands.sort((p, q) => p.d - q.d);
    for (const c of cands.slice(0, 600)) {
      if (nearOther(c.r, c.x, c.z, 1.0)) continue;
      let inside = false;
      for (const b of buildings) {
        if (c.x < b.minX || c.x > b.maxX || c.z < b.minZ || c.z > b.maxZ) continue;
        if (pip(c.x, c.z, b.fp)) { inside = true; break; }
      }
      if (inside) continue;
      return { x: c.x, z: c.z, yaw: Math.atan2(-c.dx, -c.dz) };
    }
    if (cands.length) { const c = cands[0]; return { x: c.x, z: c.z, yaw: Math.atan2(-c.dx, -c.dz) }; }
  } catch (e) {
    console.warn('[streets] spawn search failed', e && e.message);
  }
  return fallback;
}
