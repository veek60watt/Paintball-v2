// Paperball map proxy (Netlify Edge Function): GET /api/osm?s=&w=&n=&e=  (bbox in degrees)
// As of Oct 2026 the only reliably-answering public Overpass server (maps.mail.ru) takes 10-25 s, overpass-api.de returns
// 406 to cloud IPs, and several mirrors time out. Results are cached on Netlify's CDN for a week.

export default async (req: Request) => {
  const MIRRORS: Array<[string, number]> = [
    // [url, start delay ms] - staggered so slow mirrors get a head start without hammering all at once
    ["https://maps.mail.ru/osm/tools/overpass/api/interpreter", 0],
    ["https://overpass.kumi.systems/api/interpreter", 5000],
    ["https://overpass-api.de/api/interpreter", 5000],
    ["https://overpass.private.coffee/api/interpreter", 9000],
  ];
  // Live tests showed edge invocations cut off at ~26 s (not the documented 40 s). Stay well under;
  // if every mirror is slower, the browser falls back to calling maps.mail.ru directly.
  const BUDGET_MS = 22000;

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

  const errors: string[] = [];
  let done = false;
  const started = Date.now();

  // Each mirror gets its own controller so cancelling the losers never cuts off the winner's body.
  // The winner's body is streamed straight through (never read here): reading multi-MB JSON in the
  // edge runtime risks the 50 ms CPU limit, which showed up as empty 502s in the live smoke test.
  const attempt = async ([mirror, delay]: [string, number]) => {
    const host = new URL(mirror).host;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (done) throw new Error("skipped");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(1000, BUDGET_MS - (Date.now() - started)));
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
      if (!/json/i.test(res.headers.get("content-type") || "")) throw new Error("non-JSON reply");
      clearTimeout(timer); // headers are in; let the body stream at its own pace
      return { res, cancel: () => ctrl.abort() };
    } catch (err) {
      clearTimeout(timer);
      const msg = (err as Error).name === "AbortError" ? "timeout" : (err as Error).message;
      if (msg !== "skipped") errors.push(`${host}: ${msg}`);
      throw err;
    }
  };

  // maps.mail.ru often answers 504 when busy and succeeds on a retry: retry 5xx while time remains.
  const withRetry = async (m: [string, number]) => {
    let first = true;
    for (;;) {
      try {
        return await attempt(first ? m : [m[0], 0]);
      } catch (err) {
        first = false;
        const msg = (err as Error).message || "";
        const left = BUDGET_MS - (Date.now() - started);
        if (done || !/^HTTP 5\d\d/.test(msg) || left < 7000) throw err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  };
  const pending = MIRRORS.map(withRetry);
  try {
    const { res } = await Promise.any(pending);
    done = true;
    // cancel slower mirrors that already connected
    pending.forEach((p) => p.then((w) => { if (w.res !== res) w.cancel(); }).catch(() => {}));
    return new Response(res.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        // 1 day: Overpass can return partial data; the browser rejects that, and a short TTL limits the damage.
        "Netlify-CDN-Cache-Control": "public, durable, s-maxage=86400",
        // Without this the CDN cache key ignores the query string and every bbox gets the first map cached.
        "Netlify-Vary": "query",
      },
    });
  } catch {
    done = true;
    return reply({ error: "all map servers failed", details: errors }, 502);
  }
};

export const config = { path: "/api/osm", cache: "manual" };
