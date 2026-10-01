// Paperball map proxy: GET /api/osm?s=&w=&n=&e=  (bbox in degrees)
// Fetches OpenStreetMap data from Overpass server-side so players on shared mobile IPs
// (which Overpass rate-limits) still get maps. Responses are cached on Netlify's CDN,
// so each neighborhood is downloaded from Overpass at most once a week.

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const STAGGER_MS = 2500; // start the next mirror only if the previous one is slow
const BUDGET_MS = 9000;  // stay under the synchronous function time limit

function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const num = (k: string) => Number(url.searchParams.get(k));
  const s = num("s"), w = num("w"), n = num("n"), e = num("e");
  const valid =
    [s, w, n, e].every(Number.isFinite) &&
    n > s && e > w && n - s <= 0.02 && e - w <= 0.03 &&
    Math.abs(s) <= 90 && Math.abs(n) <= 90 && Math.abs(w) <= 180 && Math.abs(e) <= 180;
  if (!valid) return jsonResponse({ error: "bad bbox" }, 400);

  const r4 = (x: number) => x.toFixed(4);
  const bb = `${r4(s)},${r4(w)},${r4(n)},${r4(e)}`;
  const query =
    `[out:json][timeout:25];(` +
    `way["building"](${bb});relation["building"](${bb});` +
    `way["highway"](${bb});node["natural"="tree"](${bb});` +
    `);out body;>;out skel qt;`;
  const body = "data=" + encodeURIComponent(query);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BUDGET_MS);
  const errors: string[] = [];
  let done = false;

  const attempt = async (mirror: string, i: number): Promise<string> => {
    const host = new URL(mirror).host;
    if (i > 0) await new Promise((r) => setTimeout(r, i * STAGGER_MS));
    if (done) throw new Error("skipped");
    try {
      const res = await fetch(mirror, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Paperball/1.0 (+https://paintball-v2.netlify.app)",
        },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.trimStart().startsWith("{")) throw new Error("non-JSON reply");
      // Overpass reports timeouts/overload as 200 + "remark" + empty elements: don't cache that.
      if (/"remark"\s*:/.test(text) && /"elements"\s*:\s*\[\s*\]/.test(text)) throw new Error("server overloaded");
      return text;
    } catch (err) {
      errors.push(`${host}: ${(err as Error).name === "AbortError" ? "timeout" : (err as Error).message}`);
      throw err;
    }
  };

  try {
    const text = await Promise.any(MIRRORS.map(attempt));
    done = true;
    ctrl.abort(); // cancel slower mirrors
    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        "Netlify-CDN-Cache-Control": "public, durable, s-maxage=604800, stale-while-revalidate=86400",
      },
    });
  } catch {
    return jsonResponse({ error: "all map servers failed", details: errors }, 502);
  } finally {
    done = true;
    clearTimeout(timer);
  }
};

export const config = { path: "/api/osm" };
