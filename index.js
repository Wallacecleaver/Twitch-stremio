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
const sealLib = require('./lib/seal');
const siteLib = require('./lib/site');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 7000;
const GQL = 'https://gql.twitch.tv/gql';
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // identifiant public du lecteur web de Twitch
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
let FEAT = siteLib.DEF.feat; // interrupteurs du dashboard (Paramètres), rafraîchis à chaque requête
const LOGIN_RE = /^[a-z0-9_]{3,25}$/;

const BLANK = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title></title></head><body style="margin:0;background:#0b0b10"></body></html>'; // accueil et chemins inconnus : rien à voir
const send = (res, code, type, body, h = {}) => { res.writeHead(code, { 'Content-Type': type, ...h }); res.end(body); };
const json = (res, o, h) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(o), { 'Cache-Control': 'no-store', ...h });

/* ------------------------------------------------------------------ lecture d'un live (méthode non officielle) */
const TOKEN_QUERY = 'query PlaybackAccessToken($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename } videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }';

const PERSISTED_HASH = 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9'; // requête enregistrée utilisée par le lecteur web
async function accessToken(login, playerType = 'site', clientId = GQL_CLIENT_ID, o = {}) {
  const headers = { 'Client-ID': clientId, 'Content-Type': 'application/json', 'User-Agent': UA };
  if (o.oauth) { headers.Authorization = 'OAuth ' + o.oauth; headers['X-Device-Id'] = crypto.randomBytes(16).toString('hex'); }
  const body = o.persisted
    ? { operationName: 'PlaybackAccessToken', variables: { isLive: true, login, isVod: false, vodID: '', playerType, platform: 'web' }, extensions: { persistedQuery: { version: 1, sha256Hash: PERSISTED_HASH } } }
    : { operationName: 'PlaybackAccessToken', variables: { isLive: true, login, isVod: false, vodID: '', playerType }, query: TOKEN_QUERY };
  const r = await fetch(GQL, { method: 'POST', headers, signal: AbortSignal.timeout(10000), body: JSON.stringify(body) });
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
const EXACT = { _exact: 1, allow_source: 'true', allow_audio_only: 'true', include_unavailable: 'true', multigroup_video: 'false', platform: 'web', playlist_include_framerate: 'true', supported_codecs: 'av1,h265,h264' }; // demande de l'application Xtra
const AUTH_TRIES = [
  { auth: 1, tok: 'site', v2: true, q: WEBV2('av1,h265,h264') },
  { auth: 1, tok: 'site', v2: true, persisted: true, q: EXACT },
  { auth: 1, tok: 'site', v2: true, q: EXACT },
  { auth: 1, tok: 'site', v2: true, persisted: true, q: WEBV2('h265,h264') },
];
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
  const exact = extra && extra._exact; if (exact) { extra = { ...extra }; delete extra._exact; }
  const q = new URLSearchParams(exact ? { sig: t.signature, token: t.value, p: String(Math.floor(Math.random() * 1e7)), ...extra } : { sig: t.signature, token: t.value, allow_source: 'true', allow_audio_only: 'true', ...(FEAT.fast ? { fast_bread: 'true' } : {}), player: 'twitchweb', type: 'any', supported_codecs: 'avc1', p: String(Math.floor(Math.random() * 1e7)), ...(extra || {}) });
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
async function liveStream(login, hevc, oauth) {
  if (!hevc && !oauth) return liveOnce(login, 'site', null);
  const ck = login + '|' + (oauth ? crypto.createHash('sha1').update(oauth).digest('hex').slice(0, 8) : ''), c = hevcCache.get(ck);
  if (c && c.exp > Date.now()) return c.v;
  const list = (oauth ? AUTH_TRIES : []).concat(HEVC_TRIES), tokens = {};
  const res = await Promise.allSettled(list.map(async t => {
    const key = t.tok + (t.cid || '') + (t.auth ? 'A' : '') + (t.persisted ? 'P' : ''), tk = await (tokens[key] ||= accessToken(login, t.tok, t.cid, { oauth: t.auth ? oauth : null, persisted: t.persisted }));
    const r = await liveOnce(login, t.tok, typeof t.q === 'function' ? t.q(login) : t.q, tk, t.v2);
    r.tk = tk;
    return r;
  }));
  const hOf = r => Math.max(0, ...r.variants.map(v => v.h));
  const ok = res.map((x, i) => ({ i, x })).filter(o => o.x.status === 'fulfilled').map(o => ({ i: o.i, r: o.x.value }));
  const tries = res.map((x, i) => (list[i].auth ? 'compte:' : '') + (x.status === 'fulfilled' ? (x.value.offline ? 'hors ligne' : hOf(x.value) + 'p') : 'échec (' + String(x.reason && x.reason.message).slice(0, 40) + ')'));
  if (!ok.length) throw res[0].reason;
  let best;
  const live = ok.filter(o => !o.r.offline);
  if (!live.length) best = ok[0].r;
  else { live.sort((a, b) => hOf(b.r) - hOf(a.r) || a.i - b.i); best = { ...live[0].r, essai: live[0].i + 1 }; }
  best.essais = tries;
  if (oauth) { // ce que Twitch accorde à ce compte
    const a = ok.find(o => list[o.i].auth && o.r.tk), j = (() => { try { return a ? JSON.parse(a.r.tk.value) : null; } catch { return null; } })();
    best.compte = j ? { resolution: j.maximum_resolution || '?', connecte: !!j.user_id } : { resolution: null, connecte: false };
  }
  delete best.tk;
  if (hevcCache.size > 100) hevcCache.clear();
  hevcCache.set(ck, { v: best, exp: Date.now() + 20000 });
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
const Q = '?allow_source=true&allow_audio_only=true';
const DEFAULT_PROXIES = [
  ['Luminous EU', 'https://eu.luminous.dev/live/{channel}'], ['Luminous EU 2', 'https://eu2.luminous.dev/live/{channel}'], ['Luminous EU 3', 'https://eu3.luminous.dev/live/{channel}'],
  ['Luminous AS', 'https://as.luminous.dev/live/{channel}'], ['Nadeko', 'https://twitch-al.nadeko.net/live/{channel}'],
  ['Perfprod EU', 'https://lb-eu.cdn-perfprod.com/live/{channel}'], ['Perfprod EU 2', 'https://lb-eu2.cdn-perfprod.com/live/{channel}'], ['Perfprod EU 3', 'https://lb-eu3.cdn-perfprod.com/live/{channel}'],
  ['Perfprod EU 4', 'https://lb-eu4.cdn-perfprod.com/live/{channel}'], ['Perfprod EU 5', 'https://lb-eu5.cdn-perfprod.com/live/{channel}'], ['Perfprod NA', 'https://lb-na.cdn-perfprod.com/live/{channel}'],
  ['Perfprod AS', 'https://lb-as.cdn-perfprod.com/live/{channel}'], ['Perfprod SA', 'https://lb-sa.cdn-perfprod.com/live/{channel}'],
].map(([name, url]) => ({ name, url: url + Q }));
const allProxies = () => {
  const env = String(process.env.PROXIES || '').split('\n').map(x => x.trim()).filter(Boolean);
  if (!env.length) return DEFAULT_PROXIES;
  return env.map((l, i) => { const [a, b] = l.includes('|') ? l.split('|').map(x => x.trim()) : ['Relais ' + (i + 1), l]; return { name: a, url: b }; }).filter(x => /^https:\/\/.+\{channel\}/.test(x.url));
};
const proxyList = () => allProxies().filter(x => !FEAT.offRelays.includes(x.name));
const isMaster = t => typeof t === 'string' && t.startsWith('#EXTM3U') && /#EXT-X-STREAM-INF/.test(t);
async function askProxy(px, login, signal, hevc) {
  const t0 = Date.now(), url = px.url.replace('{channel}', login) + (FEAT.fast ? (px.url.includes('?') ? '&' : '?') + 'fast_bread=true' : '') + (hevc ? (px.url.includes('?') ? '&' : '?') + 'supported_codecs=av1,h265,h264' : '');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), FEAT.timeout);
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

// Mode ordinateur : les listes de lecture passent par nous, nettoyées (sans balises Twitch propres) pour le lecteur de Stremio PC.
const pcOn = cfg => !!(cfg && cfg.pc && sealLib.available());
const pcUrl = (origin, base, u) => origin + base + '/m/' + sealLib.seal(u) + '.m3u8';
function pcMaster(text, origin, base) {
  const L = text.split(/\r?\n/), out = [];
  for (let i = 0; i < L.length; i++) {
    if (L[i].startsWith('#EXT-X-MEDIA')) continue;
    if (L[i].startsWith('#EXT-X-STREAM-INF')) {
      const u = L[i + 1] || '';
      if (/audio_only/i.test(L[i] + u) || !/RESOLUTION=/.test(L[i])) { i++; continue; }
      out.push(L[i].replace(/,?AUDIO="[^"]*"/, '').replace(/,?VIDEO="[^"]*"/, ''), /^https?:/.test(u) ? pcUrl(origin, base, u) : u); i++;
    } else out.push(L[i]);
  }
  return out.join('\n');
}
function cleanMedia(text) {
  return text.split(/\r?\n/).filter(l => !/^#EXT-X-(TWITCH-PREFETCH|DATERANGE|TWITCH-INFO|TWITCH-ELAPSED-SECS|TWITCH-TOTAL-SECS|SCTE35)/.test(l) && !/^#EXT-X-PROGRAM-DATE-TIME/.test(l)).join('\n');
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
  description: s.title + '\n\n🎮 ' + s.game_name + ' · 👁 ' + fmtN(s.viewer_count) + ' spectateurs', genres: s.game_name ? [s.game_name] : [], releaseInfo: '🔴 ' + fmtN(s.viewer_count) + ' 👁',
});

const fmtN = n => (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',').replace(',0', '') + ' M' : n >= 1000 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace('.', ',').replace(',0', '') + ' k' : String(n)); // 111882 → « 112 k »
const GAMES = ['Just Chatting', 'Fortnite', 'League of Legends', 'VALORANT', 'Counter-Strike', 'Garry\'s Mod', 'Grand Theft Auto V', 'Rocket League', 'Minecraft', 'Call of Duty: Warzone', 'World of Warcraft', 'Apex Legends', 'Rust', 'Overwatch 2', 'Teamfight Tactics', 'Escape from Tarkov', 'Dead by Daylight', 'Music', 'Sports']; // menu « jeu » de Stremio (la recherche accepte n'importe quel jeu)
const ALIAS = { gmod: 'Garry\'s Mod', gta: 'Grand Theft Auto V', gta5: 'Grand Theft Auto V', gtav: 'Grand Theft Auto V', lol: 'League of Legends', cs: 'Counter-Strike', cs2: 'Counter-Strike', csgo: 'Counter-Strike', wow: 'World of Warcraft', cod: 'Call of Duty: Warzone', warzone: 'Call of Duty: Warzone', tft: 'Teamfight Tactics', ow: 'Overwatch 2', overwatch: 'Overwatch 2', rl: 'Rocket League', valo: 'VALORANT', jc: 'Just Chatting', tarkov: 'Escape from Tarkov', dbd: 'Dead by Daylight' };
const byGame = (list, g, get) => (g ? list.filter(x => String(get(x) || '').toLowerCase().includes(g.toLowerCase())) : list);
const extraOf = e => new URLSearchParams(String(e || '').replace(/\.json$/, ''));
// Fiche d'une chaîne (photo, titre du live, jeu, spectateurs) via la même API publique que le site web de Twitch : aucune clé nécessaire.
const INFO_QUERY = 'query ChannelInfo($login: String!) { user(login: $login) { displayName login description profileImageURL(width: 300) bannerImageURL offlineImageURL stream { title viewersCount previewImageURL(width: 1280, height: 720) game { displayName } } } }';
const infoCache = new Map();
async function channelInfo(login) {
  const c = infoCache.get(login);
  if (c && c.exp > Date.now()) return c.v;
  let v = null;
  try {
    const r = await fetch(GQL, { method: 'POST', headers: { 'Client-ID': GQL_CLIENT_ID, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ operationName: 'ChannelInfo', variables: { login }, query: INFO_QUERY }), signal: AbortSignal.timeout(4000) });
    const u = r.ok ? ((await r.json().catch(() => ({}))).data || {}).user : null;
    if (u && u.login) v = { name: u.displayName || login, avatar: u.profileImageURL || '', banner: u.offlineImageURL || u.bannerImageURL || '', bio: u.description || '', live: !!u.stream, title: u.stream ? u.stream.title || '' : '', game: u.stream && u.stream.game ? u.stream.game.displayName : '', viewers: u.stream ? Number(u.stream.viewersCount) || 0 : 0, preview: u.stream ? u.stream.previewImageURL || '' : '' };
  } catch { /* sans fiche : on affiche une fiche simple */ }
  infoCache.set(login, { v, exp: Date.now() + (v ? 45000 : 10000) });
  if (infoCache.size > 300) infoCache.delete(infoCache.keys().next().value);
  return v;
}
const metaFromInfo = (login, i) => {
  const nb = i.viewers.toLocaleString('fr-FR'), live = 'https://static-cdn.jtvnw.net/previews-ttv/live_user_' + login + '-1280x720.jpg';
  return {
    id: 'twitch:' + login, type: 'tv', name: i.name, posterShape: 'landscape',
    poster: i.preview || i.avatar || live, background: i.preview || i.banner || i.avatar || undefined, ...(i.avatar ? { logo: i.avatar } : {}),
    description: i.live ? ((i.game ? '🎮 ' + i.game + '\n\n' : '') + (i.title || '')).trim() : ('Hors ligne' + (i.bio ? '\n\n' + i.bio : '')),
    genres: i.game ? [i.game] : [], releaseInfo: i.name,
  };
};

