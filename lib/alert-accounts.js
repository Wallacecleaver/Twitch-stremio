'use strict';

const { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const derive = promisify(scrypt);
const NAME = /^[a-z0-9_-]{3,24}$/i;
const SESSION = /^[A-Za-z0-9_-]{43}$/;
const RECOVERY = /^[A-Za-z0-9_-]{24}$/;
const SESSION_AGE = 30 * 86400;
const HASH = value => createHash('sha256').update(value).digest('hex');
const cookieName = 'twitchio_alerts';
const incorrect = { error: 'Pseudo ou identifiants incorrects.' };

async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + (await derive(password, salt, 32)).toString('hex');
}
async function passwordMatches(password, hash) {
  const [salt, expected] = (hash || '0'.repeat(32) + ':' + '0'.repeat(64)).split(':');
  const actual = await derive(password, salt, 32);
  const digest = Buffer.from(expected || '', 'hex');
  return !!hash && digest.length === actual.length && timingSafeEqual(actual, digest);
}

function createAlertAccounts(saved) {
  const accounts = new Map(saved?.accounts || []);
  const sessions = new Map(saved?.sessions || []);
  const owners = new Set([...accounts.values()].map(account => account.id));
  const attempts = new Map();

  function limited(key, max) {
    const now = Date.now();
    for (const [id, entry] of attempts) if (entry.until <= now) attempts.delete(id);
    if (!attempts.has(key) && attempts.size >= 4000) return true;
    const entry = attempts.get(key) || { count: 0, until: now + 600000 };
    attempts.set(key, entry);
    return ++entry.count > max;
  }
  function identify(secret) {
    if (typeof secret !== 'string' || !SESSION.test(secret)) return null;
    const session = sessions.get(HASH(secret));
    return session?.expires > Date.now() ? accounts.get(session.key) || null : null;
  }
  function issue(key, all = false) {
    const now = Date.now();
    const owned = [];
    for (const [hash, session] of sessions) {
      if (session.expires <= now || (all && session.key === key)) sessions.delete(hash);
      else if (session.key === key) owned.push(hash);
    }
    for (const hash of owned.slice(0, Math.max(0, owned.length - 9))) sessions.delete(hash);
    const secret = randomBytes(32).toString('base64url');
    sessions.set(HASH(secret), { key, expires: now + SESSION_AGE * 1000 });
    return secret;
  }

  async function action(body, { secret, ip, createProfile, disconnect, persist }) {
    const method = body?.action;
    if (method === 'logout') {
      const account = identify(secret);
      if (account) {
        sessions.delete(HASH(secret));
        disconnect(account);
        await persist();
      }
      return { ok: true, session: '' };
    }
    if (!['register', 'login', 'recover'].includes(method)) return { error: 'Action inconnue.' };
    if (identify(secret)) return { error: 'Déconnecte-toi avant d’ouvrir un autre compte.' };

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const password = body.password;
    if (!NAME.test(name)) return { error: 'Choisis un pseudo de 3 à 24 caractères (lettres, chiffres, tiret ou _).' };
    if (typeof password !== 'string' || password.length > 100 || password.length < (method === 'login' ? 1 : 10)) {
      return { error: method === 'login' ? 'Saisis ton mot de passe.' : 'Utilise un mot de passe de 10 à 100 caractères.' };
    }
    const key = name.toLowerCase();
    if (limited('ip:' + ip, 15) || limited('name:' + key, 10)) return { error: 'Trop d’essais. Réessaie dans quelques minutes.' };
    const previous = accounts.get(key);

    if (method === 'login') {
      if (!await passwordMatches(password, previous?.password) || accounts.get(key) !== previous) return incorrect;
      const session = issue(key);
      await persist();
      return { ok: true, account: previous.name, session };
    }
    if (method === 'recover') {
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!RECOVERY.test(code) || !previous || HASH(code) !== previous.recovery) return incorrect;
    } else if (previous) return { error: 'Ce pseudo est déjà utilisé.' };

    const passwordDigest = await passwordHash(password);
    if (accounts.get(key) !== previous) return { error: method === 'register' ? 'Ce pseudo est déjà utilisé.' : 'Ce code a déjà été utilisé.' };
    const id = previous?.id || randomUUID();
    if (method === 'register') {
      const problem = createProfile(id);
      if (problem) return { error: problem };
    }
    const code = randomBytes(18).toString('base64url');
    const account = { id, name: previous?.name || name, password: passwordDigest, recovery: HASH(code) };
    accounts.set(key, account);
    owners.add(id);
    const session = issue(key, method === 'recover');
    await persist();
    return { ok: true, account: account.name, code, session };
  }

  return { identify, action, hasOwner: id => owners.has(id), snapshot: () => ({ accounts: [...accounts], sessions: [...sessions] }) };
}

const readSession = req => /(?:^|;\s*)twitchio_alerts=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
function sessionCookie(req, secret, path) {
  const secure = req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
  return cookieName + '=' + secret + '; Path=' + path + '; HttpOnly; SameSite=Strict; Max-Age=' + (secret ? SESSION_AGE : 0) + (secure ? '; Secure' : '');
}

module.exports = { createAlertAccounts, readSession, sessionCookie };
