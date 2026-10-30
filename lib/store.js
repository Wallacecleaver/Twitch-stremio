'use strict';
// Statistiques, journal, profils et réglages : tout est gardé dans UN fichier JSON (data/data.json par défaut,
// dossier modifiable avec la variable DATA_DIR). Le fichier est relu au démarrage : rien n'est perdu quand l'addon ou le PC redémarre.
// Écriture atomique (fichier temporaire puis renommage) + copie de secours data.bak.json toutes les 10 minutes.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const FILE = path.join(DIR, 'data.json');
const BAK = path.join(DIR, 'data.bak.json');
const persistent = true;
const MAX_LOGS = 1000;
const KEEP_DAYS = 45;
const day = (d = new Date()) => d.toISOString().slice(0, 10);
const days = n => Array.from({ length: n }, (_, i) => day(new Date(Date.now() - (n - 1 - i) * 864e5)));
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const obj = x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});

// uniq : jour -> Set d'identifiants d'appareils (enregistré sous forme de listes)
const db = { since: Date.now(), logs: [], stats: {}, top: {}, uniq: {}, users: {}, kv: {} };
let lastError = null, dirty = false, timer = null, lastBackup = 0;

function adopt(o) {
  db.since = Number(o.since) || db.since;
  db.logs = Array.isArray(o.logs) ? o.logs.slice(0, MAX_LOGS) : [];
  db.stats = obj(o.stats); db.top = obj(o.top); db.users = obj(o.users); db.kv = obj(o.kv);
  db.uniq = {};
  for (const [d, a] of Object.entries(obj(o.uniq))) db.uniq[d] = new Set(Array.isArray(a) ? a : []);
}
function load() {
  let main;
  try { main = fs.readFileSync(FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; lastError = 'lecture impossible : ' + e.message; return; }
  try { adopt(JSON.parse(main)); return; } catch (e) {
    const bad = path.join(DIR, 'data.corrompu-' + Date.now() + '.json');
    try { fs.renameSync(FILE, bad); } catch { /* on continue */ }
    console.error('data.json illisible (' + e.message + '), copie gardée : ' + bad);
    try { adopt(JSON.parse(fs.readFileSync(BAK, 'utf8'))); lastError = 'data.json était illisible : la copie de secours a été restaurée.'; touch(); return; } catch { /* pas de copie */ }
    lastError = 'data.json était illisible : démarrage à vide (ancien fichier : ' + path.basename(bad) + ').';
  }
}
function prune() {
  const cut = day(new Date(Date.now() - KEEP_DAYS * 864e5));
  for (const k of Object.keys(db.stats)) { const m = /^d:(\d{4}-\d\d-\d\d):/.exec(k); if (m && m[1] < cut) delete db.stats[k]; }
  for (const d of Object.keys(db.uniq)) if (d < cut) delete db.uniq[d];
  const t = Object.entries(db.top);
  if (t.length > 1000) db.top = Object.fromEntries(t.sort((a, b) => b[1] - a[1]).slice(0, 500));
}
function saveNow() {
  clearTimeout(timer); timer = null;
  if (!dirty) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    prune();
    const out = JSON.stringify({ ...db, uniq: Object.fromEntries(Object.entries(db.uniq).map(([d, s]) => [d, [...s]])) });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, out);
    if (Date.now() - lastBackup > 6e5 && fs.existsSync(FILE)) { try { fs.copyFileSync(FILE, BAK); lastBackup = Date.now(); } catch { /* sans copie de secours */ } }
    fs.renameSync(tmp, FILE);
    dirty = false; lastError = null;
  } catch (e) {
    lastError = 'écriture impossible : ' + e.message;
    timer = setTimeout(saveNow, 10000); if (timer.unref) timer.unref();
  }
}
const touch = () => { dirty = true; if (!timer) { timer = setTimeout(saveNow, 2000); if (timer.unref) timer.unref(); } };
load();
process.on('exit', saveNow);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { saveNow(); process.exit(0); });

