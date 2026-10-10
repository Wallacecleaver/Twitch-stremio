'use strict';
/*
 * Twitch pour Stremio — étape 1 : base de l'addon + test de lecture depuis Vercel.
 *   /manifest.json            manifeste de l'addon
 *   /catalog/tv/<id>.json     « Lives populaires » (nécessite TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET)
 *   /meta/tv/twitch:<nom>.json  fiche d'une chaîne
 *   /stream/tv/twitch:<nom>.json  lien de lecture du live
 *   /test/<nom>               diagnostic : Vercel obtient-il bien le flux de cette chaîne ?
 */
const http = require('http');

const PORT = process.env.PORT || 7000;
const GQL = 'https://gql.twitch.tv/gql';
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // identifiant public du lecteur web de Twitch
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FAST_BREAD = process.env.FAST_BREAD === '1'; // faible latence : plus réactif mais moins stable sur certains lecteurs (PC)
const LOGIN_RE = /^[a-z0-9_]{3,25}$/;

const send = (res, code, type, body, h = {}) => { res.writeHead(code, { 'Content-Type': type, ...h }); res.end(body); };
const json = (res, o, h) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(o), { 'Cache-Control': 'no-store', ...h });

/* ------------------------------------------------------------------ lecture d'un live (méthode non officielle) */
const TOKEN_QUERY = 'query PlaybackAccessToken($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename } videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }';

async function accessToken(login) {
  const r = await fetch(GQL, {
    method: 'POST', headers: { 'Client-ID': GQL_CLIENT_ID, 'Content-Type': 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ operationName: 'PlaybackAccessToken', variables: { isLive: true, login, isVod: false, vodID: '', playerType: 'site' }, query: TOKEN_QUERY }),
  });
  if (!r.ok) throw new Error('Twitch (GQL) : HTTP ' + r.status);
  const j = await r.json().catch(() => ({}));
  const t = j && j.data && j.data.streamPlaybackAccessToken;
  if (!t || !t.value || !t.signature) throw new Error('Twitch n\'a pas fourni de jeton de lecture' + (j && j.errors ? ' : ' + String(j.errors[0] && j.errors[0].message).slice(0, 100) : ''));
  return t;
}
function usherUrl(login, t) {
  const q = new URLSearchParams({ sig: t.signature, token: t.value, allow_source: 'true', allow_audio_only: 'true', ...(FAST_BREAD ? { fast_bread: 'true' } : {}), player: 'twitchweb', type: 'any', supported_codecs: 'avc1', p: String(Math.floor(Math.random() * 1e7)) });
  return 'https://usher.ttvnw.net/api/channel/hls/' + login + '.m3u8?' + q;
}
// qualités individuelles d'une liste de lecture principale : [{ name, url }]
function variantsOf(txt) {
  const names = {}, variants = [], lines = String(txt).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-MEDIA')) {
      const g = (lines[i].match(/GROUP-ID="([^"]+)"/) || [])[1], n = (lines[i].match(/NAME="([^"]+)"/) || [])[1];
      if (g && n) names[g] = n;
    }
    if (lines[i].startsWith('#EXT-X-STREAM-INF') && /^https?:\/\//.test(lines[i + 1] || '')) {
      const g = (lines[i].match(/VIDEO="([^"]+)"/) || [])[1];
      variants.push({ name: (g && names[g]) || g || 'qualité', url: lines[i + 1].trim() });
    }
  }
  return variants;
}
// Retourne { url, qualities } si la chaîne est en direct, sinon { offline: true }
async function liveStream(login) {
  const t = await accessToken(login), url = usherUrl(login, t);
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (r.status === 404) return { offline: true, status: 404 };
  if (!r.ok) throw new Error('Twitch (usher) : HTTP ' + r.status);
  const txt = await r.text();
  if (!txt.startsWith('#EXTM3U')) throw new Error('Réponse de Twitch inattendue (pas une liste de lecture)');
  const qualities = [...txt.matchAll(/NAME="([^"]+)"/g)].map(m => m[1]);
  const variants = variantsOf(txt);
  return { url, qualities, variants, status: r.status };
}


