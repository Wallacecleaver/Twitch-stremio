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
const store = require('./lib/store');
const makeAdmin = require('./lib/admin');
const cfgLib = require('./lib/settings');
const fs = require('fs');
const path = require('path');

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

async function accessToken(login, playerType = 'site', clientId = GQL_CLIENT_ID) {
  const r = await fetch(GQL, {
    method: 'POST', headers: { 'Client-ID': clientId, 'Content-Type': 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ operationName: 'PlaybackAccessToken', variables: { isLive: true, login, isVod: false, vodID: '', playerType }, query: TOKEN_QUERY }),
  });
  if (!r.ok) throw new Error('Twitch (GQL) : HTTP ' + r.status);
  const j = await r.json().catch(() => ({}));
  const t = j && j.data && j.data.streamPlaybackAccessToken;
  if (!t || !t.value || !t.signature) throw new Error('Twitch n\'a pas fourni de jeton de lecture' + (j && j.errors ? ' : ' + String(j.errors[0] && j.errors[0].message).slice(0, 100) : ''));
  return t;
}
// Variantes de demande à Twitch pour obtenir les qualités HEVC / AV1 (1440p et plus) : on les essaie toutes et on garde la meilleure.
const WEB = { platform: 'web', player_backend: 'mediaplayer', playlist_include_framerate: 'true', reassignments_supported: 'true', transcode_mode: 'cbr_v1' };
const TV_ID = 'ue6666qo983tsx6so1t0vnawi233wa', ANDROID_ID = 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp'; // identifiants publics des applications Twitch TV et Android
// copie de la demande du lecteur web de Twitch (relevée dans Chrome) : adresse /api/v2/, include_unavailable, acmb, etc.
const hex = n => [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
const WEBV2 = (codecs, unavailable = true) => login => ({
  acmb: Buffer.from(JSON.stringify({ AppVersion: '76ac281a-9974-467d-bf30-ba2ea81eec47', ClientApp: 'twilight', URL: 'https://www.twitch.tv/' + login })).toString('base64'),
  browser_family: 'chrome', browser_version: '155.0', cdm: 'wv', enable_score: 'true', ...(unavailable ? { include_unavailable: 'true' } : {}), lang: 'fr', os_name: 'Windows', os_version: 'NT 10.0',
  platform: 'web', play_session_id: hex(32), player_backend: 'mediaplayer', player_version: '1.57.0-rc.2', playlist_include_framerate: 'true', reassignments_supported: 'true', supported_codecs: codecs, transcode_mode: 'cbr_v1',
});
const HEVC_TRIES = [
  { tok: 'site', v2: true, q: WEBV2('av1,h265,h264') },
  { tok: 'site', v2: true, q: WEBV2('h265,h264') },
  { tok: 'site', v2: true, q: WEBV2('av1,h265,h264', false) },
  { tok: 'site', q: { supported_codecs: 'av1,h265,h264', ...WEB } },
  { tok: 'site', q: { supported_codecs: 'h265,h264', ...WEB } },
  { tok: 'site', q: { supported_codecs: 'av1,h264', ...WEB } },
  { tok: 'site', q: { supported_codecs: 'av1,h265,h264' } },
  { tok: 'site', q: { supported_codecs: 'av01,hev1,avc1' } },
  { tok: 'site', q: { supported_codecs: 'hev1,avc1' } },
  { tok: 'embed', q: { supported_codecs: 'av1,h265,h264', ...WEB } },
  { tok: 'popout', q: { supported_codecs: 'av1,h265,h264', ...WEB } },
  { tok: 'site', cid: TV_ID, q: { supported_codecs: 'av1,h265,h264', ...WEB } },
  { tok: 'site', cid: TV_ID, q: { supported_codecs: 'h265,h264' } },
  { tok: 'site', cid: ANDROID_ID, q: { supported_codecs: 'av1,h265,h264', ...WEB } },
  { tok: 'site', cid: ANDROID_ID, q: { supported_codecs: 'h265,h264' } },
];
function usherUrl(login, t, extra, v2) {
  const q = new URLSearchParams({ sig: t.signature, token: t.value, allow_source: 'true', allow_audio_only: 'true', ...(FAST_BREAD ? { fast_bread: 'true' } : {}), player: 'twitchweb', type: 'any', supported_codecs: 'avc1', p: String(Math.floor(Math.random() * 1e7)), ...(extra || {}) });
  return 'https://usher.ttvnw.net/api/' + (v2 ? 'v2/' : '') + 'channel/hls/' + login + '.m3u8?' + q;
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
      const L = lines[i], g = (L.match(/VIDEO="([^"]+)"/) || [])[1], res = L.match(/RESOLUTION=(\d+)x(\d+)/), fr = L.match(/FRAME-RATE=([\d.]+)/), bw = L.match(/(?:^|[:,])BANDWIDTH=(\d+)/);
      const h = res ? Number(res[2]) : 0, fps = fr ? Math.round(Number(fr[1])) : 0;
      let name = (g && names[g]) || '';
      const audio = /audio_only/i.test(g || '') || /audio/i.test(name) || (!res && /audio/i.test(L));
      if (audio) name = 'Audio seul';
      else if (!/\d{3,4}p/.test(name)) name = h ? h + 'p' + (fps > 30 ? fps : '') : (g && g !== 'chunked' ? g : bw ? (Number(bw[1]) / 1e6).toFixed(1) + ' Mb/s' : 'Source');
      variants.push({ name, url: lines[i + 1].trim(), h, fps, audio });
    }
  }
  return variants;
}
// Retourne { url, qualities } si la chaîne est en direct, sinon { offline: true }
const hevcCache = new Map();
async function liveStream(login, hevc) {
  if (!hevc) return liveOnce(login, 'site', null);
  const c = hevcCache.get(login);
  if (c && c.exp > Date.now()) return c.v;
  const tokens = {};
  const res = await Promise.allSettled(HEVC_TRIES.map(async (t, i) => {
    const key = t.tok + (t.cid || ''), tk = await (tokens[key] ||= accessToken(login, t.tok, t.cid));
    const r = await liveOnce(login, t.tok, typeof t.q === 'function' ? t.q(login) : t.q, tk, t.v2);
    return { i, r };
  }));
  const ok = res.filter(x => x.status === 'fulfilled').map(x => x.value);
  const tries = res.map((x, i) => x.status === 'fulfilled' ? (x.value.r.offline ? 'hors ligne' : Math.max(0, ...x.value.r.variants.map(v => v.h)) + 'p') : 'échec (' + String(x.reason && x.reason.message).slice(0, 40) + ')');
  if (!ok.length) throw res[0].reason;
  let best = ok.find(x => x.r.offline) && ok.every(x => x.r.offline) ? ok[0].r : null;
  if (!best) { const live = ok.filter(x => !x.r.offline).sort((a, b) => Math.max(0, ...b.r.variants.map(v => v.h)) - Math.max(0, ...a.r.variants.map(v => v.h)) || a.i - b.i); best = live[0] ? { ...live[0].r, essai: live[0].i + 1 } : ok[0].r; }
  best.essais = tries;
  if (hevcCache.size > 100) hevcCache.clear();
  hevcCache.set(login, { v: best, exp: Date.now() + 20000 });
  return best;
}
async function liveOnce(login, tokType, extra, tok, v2) {
  const t = tok || await accessToken(login, tokType), url = usherUrl(login, t, extra, v2);
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (r.status === 404) return { offline: true, status: 404 };
  if (!r.ok) throw new Error('Twitch (usher) : HTTP ' + r.status);
  const txt = await r.text();
  if (!txt.startsWith('#EXTM3U')) throw new Error('Réponse de Twitch inattendue (pas une liste de lecture)');
  const qualities = [...txt.matchAll(/NAME="([^"]+)"/g)].map(m => m[1]);
  const variants = variantsOf(txt);
  return { url, qualities, variants, text: txt, status: r.status };
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
async function askProxy(px, login, signal, hevc) {
  const t0 = Date.now(), url = px.url.replace('{channel}', login) + (hevc ? (px.url.includes('?') ? '&' : '?') + 'supported_codecs=av1,h265,h264' : '');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), PROXY_TIMEOUT);
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal, redirect: 'follow' });
    const text = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!isMaster(text)) throw new Error('réponse inattendue');
    store.incr('r|' + px.name + '|ok'); store.incr('r|' + px.name + '|ms', Date.now() - t0);
    return { name: px.name, url, text, ms: Date.now() - t0 };
  } catch (e) { if (!(signal && signal.aborted)) store.incr('r|' + px.name + '|fail'); throw Object.assign(new Error(e.name === 'AbortError' ? 'délai dépassé' : e.message), { ms: Date.now() - t0, proxy: px.name }); }
  finally { clearTimeout(timer); }
}
async function relayReport(login) {
  if (!LOGIN_RE.test(login)) return { erreur: 'nom de chaîne invalide' };
  const inspect = async r => { // où sont les segments, et y a-t-il des pubs dans la liste de lecture ?
    const v = variantsOf(absolutize(r.text, r.url)).filter(x => !x.audio).pop();
    if (!v) return {};
    try {
  const pr = await fetch(v.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(3000) }), t = await pr.text();
  const seg = t.split(/\r?\n/).find(l => /^https?:\/\//.test(l));
  return { qualite_testee: v.name, liste_http: pr.status, hote_liste: new URL(v.url).hostname, hote_segments: seg ? new URL(seg).hostname : null, pubs_detectees: /stitched|X-TV-TWITCH-AD|SCTE35|CUE-OUT/i.test(t) };
    } catch (e) { return { qualite_testee: v.name, liste_erreur: e.message }; }
  };
  const rows = await Promise.all(proxyList().map(px => askProxy(px, login).then(async r => ({ relais: px.name, ok: true, ms: r.ms, ...(await inspect(r)) }), e => ({ relais: px.name, ok: false, ms: e.ms, erreur: e.message }))));
  const direct = await liveStream(login).then(async d => d.offline ? { hors_ligne: true } : { officiel: await inspect({ text: await fetch(d.url, { headers: { 'User-Agent': UA } }).then(x => x.text()), url: d.url }) }, e => ({ officiel_erreur: e.message }));
  return { chaine: login, relais_valides: rows.filter(r => r.ok).length, sur: rows.length, flux_officiel: direct, detail: rows.filter(r => r.ok).concat(rows.filter(r => !r.ok).map(r => ({ relais: r.relais, ok: false, erreur: r.erreur }))) };
}
const proxyCache = new Map();
async function bestProxy(login, hevc) { // le relais valide le plus rapide (les autres requêtes sont annulées)
  const key = login + (hevc ? '+' : ''), c = proxyCache.get(key);
  if (c && c.exp > Date.now()) return c.v;
  const all = new AbortController();
  let v = null;
  try { v = await Promise.any(proxyList().map(px => askProxy(px, login, all.signal, hevc))); } catch { v = null; }
  all.abort();
  if (v) store.incr('r|' + v.name + '|win');
  if (proxyCache.size > 200) proxyCache.clear();
  proxyCache.set(key, { v, exp: Date.now() + (v ? 15000 : 5000) });
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

async function probe(login) { // diagnostic d'une chaîne pour le dashboard
  if (!LOGIN_RE.test(login)) return { erreur: 'nom de chaîne invalide' };
  const out = { chaine: login }, t0 = Date.now();
  try {
    const s = await liveStream(login);
    out.twitch = s.offline ? 'hors ligne' : 'en direct';
    if (!s.offline) out.qualites = s.qualities;
    out.twitch_ms = Date.now() - t0;
    const b = await bestProxy(login);
    out.relais = b ? { nom: b.name, ms: b.ms } : 'aucun relais ne répond (repli sur le flux officiel)';
  } catch (e) { out.erreur = e.message; }
  return out;
}
const mask = v => v ? 'défini' : 'absent';
const adminRoute = makeAdmin({ send, json, relayReport, probe, check: (login, c, u) => checkStream(login, cfgLib.normalize(c || {}), u || 'admin', 'admin'), config: () => ({
  relais: proxyList(),
  rows: [
    ['Version', require('./package.json').version, null],
    ['Stockage persistant (Upstash)', store.persistent ? 'actif' : 'mémoire temporaire', store.persistent],
    ['TWITCH_CLIENT_ID', mask(process.env.TWITCH_CLIENT_ID), !!process.env.TWITCH_CLIENT_ID],
    ['TWITCH_CLIENT_SECRET', mask(process.env.TWITCH_CLIENT_SECRET), !!process.env.TWITCH_CLIENT_SECRET],
    ['Catalogue « Lives populaires »', process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET ? 'disponible' : 'vide (clés Twitch manquantes)', !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET)],
    ['Relais configurés', String(proxyList().length) + (process.env.PROXIES ? ' (variable PROXIES)' : ' (liste par défaut)'), null],
    ['Faible latence (FAST_BREAD)', FAST_BREAD ? 'activée' : 'désactivée', null],
    ['Délai relais', PROXY_TIMEOUT + ' ms', null],
  ] }) });

