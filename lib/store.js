'use strict';
// Statistiques + journal. Upstash (Redis REST) si configuré, sinon mémoire de l'instance (perdue au redémarrage).
const crypto = require('crypto');
const REST = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const persistent = !!(REST && TOKEN);
const MAX_LOGS = 500;
const day = (d = new Date()) => d.toISOString().slice(0, 10);
const days = n => Array.from({ length: n }, (_, i) => day(new Date(Date.now() - (n - 1 - i) * 864e5)));

const mem = { logs: [], stats: {}, top: {}, uniq: {}, since: Date.now() };
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
const log = e => {
  const row = { t: Date.now(), ...e };
  op(['LPUSH', 'tw:logs', JSON.stringify(row)], () => { mem.logs.unshift(row); if (mem.logs.length > MAX_LOGS) mem.logs.length = MAX_LOGS; });
  if (persistent) queue.push(['LTRIM', 'tw:logs', 0, MAX_LOGS - 1]);
};
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
    return { persistent, since: mem.since, stats: mem.stats, top: Object.entries(mem.top).sort((a, b) => b[1] - a[1]).slice(0, 10), logs: mem.logs.slice(0, limit), uniq: D.map(d => mem.uniq[d] ? mem.uniq[d].size : 0), days: D };
  }
  const r = await pipeline([['HGETALL', 'tw:stats'], ['ZREVRANGE', 'tw:top', 0, 9, 'WITHSCORES'], ['LRANGE', 'tw:logs', 0, limit - 1], ...D.map(d => ['PFCOUNT', 'tw:u:' + d])]);
  const stats = {}; for (let i = 0; i < (r[0] || []).length; i += 2) stats[r[0][i]] = Number(r[0][i + 1]);
  const t = []; for (let i = 0; i < (r[1] || []).length; i += 2) t.push([r[1][i], Number(r[1][i + 1])]);
  return { persistent, lastError, stats, top: t, logs: (r[2] || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean), uniq: r.slice(3).map(Number), days: D };
}
async function reset(what) {
  if (what === 'logs') { if (persistent) await pipeline([['DEL', 'tw:logs']]); else mem.logs = []; return; }
  if (persistent) await pipeline([['DEL', 'tw:logs'], ['DEL', 'tw:stats'], ['DEL', 'tw:top'], ...days(8).map(d => ['DEL', 'tw:u:' + d])]);
  else { mem.logs = []; mem.stats = {}; mem.top = {}; mem.uniq = {}; }
}
module.exports = { persistent, incr, top, uniq, log, flush, snapshot, reset, day, days, deviceId, get lastError() { return lastError; } };
