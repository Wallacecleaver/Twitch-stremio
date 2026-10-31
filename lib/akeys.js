'use strict';
// Clés d'accès au serveur : sans clé valide dans son profil, personne ne peut faire passer sa vidéo par ce serveur (réglage « Via le serveur de l'addon »).
// Les clés se créent dans le dashboard (onglet Vidéo). Elles ne servent qu'à ça : le téléchargement direct et le Worker Cloudflare n'en ont pas besoin.
const crypto = require('crypto');
const store = require('./store');

const KEY = 'akeys';
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans 0, O, 1, I, L : plus facile à recopier
const norm = k => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const show = id => (id.match(/.{1,4}/g) || []).join('-');
let M = null; // identifiant (12 caractères) -> { name, created, exp, max, off }
const all = () => {
  if (M) return M;
  try { const o = JSON.parse(store.peek(KEY) || '{}'); M = o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { M = {}; }
  return M;
};
const persist = () => store.setKey(KEY, JSON.stringify(all()));
const gen = () => { const b = crypto.randomBytes(12); let s = ''; for (let i = 0; i < 12; i++) s += ALPHA[b[i] % ALPHA.length]; return s; };

// La clé existe-t-elle, et est-elle active (ni désactivée ni expirée) ?
function check(k) {
  const id = norm(k), r = id && all()[id];
  if (!r) return { ok: false, why: 'inconnue' };
  if (r.off) return { ok: false, why: 'désactivée' };
  if (r.exp && Date.now() > r.exp) return { ok: false, why: 'expirée' };
  return { ok: true, id, rec: r };
}

// Réglages de tous les profils enregistrés (gardés 20 s : le dashboard et l'enregistrement d'un profil s'en servent)
let pc = { at: 0, v: [] };
async function profiles() {
  if (Date.now() - pc.at < 20000) return pc.v;
  const out = [];
  for (const id of await store.profIds()) {
    try { const p = JSON.parse((await store.getKey('p:' + id)) || '{}'), c = p.cfg || {}; out.push({ id, pseudo: p.pseudo || '', seg: c.pc ? c.seg || 'auto' : 'auto', akey: norm(c.akey) }); } catch { /* profil illisible : ignoré */ }
  }
  pc = { at: Date.now(), v: out }; return out;
}
const forget = () => { pc = { at: 0, v: [] }; };
// Combien de profils (hors celui qu'on enregistre) utilisent déjà cette clé ?
async function usedBy(id, exceptProfile) { forget(); return (await profiles()).filter(p => p.akey === id && p.seg === 'addon' && p.id !== exceptProfile).length; }
async function mix() { const m = { auto: 0, direct: 0, worker: 0, addon: 0 }; for (const p of await profiles()) m[p.seg] = (m[p.seg] || 0) + 1; return m; }

async function view() {
  forget();
  const P = await profiles(), st = (await store.snapshot(1)).stats, now = Date.now();
  return {
    keys: Object.entries(all()).map(([id, r]) => ({
      id, key: show(id), name: r.name || '', created: r.created || 0, exp: r.exp || 0, max: r.max || 1, off: !!r.off,
      status: r.off ? 'off' : r.exp && now > r.exp ? 'exp' : 'ok',
      profiles: P.filter(p => p.akey === id && p.seg === 'addon').map(p => p.pseudo || '?'),
      bytes: st['akb:' + id] || 0, n: st['akn:' + id] || 0,
    })).sort((a, b) => b.created - a.created),
  };
}

// create { name, days (0 = sans limite), max } · toggle { id } · remove { id }
async function act(b) {
  b = b && typeof b === 'object' ? b : {};
  const m = all();
  if (b.op === 'create') {
    const name = String(b.name || '').trim().slice(0, 40), days = Math.max(0, Math.min(3650, Number(b.days) || 0)), max = Math.max(1, Math.min(100, Math.floor(Number(b.max) || 1)));
    if (!name) return { ok: false, error: 'Donne un nom à la clé (la personne à qui tu la donnes, par exemple).' };
    if (Object.keys(m).length >= 500) return { ok: false, error: 'Trop de clés : supprime les anciennes.' };
    let id; do id = gen(); while (m[id]);
    m[id] = { name, created: Date.now(), exp: days ? Date.now() + days * 864e5 : 0, max };
    await persist(); forget();
    return { ok: true, created: show(id), ...(await view()) };
  }
  const id = norm(b.id);
  if (!m[id]) return { ok: false, error: 'Clé introuvable.' };
  if (b.op === 'toggle') m[id].off = !m[id].off;
  else if (b.op === 'remove') delete m[id];
  else return { ok: false, error: 'Action inconnue.' };
  await persist(); forget();
  return { ok: true, ...(await view()) };
}

module.exports = { check, usedBy, mix, view, act, profiles, forget, norm };
