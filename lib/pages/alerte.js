'use strict';

const $ = id => document.getElementById(id);
const storageKey = 'twitchio-alerts';
const pageRevision = new URL(document.currentScript.src).searchParams.get('v');
const loginPattern = /^[a-z0-9_]{3,25}$/;
const supported = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let channels = [], saved = [], states = new Map(), token, active = false, paused = false, registration, publicKey, busy = false;
let listPending = false, refreshing = false, operation = 0;
let account = '', listBase = [];
let pushActive = false, telegramActive = false, telegramAvailable = false, telegramUntil = 0, telegramTimer;
let results = [];
const lists = { fr: [], top: [] }, loadingTab = { fr: false, top: false }, messages = { fr: '', top: '' };
let followed = [], profile, followLimit = 8, searchRequest, searchTimer, manualLogin = '';
let streamer, streamerRequest;
let watchLiveOnly = false;
let mutes = new Set(), quiet = null;
const minutesToTime = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
const timeToMinutes = v => { const m = /^(\d{2}):(\d{2})$/.exec(v || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : -1; };
let agendaKey, agendaTimer, agendaRequest, agendaEvents = [];
const known = new Map();
const baseTitle = document.title;
const avatarPattern = /^https:\/\/static-cdn\.jtvnw\.net\//;
const icons = { live: 'En direct' };
const fmtViewers = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',') + ' k' : String(n);
function avatarNode(item) {
  if (avatarPattern.test(item?.avatar || '')) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = item.avatar;
    return img;
  }
  const ph = document.createElement('div');
  ph.className = 'avatar ph';
  ph.setAttribute('aria-hidden', 'true');
  ph.textContent = (item?.name || item?.login || '?').charAt(0).toUpperCase();
  return ph;
}