/* ------------------------------------------------------------------ relais « sans pub » (variable PROXIES pour changer la liste) */
// Un relais renvoie la liste de lecture d'une chaîne depuis une autre région, où Twitch n'insère pas de publicité.
// Format de PROXIES : une adresse par ligne, avec {channel} (nom optionnel : « Nom | adresse »).
const Q = '?allow_source=true&allow_audio_only=true' + (FAST_BREAD ? '&fast_bread=true' : '');
const DEFAULT_PROXIES = [
  ['Luminous EU', 'https://eu.luminous.dev/live/{channel}'], ['Luminous EU 2', 'https://eu2.luminous.dev/live/{channel}'], ['Luminous EU 3', 'https://eu3.luminous.dev/live/{channel}'],
  ['Luminous AS', 'https://as.luminous.dev/live/{channel}'], ['Nadeko', 'https://twitch-al.nadeko.net/live/{channel}'],
  ['Perfprod EU', 'https://lb-eu.cdn-perfprod.com/live/{channel}'], ['Perfprod EU 2', 'https://lb-eu2.cdn-perfprod.com/live/{channel}'], ['Perfprod EU 3', 'https://lb-eu3.cdn-perfprod.com/live/{channel}'],
  ['Perfprod EU 4', 'https://lb-eu4.cdn-perfprod.com/live/{channel}'], ['Perfprod EU 5', 'https://lb-eu5.cdn-perfprod.com/live/{channel}'], ['Perfprod NA', 'https://lb-na.cdn-perfprod.com/live/{channel}'],
  ['Perfprod AS', 'https://lb-as.cdn-perfprod.com/live/{channel}'], ['Perfprod SA', 'https://lb-sa.cdn-perfprod.com/live/{channel}'],
].map(([name, url]) => ({ name, url: url + Q }));
function proxyList() {
  const env = String(process.env.PROXIES || '').split('\n').map(x => x.trim()).filter(Boolean);
  if (!env.length) return DEFAULT_PROXIES;
  return env.map((l, i) => { const [a, b] = l.includes('|') ? l.split('|').map(x => x.trim()) : ['Relais ' + (i + 1), l]; return { name: a, url: b }; }).filter(x => /^https:\/\/.+\{channel\}/.test(x.url));
}
const PROXY_TIMEOUT = 2500;
const isMaster = t => typeof t === 'string' && t.startsWith('#EXTM3U') && /#EXT-X-STREAM-INF/.test(t);
async function askProxy(px, login, signal) {
  const t0 = Date.now(), url = px.url.replace('{channel}', login);
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), PROXY_TIMEOUT);
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal, redirect: 'follow' });
    const text = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!isMaster(text)) throw new Error('réponse inattendue');
    return { name: px.name, url, text, ms: Date.now() - t0 };
  } catch (e) { throw Object.assign(new Error(e.name === 'AbortError' ? 'délai dépassé' : e.message), { ms: Date.now() - t0, proxy: px.name }); }
  finally { clearTimeout(timer); }
}
const proxyCache = new Map();
async function bestProxy(login) { // le relais valide le plus rapide (les autres requêtes sont annulées)
  const c = proxyCache.get(login);
  if (c && c.exp > Date.now()) return c.v;
  const all = new AbortController();
  let v = null;
  try { v = await Promise.any(proxyList().map(px => askProxy(px, login, all.signal))); } catch { v = null; }
  all.abort();
  if (proxyCache.size > 200) proxyCache.clear();
  proxyCache.set(login, { v, exp: Date.now() + (v ? 15000 : 5000) });
  return v;
}
// adresses relatives de la liste de lecture -> absolues (le lecteur ne contacte alors jamais le relais lui-même)
function absolutize(text, base) {
  const abs = u => { try { return new URL(u, base).href; } catch { return u; } };
  return text.split(/\r?\n/).map(l => !l || l.startsWith('#') ? l.replace(/URI="([^"]+)"/g, (_, u) => 'URI="' + abs(u) + '"') : abs(l)).join('\n');
}
const originOf = req => 'https://' + String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();

