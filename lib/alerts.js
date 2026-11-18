'use strict';

const webPush = require('web-push');
const store = require('./store');

const MAX_DEVICES = 200;
const MAX_CHANNELS = 12;
const MAX_TRACKED = 150;
const INTERVAL = 60000;
const TOKEN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const LOGIN = /^[a-z0-9_]{3,25}$/;
const KEY = 'live-alerts';
const PUSH_HOST = /^(?:fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|(?:[a-z0-9-]+\.)*web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;

function validSubscription(sub) {
  if (typeof sub?.endpoint !== 'string' || sub.endpoint.length > 2048) return null;
  let endpoint;
  try { endpoint = new URL(sub.endpoint); } catch { return null; }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port || endpoint.hash || !PUSH_HOST.test(endpoint.hostname) || endpoint.pathname === '/') return null;
  const { p256dh, auth } = sub.keys || {};
  if (typeof p256dh !== 'string' || !/^B[A-Za-z0-9_-]{86}$/.test(p256dh) || typeof auth !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(auth)) return null;
  return { endpoint: endpoint.href, keys: { p256dh, auth } };
}

function createAlerts({ scan, push = webPush, storage = store }) {
  const devices = new Map(), status = new Map();
  let keys, running = false, timer;
  try {
    const saved = JSON.parse(storage.peek(KEY) || 'null');
    if (saved?.keys?.publicKey && saved.keys.privateKey) keys = saved.keys;
    if (keys && Array.isArray(saved.devices)) {
      for (const [token, device] of saved.devices) {
        if (TOKEN.test(token) && validSubscription(device?.subscription) && device.channels) devices.set(token, device);
      }
    }
  } catch { console.error('Alertes : état enregistré illisible.'); }

  const persist = () => storage.setKey(KEY, JSON.stringify({ keys, devices: [...devices] }));
  async function publicKey() {
    if (!keys) keys = push.generateVAPIDKeys();
    if (!storage.peek(KEY)) await persist();
    return keys.publicKey;
  }
  const view = device => ({
    ok: true, active: !!device,
    channels: Object.keys(device?.channels || {}).map(login => ({ login, ...status.get(login) })),
  });
  const notify = (subscription, payload) => push.sendNotification(subscription, JSON.stringify(payload), {
    vapidDetails: { subject: 'https://github.com/Wallacecleaver/Twitch-stremio', ...keys },
    timeout: 5000, TTL: 120,
  });
  const expired = e => e.statusCode === 404 || e.statusCode === 410;

  async function action(body) {
    if (typeof body?.token !== 'string' || !TOKEN.test(body.token)) return { error: 'Identifiant de navigateur invalide.' };
    if (body.action === 'save') await publicKey();
    const { token } = body, device = devices.get(token);
    if (body.action === 'read') return view(device);
    if (body.action === 'stop') {
      if (device) { devices.delete(token); await persist(); }
      return view();
    }
    if (body.action === 'test') {
      if (!device) return { error: 'Active les notifications avant de les tester.' };
      if (Date.now() - (device.lastTest || 0) < INTERVAL) return { error: 'Attends une minute avant de refaire un test.' };
      device.lastTest = Date.now();
      try { await notify(device.subscription, { title: '🔔 Test TwitchIO', body: 'Tes notifications fonctionnent.' }); }
      catch (e) {
        if (expired(e) && devices.get(token) === device) { devices.delete(token); await persist(); }
        return { error: expired(e) ? 'Abonnement expiré. Réactive les notifications.' : 'Impossible d’envoyer la notification de test.' };
      }
      return view(devices.get(token));
    }
    if (body.action !== 'save') return { error: 'Action inconnue.' };

    const subscription = validSubscription(body.subscription);
    if (!subscription) return { error: 'Abonnement Push invalide ou navigateur non pris en charge.' };
    if (!Array.isArray(body.channels) || body.channels.length < 1 || body.channels.length > MAX_CHANNELS || !body.channels.every(x => typeof x === 'string' && LOGIN.test(x))) {
      return { error: 'Choisis entre 1 et 12 chaînes Twitch valides.' };
    }
    if (!device && devices.size >= MAX_DEVICES) return { error: 'Ce serveur a atteint sa limite d’abonnements.' };
    const tracked = new Set(body.channels);
    for (const [otherToken, other] of devices) {
      if (otherToken === token) continue;
      if (other.subscription.endpoint === subscription.endpoint) return { error: 'Ce navigateur est déjà abonné. Désactive puis réactive les notifications.' };
      for (const login of Object.keys(other.channels)) tracked.add(login);
    }
    if (tracked.size > MAX_TRACKED) return { error: 'Ce serveur surveille déjà trop de chaînes Twitch.' };

    const channels = Object.fromEntries([...new Set(body.channels)].map(login => [
      login, device?.channels[login] || { since: Date.now(), lastId: '' },
    ]));
    const next = { subscription, channels, lastTest: device?.lastTest };
    devices.set(token, next);
    await persist();
    return view(next);
  }

  async function tick() {
    if (running || !devices.size) return;
    running = true;
    try {
      const tracked = new Set([...devices.values()].flatMap(device => Object.keys(device.channels)));
      for (const login of status.keys()) if (!tracked.has(login)) status.delete(login);
      const results = await scan([...tracked]);
      for (const [login, info] of results) status.set(login, { live: !!info?.id, name: info?.name || login, title: info?.title || '', checked: Date.now() });
      const pending = [];
      for (const [token, device] of devices) for (const [login, channel] of Object.entries(device.channels)) {
        const info = results.get(login);
        if (info?.id && info.id !== channel.lastId && Date.parse(info.startedAt) >= channel.since) pending.push({ token, device, login, channel, info });
      }
      let changed = false;
      for (let i = 0; i < pending.length; i += 8) {
        await Promise.all(pending.slice(i, i + 8).map(async ({ token, device, login, channel, info }) => {
          if (devices.get(token) !== device) return;
          try {
            await notify(device.subscription, { login, title: '🔴 ' + info.name + ' est en direct', body: info.title || 'Regarder sur Twitch', id: info.id });
            const current = devices.get(token);
            if (current?.channels[login] === channel) { channel.lastId = info.id; changed = true; }
          } catch (e) {
            if (expired(e) && devices.get(token) === device) { devices.delete(token); changed = true; }
          }
        }));
      }
      if (changed) await persist();
    } finally { running = false; }
  }

  function start() {
    if (!timer) {
      const run = () => tick().catch(() => console.error('Alertes : vérification des directs impossible.'));
      timer = setInterval(run, INTERVAL);
      timer.unref();
      run();
    }
  }
  return { publicKey, action, tick, start };
}

module.exports = { createAlerts };
