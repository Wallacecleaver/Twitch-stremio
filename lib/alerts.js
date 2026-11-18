'use strict';

const webPush = require('web-push');
const { randomBytes } = require('node:crypto');
const store = require('./store');
const { createTelegram } = require('./telegram-alerts');

const MAX_DEVICES = 200;
const MAX_CHANNELS = 12;
const MAX_TRACKED = 150;
const INTERVAL = 60000;
const TOKEN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const LOGIN = /^[a-z0-9_]{3,25}$/;
const KEY = 'live-alerts';
const DEFAULT_PAGE = {
  title: 'Alertes Twitch',
  intro: 'Choisis tes streamers et reçois une notification quand ils démarrent un live, même quand cette page est fermée.',
};
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

const MINUTE = /^\d{1,4}$/;
function validTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}
// Heures calmes : { start, end, tz } avec start et end en minutes depuis minuit (heure locale du navigateur).
function validQuiet(input) {
  if (input === null || input === undefined) return { value: null };
  const { start, end, tz } = input;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > 1439 || end < 0 || end > 1439 || start === end) return { error: 'Heures calmes invalides.' };
  if (!validTimeZone(tz)) return { error: 'Fuseau horaire invalide.' };
  return { value: { start, end, tz } };
}
const formatters = new Map();
function localMinutes(tz, now) {
  let format = formatters.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, format);
  }
  const parts = format.formatToParts(now);
  return Number(parts.find(p => p.type === 'hour').value) * 60 + Number(parts.find(p => p.type === 'minute').value);
}
function inQuietHours(quiet, now = Date.now()) {
  if (!quiet) return false;
  let minutes;
  try { minutes = localMinutes(quiet.tz, new Date(now)); } catch { return false; }
  return quiet.start < quiet.end ? minutes >= quiet.start && minutes < quiet.end : minutes >= quiet.start || minutes < quiet.end;
}
const liveText = info => [info.game, info.title].filter(Boolean).join(' · ');

