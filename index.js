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
  const q = new URLSearchParams({ sig: t.signature, token: t.value, allow_source: 'true', allow_audio_only: 'true', fast_bread: 'true', player: 'twitchweb', type: 'any', supported_codecs: 'avc1', p: String(Math.floor(Math.random() * 1e7)) });
  return 'https://usher.ttvnw.net/api/channel/hls/' + login + '.m3u8?' + q;
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
  return { url, qualities, status: r.status };
}

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
  catalogs: [{ type: 'tv', id: 'twitch-top', name: 'Twitch · Lives populaires' }],
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

    if (seg[0] === 'catalog' && seg[1] === 'tv') {
      let list = [];
      try { list = await helix('/streams', { first: 50 }); } catch (e) { console.error('catalogue :', e.message); } // sans identifiants : catalogue vide
      return json(res, { metas: list.map(metaOf) }, { 'Cache-Control': 'public, s-maxage=30' });
    }
    if (seg[0] === 'meta' && seg[1] === 'tv') {
      const login = strip(seg[2]).replace(/^twitch:/, '').toLowerCase();
      if (!LOGIN_RE.test(login)) return json(res, { meta: null });
      let meta = { id: 'twitch:' + login, type: 'tv', name: login };
      try { const s = (await helix('/streams', { user_login: login }))[0]; if (s) meta = metaOf(s); } catch { /* fiche minimale */ }
      return json(res, { meta });
    }
    if (seg[0] === 'stream' && seg[1] === 'tv') {
      const login = strip(seg[2]).replace(/^twitch:/, '').toLowerCase();
      if (!LOGIN_RE.test(login)) return json(res, { streams: [] });
      const s = await liveStream(login);
      if (s.offline) return json(res, { streams: [] });
      return json(res, { streams: [{ name: 'Twitch', title: 'En direct · qualité automatique' + (s.qualities.length ? '\n' + s.qualities.slice(0, 4).join(' · ') : ''), url: s.url, behaviorHints: { notWebReady: true } }] });
    }
    send(res, 404, 'text/plain; charset=utf-8', 'Introuvable');
  } catch (e) {
    console.error('requête :', e.message);
    if (!res.headersSent) json(res, { error: e.message });
  }
}

module.exports = handler;
module.exports.handler = handler;
module.exports._t = { liveStream, usherUrl, metaOf, MANIFEST };
if (require.main === module) http.createServer(handler).listen(PORT, () => console.log('Twitch pour Stremio sur http://localhost:' + PORT));
