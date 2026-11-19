'use strict';

const { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const derive = promisify(scrypt);
const NAME = /^[a-z0-9_-]{3,24}$/i;
const SESSION = /^[A-Za-z0-9_-]{43}$/;
const RECOVERY = /^[A-Za-z0-9_-]{24}$/;
const SESSION_AGE = 30 * 86400;
const ADMIN_AGE = 8 * 3600;
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
  const owners = new Map([...accounts].map(([key, account]) => [account.id, key]));
  const attempts = new Map();

  function limited(key, max) {
    const now = Date.now();
    for (const [id, entry] of attempts) if (entry.until <= now) attempts.delete(id);
    if (!attempts.has(key) && attempts.size >= 4000) return true;
    const entry = attempts.get(key) || { count: 0, until: now + 600000 };
    attempts.set(key, entry);
    return ++entry.count > max;
  }
  function identify(secret, admin = false) {
    if (typeof secret !== 'string' || !SESSION.test(secret)) return null;
    const session = sessions.get(HASH(secret));
    if (!session || session.expires <= Date.now() || !!session.admin !== admin) return null;
    const account = accounts.get(session.key);
    return account && !account.disabled && (!admin || account.admin) ? account : null;
  }
  function revoke(key, adminOnly = false) {
    for (const [hash, session] of sessions) if (session.key === key && (!adminOnly || session.admin)) sessions.delete(hash);
  }
  function issue(key, admin = false) {
    const now = Date.now();
    const owned = [];
    for (const [hash, session] of sessions) {
      if (session.expires <= now) sessions.delete(hash);
      else if (session.key === key && !!session.admin === admin) owned.push(hash);
    }
    for (const hash of owned.slice(0, Math.max(0, owned.length - 9))) sessions.delete(hash);
    const secret = randomBytes(32).toString('base64url');
    sessions.set(HASH(secret), { key, ...(admin ? { admin } : {}), expires: now + (admin ? ADMIN_AGE : SESSION_AGE) * 1000 });
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
      if (!await passwordMatches(password, previous?.password) || previous.disabled || accounts.get(key) !== previous) return incorrect;
      previous.lastLogin = Date.now();
      const session = issue(key);
      await persist();
      return { ok: true, account: previous.name, session };
    }
    if (method === 'recover') {
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!RECOVERY.test(code) || !previous || previous.disabled || HASH(code) !== previous.recovery || (previous.recoveryExpires && previous.recoveryExpires <= Date.now())) return incorrect;
    } else if (previous) return { error: 'Ce pseudo est déjà utilisé.' };

    const passwordDigest = await passwordHash(password);
    if (accounts.get(key) !== previous) return { error: method === 'register' ? 'Ce pseudo est déjà utilisé.' : 'Ce code a déjà été utilisé.' };
    const id = previous?.id || randomUUID();
    if (method === 'register') {
      const problem = createProfile(id);
      if (problem) return { error: problem };
    }
    const code = randomBytes(18).toString('base64url');
    const account = { ...previous, id, name: previous?.name || name, password: passwordDigest, recovery: HASH(code),
      recoveryExpires: undefined, createdAt: previous ? previous.createdAt : Date.now(), lastLogin: Date.now() };
    accounts.set(key, account);
    owners.set(id, key);
    if (method === 'recover') revoke(key);
    const session = issue(key);
    await persist();
    return { ok: true, account: account.name, code, session };
  }

  async function adminLogin(input, ip, persist) {
    const key = typeof input?.name === 'string' ? input.name.trim().toLowerCase() : '';
    const password = input?.password;
    if (!NAME.test(key) || typeof password !== 'string' || !password.length || password.length > 100) return incorrect;
    if (limited('ip:' + ip, 15) || limited('name:' + key, 10)) return { error: 'Trop d’essais. Réessaie dans quelques minutes.' };
    const account = accounts.get(key);
    if (!await passwordMatches(password, account?.password) || !account.admin || account.disabled || accounts.get(key) !== account) return incorrect;
    account.lastLogin = Date.now();
    const session = issue(key, true);
    await persist();
    return { ok: true, session };
  }

  function adminLogout(secret) {
    return !!identify(secret, true) && sessions.delete(HASH(secret));
  }

  function list() {
    const now = Date.now();
    const active = new Map();
    for (const { key, expires } of sessions.values()) {
      if (expires > now) active.set(key, (active.get(key) || 0) + 1);
    }
    return [...accounts].map(([key, account]) => ({
      id: account.id, name: account.name, admin: account.admin === true, disabled: account.disabled === true, pending: !account.password,
      createdAt: account.createdAt || 0, lastLogin: account.lastLogin || 0, sessions: active.get(key) || 0,
    }));
  }

  async function manage(input, { owner, createProfile, onChange, persist }) {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!NAME.test(name)) return { error: 'Choisis un pseudo de 3 à 24 caractères (lettres, chiffres, tiret ou _).' };
    const key = name.toLowerCase(), previous = accounts.get(key), method = input.action;
    if (!owner && (previous?.admin || input.admin === true || method === 'grant' || method === 'demote')) {
      return { error: 'Seul le propriétaire du dashboard peut gérer les administrateurs.' };
    }
    if (method === 'create' ? previous : !previous) return { error: method === 'create' ? 'Ce pseudo est déjà utilisé.' : 'Compte introuvable.' };

    const account = { ...previous };
    let code;
    if (method === 'create') {
      Object.assign(account, { id: randomUUID(), name, admin: input.admin === true, createdAt: Date.now() });
      const problem = createProfile(account.id);
      if (problem) return { error: problem };
    }
    if (method === 'create' || method === 'reset') {
      code = randomBytes(18).toString('base64url');
      Object.assign(account, { password: '', recovery: HASH(code), recoveryExpires: Date.now() + 86400000 });
    } else if (method === 'grant' || method === 'demote') account.admin = method === 'grant';
    else if (method === 'suspend' || method === 'resume') {
      account.disabled = method === 'suspend';
      if (!account.disabled && previous.disabled) account.resumedAt = Date.now();
    } else if (method !== 'revoke') return { error: 'Action inconnue.' };

    accounts.set(key, account);
    owners.set(account.id, key);
    if (method === 'grant' || method === 'demote') revoke(key, true);
    else if (method !== 'resume') revoke(key);
    onChange(account.id, method);
    await persist();
    return { ok: true, name: account.name, code };
  }

  const accountById = id => accounts.get(owners.get(id));
  return { identify, action, adminLogin, adminLogout, list, manage, hasOwner: id => owners.has(id),
    suspended: id => !!accountById(id)?.disabled, resumedAt: id => accountById(id)?.resumedAt || 0,
    snapshot: () => ({ accounts: [...accounts], sessions: [...sessions] }) };
}

const readSession = req => /(?:^|;\s*)twitchio_alerts=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
function sessionCookie(req, secret, path, name = cookieName, age = SESSION_AGE) {
  const secure = req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
  return name + '=' + secret + '; Path=' + path + '; HttpOnly; SameSite=Strict; Max-Age=' + (secret ? age : 0) + (secure ? '; Secure' : '');
}
const alertsAdminCookie = (req, secret) => sessionCookie(req, secret, '/admin', 'adm_alerts', ADMIN_AGE);

module.exports = { createAlertAccounts, readSession, sessionCookie, alertsAdminCookie };
