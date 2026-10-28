'use strict';
const crypto = require('crypto');
const store = require('./store');
const siteLib = require('./site');
const PASS = process.env.ADMIN_PASSWORD || '';
const sig = () => crypto.createHmac('sha256', PASS).update('twitch-admin-v1').digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const cookieOf = req => Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).map(c => c.split(/=(.*)/s).slice(0, 2)));
const authed = req => !!PASS && safeEq(cookieOf(req).adm || '', sig());
const body = (req, max = 1e4) => new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > max) req.destroy(); }); req.on('end', () => r(b)); });
const fails = new Map(); // anti force brute : 8 essais / 10 min / adresse

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
module.exports = function admin({ send, json, relayReport, probe, check, account, config }) {
  return async function (req, res, seg) {
    if (seg[0] !== 'admin') return false;
    const ip = store.ipOf(req);
    const secure = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Frame-Options': 'DENY' };
    const nm = escapeHtml((await siteLib.load()).name), page = h => h.replace(/\{\{NAME\}\}/g, () => nm);
    if (!PASS) return send(res, 200, 'text/html; charset=utf-8', page(PAGE_SETUP), secure), true;

    if (seg[1] === 'login' && req.method === 'POST') {
      const f = fails.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - f.t > 6e5) { f.n = 0; f.t = Date.now(); }
      if (f.n >= 8) return json(res, { ok: false, error: 'Trop d\'essais, réessaie dans quelques minutes.' }), true;
      let pw = ''; try { pw = JSON.parse(await body(req)).password || ''; } catch { /* vide */ }
      if (!safeEq(pw, PASS)) { f.n++; fails.set(ip, f); return json(res, { ok: false, error: 'Mot de passe incorrect.' }), true; }
      fails.delete(ip);
      return json(res, { ok: true }, { 'Set-Cookie': 'adm=' + sig() + '; Path=/admin; HttpOnly;' + (req.socket.encrypted || /https/i.test(String(req.headers['x-forwarded-proto'] || '')) ? ' Secure;' : '') + ' SameSite=Strict; Max-Age=2592000' }), true;
    }
    if (seg[1] === 'logout') return send(res, 302, 'text/plain', '', { Location: '/admin', 'Set-Cookie': 'adm=; Path=/admin; Max-Age=0' }), true;
    if (!authed(req)) return send(res, 200, 'text/html; charset=utf-8', page(PAGE_LOGIN), secure), true;

    if (!seg[1]) return send(res, 200, 'text/html; charset=utf-8', PAGE(), secure), true;
    if (seg[1] !== 'api') return send(res, 404, 'text/plain', 'Introuvable'), true;
    const q = new URL(req.url, 'http://x').searchParams;
    try {
      if (seg[2] === 'state') return json(res, { ...(await store.snapshot(Math.min(Number(q.get('n')) || 300, 500))), config: config(), now: Date.now(), up: process.uptime(), sys: { mem_mb: Math.round(process.memoryUsage().rss / 1048576), region: require('os').hostname(), node: process.version } }), true;
      if (seg[2] === 'check') {
        const as = String(q.get('as') || ''), snap = as ? await store.snapshot(1) : null, u = snap && snap.users.find(x => x.pseudo === as);
        return json(res, await check(String(q.get('channel') || '').toLowerCase().replace(/^@/, ''), q.get('hevc') === '1' ? { ...(u && u.cfg || {}), hevc: true } : u && u.cfg, as)), true;
      }
      if (seg[2] === 'ownerbase') return json(res, { sealed: await account.sealed() }), true;
      if (seg[2] === 'account') {
        if (req.method === 'POST') { const b = JSON.parse((await body(req)) || '{}'); return json(res, seg[3] === 'unlink' ? await account.unlink() : await account.link(b.token)), true; }
        return json(res, await account.status(String(q.get('channel') || 'twitch').toLowerCase())), true;
      }
      if (seg[2] === 'export') {
        const rows = (await store.snapshot(500)).logs, fmt = q.get('fmt') === 'json' ? 'json' : 'csv';
        if (fmt === 'json') return send(res, 200, 'application/json', JSON.stringify(rows, null, 1), { 'Content-Disposition': 'attachment; filename="journal-twitch.json"', ...secure }), true;
        const cols = ['date', 'niveau', 'contexte', 'utilisateur', 'appareil', 'chaine', 'details'], esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
        const csv = [cols.join(',')].concat(rows.map(l => { const { t, lvl, k, u, appareil, ch, dev, ...r } = l; return [new Date(t).toISOString(), lvl, k, u, appareil, ch, JSON.stringify(r)].map(esc).join(','); })).join('\n');
        return send(res, 200, 'text/csv; charset=utf-8', '\ufeff' + csv, { 'Content-Disposition': 'attachment; filename="journal-twitch.csv"', ...secure }), true;
      }
      if (seg[2] === 'profiles') { // profils enregistrés : liste, réinitialisation du mot de passe, suppression (l'identifiant complet n'est jamais renvoyé)
        const refOf = id => crypto.createHash('sha256').update('ref|' + id).digest('hex').slice(0, 10);
        if (req.method === 'POST') {
          const b = JSON.parse((await body(req)) || '{}'), id = (await store.profIds()).find(i => refOf(i) === b.ref);
          if (!id) return json(res, { ok: false, error: 'Profil introuvable' }), true;
          const p = JSON.parse((await store.getKey('p:' + id)) || '{}');
          if (b.action === 'delete') { await store.delKey('p:' + id); store.log({ k: 'config', u: p.pseudo, niveau: 'INFO', action: 'profil supprimé par l\'administrateur' }); }
          else { await store.setKey('p:' + id, JSON.stringify({ ...p, pw: '' })); store.log({ k: 'config', u: p.pseudo, niveau: 'INFO', action: 'mot de passe réinitialisé par l\'administrateur' }); }
          await store.flush();
          return json(res, { ok: true }), true;
        }
        const rows = [];
        for (const id of await store.profIds()) { try { const p = JSON.parse(await store.getKey('p:' + id)); rows.push({ ref: refOf(id), pseudo: p.pseudo, device: (p.cfg || {}).device || '', pw: !!p.pw, compte: !!(p.cfg || {}).tok, hevc: !!(p.cfg || {}).hevc, pc: !!(p.cfg || {}).pc, maj: p.maj || 0 }); } catch { /* ignoré */ } }
        return json(res, { profils: rows.sort((x, y) => y.maj - x.maj) }), true;
      }
      if (seg[2] === 'site') { // réglages de la page /config : nom, logo, couleur, textes, accès
        if (seg[3] === 'logo' && req.method === 'POST') { const b = JSON.parse((await body(req, 450000)) || '{}'); return json(res, await siteLib.setLogo(b.data)), true; }
        if (req.method === 'POST') { const b = JSON.parse((await body(req)) || '{}'); return json(res, { ok: true, site: await siteLib.save(b) }), true; }
        return json(res, await siteLib.load(true)), true;
      }
      if (seg[2] === 'relays') return json(res, await relayReport(String(q.get('channel') || '').toLowerCase())), true;
      if (seg[2] === 'probe') return json(res, await probe(String(q.get('channel') || '').toLowerCase())), true;
      if (seg[2] === 'reset' && req.method === 'POST') { await store.reset(q.get('what') === 'logs' ? 'logs' : 'all'); return json(res, { ok: true }), true; }
    } catch (e) { return json(res, { error: e.message }), true; }
    return json(res, { error: 'inconnu' }), true;
  };
};