function createAlerts({ scan, push = webPush, storage = store, telegram = createTelegram() }) {
  const devices = new Map(), status = new Map();
  const pendingLinks = new Map();
  let keys, running = false, timer, paused = false, resumeAt = 0, page = DEFAULT_PAGE;
  let lastScan = 0, scanned = 0, sent = 0;
  try {
    const saved = JSON.parse(storage.peek(KEY) || 'null');
    if (saved) {
      paused = saved.paused === true;
      resumeAt = Number(saved.resumeAt) || 0;
      page = { ...DEFAULT_PAGE, ...saved.page };
    }
    if (saved?.keys?.publicKey && saved.keys.privateKey) keys = saved.keys;
    if (Array.isArray(saved?.devices)) {
      for (const [token, device] of saved.devices) {
        if (TOKEN.test(token) && device?.channels && ((keys && validSubscription(device.subscription)) || /^\d+$/.test(device.telegramChat || ''))) devices.set(token, device);
      }
    }
  } catch { console.error('Alertes : état enregistré illisible.'); }

  const persist = () => storage.setKey(KEY, JSON.stringify({ keys, devices: [...devices], paused, resumeAt, page }));
  const publicSettings = () => ({ ...page, paused, telegramAvailable: telegram.enabled });
  function overview() {
    const watched = new Map();
    for (const device of devices.values()) {
      for (const login of Object.keys(device.channels)) watched.set(login, (watched.get(login) || 0) + 1);
    }
    return {
      ...publicSettings(), devices: devices.size, lastScan, scanned, sent,
      channels: [...watched].map(([login, subscribers]) => ({ login, subscribers, ...status.get(login) }))
        .sort((a, b) => b.subscribers - a.subscribers || a.login.localeCompare(b.login)),
    };
  }
  async function configure(input) {
    if (!input || typeof input.paused !== 'boolean' || typeof input.title !== 'string' || typeof input.intro !== 'string') return { error: 'Réglages invalides.' };
    if (input.title.length > 60 || input.intro.length > 220) return { error: 'Le titre et l’introduction sont trop longs.' };
    if (paused && !input.paused) resumeAt = Date.now();
    paused = input.paused;
    page = { title: input.title.trim() || DEFAULT_PAGE.title, intro: input.intro.trim() || DEFAULT_PAGE.intro };
    await persist();
    return overview();
  }
  async function publicKey() {
    if (!keys) { keys = push.generateVAPIDKeys(); await persist(); }
    return keys.publicKey;
  }
  const view = device => ({
    ok: true, active: !!device, pushActive: !!device?.subscription, telegramActive: !!device?.telegramChat, telegramAvailable: telegram.enabled, paused,
    channels: Object.keys(device?.channels || {}).map(login => ({ login, ...status.get(login) })),
    prefs: { mutes: device?.mutes || [], quiet: device?.quiet || null },
  });
  const notify = (subscription, payload) => push.sendNotification(subscription, JSON.stringify(payload), {
    vapidDetails: { subject: 'https://github.com/Wallacecleaver/Twitch-stremio', ...keys },
    timeout: 5000, TTL: 120,
  });
  const expired = e => e.statusCode === 404 || e.statusCode === 410;
  const dropDelivery = (token, device, property) => {
    delete device[property];
    if (!device.subscription && !device.telegramChat) devices.delete(token);
  };
  function validateChannels(token, list) {
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CHANNELS || !list.every(x => typeof x === 'string' && LOGIN.test(x))) return 'Choisis entre 1 et 12 chaînes Twitch valides.';
    if (!devices.has(token) && devices.size >= MAX_DEVICES) return 'Ce serveur a atteint sa limite d’abonnements.';
    const tracked = new Set(list);
    for (const [id, device] of devices) if (id !== token) {
      for (const login of Object.keys(device.channels)) tracked.add(login);
    }
    if (tracked.size > MAX_TRACKED) return 'Ce serveur surveille déjà trop de chaînes Twitch.';
    return '';
  }
  const watch = (list, device) => Object.fromEntries([...new Set(list)].map(login => [
    login, device?.channels[login] || { since: Date.now(), lastId: '' },
  ]));
  async function telegramPair(chat, code) {
    if (!code) {
      let changed = false;
      for (const [token, device] of devices) if (device.telegramChat === chat) {
        dropDelivery(token, device, 'telegramChat'); changed = true;
      }
      if (changed) await persist();
      return 'Notifications TwitchIO désactivées sur Telegram.';
    }
    const pending = pendingLinks.get(code);
    if (!pending || pending.expires <= Date.now()) return 'Ce lien a expiré. Retourne sur la page Alertes pour en créer un nouveau.';
    if (paused) return 'Les alertes sont en pause sur TwitchIO.';
    const { token, channels } = pending;
    const problem = validateChannels(token, channels);
    if (problem) return problem;
    for (const [otherToken, other] of devices) if (otherToken !== token && other.telegramChat === chat) {
      return 'Ce compte est déjà lié. Envoie /stop ici avant de relier un autre navigateur.';
    }
    const device = devices.get(token);
    devices.set(token, { ...device, telegramChat: chat, telegramSince: Date.now(), channels: watch(channels, device) });
    pendingLinks.delete(code);
    await persist();
    return 'Telegram est connecté à TwitchIO. Tu recevras les alertes des chaînes sélectionnées.';
  }

  async function action(body) {
    if (typeof body?.token !== 'string' || !TOKEN.test(body.token)) return { error: 'Identifiant de navigateur invalide.' };
    if (body.action === 'save' && body.subscription) await publicKey();
    const { token } = body, device = devices.get(token);
    if (body.action === 'read') return view(device);
    if (body.action === 'stop' || body.action === 'telegram-stop') {
      if (body.action === 'telegram-stop') {
        for (const [code, pending] of pendingLinks) if (pending.token === token) pendingLinks.delete(code);
      }
      if (device) { dropDelivery(token, device, body.action === 'stop' ? 'subscription' : 'telegramChat'); await persist(); }
      return view(devices.get(token));
    }
    if (paused) return { error: 'Les notifications sont en pause sur ce serveur.' };
    if (body.action === 'prefs') {
      if (!device) return { error: 'Active d’abord les notifications ou Telegram.' };
      const mutes = body.mutes === undefined ? (device.mutes || []) : body.mutes;
      if (!Array.isArray(mutes) || mutes.length > MAX_CHANNELS || !mutes.every(x => typeof x === 'string' && device.channels[x])) return { error: 'Chaînes en sourdine invalides.' };
      const quiet = body.quiet === undefined ? { value: device.quiet || null } : validQuiet(body.quiet);
      if (quiet.error) return { error: quiet.error };
      device.mutes = [...new Set(mutes)];
      device.quiet = quiet.value;
      if (!device.mutes.length) delete device.mutes;
      if (!device.quiet) delete device.quiet;
      await persist();
      return view(device);
    }
    if (body.action === 'telegram-link') {
      if (!telegram.enabled) return { error: 'Le bot Telegram n’est pas configuré.' };
      const error = validateChannels(token, body.channels);
      if (error) return { error };
      for (const [code, link] of pendingLinks) if (link.expires <= Date.now() || link.token === token) pendingLinks.delete(code);
      if (pendingLinks.size >= MAX_DEVICES) return { error: 'Trop de connexions Telegram en cours.' };
      const code = randomBytes(24).toString('base64url');
      pendingLinks.set(code, { token, channels: body.channels, expires: Date.now() + 600000 });
      try { return { ...view(device), link: await telegram.link(code) }; }
      catch { pendingLinks.delete(code); return { error: 'Impossible de joindre le bot Telegram.' }; }
    }
    if (body.action === 'telegram-test') {
      if (!device?.telegramChat || !telegram.enabled) return { error: 'Connecte Telegram avant de lancer le test.' };
      if (Date.now() - (device.lastTelegramTest || 0) < INTERVAL) return { error: 'Attends une minute avant de refaire un test.' };
      device.lastTelegramTest = Date.now();
      try { await telegram.send(device.telegramChat, '🔔 Test TwitchIO · Tes notifications Telegram fonctionnent.'); }
      catch { return { error: 'Impossible d’envoyer le test Telegram.' }; }
      return view(device);
    }
    if (body.action === 'test') {
      if (!device?.subscription) return { error: 'Active les notifications du navigateur avant de les tester.' };
      if (Date.now() - (device.lastTest || 0) < INTERVAL) return { error: 'Attends une minute avant de refaire un test.' };
      device.lastTest = Date.now();
      try { await notify(device.subscription, { title: '🔔 Test TwitchIO', body: 'Tes notifications fonctionnent.' }); }
      catch (e) {
        if (expired(e) && devices.get(token) === device) { dropDelivery(token, device, 'subscription'); await persist(); }
        return { error: expired(e) ? 'Abonnement expiré. Réactive les notifications.' : 'Impossible d’envoyer la notification de test.' };
      }
      return view(devices.get(token));
    }
    if (body.action !== 'save') return { error: 'Action inconnue.' };

    const subscription = body.subscription ? validSubscription(body.subscription) : device?.subscription;
    if ((body.subscription && !subscription) || (!subscription && !device?.telegramChat)) return { error: 'Abonnement Push invalide ou navigateur non pris en charge.' };
    const error = validateChannels(token, body.channels);
    if (error) return { error };
    for (const [otherToken, other] of devices) {
      if (otherToken === token) continue;
      if (subscription && other.subscription?.endpoint === subscription.endpoint) return { error: 'Ce navigateur est déjà abonné. Désactive puis réactive les notifications.' };
    }
    const next = { ...device, subscription, channels: watch(body.channels, device) };
    if (next.mutes) {
      next.mutes = next.mutes.filter(login => next.channels[login]);
      if (!next.mutes.length) delete next.mutes;
    }
    if (subscription && !device?.subscription) next.pushSince = Date.now();
    devices.set(token, next);
    await persist();
    return view(next);
  }

  async function tick() {
    if (running || paused || !devices.size) return;
    running = true;
    try {
      const tracked = new Set([...devices.values()].flatMap(device => Object.keys(device.channels)));
      for (const login of status.keys()) if (!tracked.has(login)) status.delete(login);
      const results = await scan([...tracked]);
      lastScan = Date.now();
      scanned = results.size;
      for (const [login, info] of results) status.set(login, { live: !!info?.id, name: info?.name || login, title: info?.title || '', game: info?.game || '', checked: Date.now() });
      const pending = [];
      let silenced = false;
      for (const [token, device] of devices) for (const [login, channel] of Object.entries(device.channels)) {
        const info = results.get(login);
        const started = Date.parse(info?.startedAt);
        if (!info?.id || !Number.isFinite(started) || started < Math.max(channel.since, resumeAt)) continue;
        // Chaîne en sourdine ou heures calmes : le live est marqué comme vu sans alerte, pour ne pas notifier en retard.
        const silent = (device.mutes || []).includes(login) || inQuietHours(device.quiet);
        if (device.subscription && info.id !== channel.lastId && started >= (device.pushSince || 0)) {
          if (silent) { channel.lastId = info.id; silenced = true; }
          else pending.push({ token, device, login, channel, info, medium: 'push' });
        }
        if (telegram.enabled && device.telegramChat && info.id !== channel.telegramId && started >= (device.telegramSince || 0)) {
          if (silent) { channel.telegramId = info.id; silenced = true; }
          else pending.push({ token, device, login, channel, info, medium: 'telegram' });
        }
      }
      let changed = silenced;
      for (let i = 0; i < pending.length; i += 8) {
        await Promise.all(pending.slice(i, i + 8).map(async ({ token, device, login, channel, info, medium }) => {
          if (paused || Date.parse(info.startedAt) < resumeAt || devices.get(token) !== device) return;
          const property = medium === 'push' ? 'subscription' : 'telegramChat';
          if (!device[property]) return;
          const title = '🔴 ' + info.name + ' est en direct';
          try {
            if (medium === 'push') await notify(device.subscription, { login, title, body: liveText(info) || 'Regarder sur Twitch', id: info.id });
            else await telegram.send(device.telegramChat, [title, info.game, info.title, 'https://www.twitch.tv/' + login].filter(Boolean).join('\n'));
            sent++;
            const current = devices.get(token);
            if (current?.channels[login] === channel) { channel[medium === 'push' ? 'lastId' : 'telegramId'] = info.id; changed = true; }
          } catch (e) {
            if ((medium === 'push' ? expired(e) : e.statusCode === 403) && devices.get(token) === device) { dropDelivery(token, device, property); changed = true; }
          }
        }));
      }
      if (changed) await persist();
    } finally { running = false; }
  }

  function start() {
    if (!timer) {
      telegram.start(telegramPair);
      const run = () => tick().catch(() => console.error('Alertes : vérification des directs impossible.'));
      timer = setInterval(run, INTERVAL);
      timer.unref();
      run();
    }
  }
  return { publicKey, publicSettings, overview, configure, action, tick, start, telegramPair };
}

module.exports = { createAlerts, inQuietHours, validQuiet };
