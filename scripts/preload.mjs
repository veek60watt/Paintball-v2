// Downloads the default location's map into data/preload_osm.json so the start screen loads instantly
// without any live map-server call. Run by .github/workflows/preload.yml (GitHub's servers can reach
// Overpass; Netlify's build servers could not). Never exits non-zero.
import { readFile, writeFile } from 'node:fs/promises';

// Order matters: as of Oct 2026 maps.mail.ru is the only public server reliably answering cloud IPs
// (overpass-api.de returns 406; kumi/private.coffee often time out).
const MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const R = 260; // meters; matches desktop CONFIG.radius_m (mobile uses a subset)

async function main() {
  // Single source of truth: read default_center from js/config.js
  const cfg = await readFile(new URL('../js/config.js', import.meta.url), 'utf8');
  const m = cfg.match(/default_center:\s*\{\s*lat:\s*([-\d.]+),\s*lon:\s*([-\d.]+),\s*label:\s*'([^']+)'/);
  if (!m) { console.log('[preload] default_center not found in config.js; skipping'); return; }
  const center = { lat: Number(m[1]), lon: Number(m[2]), label: m[3] };
  const dLat = R / 111320, dLon = R / (111320 * Math.cos(center.lat * Math.PI / 180));
  const r4 = (x) => x.toFixed(4);
  const bb = `${r4(center.lat - dLat)},${r4(center.lon - dLon)},${r4(center.lat + dLat)},${r4(center.lon + dLon)}`;
  const query = `[out:json][timeout:65];(way["building"](${bb});relation["building"](${bb});way["highway"](${bb});node["natural"="tree"](${bb}););out body;>;out skel qt;`;

  for (const mirror of MIRRORS) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 70000);
      const res = await fetch(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Paperball-build/1.0 (+https://paintball-v2.netlify.app)' },
        body: 'data=' + encodeURIComponent(query),
        signal: ac.signal,
      });
      clearTimeout(t);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const els = Array.isArray(json.elements) ? json.elements : [];
      if (json.remark) throw new Error('partial data: ' + json.remark);
      const buildings = els.filter((e) => e.tags && e.tags.building).length;
      if (!buildings) throw new Error('no buildings in response');
      await writeFile(new URL('../data/preload_osm.json', import.meta.url), JSON.stringify({ ...json, center }));
      console.log(`[preload] ${center.label}: ${els.length} elements, ${buildings} buildings from ${new URL(mirror).host}`);
      return;
    } catch (err) {
      console.log(`[preload] ${new URL(mirror).host} failed: ${err.message}`);
    }
  }
  console.log('[preload] all mirrors failed; site will fetch the default map live instead');
}

main().catch((e) => console.log('[preload] skipped:', e.message)).finally(() => process.exit(0));