function toast(text, error = false) {
  const box = $('toasts'), el = document.createElement('div');
  for (const t of [...box.children]) if (t.textContent === text) t.remove();
  el.className = 'toast' + (error ? ' err' : '');
  el.textContent = text;
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, error ? 6000 : 3800);
}
function notice(text, error = false) {
  // Les erreurs restent affichées dans le panneau, les confirmations passent en toast.
  $('message').textContent = error ? text : '';
  $('message').toggleAttribute('data-error', error);
  if (text) toast(text, error);
}
const accountDraft = () => storageKey + ':pending:' + account.toLowerCase();
function readDraft(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') || {}; } catch { return {}; }
}
function restoreGuest(local) {
  channels = Array.isArray(local.channels) ? local.channels.filter(login => loginPattern.test(login)).slice(0, 12) : [];
  listPending = local.listPending ?? Array.isArray(local.channels);
  for (const login of channels) {
    const item = local.meta?.[login];
    if (item) known.set(login, { login, name: String(item.name || login).slice(0, 40), avatar: avatarPattern.test(item.avatar || '') ? item.avatar : '' });
  }
}
function remember() {
  if (account) {
    try {
      if (listPending) localStorage.setItem(accountDraft(), JSON.stringify({ channels, base: listBase }));
      else localStorage.removeItem(accountDraft());
    } catch { /* stockage indisponible */ }
    return;
  }
  const meta = {};
  for (const login of channels) {
    const item = known.get(login);
    if (item) meta[login] = { name: item.name || login, avatar: avatarPattern.test(item.avatar || '') ? item.avatar : '' };
  }
  try { localStorage.setItem(storageKey, JSON.stringify({ token, channels, meta, listPending })); } catch { /* stockage indisponible */ }
}
function editChannels(next) {
  if (account && !listPending) listBase = saved.slice();
  channels = next;
  listPending = true;
  remember();
  render();
  syncSelections();
}
function infoFor(login) {
  const s = states.get(login);
  return s?.checked ? { ...known.get(login), ...s } : known.get(login);
}
function isFresh(info) { return Date.now() - (info?.checked || 0) < 180000; }
function render() {
  const pending = active && listPending;
  const liveNow = channels.filter(login => { const i = infoFor(login); return isFresh(i) && i.live; });
  $('count').textContent = channels.length + ' / 12';
  $('count').classList.toggle('warn', channels.length >= 12);
  $('meter').style.width = (channels.length / 12 * 100) + '%';
  $('state').textContent = paused ? 'En pause' : pushActive ? 'Activées' : telegramActive ? 'Telegram seul' : 'Désactivées';
  $('state').classList.toggle('active', (pushActive || telegramActive) && !paused);
  $('state').classList.toggle('warn', paused);
  $('benefits').hidden = pushActive || telegramActive;
  $('hint').textContent = paused
    ? 'Le serveur a mis les envois en pause. Ta liste restera à jour.'
    : pending ? 'Synchronisation de la liste en attente.'
    : 'Les notifications du navigateur sont propres à cet appareil.';
  $('enable').textContent = busy ? 'Un instant…' : 'Activer dans le navigateur';
  $('enable').hidden = pushActive;
  $('enable').disabled = paused || busy || !registration || !publicKey || !channels.length;
  $('notification-actions').hidden = !pushActive;
  $('test').disabled = busy || paused;
  $('stop').disabled = busy;
  $('empty').hidden = channels.length > 0;
  $('clear-all').hidden = channels.length < 2;
  $('clear-all').disabled = busy;
  if (!channels.length) watchLiveOnly = false;
  $('watch-filter').hidden = !channels.length;
  $('watch-live').setAttribute('aria-pressed', String(watchLiveOnly));
  $('watch-live').textContent = 'En direct · ' + liveNow.length;
  $('watch-live-empty').hidden = !watchLiveOnly || liveNow.length > 0;
  $('savebar').classList.toggle('show', pending && !busy);
  $('savebar-save').disabled = busy;
  $('quiet').hidden = !active;
  $('quiet-state').textContent = quiet ? minutesToTime(quiet.start) + ' – ' + minutesToTime(quiet.end) : 'Désactivées';
  $('quiet-state').classList.toggle('active', !!quiet);
  $('quiet-save').textContent = quiet ? 'Mettre à jour' : 'Activer';
  $('quiet-save').disabled = busy || paused;
  $('quiet-off').hidden = !quiet;
  $('quiet-off').disabled = busy;
  if (quiet && document.activeElement !== $('quiet-start') && document.activeElement !== $('quiet-end')) {
    $('quiet-start').value = minutesToTime(quiet.start);
    $('quiet-end').value = minutesToTime(quiet.end);
  }
  $('telegram-state').textContent = telegramActive ? 'Connecté' : telegramUntil ? 'En attente' : 'Non connecté';
  $('telegram-state').classList.toggle('active', telegramActive);
  const needsChannel = telegramAvailable && !paused && !telegramActive && !telegramUntil && !channels.length;
  $('telegram-hint').textContent = !telegramAvailable ? 'Le bot Telegram doit être configuré sur ce serveur.'
    : paused ? 'Les alertes Telegram sont en pause sur ce serveur.'
    : telegramUntil ? 'Ouvre le bot et appuie sur Démarrer pour terminer la connexion.'
    : needsChannel ? 'Ajoute au moins une chaîne à ta liste pour connecter Telegram.'
    : 'Reçois les alertes dans une conversation privée avec le bot.';
  $('telegram-search').hidden = !needsChannel;
  $('telegram-connect').hidden = telegramActive || !!telegramUntil || needsChannel;
  $('telegram-connect').disabled = busy || paused || !telegramAvailable || !channels.length;
  $('telegram-link').hidden = !telegramUntil;
  $('telegram-test').hidden = !telegramActive;
  $('telegram-test').disabled = busy || paused || !telegramAvailable;
  $('telegram-stop').hidden = !telegramActive && !telegramUntil;
  $('telegram-stop').disabled = busy;
  $('open-connection').textContent = account || 'Connexion';
  if (account) $('open-connection').setAttribute('aria-haspopup', 'dialog');
  else $('open-connection').removeAttribute('aria-haspopup');
  $('account-connected').hidden = !account;
  $('account-display').textContent = account;
  document.title = (liveNow.length ? '(' + liveNow.length + ') ' : '') + baseTitle;
  $('eyebrow-text').innerHTML = liveNow.length
    ? '<b>' + liveNow.length + (liveNow.length > 1 ? ' de tes chaînes sont' : ' de tes chaînes est') + ' en direct</b>'
    : '<b>Alertes de live</b> · gratuit, sans compte';
  const ordered = (watchLiveOnly ? liveNow : [...channels]).sort((a, b) => {
    const ia = infoFor(a), ib = infoFor(b);
    return (isFresh(ib) && ib.live) - (isFresh(ia) && ia.live);
  });
  $('channels').replaceChildren(...ordered.map((login, index) => {
    const row = document.createElement('li');
    row.style.animationDelay = index * 30 + 'ms';
    const info = infoFor(login);
    const fresh = isFresh(info);
    const channel = document.createElement('a');
    channel.className = 'channel';
    streamerLink(channel, login);
    const name = document.createElement('strong');
    name.textContent = info?.name || login;
    channel.append(name);
    const sub = document.createElement('small');
    sub.textContent = fresh && info.live && info.title ? info.title : '@' + login;
    channel.append(sub);
    const tail = document.createElement('div');
    tail.className = 'tail';
    const badge = document.createElement('span');
    badge.className = 'pill' + (fresh && info.live ? ' active' : '');
    badge.textContent = fresh ? (info.live ? 'En direct' : 'Hors ligne') : 'En attente';
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.type = 'button';
    remove.textContent = 'Retirer';
    remove.setAttribute('aria-label', 'Retirer ' + login);
    remove.disabled = busy;
    remove.onclick = () => editChannels(channels.filter(channel => channel !== login));
    if (active && saved.includes(login)) {
      const mute = document.createElement('button');
      mute.className = 'mute';
      mute.type = 'button';
      const muted = mutes.has(login);
      mute.textContent = muted ? 'Muet' : 'Sourdine';
      mute.title = muted ? 'Réactiver les alertes de cette chaîne' : 'Ne plus recevoir d’alertes de cette chaîne (elle reste dans ta liste)';
      mute.setAttribute('aria-pressed', String(muted));
      mute.setAttribute('aria-label', (muted ? 'Réactiver les alertes de ' : 'Mettre en sourdine ') + login);
      mute.disabled = busy || paused;
      mute.onclick = () => operate(async () => {
        const next = new Set(mutes);
        if (!next.delete(login)) next.add(login);
        update(await api('prefs', { mutes: [...next] }));
        notice(next.has(login) ? login + ' est en sourdine : plus d’alerte de sa part.' : 'Alertes de ' + login + ' réactivées.');
      });
      tail.append(badge, mute, remove);
    } else tail.append(badge, remove);
    row.append(avatarNode({ ...info, login }), channel, tail);
    return row;
  }));
  renderSources();
  updateStreamerButton();
  queueAgenda();
}