/* ------------------------------------------------------------------ API officielle (catalogues) */
let app = null;
async function appToken() {
  const id = process.env.TWITCH_CLIENT_ID, secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (app && app.exp > Date.now()) return app;
  const r = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Twitch : identifiants refusés (vérifiez TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET)');
  app = { id, token: j.access_token, exp: Date.now() + (j.expires_in - 3600) * 1000 };
  return app;
}
async function helix(path, qs) {
  const a = await appToken();
  if (!a) throw new Error('Variables TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET non définies');
  const u = new URL('https://api.twitch.tv/helix' + path); Object.entries(qs || {}).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { headers: { 'Client-Id': a.id, Authorization: 'Bearer ' + a.token }, signal: AbortSignal.timeout(10000) });
  if (r.status === 401) { app = null; throw new Error('Twitch : jeton refusé, réessayez'); }
  if (!r.ok) throw new Error('Twitch (API) : HTTP ' + r.status);
  return (await r.json()).data || [];
}
const thumb = u => String(u || '').replace('{width}', '440').replace('{height}', '248');
const metaOf = s => ({
  id: 'twitch:' + s.user_login, type: 'tv', name: s.user_name, poster: thumb(s.thumbnail_url), posterShape: 'landscape', background: thumb(s.thumbnail_url),
  description: s.title + '\n\n🎮 ' + s.game_name + ' · 👁 ' + s.viewer_count + ' spectateurs', genres: s.game_name ? [s.game_name] : [], releaseInfo: 'EN DIRECT',
});

/* ------------------------------------------------------------------ addon */
const MANIFEST = {
  id: 'community.twitch.lives', version: '0.1.0', name: 'Twitch', description: 'Lives Twitch dans Stremio',
  resources: ['catalog', 'meta', 'stream'], types: ['tv'], idPrefixes: ['twitch:'],
  catalogs: [{ type: 'tv', id: 'twitch-top', name: 'Twitch · Lives populaires', extra: [{ name: 'search', isRequired: false }] }],
};