// Le relais ne transmet pas toujours la demande HEVC/AV1 : les qualités plus hautes que les siennes (ex. 1440p) viennent alors du flux officiel.
function mergedMaster(b, live, cfg) {
  const text = absolutize(b.text, b.url);
  if (!cfg.hevc || !live || !live.text) return text;
  const maxH = Math.max(0, ...variantsOf(text).filter(v => !v.audio).map(v => v.h));
  const L = live.text.split(/\r?\n/), extra = [];
  for (let i = 0; i < L.length; i++) if (L[i].startsWith('#EXT-X-STREAM-INF') && /^https?:\/\//.test(L[i + 1] || '')) { const h = Number((L[i].match(/RESOLUTION=\d+x(\d+)/) || [])[1] || 0); if (h > maxH) extra.push(L[i], L[i + 1]); }
  if (!extra.length) return text;
  const lines = text.split(/\r?\n/), k = lines.findIndex(l => l.startsWith('#EXT-X-STREAM-INF'));
  lines.splice(k < 0 ? lines.length : k, 0, ...extra);
  return lines.join('\n');
}
const byQuality = (a, b) => (b.h - a.h) || (b.fps - a.fps);

const pageCache = {};
const page = name => pageCache[name] ||= fs.readFileSync(path.join(__dirname, 'lib', 'pages', name), 'utf8');
const summary = c => [c.cap ? 'max ' + c.cap + 'p' : 'qualité max', c.fps60 ? '60 i/s' : '30 i/s', c.relay ? 'relais' : 'sans relais', c.fixed + ' fixes', c.hevc ? '1440p' : '', c.audio ? 'audio' : ''].filter(Boolean).join(' · ');
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 8000) req.destroy(); }); req.on('end', () => r(b)); req.on('error', () => r(b)); });
const text = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, n);
const hits = new Map(); // limite : 40 signalements / test par minute et par adresse
const tooMany = req => { const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x', n = (hits.get(ip) || 0) + 1; hits.set(ip, n); if (hits.size > 500) hits.clear(); setTimeout(() => hits.delete(ip), 60000).unref?.(); return n > 40; };

// signalement envoyé par le lecteur de test (blocage, erreur…) ou à la main : il apparaît dans le journal
async function report(req, dev) {
  if (tooMany(req)) return { ok: false, error: 'trop de demandes' };
  let b = {}; try { b = JSON.parse(await readBody(req)); } catch { return { ok: false, error: 'requête invalide' }; }
  const u = cfgLib.cleanPseudo(b.pseudo), ch = text(b.ch, 25).toLowerCase(), type = ['blocage', 'erreur', 'fatal', 'lenteur', 'note', 'info'].includes(b.type) ? b.type : 'note';
  const lvl = type === 'info' ? 'INFO' : type === 'fatal' || type === 'erreur' ? 'ERROR' : 'WARN';
  const row = { k: 'incident', lvl, u: u || undefined, ch: ch || undefined, type, detail: text(b.detail, 300), appareil: text(b.device, 24) || undefined, source: text(b.source, 12) || 'navigateur', dev };
  if (b.stats && typeof b.stats === 'object') for (const k of ['arrets', 'arret_ms', 'images_perdues', 'qualite', 'tampon_s', 'debit_kbps']) if (b.stats[k] !== undefined) row[k] = text(b.stats[k], 20);
  if (type !== 'info') { store.incr('incident'); store.incr('d:' + store.day() + ':incident'); store.user(u, { incident: true }); }
  store.log(row);
  return { ok: true };
}

// vérification côté serveur : la liste de lecture avance-t-elle ? les segments se téléchargent-ils assez vite ? des pubs ?
async function checkStream(login, c, u, dev) {
  if (!LOGIN_RE.test(login)) return { verdict: 'erreur', erreur: 'nom de chaîne invalide' };
  const out = { chaine: login, verdict: 'ok', etapes: [], pseudo: u || undefined }, t0 = Date.now();
  const step = (nom, ok, detail) => out.etapes.push({ nom, ok, detail, ms: Date.now() - t0 });
  const finish = (verdict, resume, extra = {}) => {
    out.verdict = verdict; out.resume = resume;
    const lvl = verdict === 'ok' ? 'INFO' : verdict === 'lent' || verdict === 'hors ligne' ? 'WARN' : 'ERROR';
    if (verdict !== 'ok' && verdict !== 'hors ligne') { store.incr('incident'); store.incr('d:' + store.day() + ':incident'); store.user(u, { incident: true }); }
    store.log({ k: 'test', lvl, u: u || undefined, ch: login, verdict, resume, ...extra, appareil: c.device || undefined, dev });
    return out;
  };
  let live;
  try { live = await liveStream(login, c.hevc); } catch (e) { step('Twitch', false, e.message); return finish('erreur', 'Twitch ne répond pas : ' + e.message); }
  if (live.offline) { step('Twitch', true, 'chaîne hors ligne'); return finish('hors ligne', 'La chaîne n\'est pas en direct, rien à tester.'); }
  step('Twitch', true, live.variants.length + ' qualités');
  const b = c.relay ? await bestProxy(login, c.hevc) : null;
  step('Relais', !!b || !c.relay, b ? b.name + ' (' + b.ms + ' ms)' : c.relay ? 'aucun relais ne répond, flux officiel utilisé' : 'désactivés dans tes réglages');
  step('Qualités (officiel)', true, live.variants.filter(v => !v.audio).sort(byQuality).map(v => v.name).join(', ') || 'aucune');
  if (live.essais) step('Essais 1440p', live.essais.some(x => /^(14|21|28|43)\d\dp$/.test(x)), 'meilleure demande : n°' + (live.essai || '–') + ' · ' + live.essais.map((x, i) => (i + 1) + '=' + x).join(', '));
  if (b) step('Qualités (relais)', true, variantsOf(absolutize(b.text, b.url)).filter(v => !v.audio).sort(byQuality).map(v => v.name).join(', '));
  let mtxt;
  try { mtxt = b ? mergedMaster(b, live, c) : await fetch(live.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }).then(r => r.text()); } catch (e) { step('Liste principale', false, e.message); return finish('bloque', 'Impossible de lire la liste de lecture : ' + e.message); }
  const vars = variantsOf(cfgLib.filterMaster(mtxt, c)).filter(v => !v.audio).sort(byQuality);
  const v = vars[0];
  if (!v) { step('Qualité', false, 'aucune qualité disponible avec tes réglages'); return finish('erreur', 'Aucune qualité ne correspond à ton plafond.'); }
  step('Qualité testée', true, v.name);
  const seqs = [], polls = [];
  let last = null, ads = false, host = '';
  const rd = async () => {
    const t = Date.now();
    const r = await fetch(v.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) });
    const txt = await r.text();
    if (!r.ok) throw new Error('liste HTTP ' + r.status);
    const seq = Number((txt.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] || 0), L = txt.split(/\r?\n/), segs = [];
    for (let i = 0; i < L.length; i++) if (L[i].startsWith('#EXTINF:') && /^https?:\/\//.test(L[i + 1] || '')) segs.push({ dur: parseFloat(L[i].slice(8)) || 2, url: L[i + 1].trim() });
    if (/stitched|X-TV-TWITCH-AD|SCTE35|CUE-OUT/i.test(txt)) ads = true;
    seqs.push(seq + segs.length); polls.push(Date.now() - t); last = segs[segs.length - 1] || last;
    if (last) host = new URL(last.url).hostname;
  };
  try { await rd(); await new Promise(r => setTimeout(r, 2500)); await rd(); await new Promise(r => setTimeout(r, 2500)); await rd(); }
  catch (e) { step('Liste de lecture', false, e.message); return finish('bloque', 'La liste de lecture ne répond pas : ' + e.message); }
  const avance = seqs[seqs.length - 1] - seqs[0], pollMs = Math.round(polls.reduce((a, x) => a + x, 0) / polls.length);
  step('Liste de lecture', avance > 0, avance > 0 ? '+' + avance + ' segments en 5 s · ' + pollMs + ' ms par appel' : 'la liste ne bouge plus (flux figé)');
  if (!last) return finish('erreur', 'Aucun segment dans la liste de lecture.');
  let dl = null;
  try {
    const t = Date.now(), r = await fetch(last.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }), buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok) throw new Error('segment HTTP ' + r.status);
    dl = { ms: Date.now() - t, octets: buf.length };
  } catch (e) { step('Segment', false, e.message); return finish('bloque', 'Le segment vidéo ne se télécharge pas : ' + e.message, { hote: host }); }
  const ratio = dl.ms / (last.dur * 1000), kbps = Math.round(dl.octets * 8 / 1000 / (dl.ms / 1000));
  step('Segment', ratio < 1, dl.ms + ' ms pour ' + last.dur.toFixed(1) + ' s de vidéo (' + Math.round(dl.octets / 1024) + ' Ko, ' + kbps + ' kb/s) · hôte ' + host);
  if (ads) step('Publicité', false, 'marqueurs de pub détectés dans la liste');
  const extra = { qualite: v.name, hote: host, segment_ms: dl.ms, duree_s: last.dur, debit_kbps: kbps, pubs: ads || undefined };
  if (avance <= 0) return finish('bloque', 'Le flux est figé : la liste de lecture n\'avance pas.', extra);
  if (ratio >= 1) return finish('bloque', 'Les segments arrivent plus lentement qu\'ils ne se lisent (' + dl.ms + ' ms pour ' + last.dur.toFixed(1) + ' s) : coupures probables.', extra);
  if (ratio >= .6 || ads) return finish('lent', ads ? 'Des pubs sont présentes dans ce flux.' : 'Les segments arrivent juste à temps (' + dl.ms + ' ms pour ' + last.dur.toFixed(1) + ' s) : risque de saccades.', extra);
  return finish('ok', 'Flux sain : segments en ' + dl.ms + ' ms pour ' + last.dur.toFixed(1) + ' s de vidéo.', extra);
}

