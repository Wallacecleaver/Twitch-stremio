'use strict';
// Réglages du site (nom, logo, couleur, textes, accès) : modifiables depuis le dashboard, gardés dans Upstash.
const store = require('./store');
const cfgLib = require('./settings');
const DEF = { name: process.env.ADDON_NAME || 'TwitchIO', color: '#9d5cff', title: 'Les lives Twitch, dans Stremio', text: '', credit: '', banner: '', open: true, code: '', legal: 'Addon gratuit et non officiel · n\'héberge aucun contenu', dcOn: true, dcUrl: 'https://discord.gg/KN3vRqTHDa', dcTitle: 'Rejoins Stremio FR', dcText: 'Entraide, nouveautés et idées pour l\'addon', def: { cap: 0, fps60: true, relay: true, pc: false, fmt: 'classique' }, logoV: 0,
  feat: { relays: true, pc: true, hevc: true, audio: true, catalog: true, followed: true, vods: true, fast: process.env.FAST_BREAD === '1', logs: true, maint: false, maintMsg: '', capMax: 0, timeout: 2500, offRelays: [] } };
const DISCORD_RE = /^https:\/\/(discord\.gg|discord\.com\/invite)\/[A-Za-z0-9_-]{2,40}$/;
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
function clean(o = {}) {
  const c = {
    name: (nm => nm && nm !== 'Wallace Live' ? nm : DEF.name)(str(o.name, 40)), color: /^#[0-9a-f]{6}$/i.test(o.color || '') ? o.color.toLowerCase() : DEF.color,
    title: str(o.title, 80) || DEF.title, text: str(o.text, 400), credit: str(o.credit, 120), banner: str(o.banner, 200),
    legal: str(o.legal, 140) || DEF.legal, dcOn: o.dcOn !== false, dcUrl: DISCORD_RE.test(str(o.dcUrl, 100)) ? str(o.dcUrl, 100) : DEF.dcUrl,
    dcTitle: str(o.dcTitle, 50) || DEF.dcTitle, dcText: o.dcText === undefined ? DEF.dcText : str(o.dcText, 100),
    open: o.open !== false, code: str(o.code, 40), def: { ...DEF.def }, logoV: Number(o.logoV) || 0,
  };
  const f = o.feat && typeof o.feat === 'object' ? o.feat : {}, D = DEF.feat, b = (k) => (f[k] === undefined ? D[k] : f[k] !== false), tm = Number(f.timeout);
  c.feat = { relays: b('relays'), pc: b('pc'), hevc: b('hevc'), audio: b('audio'), catalog: b('catalog'), followed: b('followed'), vods: b('vods'), logs: b('logs'), fast: f.fast === undefined ? D.fast : f.fast === true, maint: f.maint === true, maintMsg: str(f.maintMsg, 160),
    capMax: [0, 1440, 1080, 720, 480].includes(Number(f.capMax)) ? Number(f.capMax) : 0, timeout: tm >= 1000 && tm <= 8000 ? Math.round(tm) : D.timeout, offRelays: Array.isArray(f.offRelays) ? f.offRelays.map(x => str(x, 60)).filter(Boolean).slice(0, 60) : [] };
  if (o.def && typeof o.def === 'object') { const n = cfgLib.normalize(o.def); c.def = { cap: n.cap, fps60: n.fps60, relay: n.relay, pc: n.pc, fmt: n.fmt }; }
  return c;
}
let cache = null, at = 0;
async function load(force) {
  if (!force && cache && Date.now() - at < 15000) return cache;
  let o = {}; try { const r = await store.getKey('site'); if (r) o = JSON.parse(r); } catch { /* base indisponible : valeurs par défaut */ }
  cache = clean(o); at = Date.now(); return cache;
}
async function save(o) { const cur = await load(true), c = clean({ ...cur, ...o, feat: o.feat ? { ...cur.feat, ...o.feat } : cur.feat, logoV: cur.logoV }); await store.setKey('site', JSON.stringify(c)); cache = c; at = Date.now(); return c; }
async function setLogo(data) {
  const cur = await load(true);
  if (!data) { await store.delKey('logo'); cache = clean({ ...cur, logoV: 0 }); await store.setKey('site', JSON.stringify(cache)); at = Date.now(); return { ok: true, site: cache }; }
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(data)) || data.length > 400000) return { ok: false, error: 'Image refusée (PNG, JPG ou WebP, 300 Ko maximum).' };
  await store.setKey('logo', data); cache = clean({ ...cur, logoV: Date.now() }); await store.setKey('site', JSON.stringify(cache)); at = Date.now();
  return { ok: true, site: cache };
}
module.exports = { load, save, setLogo, clean, DEF, DISCORD_RE };