const CSS = `:root{--bg:#0e0e10;--p:#18181b;--p2:#1f1f23;--b:#2d2d33;--t:#efeff1;--m:#a1a1aa;--a:#9147ff;--ok:#22c55e;--ko:#ef4444;--w:#f59e0b}
*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;background:var(--bg);color:var(--t);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--a)}h1,h2,h3{margin:0}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}`;

const PAGE_SETUP = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>{{NAME}} · Admin</title><link rel=icon type=image/png href=/logo.png><style>${CSS}
body{display:grid;place-items:center;min-height:100vh;padding:16px}.c{max-width:480px;background:var(--p);border:1px solid var(--b);border-radius:12px;padding:24px}code{background:var(--p2);padding:2px 6px;border-radius:4px}</style>
<div class=c><h2 style="display:flex;align-items:center;gap:10px"><img src=/logo.png width=34 height=34 alt="" style="border-radius:10px">{{NAME}} · non activé</h2><p style="color:var(--m)">Ajoute <code>ADMIN_PASSWORD=ton mot de passe</code> dans le fichier <code>.env</code> (à côté de index.js), puis redémarre l'addon. Choisis un mot de passe long.</p></div>`;

const PAGE_LOGIN = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Connexion · {{NAME}}</title><link rel=icon type=image/png href=/logo.png><style>${CSS}
body{display:grid;place-items:center;min-height:100vh;padding:16px}form{width:100%;max-width:340px;background:var(--p);border:1px solid var(--b);border-radius:12px;padding:24px;display:grid;gap:14px}
input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--b);background:var(--p2);color:var(--t)}button{background:var(--a);border-color:var(--a);font-weight:600;cursor:pointer}#e{color:var(--ko);min-height:1.2em;font-size:13px}</style>
<form id=f><h2 style="display:flex;align-items:center;gap:10px"><img src=/logo.png width=34 height=34 alt="" style="border-radius:10px">{{NAME}}</h2><input id=pw type=password placeholder="Mot de passe" autofocus autocomplete=current-password><button>Se connecter</button><div id=e></div></form>
<script>f.onsubmit=async e=>{e.preventDefault();const r=await fetch('/admin/login',{method:'POST',body:JSON.stringify({password:pw.value})}).then(r=>r.json());r.ok?location.reload():(document.getElementById('e').textContent=r.error)}</script>`;

const fs = require('fs'), path = require('path');
let PAGE_CACHE;
const PAGE = () => PAGE_CACHE ||= fs.readFileSync(path.join(__dirname, 'pages', 'admin.html'), 'utf8');