const incr = (f, n = 1) => { db.stats[f] = (db.stats[f] || 0) + n; touch(); };
const top = login => { db.top[login] = (db.top[login] || 0) + 1; touch(); };
const uniq = id => { (db.uniq[day()] ||= new Set()).add(id); touch(); };
const LEVELS = { erreur: 'ERROR', incident: 'WARN' };
let logOn = true;
const setLog = v => { logOn = v !== false; };
const log = e => {
  if (!logOn && !(e.k === 'erreur' || e.k === 'incident')) return;
  db.logs.unshift({ t: Date.now(), lvl: LEVELS[e.k] || 'INFO', ...e });
  if (db.logs.length > MAX_LOGS) db.logs.length = MAX_LOGS;
  touch();
};
// fiche d'un utilisateur (pseudo) : compteur, dernière activité, dernière chaîne, appareil, réglages, incidents
function user(pseudo, { ch, dev, cfg, incident } = {}) {
  if (!pseudo) return;
  const now = Date.now();
  const u = (db.users[pseudo] ||= { pseudo, n: 0, inc: 0, first: now });
  if (!incident) u.n++; else u.inc++;
  u.last = now; if (ch) u.ch = ch; if (dev) u.dev = dev; if (cfg) u.cfg = cfg;
  touch();
}

// adresse du visiteur : les en-têtes d'un proxy ou d'un tunnel (cloudflared, ngrok…) ne sont crus que s'ils viennent de ce PC ou du réseau local
const isLocalAddr = a => /^(::1$|127\.|::ffff:127\.|10\.|::ffff:10\.|192\.168\.|::ffff:192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:172\.(1[6-9]|2\d|3[01])\.|f[cd])/i.test(a);
const ipOf = req => {
  const sock = (req.socket && req.socket.remoteAddress) || '';
  if (isLocalAddr(sock)) { const h = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (h) return h; }
  return sock || 'x';
};
const deviceId = req => crypto.createHash('sha256').update(ipOf(req) + '|' + (req.headers['user-agent'] || '')).digest('hex').slice(0, 12);

// Enregistre tout de suite ce qui est en attente (les écritures normales partent seules, 2 s après le dernier changement).
async function flush() { saveNow(); }

async function snapshot(limit = 300) {
  const D = days(7);
  return {
    persistent, file: FILE, lastError, since: db.since, stats: { ...db.stats },
    top: Object.entries(db.top).sort((a, b) => b[1] - a[1]).slice(0, 10),
    logs: db.logs.slice(0, limit), users: Object.values(db.users).map(u => ({ ...u })),
    uniq: D.map(d => (db.uniq[d] ? db.uniq[d].size : 0)), days: D,
  };
}
async function reset(what) {
  db.logs = [];
  if (what !== 'logs') { db.stats = {}; db.top = {}; db.uniq = {}; db.users = {}; } // les profils, les réglages du site et le compte lié (kv) ne sont jamais touchés
  dirty = true; saveNow();
}

// petites valeurs persistantes : profils (p:<id>), réglages du site, logo, jeton chiffré du compte lié
const failIfUnsaved = () => { if (dirty) throw new Error('Enregistrement impossible : ' + (lastError || 'erreur inconnue')); };
const peek = k => (hasOwn(db.kv, k) ? db.kv[k] : null); // lecture immédiate (au démarrage, avant que le serveur écoute)
const getKey = async k => peek(k);
const setKey = async (k, v) => { db.kv[k] = String(v); dirty = true; saveNow(); failIfUnsaved(); };
const delKey = async k => { delete db.kv[k]; dirty = true; saveNow(); failIfUnsaved(); };
const profIds = async () => Object.keys(db.kv).filter(k => k.startsWith('p:')).map(k => k.slice(2)); // identifiants des profils enregistrés

module.exports = { profIds, peek, getKey, setKey, delKey, persistent, incr, top, uniq, log, setLog, user, flush, snapshot, reset, day, days, deviceId, ipOf, file: FILE, get lastError() { return lastError; } };
