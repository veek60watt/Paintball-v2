// Paperball map proxy (Netlify Edge Function): GET /api/osm?s=&w=&n=&e=  (bbox in degrees)
// Edge functions may wait up to 40 s for a response, which matters: as of Oct 2026 the only
// reliably-answering public Overpass server (maps.mail.ru) takes ~15 s, overpass-api.de returns
// 406 to cloud IPs, and several mirrors time out. Results are cached on Netlify's CDN for a week.

export default async (req: Request) => {
  const MIRRORS: Array<[string, number]> = [
    // [url, start delay ms] - staggered so slow mirrors get a head start without hammering all at once
    ["https://maps.mail.ru/osm/tools/overpass/api/interpreter", 0],
    ["https://overpass.kumi.systems/api/interpreter", 8000],
    ["https://overpass-api.de/api/interpreter", 8000],
    ["https://overpass.private.coffee/api/interpreter", 16000],
  ];
  const BUDGET_MS = 36000; // under the 40 s response-header limit

  const reply = (obj: unknown, status: number) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const url = new URL(req.url);
  const num = (k: string) => Number(url.searchParams.get(k));
  const s = num("s"), w = num("w"), n = num("n"), e = num("e");
  const valid =
    [s, w, n, e].every(Number.isFinite) &&
    n > s && e > w && n - s <= 0.02 && e - w <= 0.03 &&
    Math.abs(s) <= 90 && Math.abs(n) <= 90 && Math.abs(w) <= 180 && Math.abs(e) <= 180;
  if (!valid) return reply({ error: "bad bbox" }, 400);

  const r4 = (x: number) => x.toFixed(4);
  const bb = `${r4(s)},${r4(w)},${r4(n)},${r4(e)}`;
  const query =
    `[out:json][timeout:30];(` +
    `way["building"](${bb});relation["building"](${bb});` +
    `way["highway"](${bb});node["natural"="tree"](${bb});` +
    `);out body;>;out skel qt;`;
  const body = "data=" + encodeURIComponent(query);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BUDGET_MS);
  const errors: string[] = [];
  let done = false;

  const attempt = async ([mirror, delay]: [string, number]): Promise<string> => {
    const host = new URL(mirror).host;
    if (delay) await new Promise((r) => setTimeout(r, delay));
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
      if (/"remark"\s*:/.test(text) && /"elements"\s*:\s*\[\s*\]/.test(text)) throw new Error("server overloaded");
      return text;
    } catch (err) {
      const msg = (err as Error).name === "AbortError" ? "timeout" : (err as Error).message;
      if (msg !== "skipped") errors.push(`${host}: ${msg}`);
      throw err;
    }
  };

  try {
    const text = await Promise.any(MIRRORS.map(attempt));
    done = true;
    ctrl.abort();
    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        "Netlify-CDN-Cache-Control": "public, durable, s-maxage=604800, stale-while-revalidate=86400",
      },
    });
  } catch {
    return reply({ error: "all map servers failed", details: errors }, 502);
  } finally {
    done = true;
    clearTimeout(timer);
  }
};

export const config = { path: "/api/osm", cache: "manual" };
