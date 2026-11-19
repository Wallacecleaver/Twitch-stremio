'use strict';

const webPush = require('web-push');
const { randomBytes } = require('node:crypto');
const store = require('./store');
const { createTelegram } = require('./telegram-alerts');
const { createAlertAccounts, profileOf } = require('./alert-accounts');

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
const telegramHtml = text => String(text).replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
const connectTelegram = 'Sur la page Alertes de TwitchIO, ajoute une chaîne et choisis « Connecter Telegram ». Ouvre ensuite le bot depuis le lien généré.';

function telegramMessage(title, body) {
  const message = { text: '<b>' + title + '</b>\n\n' + body };
  // Utiliser l’adresse publique configurée par l’admin pour les liens envoyés par le bot.
  try {
    const url = new URL(process.env.PUBLIC_URL);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      message.buttons = [{ text: 'Ouvrir mes alertes', url: url.origin + '/alerte' }];
    }
  } catch { /* Serveur sans adresse publique configurée. */ }
  return message;
}

function telegramLive(login, info) {
  const heading = '🔴 <b>' + telegramHtml(info.name || login) + ' est en direct</b>';
  const details = [info.title && telegramHtml(info.title), info.game && ('🎮 ' + telegramHtml(info.game))].filter(Boolean);
  return {
    text: [heading, details.join('\n')].filter(Boolean).join('\n\n'),
    buttons: [{ text: '▶ Regarder sur Twitch', url: 'https://www.twitch.tv/' + login }],
  };
}

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
  let migrated = false;
  const recent = []; // dernières alertes envoyées (en mémoire, depuis le démarrage)
  let auth = createAlertAccounts();
  try {
    const saved = JSON.parse(storage.peek(KEY) || 'null');
    if (saved) {
      auth = createAlertAccounts(saved.auth);
      paused = saved.paused === true;
      resumeAt = Number(saved.resumeAt) || 0;
      page = { ...DEFAULT_PAGE, ...saved.page };
    }
    if (saved?.keys?.publicKey && saved.keys.privateKey) keys = saved.keys;
    if (Array.isArray(saved?.devices)) {
      for (const [token, device] of saved.devices) {
        if (TOKEN.test(token) && device?.channels) {
          if (keys && validSubscription(device.subscription)) {
            const ids = Object.fromEntries(Object.entries(device.channels).map(([login, channel]) => [login, channel.lastId || '']));
            device.pushes = { [token]: { subscription: device.subscription, since: device.pushSince, lastTest: device.lastTest, ids } };
            delete device.subscription;
            delete device.pushSince;
            delete device.lastTest;
            migrated = true;
          }
          if (!auth.hasOwner(token) && !Object.keys(device.pushes || {}).length && !/^\d+$/.test(device.telegramChat || '')) continue;
          for (const target of Object.values(device.pushes || {})) target.ids = Object.assign(Object.create(null), target.ids);
          if (device.telegramChat && device.telegramBotId === undefined) {
            device.telegramBotId = telegram.botId || null;
            migrated = true;
          }
          devices.set(token, device);
        }
      }
    }
  } catch { console.error('Alertes : état enregistré illisible.'); }

  const persist = () => storage.setKey(KEY, JSON.stringify({ keys, devices: [...devices], auth: auth.snapshot(), paused, resumeAt, page }));
  if (migrated) persist().catch(() => console.error('Alertes : migration des abonnements impossible.'));
  const publicSettings = () => ({ ...page, paused, telegramAvailable: telegram.enabled });
  const telegramLinked = device => !!(device?.telegramChat && telegram.enabled && device.telegramBotId === telegram.botId);
  const activeDevices = () => [...devices].filter(([id]) => !auth.suspended(id));
  function overview() {
    const enabled = activeDevices();
    const watched = new Map();
    for (const [, device] of enabled) {
      for (const login of Object.keys(device.channels)) watched.set(login, (watched.get(login) || 0) + 1);
    }
    let pushDevices = 0, telegramDevices = 0, customDevices = 0;
    for (const [, device] of enabled) {
      pushDevices += Object.keys(device.pushes || {}).length;
      if (telegramLinked(device)) telegramDevices++;
      if (device.mutes?.length || device.quiet) customDevices++;
    }
    const channels = [...watched].map(([login, subscribers]) => ({ login, subscribers, ...status.get(login) }))
      .sort((a, b) => b.subscribers - a.subscribers || a.login.localeCompare(b.login));
    return {
      ...publicSettings(), devices: enabled.length, lastScan, scanned, sent, interval: INTERVAL / 1000,
      pushDevices, telegramDevices, customDevices,
      liveNow: channels.filter(c => c.live && Date.now() - (c.checked || 0) < 180000).length,
      channels,
      recent: recent.map(({ id, ...entry }) => entry),
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
  const view = (device, browser, account) => ({
    ok: true, account: account?.name || '', active: !!account || !!device?.pushes?.[browser] || telegramLinked(device),
    ...(account ? { profile: profileOf(account) } : {}),
    pushActive: !!device?.pushes?.[browser], telegramActive: telegramLinked(device), telegramAvailable: telegram.enabled, paused,
    channels: Object.keys(device?.channels || {}).map(login => ({ login, ...status.get(login) })),
    prefs: { mutes: device?.mutes || [], quiet: device?.quiet || null },
  });
  const notify = (subscription, payload) => push.sendNotification(subscription, JSON.stringify(payload), {
    vapidDetails: { subject: 'https://github.com/Wallacecleaver/Twitch-stremio', ...keys },
    timeout: 5000, TTL: 120,
  });
  const expired = e => e.statusCode === 404 || e.statusCode === 410;
  const dropDelivery = (token, device, medium, browser) => {
    if (medium === 'push') {
      if (device.pushes) delete device.pushes[browser];
    } else {
      delete device.telegramChat;
      delete device.telegramBotId;
    }
    if (!auth.hasOwner(token) && !Object.keys(device.pushes || {}).length && !device.telegramChat) devices.delete(token);
  };
  function validateChannels(token, list, allowEmpty = false) {
    if (!Array.isArray(list) || (!allowEmpty && !list.length) || list.length > MAX_CHANNELS || !list.every(x => typeof x === 'string' && LOGIN.test(x))) {
      return allowEmpty ? 'La liste doit contenir au plus 12 chaînes Twitch valides.' : 'Choisis entre 1 et 12 chaînes Twitch valides.';
    }
    if (!devices.has(token) && devices.size >= MAX_DEVICES) return 'Ce serveur a atteint sa limite d’abonnements.';
    const tracked = new Set(list);
    for (const [id, device] of devices) if (id !== token) {
      for (const login of Object.keys(device.channels)) tracked.add(login);
    }
    if (tracked.size > MAX_TRACKED) return 'Ce serveur surveille déjà trop de chaînes Twitch.';
    return '';
  }
  const watch = (list, device) => Object.fromEntries([...new Set(list)].map(login => [
    login, Object.hasOwn(device?.channels || {}, login) ? device.channels[login] : { since: Date.now() },
  ]));
  function replaceList(device, list) {
    const next = { ...device, channels: watch(list, device) };
    if (next.mutes) next.mutes = next.mutes.filter(login => Object.hasOwn(next.channels, login));
    for (const target of Object.values(next.pushes || {})) {
      for (const login of Object.keys(target.ids)) if (!Object.hasOwn(next.channels, login)) delete target.ids[login];
    }
    return next;
  }
  async function accountAction(body, secret, ip) {
    const browser = body?.token;
    if (typeof browser !== 'string' || !TOKEN.test(browser) || auth.hasOwner(browser)) return { error: 'Identifiant de navigateur invalide.' };
    return auth.action(body, {
      secret, ip, persist,
      createProfile(id) {
        const guest = devices.get(browser);
        const list = body.channels;
        const problem = validateChannels(browser, list, true);
        if (problem) return problem;
        devices.set(id, replaceList(guest, list));
        devices.delete(browser);
        for (const [code, pending] of pendingLinks) if (pending.token === browser) pendingLinks.delete(code);
      },
      disconnect(account) {
        const device = devices.get(account.id);
        if (device) dropDelivery(account.id, device, 'push', browser);
        for (const [code, pending] of pendingLinks) {
          if (pending.token === account.id && pending.browser === browser) pendingLinks.delete(code);
        }
      },
    });
  }
  function usersOverview() {
    return auth.list().map(({ id, ...account }) => {
      const device = devices.get(id);
      return { ...account, channels: Object.keys(device?.channels || {}), push: Object.keys(device?.pushes || {}).length, telegram: telegramLinked(device) };
    }).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }
  function manageUsers(body, owner) {
    return auth.manage(body, {
      owner, persist,
      createProfile(id) {
        const problem = validateChannels(id, [], true);
        if (problem) return problem;
        devices.set(id, { channels: {} });
      },
      onChange(id, method) {
        if (method === 'delete') devices.delete(id);
        if (!['suspend', 'revoke', 'reset', 'delete'].includes(method)) return;
        for (const [code, pending] of pendingLinks) if (pending.token === id) pendingLinks.delete(code);
      },
    });
  }
  async function handleTelegram(chat, command, code, botId) {
    const linked = [...devices].find(([, device]) => device.telegramChat === chat && device.telegramBotId === botId);
    if (command === 'stop') {
      if (!linked) return telegramMessage('Telegram non connecté', connectTelegram);
      const [token, device] = linked;
      dropDelivery(token, device, 'telegram');
      await persist();
      return telegramMessage('🔕 Alertes Telegram désactivées', 'Tu peux les réactiver à tout moment depuis la page Alertes.');
    }
    if (command === 'aide') return telegramMessage('❔ Aide TwitchIO', [
      connectTelegram,
      '/statut · Voir tes chaînes et leur mise en sourdine\n/stop · Désactiver tes alertes Telegram',
      'Tu peux vérifier la réception avec « Tester Telegram » sur la page Alertes.',
    ].join('\n\n'));
    if (command === 'statut' || !code) {
      if (!linked) return telegramMessage('👋 Bienvenue sur TwitchIO Alertes', connectTelegram);
      const [id, device] = linked;
      if (auth.suspended(id)) return telegramMessage('Alertes suspendues', 'Ton compte a été suspendu. Contacte l’administrateur de TwitchIO.');
      const channels = Object.keys(device.channels).map(login => {
        const name = telegramHtml(status.get(login)?.name || login);
        return '• ' + name + ((device.mutes || []).includes(login) ? ' · sourdine' : '');
      });
      const state = paused ? 'Envois en pause sur TwitchIO.' : 'Telegram est connecté.';
      const list = channels.length ? '<b>Chaînes surveillées</b>\n' + channels.join('\n') : 'Aucune chaîne surveillée. Ajoute une chaîne depuis la page Alertes.';
      return telegramMessage('🔔 Mes alertes TwitchIO', state + '\n\n' + list);
    }

    const pending = pendingLinks.get(code);
    if (!pending || pending.botId !== botId || botId !== telegram.botId || pending.expires <= Date.now()) {
      return telegramMessage('⌛ Lien de connexion expiré', 'Retourne sur la page Alertes pour créer un nouveau lien Telegram.');
    }
    if (paused) return telegramMessage('⏸ Alertes en pause', 'Réessaie la connexion quand TwitchIO aura repris les envois.');
    const { token } = pending;
    if (auth.suspended(token)) return telegramMessage('Alertes suspendues', 'Ton compte a été suspendu. Contacte l’administrateur de TwitchIO.');
    const device = devices.get(token);
    const shared = auth.hasOwner(token);
    const channels = shared ? Object.keys(device.channels) : pending.channels;
    const problem = validateChannels(token, channels, shared);
    if (problem) return telegramMessage('Connexion impossible', problem);
    if (linked && linked[0] !== token) {
      return telegramMessage('Telegram est déjà connecté', 'Ce compte reçoit déjà les alertes d’une autre liste. Envoie /stop pour te déconnecter, puis rouvre le lien généré depuis ta nouvelle liste.');
    }
    const watched = watch(channels, device);
    devices.set(token, { ...device, telegramChat: chat, telegramBotId: botId, telegramSince: Date.now(), channels: watched });
    pendingLinks.delete(code);
    await persist();
    const count = Object.keys(watched).length;
    return telegramMessage('✅ Telegram connecté', 'Tu surveilles ' + count + (count === 1 ? ' chaîne Twitch.' : ' chaînes Twitch.') + ' Les alertes arriveront dès leur prochain démarrage de live.\n\nEnvoie /statut pour voir ta liste.');
  }

  async function action(body, secret) {
    if (typeof body?.token !== 'string' || !TOKEN.test(body.token)) return { error: 'Identifiant de navigateur invalide.' };
    const browser = body.token;
    if (auth.hasOwner(browser)) return { error: 'Identifiant de navigateur invalide.' };
    if (body.action === 'save' && body.subscription) await publicKey();
    const account = auth.identify(secret);
    const token = account?.id || browser;
    const device = devices.get(token);
    const state = () => view(devices.get(token), browser, account);
    if (body.action === 'read') return state();
    if ((body.account || '') !== (account?.name || '')) return { error: 'La session a changé. Ouvre à nouveau ton compte.', sessionChanged: true };
    if (body.action === 'stop' || body.action === 'telegram-stop') {
      if (body.action === 'telegram-stop') {
        for (const [code, pending] of pendingLinks) if (pending.token === token) pendingLinks.delete(code);
      }
      if (device) { dropDelivery(token, device, body.action === 'stop' ? 'push' : 'telegram', browser); await persist(); }
      return state();
    }
    if (paused && (body.action !== 'save' || !device || body.subscription)) return { error: 'Les notifications sont en pause sur ce serveur.' };
    if (body.action === 'prefs') {
      if (!device) return { error: 'Active d’abord les notifications ou Telegram.' };
      const mutes = body.mutes === undefined ? (device.mutes || []) : body.mutes;
      if (!Array.isArray(mutes) || mutes.length > MAX_CHANNELS || !mutes.every(x => typeof x === 'string' && Object.hasOwn(device.channels, x))) return { error: 'Chaînes en sourdine invalides.' };
      const quiet = body.quiet === undefined ? { value: device.quiet || null } : validQuiet(body.quiet);
      if (quiet.error) return { error: quiet.error };
      device.mutes = [...new Set(mutes)];
      device.quiet = quiet.value;
      if (!device.mutes.length) delete device.mutes;
      if (!device.quiet) delete device.quiet;
      await persist();
      return state();
    }
    if (body.action === 'telegram-link') {
      if (!telegram.enabled) return { error: 'Le bot Telegram n’est pas configuré.' };
      const list = account ? Object.keys(device.channels) : body.channels;
      const error = validateChannels(token, list);
      if (error) return { error };
      for (const [code, link] of pendingLinks) if (link.expires <= Date.now() || link.token === token) pendingLinks.delete(code);
      if (pendingLinks.size >= MAX_DEVICES) return { error: 'Trop de connexions Telegram en cours.' };
      const code = randomBytes(24).toString('base64url');
      pendingLinks.set(code, { token, browser, botId: telegram.botId, channels: list, expires: Date.now() + 600000 });
      try { return { ...state(), link: await telegram.link(code) }; }
      catch { pendingLinks.delete(code); return { error: 'Impossible de joindre le bot Telegram.' }; }
    }
    if (body.action === 'telegram-test') {
      if (!telegramLinked(device)) return { error: 'Connecte Telegram avant de lancer le test.' };
      if (Date.now() - (device.lastTelegramTest || 0) < INTERVAL) return { error: 'Attends une minute avant de refaire un test.' };
      device.lastTelegramTest = Date.now();
      try { await telegram.send(device.telegramChat, telegramMessage('🔔 Test TwitchIO', 'Ta connexion Telegram fonctionne. Les prochaines alertes de live arriveront dans cette conversation.'), device.telegramBotId); }
      catch { return { error: 'Impossible d’envoyer le test Telegram.' }; }
      return state();
    }
    if (body.action === 'test') {
      const target = device?.pushes?.[browser];
      if (!target) return { error: 'Active les notifications du navigateur avant de les tester.' };
      if (Date.now() - (target.lastTest || 0) < INTERVAL) return { error: 'Attends une minute avant de refaire un test.' };
      target.lastTest = Date.now();
      try { await notify(target.subscription, { title: '🔔 Test TwitchIO', body: 'Tes notifications fonctionnent.' }); }
      catch (e) {
        const current = devices.get(token);
        if (expired(e) && current?.pushes?.[browser] === target) { dropDelivery(token, current, 'push', browser); await persist(); }
        return { error: expired(e) ? 'Abonnement expiré. Réactive les notifications.' : 'Impossible d’envoyer la notification de test.' };
      }
      return state();
    }
    if (body.action !== 'save') return { error: 'Action inconnue.' };

    const subscription = body.subscription && validSubscription(body.subscription);
    if ((body.subscription && !subscription) || (!account && !subscription && !device?.pushes?.[browser] && !device?.telegramChat)) return { error: 'Abonnement Push invalide ou navigateur non pris en charge.' };
    let list = body.channels;
    if (account) {
      list = Object.keys(device.channels);
      if (body.changes !== undefined) {
        const { add, remove } = body.changes || {};
        const valid = items => Array.isArray(items) && items.length <= MAX_CHANNELS && items.every(login => typeof login === 'string' && LOGIN.test(login));
        if (!valid(add) || !valid(remove)) return { error: 'Modifications de la liste invalides.' };
        list = [...new Set([...list.filter(login => !remove.includes(login)), ...add])];
      }
    }
    const error = validateChannels(token, list, !!device && !subscription);
    if (error) return { error };
    let pushTarget;
    if (subscription) {
      const targets = Object.entries(device?.pushes || {});
      if (targets.length >= 10 && !device?.pushes?.[browser]) return { error: 'Ce compte a atteint sa limite de navigateurs abonnés.' };
      for (const [owner, other] of devices) for (const [otherBrowser, target] of Object.entries(other.pushes || {})) {
        if (owner === token && otherBrowser === browser) continue;
        if (target.subscription.endpoint === subscription.endpoint) return { error: 'Ce navigateur reçoit déjà les notifications d’une autre liste.' };
      }
      const previous = device?.pushes?.[browser];
      pushTarget = previous?.subscription.endpoint === subscription.endpoint ? { ...previous, subscription } : { subscription, since: Date.now(), ids: Object.create(null) };
    }
    const next = replaceList(device, list);
    if (pushTarget) next.pushes = { ...next.pushes, [browser]: pushTarget };
    devices.set(token, next);
    await persist();
    return state();
  }

  async function tick() {
    if (running || paused || !devices.size) return;
    running = true;
    try {
      const tracked = new Set(activeDevices().flatMap(([, device]) => Object.keys(device.channels)));
      for (const login of status.keys()) if (!tracked.has(login)) status.delete(login);
      const results = await scan([...tracked]);
      lastScan = Date.now();
      scanned = results.size;
      for (const [login, info] of results) status.set(login, { live: !!info?.id, name: info?.name || login, title: info?.title || '', game: info?.game || '', checked: Date.now() });
      const pending = [];
      let silenced = false;
      for (const [token, device] of activeDevices()) for (const [login, channel] of Object.entries(device.channels)) {
        const info = results.get(login);
        const started = Date.parse(info?.startedAt);
        if (!info?.id || !Number.isFinite(started) || started < Math.max(channel.since, resumeAt, auth.resumedAt(token))) continue;
        // Chaîne en sourdine ou heures calmes : le live est marqué comme vu sans alerte, pour ne pas notifier en retard.
        const silent = (device.mutes || []).includes(login) || inQuietHours(device.quiet);
        for (const [browser, target] of Object.entries(device.pushes || {})) {
          if (info.id === target.ids[login] || started < (target.since || 0)) continue;
          if (silent) { target.ids[login] = info.id; silenced = true; }
          else pending.push({ token, device, login, channel, info, medium: 'push', browser, target });
        }
        if (telegramLinked(device) && info.id !== channel.telegramId && started >= (device.telegramSince || 0)) {
          if (silent) { channel.telegramId = info.id; silenced = true; }
          else pending.push({ token, device, login, channel, info, medium: 'telegram' });
        }
      }
      let changed = silenced;
      for (let i = 0; i < pending.length; i += 8) {
        await Promise.all(pending.slice(i, i + 8).map(async ({ token, device, login, channel, info, medium, browser, target }) => {
          if (paused || auth.suspended(token) || Date.parse(info.startedAt) < Math.max(resumeAt, auth.resumedAt(token)) || devices.get(token) !== device) return;
          if (target ? device.pushes?.[browser] !== target : !device.telegramChat) return;
          const title = '🔴 ' + info.name + ' est en direct';
          try {
            if (target) await notify(target.subscription, { login, title, body: liveText(info) || 'Regarder sur Twitch', id: info.id });
            else await telegram.send(device.telegramChat, telegramLive(login, info), device.telegramBotId);
            sent++;
            const entry = recent.find(r => r.login === login && r.id === info.id);
            if (entry) entry[medium]++;
            else {
              recent.unshift({ at: Date.now(), login, name: info.name, game: info.game || '', title: info.title || '', id: info.id, push: medium === 'push' ? 1 : 0, telegram: medium === 'telegram' ? 1 : 0 });
              if (recent.length > 20) recent.length = 20;
            }
            const current = devices.get(token);
            if (current?.channels[login] === channel && (!target || current.pushes?.[browser] === target)) {
              if (target) target.ids[login] = info.id;
              else channel.telegramId = info.id;
              changed = true;
            }
          } catch (e) {
            if ((target ? expired(e) && device.pushes?.[browser] === target : e.statusCode === 403) && devices.get(token) === device) {
              dropDelivery(token, device, medium, browser);
              changed = true;
            }
          }
        }));
      }
      if (changed) await persist();
    } finally { running = false; }
  }

  function start() {
    if (!timer) {
      telegram.start(handleTelegram);
      const run = () => tick().catch(() => console.error('Alertes : vérification des directs impossible.'));
      timer = setInterval(run, INTERVAL);
      timer.unref();
      run();
    }
  }
  return { publicKey, publicSettings, overview, configure, action, accountAction, usersOverview, manageUsers, tick, start,
    adminOf: secret => auth.identify(secret, true)?.name || '',
    adminLogin: (input, ip) => auth.adminLogin(input, ip, persist),
    async adminLogout(secret) { if (auth.adminLogout(secret)) await persist(); },
    isSignedIn: secret => !!auth.identify(secret), verifyTelegram: token => telegram.verify(token) };
}

module.exports = { createAlerts, inQuietHours, validQuiet };