function reloadIfOutdated(response) {
  const revision = response.headers.get('X-TwitchIO-Alerts-Revision');
  if (!revision || revision === pageRevision || busy || document.querySelector('dialog[open], input:focus')) return false;
  location.reload();
  return true;
}
async function fetchAlertSettings() {
  const response = await fetch('/api/alerts');
  return reloadIfOutdated(response) ? null : response.json();
}
async function api(action, fields = {}) {
  const r = await fetch('/api/alerts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    keepalive: action === 'save',
    body: JSON.stringify({ action, token, account, ...fields }),
  });
  if (action === 'read' && reloadIfOutdated(r)) return null;
  const result = await r.json();
  if (result.sessionChanged) setTimeout(refresh, 0);
  if (!r.ok || !result.ok) throw new Error(result.error || 'Le serveur ne répond pas.');
  return result;
}
function update(result) {
  active = result.active;
  pushActive = result.pushActive === true;
  telegramActive = result.telegramActive === true;
  telegramAvailable = result.telegramAvailable === true;
  if (telegramActive) clearTelegramLink();
  paused = result.paused === true;
  mutes = new Set(result.prefs?.mutes || []);
  quiet = result.prefs?.quiet || null;
  saved = result.channels.map(channel => channel.login);
  states = new Map(result.channels.map(channel => [channel.login, channel]));
  if ((result.account || '') !== account) {
    account = result.account || '';
    clearTelegramLink();
    disconnect();
    if (account) {
      const draft = readDraft(accountDraft());
      listPending = Array.isArray(draft.channels) && Array.isArray(draft.base);
      channels = listPending ? draft.channels : saved.slice();
      listBase = listPending ? draft.base : [];
    } else restoreGuest(readDraft(storageKey));
  }
  if (active) {
    const sameList = channels.join(',') === saved.join(',');
    if (listPending && sameList) {
      listPending = false;
      remember();
    } else if (!listPending && !sameList) {
      channels = saved.slice();
      remember();
    }
  }
  render();
}
function bytes(key) {
  const base64 = key.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
}
async function operate(fn) {
  if (busy) return;
  operation++;
  busy = true;
  render();
  notice('');
  try { await fn(); }
  catch (e) { notice(e.message || 'Une erreur est survenue.', true); }
  finally { busy = false; render(); }
}

