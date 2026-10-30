// Worker Cloudflare de TwitchIO : télécharge à la place de l'addon les listes de lecture (/m/) et les morceaux vidéo (/s/).
// L'addon ne fait plus passer aucune vidéo par son serveur : il ne répond qu'à la liste des sources et à la liste principale (/p/).
// Les adresses sont chiffrées par l'addon (même clé que SECRET) : ce Worker n'est pas un relais ouvert, il ne sait ouvrir que ce que l'addon a chiffré.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CORS = { 'Access-Control-Allow-Origin': '*' };
const enc = new TextEncoder(), dec = new TextDecoder();

const fromB64u = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; };
const toB64u = b => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

// même format que lib/seal.js : base64url( iv(12) | tag(16) | texte chiffré ), AES-256-GCM, clé = sha256('twitch-seal-v1|' + SECRET)
let keyP = null;
const getKey = secret => (keyP ||= crypto.subtle.digest('SHA-256', enc.encode('twitch-seal-v1|' + secret)).then(d => crypto.subtle.importKey('raw', d, 'AES-GCM', false, ['encrypt', 'decrypt'])));
async function open(sealed, secret) {
  try {
    const b = fromB64u(sealed); if (b.length < 29) return null;
    const ct = b.subarray(28), data = new Uint8Array(ct.length + 16); data.set(ct); data.set(b.subarray(12, 28), ct.length); // WebCrypto attend « texte chiffré | tag »
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, await getKey(secret), data));
  } catch { return null; }
}
async function seal(plain, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12)), out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(secret), enc.encode(plain)));
  const ct = out.subarray(0, out.length - 16), r = new Uint8Array(28 + ct.length);
  r.set(iv); r.set(out.subarray(out.length - 16), 12); r.set(ct, 28);
  return toB64u(r);
}

const segExt = u => { const m = /\.(ts|mp4|m4s|aac|m4a|cmfv|cmfa)(?:$|\?)/i.exec(String(u).split('#')[0]); return m ? '.' + m[1].toLowerCase() : ''; };
const absolutize = (text, base) => { // adresses relatives → absolues
  const abs = u => { try { return new URL(u, base).href; } catch { return u; } };
  return text.split(/\r?\n/).map(l => !l || l.startsWith('#') ? l.replace(/URI="([^"]+)"/g, (_, u) => 'URI="' + abs(u) + '"') : abs(l)).join('\n');
};
const cleanMedia = text => text.split(/\r?\n/).filter(l => !/^#EXT-X-(TWITCH-PREFETCH|DATERANGE|TWITCH-INFO|TWITCH-ELAPSED-SECS|TWITCH-TOTAL-SECS|SCTE35)/.test(l) && !/^#EXT-X-PROGRAM-DATE-TIME/.test(l)).join('\n');
const text = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });

async function playlist(target, origin, secret) { // liste de lecture d'une qualité : nettoyée, et ses morceaux repointés vers ce Worker
  const r = await fetch(target, { headers: { 'User-Agent': UA } }), t = await r.text();
  if (!r.ok || !t.startsWith('#EXTM3U')) return text(r.ok ? 502 : r.status, 'Flux indisponible');
  let body = cleanMedia(absolutize(t, target));
  if (/cloudfront/.test(target)) body = body.replace(/-unmuted/g, '-muted'); // rediffs réservées aux abonnés : seuls les morceaux « muted » sont ouverts
  const out = [];
  for (const l of body.split(/\r?\n/)) {
    if (/^#EXT-X-(MAP|KEY|PRELOAD-HINT):/.test(l)) {
      let line = l;
      for (const m of [...l.matchAll(/URI="(https?:[^"]+)"/g)]) line = line.replace(m[0], 'URI="' + origin + '/s/' + (await seal(m[1], secret)) + segExt(m[1]) + '"');
      out.push(line);
    } else out.push(/^https?:\/\//.test(l) ? origin + '/s/' + (await seal(l.trim(), secret)) + segExt(l) : l);
  }
  return new Response(out.join('\n'), { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', ...CORS } });
}

async function segment(req, target, ctx) { // morceau vidéo téléchargé en entier puis renvoyé avec sa taille exacte (Twitch l'envoie sans taille)
  const cache = typeof caches !== 'undefined' ? caches.default : null, key = new Request(target);
  let buf, type;
  try { const hit = cache && (await cache.match(key)); if (hit) { buf = await hit.arrayBuffer(); type = hit.headers.get('Content-Type'); } } catch { /* pas de cache : on télécharge */ }
  if (!buf) {
    const up = await fetch(target, { headers: { 'User-Agent': UA } });
    if (!up.ok) return text(up.status === 404 ? 404 : 502, 'Morceau indisponible');
    buf = await up.arrayBuffer(); type = up.headers.get('Content-Type') || 'application/octet-stream';
    // les spectateurs d'une même chaîne se partagent le morceau (cache de la zone Cloudflare ; ne marche que sur un domaine à toi, pas sur *.workers.dev)
    if (cache) ctx.waitUntil(cache.put(key, new Response(buf, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=120' } })).catch(() => {}));
  }
  const len = buf.byteLength, headers = { 'Content-Type': type || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...CORS };
  const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('Range') || '');
  if (rg && (rg[1] || rg[2])) {
    const s = rg[1] === '' ? Math.max(0, len - Number(rg[2])) : Number(rg[1]), e = rg[1] === '' || rg[2] === '' ? len - 1 : Math.min(Number(rg[2]), len - 1);
    if (s > e || s >= len) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': 'bytes */' + len } });
    return new Response(req.method === 'HEAD' ? null : buf.slice(s, e + 1), { status: 206, headers: { ...headers, 'Content-Range': 'bytes ' + s + '-' + e + '/' + len, 'Content-Length': String(e - s + 1) } });
  }
  return new Response(req.method === 'HEAD' ? null : buf, { status: 200, headers: { ...headers, 'Content-Length': String(len) } });
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Headers': 'Range' } });
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Méthode refusée');
    const url = new URL(req.url);
    if (url.pathname === '/') return text(200, 'TwitchIO · relais de morceaux vidéo' + (env.SECRET ? '' : ' · SECRET manquant'));
    const m = /^\/(m|s)\/([A-Za-z0-9_-]+)(?:\.[a-z0-9]{2,5})?$/.exec(url.pathname);
    if (!m || !env.SECRET) return text(404, 'Introuvable');
    const target = await open(m[2], env.SECRET);
    if (!target || !/^https:\/\//.test(target)) return text(400, 'Lien invalide');
    try { return m[1] === 'm' ? await playlist(target, url.origin, env.SECRET) : await segment(req, target, ctx); } catch (e) { return text(502, 'Erreur : ' + e.message); }
  },
};
