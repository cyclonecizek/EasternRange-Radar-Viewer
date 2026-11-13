// Optional Cloudflare Worker relay. Only needed if the browser is refused a direct
// connection to the WSR API (CORS). Deploy, then paste  https://<your-worker>.workers.dev/?url=
// into Settings > Connections > Relay in the workbench.
const ALLOWED_HOSTS = ['codiapi-wsr.rad.spaceforce.mil'];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' };
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return new Response('GET only', { status: 405, headers: CORS });
    const target = new URL(request.url).searchParams.get('url');
    let t; try { t = new URL(target); } catch (e) { return new Response('Missing or bad ?url=', { status: 400, headers: CORS }); }
    if (t.protocol !== 'https:' || !ALLOWED_HOSTS.includes(t.hostname)) return new Response('Host not allowed', { status: 403, headers: CORS });
    const r = await fetch(t.toString(), { headers: { 'User-Agent': 'LLCC-Radar-Workbench-relay/1.0' } });
    const h = new Headers(CORS); h.set('Content-Type', r.headers.get('Content-Type') || 'application/octet-stream'); h.set('Cache-Control', 'no-store');
    return new Response(r.body, { status: r.status, headers: h });
  }
};