// Chaînes suivies du compte Twitch lié au profil (jeton « auth-token » déjà utilisé pour le 1440p), via l'API du site web de Twitch.
const NODE_FIELDS = 'login displayName profileImageURL(width: 300) stream { title viewersCount previewImageURL(width: 640, height: 360) game { displayName } }';
const followQuery = (field, after) => 'query Followed { currentUser { login ' + field + '(first: 100' + (after ? ', after: "' + after + '"' : '') + ') { edges { cursor node { ' + NODE_FIELDS + ' } } pageInfo { hasNextPage } } } }';
const followCache = new Map();
async function followPage(oauth, field, after) {
  const r = await fetch(GQL, { method: 'POST', headers: { 'Client-ID': GQL_CLIENT_ID, Authorization: 'OAuth ' + oauth, 'Content-Type': 'application/json', 'User-Agent': UA, 'X-Device-Id': crypto.randomBytes(16).toString('hex') }, body: JSON.stringify({ operationName: 'Followed', query: followQuery(field, after) }), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Twitch (suivis) : HTTP ' + r.status);
  const j = await r.json().catch(() => ({})), u = j && j.data && j.data.currentUser, conn = u && u[field];
  if (!conn) throw new Error('Twitch n\'a pas renvoyé les chaînes suivies' + (j && j.errors && j.errors[0] ? ' : ' + String(j.errors[0].message).slice(0, 120) : ' (compte non reconnu ?)'));
  return { edges: (conn.edges || []).filter(e => e && e.node && e.node.login), more: !!(conn.pageInfo && conn.pageInfo.hasNextPage) };
}
async function followedChannels(oauth) {
  const key = crypto.createHash('sha1').update(oauth).digest('hex').slice(0, 10), c = followCache.get(key);
  if (c && c.exp > Date.now()) return c.v;
  const collect = async (field, maxPages) => { // toutes les pages (100 par page) : un compte peut suivre des centaines de chaînes
    const out = []; let after = '';
    for (let i = 0; i < maxPages; i++) { const pg = await followPage(oauth, field, after); out.push(...pg.edges.map(e => e.node)); if (!pg.more || !pg.edges.length) break; after = pg.edges[pg.edges.length - 1].cursor; if (!after) break; }
    return out;
  };
  let nodes;
  try { nodes = await collect('followedLiveUsers', 3); } // la liste « en direct » du site web de Twitch
  catch (e1) { try { nodes = (await collect('follows', 8)).filter(n => n.stream); } catch (e2) { throw new Error(e1.message + ' | ' + e2.message); } }
  const v = nodes.filter(n => n.stream).map(n => ({ login: n.login, info: { name: n.displayName || n.login, avatar: n.profileImageURL || '', banner: '', bio: '', live: true, title: n.stream.title || '', game: n.stream.game ? n.stream.game.displayName : '', viewers: Number(n.stream.viewersCount) || 0, preview: n.stream.previewImageURL || '' } }));
  v.sort((a, b) => b.info.viewers - a.info.viewers);
  followCache.set(key, { v, exp: Date.now() + 30000 });
  return v;
}

// Toutes les chaînes suivies (en ligne ou non), pour le catalogue « Mes rediffusions » : live d'abord (par spectateurs), puis ordre alphabétique.
const followAllCache = new Map();
async function followedAll(oauth) {
  const key = crypto.createHash('sha1').update(oauth).digest('hex').slice(0, 10), c = followAllCache.get(key);
  if (c && c.exp > Date.now()) return c.v;
  const nodes = []; let after = '';
  for (let i = 0; i < 12; i++) { const pg = await followPage(oauth, 'follows', after); nodes.push(...pg.edges.map(e => e.node)); if (!pg.more || !pg.edges.length) break; after = pg.edges[pg.edges.length - 1].cursor; if (!after) break; }
  const v = nodes.map(n => ({ login: n.login, name: n.displayName || n.login, avatar: n.profileImageURL || '', live: !!n.stream, viewers: n.stream ? Number(n.stream.viewersCount) || 0 : 0 }))
    .sort((a, b) => (b.live - a.live) || (b.viewers - a.viewers) || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  followAllCache.set(key, { v, exp: Date.now() + 300000 });
  if (followAllCache.size > 50) followAllCache.delete(followAllCache.keys().next().value);
  return v;
}

// Lives populaires et lives d'un jeu, via l'API publique du site web de Twitch (aucune clé nécessaire).
const STREAM_NODE = 'title viewersCount previewImageURL(width: 640, height: 360) game { displayName } broadcaster { login displayName profileImageURL(width: 300) }';
const streamsCache = new Map();
async function gqlRaw(query) {
  const r = await fetch(GQL, { method: 'POST', headers: { 'Client-ID': GQL_CLIENT_ID, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Twitch (lives) : HTTP ' + r.status);
  const j = await r.json().catch(() => ({}));
  if (!j.data) throw new Error('Twitch n\'a pas renvoyé de lives' + (j.errors && j.errors[0] ? ' : ' + String(j.errors[0].message).slice(0, 120) : ''));
  return j.data;
}
const toLive = n => n && n.broadcaster && n.broadcaster.login ? { login: n.broadcaster.login, info: { name: n.broadcaster.displayName || n.broadcaster.login, avatar: n.broadcaster.profileImageURL || '', banner: '', bio: '', live: true, title: n.title || '', game: n.game ? n.game.displayName : '', viewers: Number(n.viewersCount) || 0, preview: n.previewImageURL || '' } } : null;
async function liveStreams(game) { // game vide = les plus regardés de tout Twitch ; null si le jeu n'existe pas
  const k = game.toLowerCase(), c = streamsCache.get(k);
  if (c && c.exp > Date.now()) return c.v;
  let edges, v;
  if (!game) edges = ((await gqlRaw('query { streams(first: 60) { edges { node { ' + STREAM_NODE + ' } } } }')).streams || {}).edges;
  else {
    const rs = await Promise.all([...new Set([game, game.toLowerCase(), game.toUpperCase()])].map(name => gqlRaw('query { game(name: ' + JSON.stringify(name) + ') { streams(first: 60) { edges { node { ' + STREAM_NODE + ' } } } } }').catch(() => ({}))));
    const g = rs.map(r => r.game).find(Boolean); if (g) edges = (g.streams || {}).edges || [];
  }
  v = edges ? edges.map(e => toLive(e && e.node)).filter(Boolean).sort((a, b) => b.info.viewers - a.info.viewers) : null;
  streamsCache.set(k, { v, exp: Date.now() + 30000 });
  if (streamsCache.size > 80) streamsCache.delete(streamsCache.keys().next().value);
  return v;
}
const norm = t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
const gameOf = async q => { const k = norm(q); if (k.length < 3) return null; if (ALIAS[k]) return ALIAS[k]; const L = await Promise.race([gameList(), new Promise(r => setTimeout(() => r(GAMES), 2500))]); return L.find(x => norm(x) === k) || L.find(x => norm(x).includes(k)) || null; }; // null : ce n'est pas un jeu connu → recherche de chaîne
const withTimeout = (p, ms, fb) => Promise.race([p, new Promise(r => setTimeout(() => r(fb), ms))]);
const catalogMeta = x => { const m = metaFromInfo(x.login, x.info); delete m.logo; return { ...m, background: undefined, name: '👁 ' + fmtN(x.info.viewers) + ' · ' + x.info.name, releaseInfo: '🔴 ' + fmtN(x.info.viewers) + ' 👁' }; };

// Menu « Genre » : les catégories les plus regardées de Twitch (liste récupérée sans clé, gardée 6 h), complétées par la liste fixe.
let gamesCache = { v: null, exp: 0 };
async function gameList() {
  if (gamesCache.v && gamesCache.exp > Date.now()) return gamesCache.v;
  let names = [];
  try { const d = await gqlRaw('query { games(first: 100) { edges { node { displayName } } } }'); names = ((d.games || {}).edges || []).map(e => e && e.node && e.node.displayName).filter(Boolean); } catch { /* liste fixe */ }
  const v = [...new Set([...names, ...GAMES])].slice(0, 150);
  gamesCache = { v: names.length ? v : null, exp: Date.now() + (names.length ? 6 * 3600e3 : 120e3) };
  return names.length ? v : GAMES;
}
// Rediffusions (VOD) : une chaîne = une série, ses rediffs = les épisodes d'une saison.
const VIDEO_NODE = 'id title publishedAt lengthSeconds viewCount previewThumbnailURL(width: 640, height: 360) game { displayName }';
const vodCache = new Map();
async function channelVods(login) {
  const c = vodCache.get(login);
  if (c && c.exp > Date.now()) return c.v;
  const d = await gqlRaw('query { user(login: ' + JSON.stringify(login) + ') { displayName login description profileImageURL(width: 300) offlineImageURL a: videos(first: 30, type: ARCHIVE, sort: TIME) { edges { node { ' + VIDEO_NODE + ' } } } h: videos(first: 10, type: HIGHLIGHT, sort: TIME) { edges { node { ' + VIDEO_NODE + ' } } } } }');
  const u = d.user, nodes = k => ((u && u[k] || {}).edges || []).map(e => e && e.node).filter(n => n && n.id);
  const v = u ? { login: u.login || login, name: u.displayName || login, avatar: u.profileImageURL || '', banner: u.offlineImageURL || '', bio: u.description || '', archives: nodes('a'), highlights: nodes('h') } : null;
  vodCache.set(login, { v, exp: Date.now() + 120000 });
  if (vodCache.size > 100) vodCache.delete(vodCache.keys().next().value);
  return v;
}
const dur = s => { s = Number(s) || 0; const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? h + ' h ' + String(m).padStart(2, '0') : m + ' min'; };
const vodMeta = (v, withVideos) => {
  const m = { id: 'twitchvod:' + v.login, type: 'series', name: v.name, poster: v.avatar, posterShape: 'square', background: v.banner || undefined, description: v.bio || 'Rediffusions de ' + v.name, releaseInfo: v.archives.length ? v.archives.length + ' rediffs' : undefined };
  if (!withVideos) return m;
  const vid = (n, season, i, total) => ({ id: 'twitchvod:' + v.login + ':' + n.id, title: n.title || 'Rediffusion', season, episode: i + 1, released: n.publishedAt || new Date(0).toISOString(), thumbnail: n.previewThumbnailURL || undefined, overview: [new Date(n.publishedAt).toLocaleDateString('fr-FR'), dur(n.lengthSeconds), n.game ? '🎮 ' + n.game.displayName : '', '👁 ' + fmtN(n.viewCount)].filter(Boolean).join(' · ') });
  m.videos = [...v.archives.map((n, i) => vid(n, 1, i)), ...v.highlights.map((n, i) => vid(n, 2, i))];
  return m;
};
async function vodToken(id, cid = GQL_CLIENT_ID, playerType = 'site', oauth = null) {
  const hd = { 'Client-ID': cid, 'Content-Type': 'application/json', 'User-Agent': UA };
  if (oauth) { hd.Authorization = 'OAuth ' + oauth; hd['X-Device-Id'] = crypto.randomBytes(16).toString('hex'); }
  const r = await fetch(GQL, { method: 'POST', headers: hd, signal: AbortSignal.timeout(10000), body: JSON.stringify({ operationName: 'PlaybackAccessToken', variables: { isLive: false, login: '', isVod: true, vodID: id, playerType }, query: TOKEN_QUERY }) });
  if (!r.ok) throw new Error('jeton : HTTP ' + r.status);
  const j = await r.json().catch(() => ({})), t = j && j.data && j.data.videoPlaybackAccessToken;
  if (!t || !t.value || !t.signature) throw new Error('jeton refusé' + (j && j.errors && j.errors[0] ? ' (' + String(j.errors[0].message).slice(0, 80) + ')' : ' (rediff supprimée ou réservée aux abonnés ?)'));
  return t;
}
// Plusieurs variantes en parallèle (identifiant client, type de lecteur, adresse usher) : on garde la première qui répond.
const VOD_TRIES = [{ cid: GQL_CLIENT_ID, pt: 'site', path: '/vod/' }, { cid: GQL_CLIENT_ID, pt: 'site', path: '/vod/v2/' }, { cid: GQL_CLIENT_ID, pt: 'embed', path: '/vod/' }, { cid: TV_ID, pt: 'site', path: '/vod/' }, { cid: ANDROID_ID, pt: 'site', path: '/vod/' }];
async function vodMaster(id, oauth) { // avec le compte Twitch lié : les rediffs réservées aux abonnés s'ouvrent si le compte est abonné
  const errs = [], tries = oauth ? [{ cid: GQL_CLIENT_ID, pt: 'site', path: '/vod/', auth: 1 }, { cid: GQL_CLIENT_ID, pt: 'site', path: '/vod/v2/', auth: 1 }, ...VOD_TRIES] : VOD_TRIES;
  const one = async (t, i) => {
    try {
      const k = await vodToken(id, t.cid, t.pt, t.auth ? oauth : null);
      const url = 'https://usher.ttvnw.net' + t.path + id + '.m3u8?' + new URLSearchParams({ nauth: k.value, nauthsig: k.signature, allow_source: 'true', allow_audio_only: 'true', allow_spectre: 'true', player: 'twitchweb', playlist_include_framerate: 'true', p: String(Math.floor(Math.random() * 1e7)) });
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }), text = await r.text();
      if (!r.ok || !text.startsWith('#EXTM3U')) throw new Error('usher : HTTP ' + r.status);
      if (!variantsOf(text).length) throw new Error('liste vide');
      return { url, text };
    } catch (e) { errs.push('essai ' + (i + 1) + (t.auth ? ' (compte)' : '') + ' ' + e.message); throw e; }
  };
  try { return await Promise.any(tries.map(one)); } catch { /* usher refuse (403) : lecture directe depuis le CDN de Twitch */ }
  try { return await vodDirect(id); } catch (e) { errs.push('cdn ' + e.message); }
  throw new Error('Rediffusion indisponible — ' + errs.join(' ; '));
}
// Lecture directe sur le CDN de Twitch (méthode « TwitchNoSub ») : les rediffs, même réservées aux abonnés, sont servies par CloudFront à une adresse
// déduite de l'aperçu de la vidéo (…/<dossier>/storyboards/…). Utilisé quand usher refuse (403).
const CDN_Q = [['chunked', '1920x1080', 60, 8000000], ['1440p60', '2560x1440', 60, 6000000], ['1080p60', '1920x1080', 60, 5000000], ['720p60', '1280x720', 60, 3400000], ['480p30', '854x480', 30, 1400000], ['360p30', '640x360', 30, 750000], ['160p30', '284x160', 30, 300000]];
async function vodDirect(id) {
  const d = await gqlRaw('query { video(id: "' + id + '") { broadcastType createdAt seekPreviewsURL owner { login } } }'), v = d.video;
  if (!v || !v.seekPreviewsURL) throw new Error('adresse introuvable');
  const u0 = new URL(v.seekPreviewsURL), parts = u0.pathname.split('/'), k = parts.findIndex(x => x.includes('storyboards'));
  if (k < 1) throw new Error('adresse inattendue');
  const host = u0.host, special = parts[k - 1], type = String(v.broadcastType || '').toLowerCase(), old = (Date.now() - new Date(v.createdAt).getTime()) / 864e5 > 7;
  const urlOf = q => type === 'highlight' ? 'https://' + host + '/' + special + '/' + q + '/highlight-' + id + '.m3u8'
    : type === 'upload' && old ? 'https://' + host + '/' + (v.owner && v.owner.login) + '/' + id + '/' + special + '/' + q + '/index-dvr.m3u8'
      : 'https://' + host + '/' + special + '/' + q + '/index-dvr.m3u8';
  const ok = await Promise.all(CDN_Q.map(async q => { try { const u = urlOf(q[0]), r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) }); if (!r.ok) throw new Error('HTTP ' + r.status); const t = await r.text(); if (!t.startsWith('#EXTM3U')) throw new Error('liste invalide'); return { q, u }; } catch { return null; } }));
  let have = ok.filter(Boolean);
  if (have.some(o => /^(1080|1440)p60$/.test(o.q[0]))) have = have.filter(o => o.q[0] !== 'chunked'); // évite un doublon avec la source
  if (!have.length) throw new Error('aucune qualité accessible (rediff supprimée ?)');
  // « chunked » = qualité source : on ne la garde que si la 1080p60 n'existe pas déjà en doublon ; 1440p60 / 1080p60 explicites passent avant
  const text = '#EXTM3U\n' + have.map(o => '#EXT-X-STREAM-INF:BANDWIDTH=' + o.q[3] + ',RESOLUTION=' + o.q[1] + ',FRAME-RATE=' + o.q[2] + '.000\n' + o.u).join('\n') + '\n';
  return { url: have[0].u, text, direct: true };
}

/* ------------------------------------------------------------------ addon */
const MANIFEST = {
  id: 'community.twitch.lives', version: '0.1.0', name: 'Twitch', description: 'Lives Twitch dans Stremio',
  resources: ['catalog', 'meta', 'stream'], types: ['tv', 'series'], idPrefixes: ['twitch:', 'twitchvod:'],
  behaviorHints: { configurable: true, configurationRequired: false },
  catalogs: [{ type: 'tv', id: 'twitch-top', name: 'Twitch · Lives par jeu', extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false, options: GAMES }] }],
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

