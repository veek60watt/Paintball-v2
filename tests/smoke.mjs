// Live smoke test for paintball-v2.netlify.app. Runs in GitHub Actions after each deploy.
// Writes verify/results.json + screenshots; the workflow publishes them to the verify-results branch.
// Public repo: only public places are tested here (no personal addresses).
import { chromium, devices } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';

const BASE = process.env.BASE_URL || 'https://paintball-v2.netlify.app/';
const OUT = 'verify';
await mkdir(OUT, { recursive: true });
const results = { base: BASE, commit: process.env.GITHUB_SHA || null, at: new Date().toISOString(), checks: {} };

async function check(name, fn) {
  const t0 = Date.now();
  try { results.checks[name] = { ok: true, ...(await fn()) }; }
  catch (e) { results.checks[name] = { ok: false, error: String((e && e.message) || e) }; }
  results.checks[name].ms = Date.now() - t0;
  console.log(name, JSON.stringify(results.checks[name]).slice(0, 400));
}
const osmStats = (j) => ({
  elements: j.elements.length,
  buildings: j.elements.filter((e) => e.tags && e.tags.building).length,
  named_streets: [...new Set(j.elements.filter((e) => e.tags && e.tags.highway && e.tags.name).map((e) => e.tags.name))].slice(0, 12),
});

// ---------- HTTP checks ----------
await check('preload_file', async () => {
  const r = await fetch(BASE + 'data/preload_osm.json');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return { center: j.center, ...osmStats(j) };
});
for (const [name, bbox] of [
  ['proxy_enid_downtown', 's=36.3933&w=-97.8813&n=36.3979&e=-97.8755'],
  ['proxy_white_house', 's=38.8955&w=-77.0395&n=38.8999&e=-77.0335'],
]) {
  for (const pass of ['first', 'repeat']) {
    await check(`${name}_${pass}`, async () => {
      const r = await fetch(BASE + 'api/osm?' + bbox);
      const text = await r.text();
      const hdr = { status: r.status, cache_status: r.headers.get('cache-status'), age: r.headers.get('age') };
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
      return { ...hdr, ...osmStats(JSON.parse(text)) };
    });
  }
}
await check('geocode_white_house', async () => {
  const u = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=us&limit=3'
    + '&street=' + encodeURIComponent('1600 Pennsylvania Avenue NW') + '&city=Washington&state=' + encodeURIComponent('District of Columbia');
  const r = await fetch(u, { headers: { 'User-Agent': 'paperball-smoke/1.0 (github actions)' } });
  const j = await r.json();
  return { results: j.map((x) => ({ house: x.address?.house_number, road: x.address?.road, state: x.address?.state, lat: x.lat, lon: x.lon })) };
});

// ---------- Real browser on the live site ----------
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function openGame(ctxOpts, url) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('request', (r) => { const u = r.url(); if (/preload_osm|api\/osm|overpass|nominatim|fallback_osm/.test(u)) requests.push(u.replace(/\?.*/, '')); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('start-btn').disabled, null, { timeout: 120000 });
  return { ctx, page, errors, requests };
}
const statusOf = async (page) => (await page.textContent('#loading-msg')).replace(/\s+/g, ' ').trim();
const fields = async (page) => [await page.inputValue('#street-input'), await page.inputValue('#city-input'), await page.inputValue('#state-input')];

await check('browser_default_desktop', async () => {
  const { ctx, page, errors, requests } = await openGame({ viewport: { width: 1280, height: 760 } }, BASE);
  const out = { status: await statusOf(page), fields: await fields(page), requests: [...new Set(requests)] };
  await page.screenshot({ path: `${OUT}/default_start.png` });
  await page.click('#start-btn');
  await page.waitForTimeout(1500);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(1500); await page.keyboard.up('KeyW');
  await page.waitForTimeout(500);
  out.hud_label = await page.textContent('#location-label');
  await page.screenshot({ path: `${OUT}/default_play.png` });
  out.errors = errors;
  await ctx.close();
  if (/Couldn't load/.test(out.status)) throw Object.assign(new Error('fell back to sample block: ' + out.status), out);
  return out;
});

await check('browser_default_mobile', async () => {
  const { ctx, page, errors } = await openGame({ ...devices['iPhone 13'] }, BASE);
  const out = { status: await statusOf(page) };
  await page.screenshot({ path: `${OUT}/mobile_start.png` });
  await page.tap('#start-btn');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/mobile_play.png` });
  out.errors = errors;
  await ctx.close();
  return out;
});

await check('browser_search_white_house', async () => {
  const { ctx, page, errors, requests } = await openGame({ viewport: { width: 1280, height: 760 } }, BASE);
  requests.length = 0;
  await page.fill('#street-input', '1600 Pennsylvania Avenue NW');
  await page.fill('#city-input', 'Washington');
  await page.selectOption('#state-input', 'DC');
  await Promise.all([page.waitForURL(/lat=/, { timeout: 30000 }), page.click('#search-btn')]);
  await page.waitForFunction(() => !document.getElementById('start-btn').disabled, null, { timeout: 120000 });
  const out = { url_params: decodeURIComponent(page.url().split('?')[1] || ''), status: await statusOf(page), requests: [...new Set(requests)] };
  await page.screenshot({ path: `${OUT}/search_start.png` });
  await page.click('#start-btn');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/search_play.png` });
  out.errors = errors;
  await ctx.close();
  if (/Couldn't (load|find)/.test(out.status)) throw Object.assign(new Error(out.status), out);
  return out;
});

await browser.close();
await writeFile(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = Object.entries(results.checks).filter(([, v]) => !v.ok).map(([k]) => k);
console.log(failed.length ? 'FAILED: ' + failed.join(', ') : 'ALL CHECKS PASSED');
