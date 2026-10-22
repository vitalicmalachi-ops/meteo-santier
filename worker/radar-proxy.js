// Proxy minimal pentru imaginile radar EUMETNET OPERA (date deschise, CC BY 4.0).
// Serverul S3 unde stau fișierele nu permite citirea din browser (fără CORS), așa că trecem cererile pe aici.
// Acceptă doar fișierele compozite OPERA (GeoTIFF) și doar cereri GET cu Range; răspunsurile se păstrează în cache 1 oră.
const ORIGIN = "https://s3.waw3-1.cloudferro.com/openradar-24h/";
const OK_PATH = /^\d{4}\/\d{2}\/\d{2}\/OPERA\/COMP\/OPERA@\d{8}T\d{4}@0@(DBZH|RATE)\.tiff$/;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Range", "Access-Control-Expose-Headers": "Content-Range, Content-Length", "Access-Control-Max-Age": "86400" };
export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "GET") return new Response("method", { status: 405, headers: CORS });
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname.slice(1));
    if (!OK_PATH.test(path)) return new Response("not found", { status: 404, headers: CORS });
    const range = req.headers.get("Range") || "";
    const m = range.match(/^bytes=(\d+)-(\d+)$/);
    if (!m || +m[2] - +m[1] > 2_000_000) return new Response("range required", { status: 416, headers: CORS });
    const cacheKey = new Request(`https://cache.local/${path}?r=${m[1]}-${m[2]}`);
    const cache = caches.default;
    let res = await cache.match(cacheKey);
    if (!res) {
      const up = await fetch(ORIGIN + path, { headers: { Range: range } });
      if (up.status !== 206 && up.status !== 200) return new Response("upstream " + up.status, { status: 502, headers: CORS });
      const body = await up.arrayBuffer();
      res = new Response(body, { status: 200, headers: { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=3600", "X-Content-Range": up.headers.get("Content-Range") || "" } });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    const h = new Headers(CORS);
    h.set("Content-Type", "application/octet-stream");
    h.set("Cache-Control", "public, max-age=3600");
    if (res.headers.get("X-Content-Range")) h.set("Content-Range", res.headers.get("X-Content-Range"));
    return new Response(res.body, { status: 206, headers: h });
  },
};