// compte Twitch du propriétaire, lié depuis le dashboard (chiffré, stocké dans Upstash) ou variable TWITCH_AUTH_TOKEN
let acctCache = { v: null, exp: 0 };
async function ownerToken() {
  if (acctCache.exp > Date.now()) return acctCache.v;
  let v = null;
  try { const sealed = await store.getKey('acct'); v = sealed ? sealLib.open(sealed) : null; } catch { /* base indisponible */ }
  if (!v && process.env.TWITCH_AUTH_TOKEN) v = process.env.TWITCH_AUTH_TOKEN.trim().replace(/^oauth:?\s*/i, '');
  acctCache = { v, exp: Date.now() + 60000 };
  return v;
}
const account = {
  async status(channel) {
    const tok = await ownerToken(), src = tok ? ((await store.getKey('acct').catch(() => null)) ? 'dashboard' : 'variable TWITCH_AUTH_TOKEN') : null;
    const out = { lie: !!tok, source: src, stockage: store.persistent, chiffrement: sealLib.available() };
    if (!tok) return out;
    try {
      const v = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + tok, 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (v.status === 401) { out.erreur = 'Twitch refuse ce jeton (expiré ou révoqué) : relie ton compte.'; return out; }
      const j = await v.json(); out.login = j.login; out.user_id = j.user_id;
      if (channel && LOGIN_RE.test(channel)) { const t = await accessToken(channel, 'site', GQL_CLIENT_ID, { oauth: tok }); const info = JSON.parse(t.value); out.resolution_max = info.maximum_resolution || '?'; out.connecte = !!info.user_id; }
    } catch (e) { out.erreur = e.message; }
    return out;
  },
  async link(token) {
    if (!sealLib.available()) return { ok: false, error: 'Ajoute la variable SECRET (ou ADMIN_PASSWORD) dans Vercel.' };
    const tok = String(token || '').trim().replace(/^oauth:?\s*/i, '');
    if (!/^[A-Za-z0-9]{20,64}$/.test(tok)) return { ok: false, error: 'Jeton non reconnu : colle la valeur du cookie auth-token, sans guillemets.' };
    const r = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + tok, 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (r.status === 401) return { ok: false, error: 'Twitch refuse ce jeton (expiré ou incorrect). Reconnecte-toi sur twitch.tv et recopie-le.' };
    if (!r.ok) return { ok: false, error: 'Twitch ne répond pas (HTTP ' + r.status + ')' };
    if (!store.persistent) return { ok: false, error: 'Il faut la base Upstash pour garder le compte. Sinon, mets le jeton dans la variable Vercel TWITCH_AUTH_TOKEN.' };
    await store.setKey('acct', sealLib.seal(tok)); acctCache = { v: null, exp: 0 };
    const j = await r.json(); return { ok: true, login: j.login };
  },
  async sealed() { const t = await ownerToken(); return t && sealLib.available() ? sealLib.seal(t) : null; },
  async unlink() { await store.delKey('acct'); acctCache = { v: null, exp: 0 }; return { ok: true }; },
};
const pageCache = {};
const rawPage = name => pageCache[name] ||= fs.readFileSync(path.join(__dirname, 'lib', 'pages', name), 'utf8');
const page = rawPage;
const escH = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const accentCss = hex => { const rgb = [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16)), dark = rgb.map(x => Math.round(x * .72).toString(16).padStart(2, '0')).join(''); return ':root{--a:' + hex + ';--ah:#' + dark + ';--as:rgba(' + rgb.join(',') + ',.15)}'; };
async function configPage() { // page /config : nom, logo, couleur et textes viennent des réglages du site (dashboard)
  const s = await siteLib.load(), pub = { name: s.name, color: s.color, title: s.title, text: s.text, banner: s.banner, open: s.open, needCode: !!s.code, def: s.def, v: s.logoV };
  const credit = s.credit ? escH(s.credit) : 'Addon gratuit et non officiel · n\'héberge aucun contenu · créé par <b>Wallace</b>';
  return rawPage('config.html').replace(/\{\{NAME\}\}/g, () => escH(s.name)).replace(/\{\{COLOR\}\}/g, () => s.color).replace('{{ACCENT}}', () => accentCss(s.color)).replace('{{CREDIT}}', () => credit).replace(/\{\{V\}\}/g, () => String(s.logoV)).replace('{{SITE}}', () => JSON.stringify(pub).replace(/</g, '\\u003c'));
}
const asset = name => pageCache['a:' + name] ||= fs.readFileSync(path.join(__dirname, 'lib', 'assets', name));
const summary = c => [c.cap ? 'max ' + c.cap + 'p' : 'qualité max', c.fps60 ? '60 i/s' : '30 i/s', c.relay ? 'relais' : 'sans relais', c.fixed + ' fixes', c.hevc ? '1440p' : '', c.tok ? 'compte lié' : '', c.audio ? 'audio' : ''].filter(Boolean).join(' · ');
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 8000) req.destroy(); }); req.on('end', () => r(b)); req.on('error', () => r(b)); });
const text = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, n);
const hits = new Map(); // limite : 40 signalements / test par minute et par adresse
const tooMany = req => { const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x', n = (hits.get(ip) || 0) + 1; hits.set(ip, n); if (hits.size > 500) hits.clear(); setTimeout(() => hits.delete(ip), 60000).unref?.(); return n > 40; };

// lie le compte Twitch d'une personne : vérifie le jeton, le chiffre, renvoie la version chiffrée (qui ira dans SON lien ; rien n'est stocké)
async function sealToken(req) {
  if (tooMany(req)) return { ok: false, error: 'trop de demandes, réessaie dans une minute' };
  if (!sealLib.available()) return { ok: false, error: 'Chiffrement non configuré : l\'administrateur doit ajouter la variable SECRET.' };
  let b = {}; try { b = JSON.parse(await readBody(req)); } catch { return { ok: false, error: 'requête invalide' }; }
  const tok = String(b.token || '').trim().replace(/^oauth:?\s*/i, '');
  if (!/^[A-Za-z0-9]{20,64}$/.test(tok)) return { ok: false, error: 'Jeton non reconnu : colle la valeur du cookie auth-token, sans guillemets.' };
  try {
    const r = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + tok, 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (r.status === 401) return { ok: false, error: 'Twitch refuse ce jeton (expiré ou incorrect). Reconnecte-toi sur twitch.tv et recopie-le.' };
    if (!r.ok) return { ok: false, error: 'Twitch ne répond pas (HTTP ' + r.status + ')' };
    const j = await r.json();
    return { ok: true, sealed: sealLib.seal(tok), login: j.login || '' };
  } catch (e) { return { ok: false, error: e.message }; }
}

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
async function checkStream(login, c, u, dev, auth) {
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
  try { live = await liveStream(login, c.hevc, auth); } catch (e) { step('Twitch', false, e.message); return finish('erreur', 'Twitch ne répond pas : ' + e.message); }
  if (live.offline) { step('Twitch', true, 'chaîne hors ligne'); return finish('hors ligne', 'La chaîne n\'est pas en direct, rien à tester.'); }
  step('Twitch', true, live.variants.length + ' qualités');
  if (auth) step('Compte Twitch', !!(live.compte && live.compte.connecte), live.compte && live.compte.connecte ? 'lié · qualité maximale accordée : ' + live.compte.resolution : 'jeton refusé ou expiré : relie ton compte');
  else if (c.hevc) step('Compte Twitch', false, 'aucun compte lié : lie ton compte sur /config pour obtenir le 1440p');
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

const mask = v => v ? 'défini' : 'absent';
const adminRoute = makeAdmin({ send, json, relayReport, probe, check: async (login, c, u) => { const n = cfgLib.normalize(c || {}); return checkStream(login, n, u || 'admin', 'admin', n.hevc ? await ownerToken() : null); }, account, config: () => ({
  relais: allProxies(),
  rows: [
    ['Version', require('./package.json').version, null],
    ['Stockage persistant (Upstash)', store.persistent ? 'actif' : 'mémoire temporaire', store.persistent],
    ['TWITCH_CLIENT_ID', mask(process.env.TWITCH_CLIENT_ID), !!process.env.TWITCH_CLIENT_ID],
    ['TWITCH_CLIENT_SECRET', mask(process.env.TWITCH_CLIENT_SECRET), !!process.env.TWITCH_CLIENT_SECRET],
    ['Catalogue « Lives populaires »', process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET ? 'disponible' : 'vide (clés Twitch manquantes)', !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET)],
    ['Compte Twitch lié', acctCache.v ? 'oui' : 'non / pas encore vérifié', acctCache.v ? true : null],
    ['Chiffrement des jetons (SECRET)', sealLib.available() ? 'actif' : 'absent (liaison de compte impossible)', sealLib.available()],
    ['Relais actifs', proxyList().length + ' sur ' + allProxies().length + (process.env.PROXIES ? ' (variable PROXIES)' : ' (liste par défaut)'), null],
  ] }) });

// Profils enregistrés : /u/<id>/… (l'identifiant est le secret). Les réglages sont modifiables sans réinstaller l'addon.
const ID_RE = /^[A-Za-z0-9_-]{16,40}$/;
async function loadProfile(id) {
  try { const raw = await store.getKey('p:' + id); if (!raw) return null; const p = JSON.parse(raw); return { pseudo: cfgLib.cleanPseudo(p.pseudo), cfg: cfgLib.normalize(p.cfg), pw: typeof p.pw === 'string' ? p.pw : '' }; } catch { return null; }
}
const pwHash = pw => { const salt = crypto.randomBytes(16); return salt.toString('base64url') + ':' + crypto.scryptSync(String(pw), salt, 32).toString('base64url'); };
const pwCheck = (pw, h) => { try { const [s, k] = String(h).split(':'), a = crypto.scryptSync(String(pw), Buffer.from(s, 'base64url'), 32), b = Buffer.from(k, 'base64url'); return a.length === b.length && crypto.timingSafeEqual(a, b); } catch { return false; } };
const fails = new Map(); // essais de mot de passe ratés : 8 par profil et par 10 minutes
const locked = id => { const f = fails.get(id); return !!f && f.n >= 8 && Date.now() - f.t < 600000; };
const failed = id => { const f = fails.get(id), now = Date.now(); fails.set(id, f && now - f.t < 600000 ? { n: f.n + 1, t: f.t } : { n: 1, t: now }); if (fails.size > 500) fails.clear(); };
async function profileApi(req) {
  if (tooMany(req)) return { ok: false, error: 'trop de demandes, réessaie dans une minute' };
  if (req.method === 'GET') {
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    if (!id) return { ok: true, persistent: store.persistent };
    if (!ID_RE.test(id)) return { ok: false, error: 'Lien inconnu' };
    const p = await loadProfile(id);
    if (!p) return { ok: false, error: 'Profil introuvable' };
    return p.pw ? { ok: true, persistent: store.persistent, locked: true } : { ok: true, persistent: store.persistent, locked: false, nopw: true, pseudo: p.pseudo, cfg: p.cfg };
  }
  if (!store.persistent) return { ok: false, persistent: false, error: 'La base de données n\'est pas configurée : utilise le lien classique.' };
  let b = {}; try { b = JSON.parse(await readBody(req)); } catch { return { ok: false, error: 'requête invalide' }; }
  const id0 = String(b.id || ''), pw = String(b.password || '').slice(0, 100), npw = String(b.newPassword || '').slice(0, 100);
  let old = null;
  if (id0) {
    if (!ID_RE.test(id0) || !(old = await loadProfile(id0))) return { ok: false, error: 'Profil introuvable' };
    if (old.pw) {
      if (locked(id0)) return { ok: false, error: 'Trop d\'essais : réessaie dans 10 minutes.' };
      if (!pwCheck(pw, old.pw)) { failed(id0); return { ok: false, bad: true, error: 'Mot de passe incorrect' }; }
    }
    if (b.action === 'open') return { ok: true, pseudo: old.pseudo, cfg: old.cfg, nopw: !old.pw };
  }
  if (!id0) {
    const S = await siteLib.load();
    if (!S.open) return { ok: false, error: 'Les inscriptions sont fermées pour le moment.' };
    if (S.code && String(b.code || '').trim() !== S.code) return { ok: false, bad: 'code', error: 'Code d\'invitation incorrect' };
  }
  if ((!old || !old.pw) && npw.length < 6) return { ok: false, error: 'Choisis un mot de passe d\'au moins 6 caractères' };
  if (npw && npw.length < 6) return { ok: false, error: 'Mot de passe : 6 caractères minimum' };
  const pseudo = cfgLib.cleanPseudo(b.pseudo);
  if (pseudo.length < 2) return { ok: false, error: 'Pseudo trop court (2 caractères minimum)' };
  const cfg = cfgLib.normalize(b.cfg);
  if (cfg.tok && !sealLib.open(cfg.tok)) cfg.tok = '';
  const id = id0 || crypto.randomBytes(16).toString('base64url');
  await store.setKey('p:' + id, JSON.stringify({ pseudo, cfg, pw: npw ? pwHash(npw) : old.pw, maj: Date.now() }));
  store.log({ k: 'config', u: pseudo, niveau: 'INFO', reglages: summary(cfg), action: id0 ? 'modifiée' : 'créée' });
  return { ok: true, id, pseudo };
}

async function handler(req, res) {
  let pseudo = '';
  try {
    let seg = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).map(decodeURIComponent);
    // adresse personnelle : /c/<pseudo>/<réglages>/... (le pseudo et les réglages voyagent dans l'adresse)
    let cfg = cfgLib.DEFAULTS, base = '', auth = null;
    if (seg[0] === 'c' && seg.length >= 3) { pseudo = cfgLib.cleanPseudo(seg[1]); cfg = cfgLib.decode(seg[2]) || cfgLib.DEFAULTS; auth = cfg.hevc && cfg.tok ? sealLib.open(cfg.tok) : null; base = '/c/' + encodeURIComponent(seg[1]) + '/' + seg[2]; seg = seg.slice(3); }
    if (seg[0] === 'u' && ID_RE.test(seg[1] || '')) {
      if (!seg[2]) return send(res, 302, 'text/plain', '', { Location: '/u/' + seg[1] + '/configure' });
      if (seg[2] !== 'configure') {
        const p = await loadProfile(seg[1]);
        if (!p) return send(res, 404, 'text/plain; charset=utf-8', 'Profil introuvable : crée un nouveau lien sur /config');
        pseudo = p.pseudo; cfg = p.cfg; auth = cfg.hevc && cfg.tok ? sealLib.open(cfg.tok) : null; base = '/u/' + seg[1];
      }
      seg = seg.slice(2);
    }
    const strip = s => String(s || '').replace(/\.json$/, '');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (await adminRoute(req, res, seg)) return;
    const SS = await siteLib.load(), F = FEAT = SS.feat; store.setLog(F.logs);
    cfg = { ...cfg, relay: cfg.relay && F.relays, pc: cfg.pc && F.pc, hevc: cfg.hevc && F.hevc, audio: cfg.audio && F.audio, cap: F.capMax && (!cfg.cap || cfg.cap > F.capMax) ? F.capMax : cfg.cap };
    if (!cfg.hevc) auth = null;
    const maint = () => json(res, { streams: [{ name: '⚠️ Maintenance', title: F.maintMsg || 'Addon en maintenance, réessaie un peu plus tard.', externalUrl: originOf(req) + '/config' }] });
    // statistiques : on attend leur enregistrement avant de répondre (Vercel coupe le travail après la réponse)
    const end = res.end.bind(res);
    res.end = (...a) => { store.flush().finally(() => end(...a)); return res; };
    const t0 = Date.now(), dev = store.deviceId(req);
    store.incr('req'); store.incr('d:' + store.day() + ':req');
    if (['stream', 'catalog', 'p', 'manifest.json'].includes(seg[0])) store.uniq(dev);

    if (!seg.length) return send(res, 200, 'text/html; charset=utf-8', BLANK, { 'Cache-Control': 'no-cache' }); // accueil : page vide (la config est sur /config)
    if (seg[0] === 'logo.png') {
      const S = await siteLib.load(); let buf = null, type = 'image/png';
      if (S.logoV) { try { const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec((await store.getKey('logo')) || ''); if (m) { type = m[1]; buf = Buffer.from(m[2], 'base64'); } } catch { /* logo par défaut */ } }
      return send(res, 200, type, buf || asset('logo.png'), { 'Cache-Control': 'public, max-age=300' });
    }
    if (seg[0] === 'logo.svg') return send(res, 200, 'image/svg+xml', asset('logo.svg'), { 'Cache-Control': 'public, max-age=86400' });
    if (seg[0] === 'config' || seg[0] === 'configure') return send(res, 200, 'text/html; charset=utf-8', await configPage(), { 'Cache-Control': 'no-cache' });
    if (seg[0] === 'api' && seg[1] === 'profile') return json(res, await profileApi(req));
    if (seg[0] === 'api' && seg[1] === 'seal' && req.method === 'POST') return json(res, await sealToken(req));
    if (seg[0] === 'api' && seg[1] === 'report' && req.method === 'POST') return json(res, await report(req, dev));
    if (seg[0] === 'manifest.json') {
      store.log({ k: 'install', u: pseudo || undefined, appareil: cfg.device || undefined, reglages: pseudo ? summary(cfg) : 'défaut', dev }); store.user(pseudo, { cfg: { ...cfg, tok: undefined, compte: !!cfg.tok }, dev: cfg.device });
      const S = await siteLib.load(), mf = { ...MANIFEST, name: S.name, logo: originOf(req) + '/logo.png?v=' + S.logoV }, GL = await Promise.race([gameList(), new Promise(r => setTimeout(() => r(GAMES), 3000))]);
      mf.catalogs = [{ type: 'tv', id: 'twitch-top', name: 'Twitch · Lives par jeu', extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false, options: GL }] }];
      if (S.feat.vods) mf.catalogs.push({ type: 'series', id: 'twitch-vods', name: 'Twitch · Rediffusions', extra: [{ name: 'search', isRequired: false }] });
      if (S.feat.vods && S.feat.followed && auth) mf.catalogs.unshift({ type: 'series', id: 'twitch-myvods', name: 'Twitch · Mes rediffusions', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] });
      if (auth && S.feat.followed) mf.catalogs = [{ type: 'tv', id: 'twitch-followed', name: 'Twitch · Mes chaînes suivies', extra: [{ name: 'genre', isRequired: false, options: GL }] }, ...mf.catalogs];
      return json(res, pseudo ? { ...mf, name: S.name + ' · ' + pseudo, description: MANIFEST.description + ' — profil de ' + pseudo } : mf);
    }

    if (seg[0] === 'check') { // vérification d'un profil (page de configuration) : serveur, Twitch, relais, compte lié
      const out = { v: require('./package.json').version, maint: !!F.maint, stockage: store.persistent, catalogues: ['Lives par jeu'].concat(F.vods ? ['Rediffusions'] : [], auth && F.followed ? ['Mes chaînes suivies'] : []) };
      const timed = async f => { const t = Date.now(); try { return { ok: true, ms: Date.now() - t, ...(await f()) }; } catch (e) { return { ok: false, ms: Date.now() - t, err: String(e.message).slice(0, 120) }; } };
      let sample = null, live = false;
      out.twitch = await timed(async () => { // Twitch répond-il ? (une chaîne quelconque suffit, en ligne ou non)
        const d = await gqlRaw('query { user(login: "twitch") { login } }'); if (!d.user) throw new Error('réponse vide de Twitch');
        sample = 'twitch';
        try { const L = (await liveStreams('')) || []; if (L.length) { sample = L[0].login; live = true; return { n: L.length }; } } catch { /* repli ci-dessous */ }
        if (auth) { try { const L = (await followedChannels(auth)).filter(x => x.info.live); if (L.length) { sample = L[0].login; live = true; return { n: L.length }; } } catch { /* sans live */ } }
        return { n: 0 };
      });
      if (cfg.relay && F.relays) out.relais = await timed(async () => { if (!live) return { nom: null, total: proxyList().length, sansLive: true }; const b = await Promise.race([bestProxy(sample, false), new Promise((_, r) => setTimeout(() => r(new Error('aucun relais ne répond')), 7000))]); if (!b) throw new Error('aucun relais ne répond'); return { nom: b.name, total: proxyList().length }; });
      if (cfg.tok && auth) out.compte = await timed(async () => { const t = await accessToken(sample || 'twitch', 'site', GQL_CLIENT_ID, { oauth: auth }), j = JSON.parse(t.value); if (!j.user_id) throw new Error('compte non reconnu par Twitch (jeton expiré ?)'); return { resolution: j.maximum_resolution || '?' }; });
      return json(res, out, { 'Cache-Control': 'no-store' });
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

    if (seg[0] === 'm' && seg[1]) { // liste de lecture d'une qualité, nettoyée (mode ordinateur)
      const u = sealLib.open(strip(seg[1]).replace(/\.m3u8$/, ''));
      if (!u || !/^https:\/\//.test(u)) return send(res, 400, 'text/plain; charset=utf-8', 'Lien invalide');
      const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      const t = await r.text();
      if (!r.ok || !t.startsWith('#EXTM3U')) return send(res, r.ok ? 502 : r.status, 'text/plain; charset=utf-8', 'Flux indisponible');
      const body = cleanMedia(absolutize(t, u));
      return send(res, 200, 'application/vnd.apple.mpegurl', /cloudfront/.test(u) ? body.replace(/-unmuted/g, '-muted') : body, { 'Cache-Control': 'no-store' }); // rediffs réservées aux abonnés : seuls les segments « muted » sont ouverts
    }

    if (seg[0] === 'p' && seg[1]) { // liste de lecture « sans pub » : récupérée côté serveur auprès d'un relais, puis servie au lecteur
      const login = strip(seg[1]).replace(/\.m3u8$/, '').toLowerCase();
      if (!LOGIN_RE.test(login)) return send(res, 400, 'text/plain; charset=utf-8', 'Nom de chaîne invalide');
      if (F.maint) return send(res, 503, 'text/plain; charset=utf-8', 'Addon en maintenance');
      const fin = m => pcOn(cfg) ? pcMaster(m, originOf(req), base) : m;
      const [b, lv] = await Promise.all([cfg.relay ? bestProxy(login, cfg.hevc) : null, cfg.hevc && cfg.relay ? liveStream(login, true, auth).catch(() => null) : null]);
      store.incr('play'); store.top(login); store.user(pseudo, { ch: login, dev: cfg.device });
      store.log({ k: 'play', u: pseudo || undefined, ch: login, relais: b ? b.name : cfg.relay ? 'officiel (repli)' : 'officiel (relais coupés)', ms: Date.now() - t0, appareil: cfg.device || undefined, dev });
      if (b) return send(res, 200, 'application/vnd.apple.mpegurl', fin(cfgLib.filterMaster(mergedMaster(b, lv, cfg), cfg)), { 'Cache-Control': 'no-store', 'X-Relais': b.name });
      const s = await liveStream(login, cfg.hevc, auth); // aucun relais : flux officiel, servi par nous pour appliquer le plafond de qualité
      if (s.offline) return send(res, 404, 'text/plain; charset=utf-8', 'Chaîne hors ligne');
      const o = await fetch(s.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }).then(r => r.text());
      return send(res, 200, 'application/vnd.apple.mpegurl', fin(cfgLib.filterMaster(o, cfg)), { 'Cache-Control': 'no-store' });
    }
    if (seg[0] === 'relais' && seg[1]) { // diagnostic : quels relais répondent depuis Vercel ?
      const login = seg[1].toLowerCase();
      if (!LOGIN_RE.test(login)) return json(res, { erreur: 'nom de chaîne invalide' });
      return json(res, await relayReport(login));
    }
    if (seg[1] === 'series' && F.vods) { // rediffusions : chaîne = série, rediffs = saison 1, temps forts = saison 2
      try {
        if (seg[0] === 'catalog' && strip(seg[2]) === 'twitch-myvods') { // toutes mes chaînes suivies, en ligne ou non : on ouvre une chaîne pour voir ses rediffs
          if (!auth || !F.followed) return json(res, { metas: [] });
          const ex = extraOf(seg[3]), q = (ex.get('search') || '').trim().toLowerCase(), skip = Math.max(0, parseInt(ex.get('skip'), 10) || 0);
          const all = (await followedAll(auth)).filter(x => !q || x.name.toLowerCase().includes(q) || x.login.includes(q));
          store.log({ k: 'catalog', u: pseudo || undefined, n: all.length, mesRediffs: true, dev });
          return json(res, { metas: all.slice(skip, skip + 100).map(x => ({ id: 'twitchvod:' + x.login, type: 'series', name: x.name, poster: x.avatar, posterShape: 'square', description: x.live ? '🔴 En direct · ' + fmtN(x.viewers) + ' 👁' : 'Rediffusions de ' + x.name, releaseInfo: x.live ? '🔴 En direct' : undefined })) }, { 'Cache-Control': 'no-store' });
        }
        if (seg[0] === 'catalog') {
          const q = (extraOf(seg[3]).get('search') || '').trim().toLowerCase().replace(/^@/, '');
          let logins = [];
          if (q) logins = LOGIN_RE.test(q) ? [q] : [];
          else if (auth) logins = (await followedChannels(auth).catch(() => [])).slice(0, 24).map(x => x.login);
          else logins = ((await liveStreams('').catch(() => [])) || []).slice(0, 24).map(x => x.login);
          const vs = (await withTimeout(Promise.all(logins.map(l => withTimeout(channelVods(l), 6000, null).catch(() => null))), 7000, [])).filter(Boolean);
          store.log({ k: 'catalog', u: pseudo || undefined, n: vs.length, rediffs: true, dev });
          return json(res, { metas: vs.map(v => vodMeta(v)) }, { 'Cache-Control': 'public, s-maxage=60' });
        }
        if (seg[0] === 'meta') {
          const login = strip(seg[2]).replace(/^twitchvod:/, '').toLowerCase();
          const v = LOGIN_RE.test(login) ? await channelVods(login) : null;
          return json(res, { meta: v ? vodMeta(v, true) : null });
        }
        if (seg[0] === 'stream') {
          if (F.maint) return maint();
          const m = /^twitchvod:([^:]+):(\d+)$/.exec(strip(seg[2]));
          if (!m) return json(res, { streams: [] });
          const vm = await vodMaster(m[2], auth), vars = variantsOf(vm.text), video = vars.filter(v => !v.audio && cfgLib.keepVariant(v, cfg)).sort(byQuality);
          store.incr('vod'); store.user(pseudo, { ch: m[1], dev: cfg.device }); store.log({ k: 'stream', u: pseudo || undefined, ch: m[1], etat: 'rediff', ms: Date.now() - t0, dev });
          const tier = h => h >= 1440 ? 'Ultra HD' : h >= 1080 ? 'Full HD' : h >= 720 ? 'HD' : h >= 480 ? 'SD' : 'Éco';
          const fixed = video.slice(0, cfg.fixed).map(v => ({ name: 'Twitch\n' + (v.h ? v.h + 'p' + (v.fps > 30 ? v.fps : '') : v.name), title: '📼 Rediffusion\n📺 ' + tier(v.h) + (v.fps ? ' · ' + (v.fps > 30 ? v.fps : 30) + ' images/s' : ''), url: pcOn(cfg) || (vm.direct && sealLib.available()) ? pcUrl(originOf(req), base, v.url) : v.url }));
          const auto = { name: 'Twitch\nAuto', title: '📼 Rediffusion\n✨ Auto' + (cfg.cap ? ' · max ' + cfg.cap + 'p' : ' · meilleure qualité'), url: originOf(req) + base + '/v/' + m[2] + '.m3u8' };
          return json(res, { streams: [auto, ...fixed] });
        }
      } catch (e) { store.incr('err'); store.log({ k: 'erreur', u: pseudo || undefined, ou: 'rediffusions', msg: e.message });
        const vm = seg[0] === 'stream' && /^twitchvod:[^:]+:(\d+)$/.exec(strip(seg[2])); // rediff illisible (souvent réservée aux abonnés) : lien vers Twitch
        if (vm) return json(res, { streams: [{ name: 'Twitch\n🔒 Abonnés', title: '🔒 Rediff réservée\naux abonnés ou\nindisponible\n↗ Ouvrir sur Twitch', externalUrl: 'https://www.twitch.tv/videos/' + vm[1] }] });
        return json(res, seg[0] === 'catalog' ? { metas: [] } : seg[0] === 'meta' ? { meta: null } : { streams: [] }); }
    }
    if (seg[0] === 'v' && seg[1] && F.vods) { // liste de lecture d'une rediffusion avec le plafond de qualité du profil
      const id = strip(seg[1]).replace(/\.m3u8$/, '');
      if (!/^\d+$/.test(id)) return send(res, 400, 'text/plain; charset=utf-8', 'Rediffusion invalide');
      const vm = await vodMaster(id, auth), fin = pcOn(cfg) || (vm.direct && sealLib.available()) ? pcMaster(vm.text, originOf(req), base) : vm.text;
      return send(res, 200, 'application/vnd.apple.mpegurl', cfgLib.filterMaster(fin, cfg), { 'Cache-Control': 'no-store' });
    }
    if (seg[0] === 'catalog' && seg[1] === 'tv' && strip(seg[2]) === 'twitch-followed') {
      if (!auth || !F.followed) return json(res, { metas: [] });
      try {
        const L = byGame((await followedChannels(auth)).filter(x => x.info.live), extraOf(seg[3]).get('genre'), x => x.info.game); // seules les chaînes en direct : les autres apparaissent quand elles passent en ligne
        store.log({ k: 'catalog', u: pseudo || undefined, n: L.length, suivis: true, dev });
        return json(res, { metas: L.map(catalogMeta) }, { 'Cache-Control': 'no-store' });
      } catch (e) { store.incr('err'); store.log({ k: 'erreur', u: pseudo || undefined, ou: 'catalogue des chaînes suivies', msg: e.message }); return json(res, { metas: [] }); }
    }
    if (seg[0] === 'catalog' && seg[1] === 'tv' && strip(seg[2]) === 'twitch-top' && F.catalog) { // sans jeu : les plus regardés ; avec un jeu (menu ou recherche) : ses lives
      const ex = extraOf(seg[3]), genre = ex.get('genre'), q = (ex.get('search') || '').trim();
      try {
        if (genre || !q) { const L = await liveStreams(genre || ''); store.log({ k: 'catalog', u: pseudo || undefined, n: L ? L.length : 0, jeu: genre || 'populaires', dev }); return json(res, { metas: (L || []).map(catalogMeta) }, { 'Cache-Control': 'public, s-maxage=30' }); }
        const gm = q.length >= 3 ? await gameOf(q) : null;
        if (gm) { const L = await withTimeout(liveStreams(gm), 6000, null); if (L && L.length) { store.log({ k: 'catalog', u: pseudo || undefined, n: L.length, jeu: gm, dev }); return json(res, { metas: L.map(catalogMeta) }, { 'Cache-Control': 'public, s-maxage=30' }); } }
      } catch (e) { store.incr('err'); store.log({ k: 'erreur', u: pseudo || undefined, ou: 'catalogue des lives par jeu', msg: e.message }); }
    }
    if (seg[0] === 'catalog' && seg[1] === 'tv') {
      const search = seg[3] ? (new URLSearchParams(strip(seg[3])).get('search') || '').trim().toLowerCase().replace(/^@/, '') : '';
      if (search) { // recherche d'une chaîne par son nom (sans clés Twitch) : la fiche s'ouvre, puis le live se lance
        if (!LOGIN_RE.test(search)) return json(res, { metas: [] });
        const info = await channelInfo(search);
        if (info && !info.live) return json(res, { metas: [] }); // hors ligne : pas proposée dans les lives (ses rediffs restent dans « Rediffusions »)
        let meta = info ? metaFromInfo(search, info) : { id: 'twitch:' + search, type: 'tv', name: search, poster: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_' + search + '-440x248.jpg', posterShape: 'landscape' };
        if (!info) { try { const s = (await helix('/streams', { user_login: search }))[0]; if (s) meta = metaOf(s); } catch { /* sans clés : fiche simple */ } }
        return json(res, { metas: [meta] });
      }
      let list = [];
      if (!F.catalog) return json(res, { metas: [] });
      try { list = byGame(await helix('/streams', { first: extraOf(seg[3]).get('genre') ? 100 : 50 }), extraOf(seg[3]).get('genre'), x => x.game_name); store.log({ k: 'catalog', n: list.length, dev }); } catch (e) { console.error('catalogue :', e.message); store.incr('err'); store.log({ k: 'erreur', ou: 'catalogue', msg: e.message }); } // sans identifiants : catalogue vide
      return json(res, { metas: list.map(metaOf) }, { 'Cache-Control': 'public, s-maxage=30' });
    }
    if (seg[0] === 'meta' && seg[1] === 'tv') {
      const login = strip(seg[2]).replace(/^twitch:/, '').toLowerCase();
      if (!LOGIN_RE.test(login)) return json(res, { meta: null });
      const info = await channelInfo(login);
      let meta = info ? metaFromInfo(login, info) : { id: 'twitch:' + login, type: 'tv', name: login, poster: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_' + login + '-440x248.jpg', posterShape: 'landscape' };
      if (!info) { try { const s = (await helix('/streams', { user_login: login }))[0]; if (s) meta = metaOf(s); } catch { /* fiche minimale */ } }
      return json(res, { meta });
    }
    if (seg[0] === 'stream' && seg[1] === 'tv') {
      const login = strip(seg[2]).replace(/^twitch:/, '').toLowerCase();
      if (!LOGIN_RE.test(login)) return json(res, { streams: [] });
      if (F.maint) return maint();
      const [s, b, info] = await Promise.all([liveStream(login, cfg.hevc, auth), cfg.relay ? bestProxy(login, cfg.hevc) : null, Promise.race([channelInfo(login), new Promise(r => setTimeout(() => r(null), 1500))])]);
      store.incr('stream'); store.incr('d:' + store.day() + ':stream'); store.user(pseudo, { ch: login, dev: cfg.device });
      const who = { u: pseudo || undefined, appareil: cfg.device || undefined, dev };
      if (s.offline) { store.incr('stream_offline'); store.log({ k: 'stream', ...who, ch: login, etat: 'hors ligne', ms: Date.now() - t0 }); return json(res, { streams: [] }); }
      store.incr(b ? 'stream_relay' : 'stream_official'); store.top(login);
      store.log({ k: 'stream', ...who, ch: login, relais: b ? b.name : cfg.relay ? 'aucun (officiel)' : 'coupés (officiel)', relais_ms: b ? b.ms : undefined, ms: Date.now() - t0, plafond: cfg.cap || undefined });
      // Un relais répond : tous les flux passent par lui (sans pub). Sinon : flux officiel.
      const vars = b ? variantsOf(mergedMaster(b, s, cfg)) : s.variants;
      const relayUrls = b ? new Set(variantsOf(absolutize(b.text, b.url)).map(v => v.url)) : null;
      const video = vars.filter(v => !v.audio && cfgLib.keepVariant(v, cfg)).sort(byQuality);
      // Affichage dans la liste des sources de Stremio : nom court à gauche, détails sur plusieurs lignes à droite.
      try {
      // Colonne de droite étroite dans Stremio : lignes courtes (≈ 24 caractères) pour ne rien couper.
      const cut = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);
      const nb = info && info.viewers ? fmtN(info.viewers) : '';
      const adLine = ok => ok ? '🚫 Sans pub' : '⚠️ Officiel · avec pubs';
      const entry = (name, lines, url) => ({ name, title: lines.filter(Boolean).join('\n'), url });
      const label = v => {
        const m = /(\d{3,4})p(\d+)?/.exec(v.name) || [], h = Number(m[1] || v.h || 0), f = m[2] || (v.fps > 30 ? String(v.fps) : '30');
        const tier = h >= 1440 ? 'Ultra HD' : h >= 1080 ? 'Full HD' : h >= 720 ? 'HD' : h >= 480 ? 'SD' : 'Éco';
        return { short: h ? h + 'p' + (m[2] || (v.fps > 30 ? v.fps : '')) : v.name.replace(/ \(source\)/, ''), long: h ? '📺 ' + tier + ' · ' + f + ' images/s' : '📺 ' + v.name };
      };
      const fixed = video.slice(0, cfg.fixed).map(v => { const l = label(v); return entry('Twitch\n' + l.short, [l.long, adLine(!!relayUrls && relayUrls.has(v.url))], pcOn(cfg) ? pcUrl(originOf(req), base, v.url) : v.url); });
      const auto = entry('Twitch\nAuto', ['🔴 En direct' + (nb ? ' · ' + nb + ' 👁' : ''), info && info.game ? '🎮 ' + cut(info.game, 22) : '', '✨ Auto' + (cfg.cap ? ' · max ' + cfg.cap + 'p' : ' · meilleure qualité'), adLine(!!b)], originOf(req) + base + '/p/' + login + '.m3u8');
      const audio = cfg.audio ? vars.filter(v => v.audio).slice(0, 1).map(v => entry('Twitch\nAudio', ['🎧 Audio seul', adLine(!!b)], v.url)) : [];
      return json(res, { streams: [auto, ...fixed, ...audio] });
      } catch (e) { // mise en forme impossible : liste simple, pour ne jamais perdre les flux
        store.log({ k: 'erreur', u: pseudo || undefined, ou: 'mise en forme des sources', msg: e.message });
        const plain = video.slice(0, cfg.fixed).map(v => ({ name: 'Twitch ' + v.name.replace(/ \(source\)/, ''), title: 'En direct · qualité fixe' + (b ? ' · sans pub' : ''), url: pcOn(cfg) ? pcUrl(originOf(req), base, v.url) : v.url }));
        return json(res, { streams: [{ name: 'Twitch', title: 'En direct · qualité automatique' + (b ? ' · sans pub' : ''), url: originOf(req) + base + '/p/' + login + '.m3u8' }, ...plain] });
      }
    }
    send(res, 404, 'text/html; charset=utf-8', BLANK);
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