function searchTerm(value) {
  let query = value.trim().toLowerCase().replace(/^@/, '');
  if (/^(?:https?:\/\/|(?:www\.|m\.)?twitch\.tv\/)/.test(query)) {
    try {
      const url = new URL(query.includes('://') ? query : 'https://' + query);
      query = /^(?:www\.|m\.)?twitch\.tv$/.test(url.hostname) ? url.pathname.split('/')[1] : '';
    } catch { return ''; }
  }
  return query;
}
function addChannels(items) {
  if (busy) return;
  const selected = [...new Set(items.map(x => x.login).filter(login => loginPattern.test(login) && !channels.includes(login)))].slice(0, 12 - channels.length);
  if (!selected.length) return;
  for (const item of items) {
    if (selected.includes(item.login)) known.set(item.login, { ...item, checked: item.live !== undefined ? Date.now() : 0 });
  }
  editChannels([...channels, ...selected]);
  if (!active) notice(selected.length === 1 ? 'Chaîne ajoutée à ta liste.' : selected.length + ' chaînes ajoutées à ta liste.');
}
function resultRow(item, index = 0, card = false) {
  const row = document.createElement('li');
  row.className = 'result';
  row.style.setProperty('--i', Math.min(index, 12));
  const thumbbed = card && item.live && loginPattern.test(item.login);
  if (thumbbed) {
    const thumb = document.createElement('a');
    thumb.className = 'thumb';
    streamerLink(thumb, item.login);
    thumb.tabIndex = -1;
    thumb.setAttribute('aria-hidden', 'true');
    if (item.title) thumb.title = item.title;
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = 'https://static-cdn.jtvnw.net/previews-ttv/live_user_' + item.login + '-440x248.jpg?t=' + Math.floor(Date.now() / 60000);
    img.onerror = () => img.remove();
    const live = document.createElement('span');
    live.className = 'tag live';
    live.textContent = 'EN DIRECT';
    thumb.append(img, live);
    if (item.viewers > 0) {
      const views = document.createElement('span');
      views.className = 'tag views';
      views.textContent = fmtViewers(item.viewers) + ' 👁';
      thumb.append(views);
    }
    row.append(thumb);
  }
  const top = document.createElement('div');
  top.className = 'top';
  const channel = document.createElement('a');
  channel.className = 'channel';
  streamerLink(channel, item.login);
  const name = document.createElement('strong'), identity = document.createElement('small');
  name.textContent = item.name || item.login;
  identity.className = 'result-label';
  if (item.live && !thumbbed) {
    const dot = document.createElement('span');
    dot.className = 'live-dot';
    dot.setAttribute('aria-hidden', 'true');
    identity.append(dot);
  }
  identity.append(thumbbed ? (item.game || '@' + item.login) : item.live ? (item.viewers > 0 ? fmtViewers(item.viewers) + ' spectateurs' : icons.live) : '@' + item.login);
  channel.append(name, identity);
  if (item.game && !thumbbed) {
    const game = document.createElement('small');
    game.textContent = item.game;
    channel.append(game);
  }
  top.append(avatarNode(item), channel);
  const button = document.createElement('button');
  const added = channels.includes(item.login);
  button.type = 'button';
  button.disabled = added || channels.length >= 12 || busy;
  button.textContent = added ? '✓ Ajoutée' : channels.length >= 12 ? 'Liste pleine' : '+ Ajouter';
  button.setAttribute('aria-label', (added ? 'Ajoutée ' : 'Ajouter ') + (item.name || item.login));
  button.onclick = () => addChannels([item]);
  row.append(top, button);
  return row;
}
function matchingFollows() {
  const query = $('follow-filter').value.trim().toLowerCase();
  return followed.filter(item => [item.login, item.name].some(s => s?.toLowerCase().includes(query)));
}
function streamerLink(link, login) {
  link.href = '/alerte?streamer=' + encodeURIComponent(login);
  link.onclick = event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openStreamer(login);
  };
}
function updateStreamerButton() {
  const button = $('streamer-alert');
  const added = streamer && channels.includes(streamer.login);
  button.textContent = added ? '✓ Dans ta liste' : 'Ajouter en alerte';
  button.disabled = !streamer || added || channels.length >= 12 || busy;
}
const scheduleDate = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
const scheduleTime = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short' });
const scheduleMonth = new Intl.DateTimeFormat('fr-FR', { month: 'short' });
const scheduleWeekday = new Intl.DateTimeFormat('fr-FR', { weekday: 'long' });
const calendarDate = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const calendarText = value => String(value).replace(/\\/g, '\\\\').replace(/\r?\n|\r/g, '\\n').replace(/[;,]/g, '\\$&');
function foldCalendarLine(line) {
  const encoder = new TextEncoder();
  let out = '', count = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (count + size > 75) { out += '\r\n '; count = 1; }
    out += char;
    count += size;
  }
  return out;
}
function exportCalendar(events, filename) {
  const stamp = calendarDate(new Date());
  const entries = events.flatMap(({ channel, event }) => {
    const title = (channel.name || channel.login) + ' · ' + (event.title || 'Live Twitch');
    const url = 'https://www.twitch.tv/' + channel.login;
    return [
      'BEGIN:VEVENT', 'UID:' + encodeURIComponent(channel.login + ':' + (event.id || event.startAt)) + '@twitchio',
      'DTSTAMP:' + stamp, 'DTSTART:' + calendarDate(new Date(event.startAt)), 'DTEND:' + calendarDate(new Date(event.endAt)),
      'SUMMARY:' + calendarText(title), 'DESCRIPTION:' + calendarText(url), 'URL:' + url, 'END:VEVENT',
    ];
  });
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TwitchIO//Alertes Twitch//FR', ...entries, 'END:VCALENDAR'];
  const file = URL.createObjectURL(new Blob([lines.map(foldCalendarLine).join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = file;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(file), 1000);
}
function downloadCalendar(channel, event) {
  exportCalendar([{ channel, event }], channel.login + '-' + event.startAt.slice(0, 10) + '.ics');
}
const agendaDay = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
function drawAgenda() {
  const groups = new Map();
  for (const { channel, event } of agendaEvents) {
    const date = new Date(event.startAt), key = date.toDateString();
    let group = groups.get(key);
    if (!group) {
      const section = document.createElement('section'), heading = document.createElement('h3'), list = document.createElement('ul');
      section.className = 'agenda-day';
      heading.textContent = agendaDay.format(date);
      section.append(heading, list);
      group = { section, list };
      groups.set(key, group);
    }
    const row = document.createElement('li'), summary = document.createElement('div');
    summary.className = 'agenda-summary';
    const title = document.createElement('strong'), details = document.createElement('small'), link = document.createElement('a');
    title.textContent = event.title || 'Live Twitch';
    link.textContent = channel.name || channel.login;
    streamerLink(link, channel.login);
    details.append(scheduleTime.format(date) + ' · ', link, event.game ? ' · ' + event.game : '');
    summary.append(title, details);
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = '+ Agenda';
    add.setAttribute('aria-label', 'Ajouter à l’agenda : ' + title.textContent);
    add.onclick = () => downloadCalendar(channel, event);
    row.append(summary, add);
    group.list.append(row);
  }
  $('agenda-days').replaceChildren(...[...groups.values()].map(group => group.section));
  $('agenda-export').hidden = !agendaEvents.length;
}
async function loadAgenda() {
  clearTimeout(agendaTimer);
  const list = [...channels];
  if (!list.length) return;
  agendaRequest?.abort();
  const controller = new AbortController();
  agendaRequest = controller;
  const status = $('agenda-status');
  $('agenda-refresh').disabled = true;
  status.textContent = 'Chargement des plannings Twitch…';
  try {
    const r = await fetch('/api/alerts/schedule?channels=' + encodeURIComponent(list.join(',')), { signal: controller.signal });
    const data = await r.json();
    if (controller.signal.aborted) return;
    if (!r.ok || !Array.isArray(data.schedules)) throw new Error(data.error || 'Calendriers Twitch indisponibles.');
    const start = Date.now(), end = start + 14 * 86400000;
    const unavailable = data.schedules.filter(s => !s.available).length;
    agendaEvents = data.schedules.flatMap(({ login, events }) => events.filter(event => {
      const when = Date.parse(event.startAt);
      return when >= start && when < end;
    }).map(event => ({ channel: { login, name: infoFor(login)?.name || login }, event })))
      .sort((a, b) => Date.parse(a.event.startAt) - Date.parse(b.event.startAt));
    const summary = agendaEvents.length
      ? agendaEvents.length + ' live' + (agendaEvents.length > 1 ? 's' : '') + ' prévu' + (agendaEvents.length > 1 ? 's' : '') + ' sur les 14 prochains jours'
      : 'Aucun live publié pour les 14 prochains jours';
    const warning = unavailable ? ' · ' + unavailable + (unavailable === 1 ? ' calendrier indisponible' : ' calendriers indisponibles') : '';
    status.textContent = unavailable === list.length ? 'Twitch ne répond pas pour ces calendriers. Essaie à nouveau.' : summary + warning + '.';
    drawAgenda();
  } catch (e) {
    if (!controller.signal.aborted) status.textContent = e.message || 'Calendriers Twitch indisponibles.';
  } finally {
    if (agendaRequest === controller) $('agenda-refresh').disabled = false;
  }
}
function queueAgenda() {
  const key = channels.join(',');
  if (key === agendaKey) return;
  agendaKey = key;
  clearTimeout(agendaTimer);
  agendaRequest?.abort();
  agendaEvents = [];
  drawAgenda();
  $('agenda-refresh').hidden = $('agenda-jump').hidden = !key;
  $('agenda-status').textContent = key ? 'Chargement des plannings Twitch…' : 'Ajoute des chaînes à ta liste pour retrouver ici leurs prochains lives.';
  if (key) agendaTimer = setTimeout(loadAgenda, 350);
}
$('agenda-refresh').onclick = loadAgenda;
$('agenda-export').onclick = () => { if (agendaEvents.length) exportCalendar(agendaEvents, 'twitchio-prochains-lives.ics'); };
function showStreamer({ channel, schedule }) {
  streamer = channel;
  $('streamer-title').textContent = channel.name || channel.login;
  $('streamer-avatar').replaceChildren(avatarNode(channel));
  const status = document.createElement('span');
  status.className = 'pill' + (channel.live ? ' live' : '');
  status.textContent = channel.live ? 'En direct' : 'Hors ligne';
  $('streamer-meta').replaceChildren(status, '@' + channel.login);
  if (channel.live && channel.viewers > 0) {
    const viewers = document.createElement('span');
    viewers.textContent = '· ' + fmtViewers(channel.viewers) + ' spectateurs';
    $('streamer-meta').append(viewers);
  }

  const cover = channel.live
    ? 'https://static-cdn.jtvnw.net/previews-ttv/live_user_' + channel.login + '-640x360.jpg?t=' + Math.floor(Date.now() / 60000)
    : channel.banner;
  if (avatarPattern.test(cover || '')) {
    const image = document.createElement('img');
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.onerror = () => image.remove();
    image.src = cover;
    $('streamer-cover').replaceChildren(image);
  }

  const content = $('streamer-content');
  content.replaceChildren();
  if (channel.live && channel.title) {
    const title = document.createElement('h3');
    title.textContent = channel.title;
    content.append(title);
  }
  if (channel.live && channel.game) {
    const game = document.createElement('p');
    game.textContent = channel.game;
    content.append(game);
  }
  if (channel.bio) {
    const bio = document.createElement('p');
    bio.className = 'streamer-bio';
    bio.textContent = channel.bio;
    content.append(bio);
  }
  $('schedule-status').textContent = !schedule.available ? 'Calendrier Twitch indisponible.' : schedule.events.length ? '' : 'Aucun prochain live publié sur Twitch.';
  $('schedule-events').replaceChildren(...schedule.events.map(event => {
    const row = document.createElement('li');
    const day = document.createElement('div'), number = document.createElement('b'), month = document.createElement('small');
    day.className = 'schedule-day';
    day.setAttribute('aria-hidden', 'true');
    const eventInfo = document.createElement('div');
    eventInfo.className = 'schedule-event';
    const label = document.createElement('strong'), time = document.createElement('time');
    label.textContent = [event.title || 'Live prévu', event.game].filter(Boolean).join(' · ');
    const start = new Date(event.startAt), end = new Date(event.endAt);
    number.textContent = start.getDate();
    month.textContent = scheduleMonth.format(start);
    day.append(number, month);
    time.dateTime = event.startAt;
    const sameDay = start.toDateString() === end.toDateString();
    time.textContent = scheduleWeekday.format(start) + ' · ' + scheduleTime.format(start) + ' – ' + (sameDay ? scheduleTime.format(end) : scheduleDate.format(end));
    time.setAttribute('aria-label', scheduleDate.format(start) + ' à ' + (sameDay ? scheduleTime.format(end) : scheduleDate.format(end)));
    eventInfo.append(label, time);
    const agenda = document.createElement('button');
    agenda.className = 'agenda';
    agenda.type = 'button';
    agenda.textContent = '+ Agenda';
    agenda.setAttribute('aria-label', 'Ajouter à l’agenda : ' + label.textContent);
    agenda.onclick = () => downloadCalendar(channel, event);
    row.append(day, eventInfo, agenda);
    return row;
  }));
  updateStreamerButton();
}
async function openStreamer(login) {
  if (!loginPattern.test(login)) return;
  streamerRequest?.abort();
  const controller = new AbortController();
  streamerRequest = controller;
  streamer = null;
  $('streamer-title').textContent = login;
  $('streamer-cover').replaceChildren();
  $('streamer-avatar').replaceChildren();
  $('streamer-meta').replaceChildren();
  $('streamer-share-url').hidden = true;
  $('streamer-share-status').textContent = '';
  $('streamer-content').textContent = 'Chargement de la fiche…';
  $('streamer-twitch').href = 'https://www.twitch.tv/' + login;
  $('schedule-status').textContent = '';
  $('schedule-events').replaceChildren();
  updateStreamerButton();
  if (!$('streamer').open) $('streamer').showModal();
  history.replaceState(null, '', '/alerte?streamer=' + encodeURIComponent(login));
  try {
    const r = await fetch('/api/alerts/channel/' + encodeURIComponent(login), { signal: controller.signal });
    const data = await r.json();
    if (controller.signal.aborted) return;
    if (!r.ok || !data.channel) throw new Error(data.error || 'Chaîne indisponible.');
    showStreamer(data);
  } catch (e) {
    if (!controller.signal.aborted) $('streamer-content').textContent = e.message || 'Chaîne indisponible.';
  }
}
$('close-streamer').onclick = () => $('streamer').close();
$('streamer').addEventListener('close', () => {
  streamerRequest?.abort();
  streamer = null;
  history.replaceState(null, '', '/alerte');
});
$('streamer-alert').onclick = () => { if (streamer) addChannels([streamer]); };
$('streamer-share').onclick = async () => {
  const url = location.href, field = $('streamer-share-url');
  try {
    await navigator.clipboard.writeText(url);
    if (location.href === url) $('streamer-share-status').textContent = 'Lien copié.';
  } catch {
    if (location.href !== url) return;
    field.value = url;
    field.hidden = false;
    field.focus();
    field.select();
    $('streamer-share-status').textContent = 'Le lien est sélectionné. Tu peux le copier.';
  }
};
$('watch-live').onclick = () => { watchLiveOnly = !watchLiveOnly; render(); };
function renderSources() {
  const searching = searchTerm($('channel').value).length >= 2;
  $('discovery-title').textContent = searching ? 'Résultats Twitch' : 'Découvrir les lives';
  $('discovery-rails').hidden = searching;
  $('search-results').hidden = !searching;
  $('refresh-suggestions').hidden = searching;
  if (searching) $('search-results').replaceChildren(...results.map((item, i) => resultRow(item, i, true)));
  else {
    $('search-status').textContent = '';
    for (const mode of ['fr', 'top']) {
      const row = $('rail-' + mode);
      row.replaceChildren(...(loadingTab[mode] && !lists[mode].length
        ? Array.from({ length: 4 }, () => Object.assign(document.createElement('li'), { className: 'skeleton' }))
        : lists[mode].map((item, i) => resultRow(item, i, true))));
      $('rail-' + mode + '-status').textContent = messages[mode];
    }
  }
  $('manual-add').hidden = !manualLogin || channels.includes(manualLogin) || channels.length >= 12;
  $('manual-add').disabled = busy;
  const matches = matchingFollows();
  $('follow-results').replaceChildren(...matches.slice(0, followLimit).map((item, i) => resultRow(item, i)));
  $('follow-more').hidden = matches.length <= followLimit;
  $('follow-add').disabled = busy || channels.length >= 12 || !matches.some(item => !channels.includes(item.login));
}
async function search() {
  searchRequest?.abort();
  const query = searchTerm($('channel').value);
  manualLogin = '';
  results = [];
  renderSources();
  if (query.length < 2) return;
  const controller = new AbortController();
  searchRequest = controller;
  $('search-status').textContent = 'Recherche sur Twitch…';
  try {
    const r = await fetch('/api/alerts/search?q=' + encodeURIComponent(query), { signal: controller.signal });
    const found = await r.json();
    if (controller.signal.aborted) return;
    if (!r.ok || found.error) throw new Error(found.error || 'Recherche indisponible.');
    results = found.channels;
    $('search-status').textContent = results.length ? '' : 'Aucun résultat.';
  } catch (e) {
    if (controller.signal.aborted) return;
    $('search-status').textContent = e.message || 'Recherche indisponible.';
  }
  if (!results.length && loginPattern.test(query)) manualLogin = query;
  renderSources();
}
$('add').onsubmit = event => {
  event.preventDefault();
  clearTimeout(searchTimer);
  search();
};
$('channel').oninput = () => {
  clearTimeout(searchTimer);
  searchRequest?.abort();
  results = [];
  manualLogin = '';
  $('search-status').textContent = '';
  renderSources();
  searchTimer = setTimeout(search, 350);
};
$('manual-add').onclick = () => addChannels([{ login: manualLogin }]);
$('follow-filter').oninput = () => { followLimit = 8; renderSources(); };
$('follow-more').onclick = () => { followLimit += 8; renderSources(); };
$('follow-add').onclick = () => addChannels(matchingFollows());
$('open-connection').onclick = event => {
  if (!account || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  $('connection-title').textContent = 'Compte Alertes';
  $('account-status').textContent = '';
  $('profile-details').open = false;
  $('connection').showModal();
};
$('open-follows').onclick = () => {
  $('connection-title').textContent = 'Importer mes suivis Twitch';
  $('account-status').textContent = '';
  $('profile-details').open = true;
  $('connection').showModal();
};
$('close-connection').onclick = () => $('connection').close();
$('account-logout').onclick = async event => {
  const button = event.currentTarget;
  await operate(async () => {
    const status = $('account-status');
    button.disabled = true;
    status.textContent = 'Un instant…';
    try {
      const res = await fetch('/api/alerts/account', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logout', token }),
      });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error || 'Le serveur ne répond pas.');
      const stopPush = pushActive;
      update(result.alerts);
      status.textContent = 'Déconnecté de ce navigateur.';
      if (stopPush && !pushActive) {
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) await subscription.unsubscribe();
      }
    } catch (error) { status.textContent = error.message || 'Déconnexion impossible.'; }
    finally { button.disabled = false; }
  });
};
async function loadSuggestions() {
  $('refresh-suggestions').classList.add('spin');
  $('refresh-suggestions').disabled = true;
  await Promise.all(['fr', 'top'].map(async mode => {
    loadingTab[mode] = true;
    messages[mode] = '';
    renderSources();
    try {
      const r = await fetch('/api/alerts/discover?mode=' + mode);
      const data = await r.json();
      if (!r.ok || !Array.isArray(data.channels)) throw new Error('Découverte indisponible');
      lists[mode] = data.channels.filter(item => loginPattern.test(item.login));
      messages[mode] = lists[mode].length ? '' : 'Aucun live dans cette rangée pour le moment.';
    } catch { messages[mode] = 'Chargement indisponible. Réessaie avec Actualiser.'; }
    finally { loadingTab[mode] = false; renderSources(); }
  }));
  $('refresh-suggestions').classList.remove('spin');
  $('refresh-suggestions').disabled = false;
}
for (const button of document.querySelectorAll('[data-rail]')) {
  button.onclick = () => {
    const row = $('rail-' + button.dataset.rail);
    row.scrollBy({ left: row.clientWidth * 0.85 * Number(button.dataset.direction), behavior: 'smooth' });
  };
}
$('refresh-suggestions').onclick = loadSuggestions;
const syncSearchBox = () => $('add').classList.toggle('filled', $('channel').value.length > 0);
$('channel').addEventListener('input', syncSearchBox);
$('clear-search').onclick = () => {
  $('channel').value = '';
  $('channel').dispatchEvent(new Event('input'));
  $('channel').focus();
};
$('clear-all').onclick = () => {
  if (busy || !channels.length || !confirm('Retirer les ' + channels.length + ' chaînes de ta liste ?')) return;
  editChannels([]);
};
$('savebar-save').onclick = syncSelections;
document.addEventListener('keydown', event => {
  const tag = (event.target.tagName || '').toLowerCase();
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && tag !== 'input' && tag !== 'textarea') {
    event.preventDefault();
    $('channel').focus();
  }
  if (event.key === 'Escape' && document.activeElement === $('channel') && $('channel').value) $('clear-search').click();
});
function disconnect() {
  profile = null;
  followed = [];
  $('profile-signin').hidden = false;
  $('profile-connected').hidden = true;
  $('profile-status').textContent = '';
  $('follow-filter').value = '';
  renderSources();
}
async function loadFollows(id, credentials, button) {
  const status = $('profile-status');
  const owner = account;
  status.textContent = 'Chargement des chaînes suivies…';
  button.disabled = $('profile-logout').disabled = true;
  try {
    const r = await fetch('/api/profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'alert-follows', id, ...credentials }),
    });
    const data = await r.json();
    if (account !== owner) return;
    if (data.expired) disconnect();
    if (!data.ok) throw new Error(data.error || 'Connexion impossible.');
    profile = { id, session: data.session };
    followed = data.channels.filter(item => loginPattern.test(item.login));
    followLimit = 8;
    $('profile-name').textContent = data.pseudo;
    $('profile-signin').hidden = true;
    $('profile-connected').hidden = false;
    status.textContent = followed.length ? followed.length + ' suivis Twitch' : 'Ce compte ne suit encore aucune chaîne.';
    renderSources();
  } catch (e) { status.textContent = e.message || 'Connexion impossible.'; }
  finally { button.disabled = $('profile-logout').disabled = false; }
}
$('profile-form').onsubmit = event => {
  event.preventDefault();
  const raw = $('profile-id').value.trim();
  const id = raw.match(/\/u\/([A-Za-z0-9_-]{16,40})(?:[/?#]|$)/)?.[1] || raw;
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(id)) {
    $('profile-status').textContent = 'Colle ton identifiant de config ou ton lien d’installation.';
    return;
  }
  const password = $('profile-password').value;
  $('profile-password').value = '';
  loadFollows(id, { password }, event.submitter || $('profile-form').querySelector('button'));
};
$('profile-refresh').onclick = event => {
  if (profile) loadFollows(profile.id, { session: profile.session }, event.currentTarget);
};
$('profile-logout').onclick = disconnect;

async function syncSelections() {
  if (!active || !listPending) return;
  await operate(async () => {
    const result = account ? await api('save', { changes: {
      add: channels.filter(login => !listBase.includes(login)),
      remove: listBase.filter(login => !channels.includes(login)),
    } }) : await api('save', { channels });
    if (account) { listPending = false; remember(); }
    update(result);
    notice('Liste de chaînes synchronisée.');
  });
}
$('enable').onclick = () => operate(async () => {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Autorise les notifications dans les réglages du site pour continuer.');
  let subscription = await registration.pushManager.getSubscription();
  const expected = bytes(publicKey);
  const previous = new Uint8Array(subscription?.options?.applicationServerKey || []);
  if (subscription && (previous.length !== expected.length || previous.some((n, i) => n !== expected[i]))) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: expected });
  token ||= crypto.randomUUID();
  remember();
  update(await api('save', { subscription: subscription.toJSON(), ...(account ? {} : { channels }) }));
  notice('Alertes activées. Les prochains directs déclencheront une notification.');
});
$('test').onclick = () => operate(async () => {
  update(await api('test'));
  notice('Notification de test envoyée.');
});
$('stop').onclick = () => operate(async () => {
  update(await api('stop'));
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) await subscription.unsubscribe();
  notice('Notifications désactivées sur ce navigateur.');
});
$('quiet-save').onclick = () => operate(async () => {
  const start = timeToMinutes($('quiet-start').value), end = timeToMinutes($('quiet-end').value);
  if (start < 0 || end < 0) throw new Error('Choisis une heure de début et une heure de fin.');
  if (start === end) throw new Error('Le début et la fin doivent être différents.');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  update(await api('prefs', { quiet: { start, end, tz } }));
  notice('Heures calmes enregistrées : ' + minutesToTime(start) + ' – ' + minutesToTime(end) + '.');
});
$('quiet-off').onclick = () => operate(async () => {
  update(await api('prefs', { quiet: null }));
  notice('Heures calmes désactivées.');
});
function clearTelegramLink() {
  clearTimeout(telegramTimer);
  telegramUntil = 0;
  $('telegram-link').removeAttribute('href');
}
async function waitForTelegram() {
  if (!telegramUntil) return;
  if (Date.now() >= telegramUntil) {
    clearTelegramLink();
    render();
    return notice('Le lien Telegram a expiré. Tu peux en créer un nouveau.', true);
  }
  await refresh();
  if (telegramUntil) telegramTimer = setTimeout(waitForTelegram, 5000);
}
$('telegram-search').onclick = () => $('channel').focus();
$('telegram-connect').onclick = () => operate(async () => {
  token ||= crypto.randomUUID();
  remember();
  const result = await api('telegram-link', { channels });
  if (!/^https:\/\/t\.me\//.test(result.link || '')) throw new Error('Lien Telegram indisponible.');
  $('telegram-link').href = result.link;
  telegramUntil = Date.now() + 600000;
  telegramTimer = setTimeout(waitForTelegram, 3000);
});
$('telegram-test').onclick = () => operate(async () => {
  update(await api('telegram-test'));
  notice('Notification de test envoyée sur Telegram.');
});
$('telegram-stop').onclick = () => operate(async () => {
  const result = await api('telegram-stop');
  clearTelegramLink();
  update(result);
  notice('Telegram déconnecté.');
});

async function refresh() {
  if (busy || refreshing) return;
  refreshing = true;
  const started = operation;
  try {
    const result = token ? await api('read') : await fetchAlertSettings();
    if (busy || started !== operation || typeof result?.paused !== 'boolean') return;
    if (token) {
      update(result);
      await syncSelections();
    } else { paused = result.paused; telegramAvailable = result.telegramAvailable === true; render(); }
  } catch { /* la prochaine vérification reprendra */ }
  finally { refreshing = false; }
}
async function init() {
  const local = readDraft(storageKey);
  try {
    const previous = JSON.parse(localStorage.getItem('twprofile') || 'null');
    if (previous?.id) $('profile-id').value = previous.id;
  } catch { /* la connexion reste manuelle */ }
  token = local.token || crypto.randomUUID?.();
  restoreGuest(local);
  if (token && !local.token) remember();
  render();
  loadSuggestions();
  openStreamer(new URL(location.href).searchParams.get('streamer') || '');
  setInterval(refresh, 20000);
  window.addEventListener('focus', refresh);
  window.addEventListener('online', refresh);
  window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
  try {
    const key = await fetchAlertSettings();
    if (!key) return;
    if (!key.publicKey) throw new Error('Clé Push indisponible.');
    publicKey = key.publicKey;
    paused = key.paused === true;
    telegramAvailable = key.telegramAvailable === true;
    if (token) await refresh();
    render();
    if (!supported) return;
    await navigator.serviceWorker.register('/alerte-sw.js', { scope: '/alerte' });
    registration = await navigator.serviceWorker.ready;
    if (pushActive && !await registration.pushManager.getSubscription()) {
      update(await api('stop'));
      notice('Ton abonnement a expiré. Réactive les notifications.', true);
    }
    render();
  } catch { notice('Impossible de préparer les notifications. Recharge la page pour réessayer.', true); }
}
init();