async function handler(req, res) {
  let pseudo = '';
  try {
    let seg = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).map(decodeURIComponent);
    // adresse personnelle : /c/<pseudo>/<réglages>/... (le pseudo et les réglages voyagent dans l'adresse)
    let cfg = cfgLib.DEFAULTS, base = '';
    if (seg[0] === 'c' && seg.length >= 3) { pseudo = cfgLib.cleanPseudo(seg[1]); cfg = cfgLib.decode(seg[2]) || cfgLib.DEFAULTS; base = '/c/' + encodeURIComponent(seg[1]) + '/' + seg[2]; seg = seg.slice(3); }
    const strip = s => String(s || '').replace(/\.json$/, '');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (await adminRoute(req, res, seg)) return;
    // statistiques : on attend leur enregistrement avant de répondre (Vercel coupe le travail après la réponse)
    const end = res.end.bind(res);
    res.end = (...a) => { store.flush().finally(() => end(...a)); return res; };
    const t0 = Date.now(), dev = store.deviceId(req);
    store.incr('req'); store.incr('d:' + store.day() + ':req');
    if (['stream', 'catalog', 'p', 'manifest.json'].includes(seg[0])) store.uniq(dev);

    if (!seg.length) return send(res, 302, 'text/plain', '', { Location: '/config' });
    if (seg[0] === 'config') return send(res, 200, 'text/html; charset=utf-8', page('config.html'), { 'Cache-Control': 'no-cache' });
    if (seg[0] === 'api' && seg[1] === 'report' && req.method === 'POST') return json(res, await report(req, dev));
    if (seg[0] === 'api' && seg[1] === 'check') return json(res, await checkStream(String(new URL(req.url, 'http://x').searchParams.get('channel') || '').toLowerCase().replace(/^@/, ''), cfg, pseudo, dev));
    if (seg[0] === 'manifest.json') {
      store.log({ k: 'install', u: pseudo || undefined, appareil: cfg.device || undefined, reglages: pseudo ? summary(cfg) : 'défaut', dev }); store.user(pseudo, { cfg, dev: cfg.device });
      return json(res, pseudo ? { ...MANIFEST, name: 'Twitch · ' + pseudo, description: MANIFEST.description + ' — profil de ' + pseudo } : MANIFEST);
    }

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
      const [b, lv] = await Promise.all([cfg.relay ? bestProxy(login, cfg.hevc) : null, cfg.hevc && cfg.relay ? liveStream(login, true).catch(() => null) : null]);
      store.incr('play'); store.top(login); store.user(pseudo, { ch: login, dev: cfg.device });
      store.log({ k: 'play', u: pseudo || undefined, ch: login, relais: b ? b.name : cfg.relay ? 'officiel (repli)' : 'officiel (relais coupés)', ms: Date.now() - t0, appareil: cfg.device || undefined, dev });
      if (b) return send(res, 200, 'application/vnd.apple.mpegurl', cfgLib.filterMaster(mergedMaster(b, lv, cfg), cfg), { 'Cache-Control': 'no-store', 'X-Relais': b.name });
      const s = await liveStream(login, cfg.hevc); // aucun relais : flux officiel, servi par nous pour appliquer le plafond de qualité
      if (s.offline) return send(res, 404, 'text/plain; charset=utf-8', 'Chaîne hors ligne');
      const o = await fetch(s.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }).then(r => r.text());
      return send(res, 200, 'application/vnd.apple.mpegurl', cfgLib.filterMaster(o, cfg), { 'Cache-Control': 'no-store' });
    }
    if (seg[0] === 'relais' && seg[1]) { // diagnostic : quels relais répondent depuis Vercel ?
      const login = seg[1].toLowerCase();
      if (!LOGIN_RE.test(login)) return json(res, { erreur: 'nom de chaîne invalide' });
      return json(res, await relayReport(login));
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
      try { list = await helix('/streams', { first: 50 }); store.log({ k: 'catalog', n: list.length, dev }); } catch (e) { console.error('catalogue :', e.message); store.incr('err'); store.log({ k: 'erreur', ou: 'catalogue', msg: e.message }); } // sans identifiants : catalogue vide
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
      const [s, b] = await Promise.all([liveStream(login, cfg.hevc), cfg.relay ? bestProxy(login, cfg.hevc) : null]);
      store.incr('stream'); store.incr('d:' + store.day() + ':stream'); store.user(pseudo, { ch: login, dev: cfg.device });
      const who = { u: pseudo || undefined, appareil: cfg.device || undefined, dev };
      if (s.offline) { store.incr('stream_offline'); store.log({ k: 'stream', ...who, ch: login, etat: 'hors ligne', ms: Date.now() - t0 }); return json(res, { streams: [] }); }
      store.incr(b ? 'stream_relay' : 'stream_official'); store.top(login);
      store.log({ k: 'stream', ...who, ch: login, relais: b ? b.name : cfg.relay ? 'aucun (officiel)' : 'coupés (officiel)', relais_ms: b ? b.ms : undefined, ms: Date.now() - t0, plafond: cfg.cap || undefined });
      // Un relais répond : tous les flux passent par lui (sans pub). Sinon : flux officiel.
      const vars = b ? variantsOf(mergedMaster(b, s, cfg)) : s.variants, tag = b ? ' · sans pub' : '';
      const relayUrls = b ? new Set(variantsOf(absolutize(b.text, b.url)).map(v => v.url)) : null;
      const video = vars.filter(v => !v.audio && cfgLib.keepVariant(v, cfg)).sort(byQuality);
      const fixed = video.slice(0, cfg.fixed).map(v => ({ name: 'Twitch ' + v.name.replace(/ \(source\)/, ''), title: 'En direct · qualité fixe' + (relayUrls && !relayUrls.has(v.url) ? ' · officiel (pubs possibles)' : tag), url: v.url }));
      const auto = { name: 'Twitch', title: 'En direct · qualité automatique' + (cfg.cap ? ' (max ' + cfg.cap + 'p)' : '') + tag, url: originOf(req) + base + '/p/' + login + '.m3u8' };
      const audio = cfg.audio ? vars.filter(v => v.audio).slice(0, 1).map(v => ({ name: 'Twitch Audio', title: 'Audio seul' + tag, url: v.url })) : [];
      return json(res, { streams: [auto, ...fixed, ...audio] });
    }
    send(res, 404, 'text/plain; charset=utf-8', 'Introuvable');
  } catch (e) {
    console.error('requête :', e.message);
    store.incr('err'); store.incr('d:' + store.day() + ':err'); store.log({ k: 'erreur', u: pseudo || undefined, ou: String(req.url).split('?')[0].slice(0, 60), msg: e.message });
    if (!res.headersSent) json(res, { error: e.message });
  }
}

module.exports = handler;
module.exports.handler = handler;
module.exports._t = { variantsOf, liveStream, usherUrl, metaOf, MANIFEST, absolutize, proxyList, bestProxy };
if (require.main === module) http.createServer(handler).listen(PORT, () => console.log('Twitch pour Stremio sur http://localhost:' + PORT));
