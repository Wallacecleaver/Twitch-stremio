'use strict';
// Statistiques + journal. Upstash (Redis REST) si configuré, sinon mémoire de l'instance (perdue au redémarrage).
const crypto = require('crypto');
const REST = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const persistent = !!(REST && TOKEN);
const MAX_LOGS = 500;
const day = (d = new Date()) => d.toISOString().slice(0, 10);
const days = n => Array.from({ length: n }, (_, i) => day(new Date(Date.now() - (n - 1 - i) * 864e5)));

const mem = { logs: [], stats: {}, top: {}, uniq: {}, users: {}, since: Date.now() };
let queue = [], pending = [], lastError = null;

async function pipeline(cmds) {
  const r = await fetch(REST + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds), signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error('Upstash HTTP ' + r.status);
  const out = await r.json();
  const bad = out.find(x => x && x.error);
  if (bad) throw new Error('Upstash : ' + bad.error);
  return out.map(x => x.result);
}
function op(cmd, local) { if (persistent) queue.push(cmd); else local(); }

const incr = (f, n = 1) => op(['HINCRBY', 'tw:stats', f, n], () => { mem.stats[f] = (mem.stats[f] || 0) + n; });
const top = login => op(['ZINCRBY', 'tw:top', 1, login], () => { mem.top[login] = (mem.top[login] || 0) + 1; });
const uniq = id => op(['PFADD', 'tw:u:' + day(), id], () => { (mem.uniq[day()] ||= new Set()).add(id); });
const LEVELS = { erreur: 'ERROR', incident: 'WARN' };
let logOn = true;
const setLog = v => { logOn = v !== false; };
const log = e => {
  if (!logOn && !(e.k === 'erreur' || e.k === 'incident')) return;
  const row = { t: Date.now(), lvl: LEVELS[e.k] || 'INFO', ...e };
  op(['LPUSH', 'tw:logs', JSON.stringify(row)], () => { mem.logs.unshift(row); if (mem.logs.length > MAX_LOGS) mem.logs.length = MAX_LOGS; });
  if (persistent) queue.push(['LTRIM', 'tw:logs', 0, MAX_LOGS - 1]);
};
// fiche d'un utilisateur (pseudo) : compteur, dernière activité, dernière chaîne, appareil, réglages, incidents
function user(pseudo, { ch, dev, cfg, incident } = {}) {
  if (!pseudo) return;
  const now = Date.now();
  if (persistent) {
    queue.push(['HINCRBY', 'tw:uc', pseudo, incident ? 0 : 1], ['HSET', 'tw:ul', pseudo, now]);
    if (ch) queue.push(['HSET', 'tw:uch', pseudo, ch]);
    if (dev) queue.push(['HSET', 'tw:ud', pseudo, dev]);
    if (cfg) queue.push(['HSET', 'tw:ucfg', pseudo, JSON.stringify(cfg)]);
    if (incident) queue.push(['HINCRBY', 'tw:ui', pseudo, 1]);
    return;
  }
  const u = (mem.users[pseudo] ||= { pseudo, n: 0, inc: 0, first: now });
  if (!incident) u.n++; else u.inc++;
  u.last = now; if (ch) u.ch = ch; if (dev) u.dev = dev; if (cfg) u.cfg = cfg;
}
const deviceId = req => crypto.createHash('sha256').update(String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() + '|' + (req.headers['user-agent'] || '')).digest('hex').slice(0, 12);

// À appeler avant d'envoyer la réponse : sur Vercel, le travail en cours est coupé une fois la réponse partie.
async function flush() {
  if (!persistent || !queue.length) return;
  const cmds = queue; queue = [];
  try { await pipeline(cmds); lastError = null; } catch (e) { lastError = e.message; }
}

async function snapshot(limit = 300) {
  const D = days(7);
  if (!persistent) {
    return { persistent, since: mem.since, stats: mem.stats, top: Object.entries(mem.top).sort((a, b) => b[1] - a[1]).slice(0, 10), logs: mem.logs.slice(0, limit), users: Object.values(mem.users), uniq: D.map(d => mem.uniq[d] ? mem.uniq[d].size : 0), days: D };
  }
  const r = await pipeline([['HGETALL', 'tw:stats'], ['ZREVRANGE', 'tw:top', 0, 9, 'WITHSCORES'], ['LRANGE', 'tw:logs', 0, limit - 1], ...D.map(d => ['PFCOUNT', 'tw:u:' + d]), ['HGETALL', 'tw:uc'], ['HGETALL', 'tw:ul'], ['HGETALL', 'tw:uch'], ['HGETALL', 'tw:ud'], ['HGETALL', 'tw:ucfg'], ['HGETALL', 'tw:ui']]);
  const H = a => { const o = {}; for (let i = 0; i < (a || []).length; i += 2) o[a[i]] = a[i + 1]; return o; };
  const [uc, ul, uch, ud, ucfg, ui] = r.slice(10).map(H);
  const users = Object.keys(ul).map(p => ({ pseudo: p, n: Number(uc[p] || 0), inc: Number(ui[p] || 0), last: Number(ul[p]), ch: uch[p], dev: ud[p], cfg: ucfg[p] ? JSON.parse(ucfg[p]) : null }));
  const stats = {}; for (let i = 0; i < (r[0] || []).length; i += 2) stats[r[0][i]] = Number(r[0][i + 1]);
  const t = []; for (let i = 0; i < (r[1] || []).length; i += 2) t.push([r[1][i], Number(r[1][i + 1])]);
  return { persistent, lastError, stats, top: t, logs: (r[2] || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean), users, uniq: r.slice(3, 10).map(Number), days: D };
}
async function reset(what) {
  if (what === 'logs') { if (persistent) await pipeline([['DEL', 'tw:logs']]); else mem.logs = []; return; }
  if (persistent) await pipeline([['DEL', 'tw:logs'], ['DEL', 'tw:stats'], ['DEL', 'tw:top'], ['DEL', 'tw:uc'], ['DEL', 'tw:ul'], ['DEL', 'tw:uch'], ['DEL', 'tw:ud'], ['DEL', 'tw:ucfg'], ['DEL', 'tw:ui'], ...days(8).map(d => ['DEL', 'tw:u:' + d])]);
  else { mem.logs = []; mem.stats = {}; mem.top = {}; mem.uniq = {}; mem.users = {}; }
}
// petite valeur persistante (ex. jeton chiffré du compte lié) : Upstash uniquement, sinon mémoire de l'instance
const kvMem = {};
const getKey = async k => persistent ? (await pipeline([['GET', 'tw:k:' + k]]))[0] : kvMem[k] || null;
const setKey = async (k, v) => { if (persistent) await pipeline([['SET', 'tw:k:' + k, v]]); else kvMem[k] = v; };
const delKey = async k => { if (persistent) await pipeline([['DEL', 'tw:k:' + k]]); else delete kvMem[k]; };
const profIds = async () => { // identifiants des profils enregistrés (clés tw:k:p:*)
  if (!persistent) return Object.keys(kvMem).filter(k => k.startsWith('p:')).map(k => k.slice(2));
  const out = []; let cur = '0';
  for (let i = 0; i < 30; i++) { const r = (await pipeline([['SCAN', cur, 'MATCH', 'tw:k:p:*', 'COUNT', '200']]))[0] || ['0', []]; cur = String(r[0]); for (const k of r[1] || []) out.push(String(k).slice(7)); if (cur === '0') break; }
  return out;
};
module.exports = { profIds, getKey, setKey, delKey, persistent, incr, top, uniq, log, setLog, user, flush, snapshot, reset, day, days, deviceId, get lastError() { return lastError; } };