async function handler(req, res) {
  try {
    const seg = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const strip = s => String(s || '').replace(/\.json$/, '');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (!seg.length) return send(res, 200, 'text/plain; charset=utf-8', 'Addon Twitch pour Stremio. Manifeste : /manifest.json — test : /test/<nom d\'un streamer en live>');
    if (seg[0] === 'manifest.json') return json(res, MANIFEST);

    if (seg[0] === 'test' && seg[1]) { // diagnostic lisible
      const login = seg[1].toLowerCase(), out = { chaine: login, vercel_peut_lire_twitch: false };
      if (!LOGIN_RE.test(login)) { out.erreur = 'nom de chaîne invalide'; return json(res, out); }
      try {
        const s = await liveStream(login);
        if (s.offline) { out.resultat = 'La chaîne est hors ligne (le test doit se faire sur un streamer en direct).'; out.vercel_peut_lire_twitch = null; }
        else { out.vercel_peut_lire_twitch = true; out.resultat = 'OK : Twitch fournit le flux à ce serveur.'; out.qualites = s.qualities; out.lien_de_lecture = s.url; }
      } catch (e) { out.erreur = e.message; }
      return json(res, out);
    }

    if (seg[0] === 'p' && seg[1]) { // liste de lecture « sans pub » : récupérée côté serveur auprès d'un relais, puis servie au lecteur
      const login = strip(seg[1]).replace(/\.m3u8$/, '').toLowerCase();
      if (!LOGIN_RE.test(login)) return send(res, 400, 'text/plain; charset=utf-8', 'Nom de chaîne invalide');
      const b = await bestProxy(login);
      if (b) return send(res, 200, 'application/vnd.apple.mpegurl', absolutize(b.text, b.url), { 'Cache-Control': 'no-store', 'X-Relais': b.name });
      const s = await liveStream(login); // aucun relais n'a répondu : repli sur le flux officiel
      if (s.offline) return send(res, 404, 'text/plain; charset=utf-8', 'Chaîne hors ligne');
      return send(res, 302, 'text/plain; charset=utf-8', 'Redirection', { Location: s.url, 'Cache-Control': 'no-store' });
    }
    if (seg[0] === 'relais' && seg[1]) { // diagnostic : quels relais répondent depuis Vercel ?
      const login = seg[1].toLowerCase();
      if (!LOGIN_RE.test(login)) return json(res, { erreur: 'nom de chaîne invalide' });
      const inspect = async r => { // où sont les segments, et y a-t-il des pubs dans la liste de lecture ?
        const v = variantsOf(absolutize(r.text, r.url)).filter(x => !/audio/i.test(x.name)).pop();
        if (!v) return {};
        try {
          const pr = await fetch(v.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(3000) }), t = await pr.text();
          const seg = t.split(/\r?\n/).find(l => /^https?:\/\//.test(l));
          return { qualite_testee: v.name, liste_http: pr.status, hote_liste: new URL(v.url).hostname, hote_segments: seg ? new URL(seg).hostname : null, pubs_detectees: /stitched|X-TV-TWITCH-AD|SCTE35|CUE-OUT/i.test(t) };
        } catch (e) { return { qualite_testee: v.name, liste_erreur: e.message }; }
      };
      const rows = await Promise.all(proxyList().map(px => askProxy(px, login).then(async r => ({ relais: px.name, ok: true, ms: r.ms, ...(await inspect(r)) }), e => ({ relais: px.name, ok: false, ms: e.ms, erreur: e.message }))));
      const direct = await liveStream(login).then(async d => d.offline ? { hors_ligne: true } : { officiel: await inspect({ text: await fetch(d.url, { headers: { 'User-Agent': UA } }).then(x => x.text()), url: d.url }) }, e => ({ officiel_erreur: e.message }));
      return json(res, { chaine: login, relais_valides: rows.filter(r => r.ok).length, sur: rows.length, flux_officiel: direct, detail: rows.filter(r => r.ok).concat(rows.filter(r => !r.ok).map(r => ({ relais: r.relais, ok: false, erreur: r.erreur }))) });
    }
    if (seg[0] === 'catalog' && seg[1] === 'tv') {
      const search = seg[3] ? (new URLSearchParams(strip(seg[3])).get('search') || '').trim().toLowerCase().replace(/^@/, '') : '';
      if (search) { // recherche d'une chaîne par son nom (sans clés Twitch) : la fiche s'ouvre, puis le live se lance
        if (!LOGIN_RE.test(search)) return json(res, { metas: [] });
        let meta = { id: 'twitch:' + search, type: 'tv', name: search, poster: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_' + search + '-440x248.jpg', posterShape: 'landscape' };
        try { const s = (await helix('/streams', { user_login: search }))[0]; if (s) meta = metaOf(s); } catch { /* sans clés : fiche simple */ }
        return json(res, { metas: [meta] });
      }
      let list = [];
      try { list = await helix('/streams', { first: 50 }); } catch (e) { console.error('catalogue :', e.message); } // sans identifiants : catalogue vide
      return json(res, { metas: list.map(metaOf) }, { 'Cache-Control': 'public, s-maxage=30' });
    }
    if (seg[0] === 'meta' && seg[1] === 'tv') {
      const login = strip(seg[2]).replace(/^twitch:/, '').toLowerCase();
      if (!LOGIN_RE.test(login)) return json(res, { meta: null });
      let meta = { id: 'twitch:' + login, type: 'tv', name: login, poster: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_' + login + '-440x248.jpg', posterShape: 'landscape' };
      try { const s = (await helix('/streams', { user_login: login }))[0]; if (s) meta = metaOf(s); } catch { /* fiche minimale */ }
      return json(res, { meta });
    }
    if (seg[0] === 'stream' && seg[1] === 'tv') {
      const login = strip(seg[2]).replace(/^twitch:/, '').toLowerCase();
      if (!LOGIN_RE.test(login)) return json(res, { streams: [] });
      const [s, b] = await Promise.all([liveStream(login), bestProxy(login)]);
      if (s.offline) return json(res, { streams: [] });
      // Un relais répond : tous les flux passent par lui (sans pub). Sinon : flux officiel.
      const vars = b ? variantsOf(absolutize(b.text, b.url)) : s.variants;
      const fixed = vars.filter(v => !/audio/i.test(v.name)).slice(0, 4).map(v => ({ name: 'Twitch ' + v.name.replace(/ \(source\)/, ''), title: 'En direct · qualité fixe' + (b ? ' · sans pub' : ''), url: v.url }));
      const auto = { name: 'Twitch', title: 'En direct · qualité automatique' + (b ? ' · sans pub' : ''), url: b ? originOf(req) + '/p/' + login + '.m3u8' : s.url };
      return json(res, { streams: [auto, ...fixed] });
    }
    send(res, 404, 'text/plain; charset=utf-8', 'Introuvable');
  } catch (e) {
    console.error('requête :', e.message);
    if (!res.headersSent) json(res, { error: e.message });
  }
}

module.exports = handler;
module.exports.handler = handler;
module.exports._t = { liveStream, usherUrl, metaOf, MANIFEST, absolutize, proxyList, bestProxy };
if (require.main === module) http.createServer(handler).listen(PORT, () => console.log('Twitch pour Stremio sur http://localhost:' + PORT));
