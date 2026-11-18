'use strict';

const $ = id => document.getElementById(id);
const storageKey = 'twitchio-alerts';
const loginPattern = /^[a-z0-9_]{3,25}$/;
const supported = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let channels = [], saved = [], states = new Map(), token, active = false, paused = false, registration, publicKey, busy = false;
let results = [], followed = [], profile, followLimit = 8, searchRequest, searchTimer, manualLogin = '';
const known = new Map();

function notice(text, error = false) {
  $('message').textContent = text;
  $('message').toggleAttribute('data-error', error);
}
function remember() {
  localStorage.setItem(storageKey, JSON.stringify({ token, channels }));
}
function render() {
  const changed = channels.join(',') !== saved.join(',');
  $('count').textContent = channels.length + ' / 12';
  $('state').textContent = paused ? 'En pause' : active ? 'Activées' : 'Désactivées';
  $('state').classList.toggle('active', active && !paused);
  $('hint').textContent = paused
    ? 'Le serveur a mis les envois en pause. Les listes enregistrées seront réutilisées à la reprise.'
    : active && changed ? 'Enregistre tes modifications pour mettre à jour les alertes.' : 'Tes alertes sont propres à ce navigateur.';
  $('enable').textContent = busy ? 'Un instant…' : active ? 'Enregistrer la liste' : 'Activer les notifications';
  $('enable').disabled = paused || busy || !registration || !publicKey || !channels.length || (active && !changed);
  $('notification-actions').hidden = !active;
  $('test').disabled = busy || paused;
  $('stop').disabled = busy;
  $('empty').hidden = channels.length > 0;
  $('channels').replaceChildren(...channels.map(login => {
    const row = document.createElement('li');
    const channel = document.createElement('a');
    channel.className = 'channel';
    channel.href = 'https://www.twitch.tv/' + login;
    channel.target = '_blank';
    channel.rel = 'noopener noreferrer';
    const info = states.get(login)?.checked ? states.get(login) : known.get(login);
    const name = document.createElement('strong');
    name.textContent = info?.name || login;
    channel.append(name);
    if (info?.live && info.title) {
      const title = document.createElement('small');
      title.textContent = info.title;
      channel.append(title);
    }
    const tail = document.createElement('div');
    tail.className = 'tail';
    const badge = document.createElement('span');
    const fresh = Date.now() - (info?.checked || 0) < 180000;
    badge.className = 'pill' + (fresh && info.live ? ' active' : '');
    badge.textContent = fresh ? (info.live ? 'En direct' : 'Hors ligne') : 'En attente';
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.type = 'button';
    remove.textContent = 'Retirer';
    remove.setAttribute('aria-label', 'Retirer ' + login);
    remove.disabled = busy;
    remove.onclick = () => {
      channels = channels.filter(channel => channel !== login);
      remember();
      render();
      if (!channels.length && active) notice('Désactive les notifications pour arrêter de surveiller la dernière chaîne.');
    };
    tail.append(badge, remove);
    row.append(channel, tail);
    return row;
  }));
  renderSources();
}

async function api(action, fields = {}) {
  const r = await fetch('/api/alerts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, token, ...fields }),
  });
  const result = await r.json();
  if (!r.ok || !result.ok) throw new Error(result.error || 'Le serveur ne répond pas.');
  return result;
}
function update(result) {
  active = result.active;
  paused = result.paused === true;
  saved = result.channels.map(channel => channel.login);
  states = new Map(result.channels.map(channel => [channel.login, channel]));
  render();
}
function bytes(key) {
  const base64 = key.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
}
async function operate(fn) {
  if (busy) return;
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
  const selected = [...new Set(items.map(x => x.login).filter(login => loginPattern.test(login) && !channels.includes(login)))].slice(0, 12 - channels.length);
  if (!selected.length) return;
  for (const item of items) {
    if (selected.includes(item.login)) known.set(item.login, { ...item, checked: item.name ? Date.now() : 0 });
  }
  channels.push(...selected);
  remember();
  render();
  notice(selected.length === 1 ? 'Chaîne ajoutée à ta liste.' : selected.length + ' chaînes ajoutées à ta liste.');
}
function resultRow(item) {
  const row = document.createElement('li');
  row.className = 'result';
  if (/^https:\/\/static-cdn\.jtvnw\.net\//.test(item.avatar || '')) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.alt = '';
    img.loading = 'lazy';
    img.src = item.avatar;
    row.append(img);
  }
  const channel = document.createElement('span');
  channel.className = 'channel';
  const name = document.createElement('strong'), identity = document.createElement('small');
  name.textContent = item.name || item.login;
  identity.textContent = '@' + item.login + (item.live ? ' · En direct' : '');
  channel.append(name, identity);
  const button = document.createElement('button');
  const added = channels.includes(item.login);
  button.type = 'button';
  button.disabled = added || channels.length >= 12 || busy;
  button.textContent = added ? 'Ajoutée' : 'Ajouter';
  button.setAttribute('aria-label', button.textContent + ' ' + (item.name || item.login));
  button.onclick = () => addChannels([item]);
  row.append(channel, button);
  return row;
}
function matchingFollows() {
  const query = $('follow-filter').value.trim().toLowerCase();
  return followed.filter(item => [item.login, item.name].some(s => s?.toLowerCase().includes(query)));
}
function renderSources() {
  $('search-results').replaceChildren(...results.map(resultRow));
  $('manual-add').hidden = !manualLogin || channels.includes(manualLogin) || channels.length >= 12;
  $('manual-add').disabled = busy;
  const matches = matchingFollows();
  $('follow-results').replaceChildren(...matches.slice(0, followLimit).map(resultRow));
  $('follow-more').hidden = matches.length <= followLimit;
  $('follow-add').disabled = busy || channels.length >= 12 || !matches.some(item => !channels.includes(item.login));
}
async function search() {
  searchRequest?.abort();
  const query = searchTerm($('channel').value);
  manualLogin = '';
  results = [];
  renderSources();
  $('search-status').textContent = '';
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
for (const source of ['search', 'follows']) {
  $('source-' + source).onclick = () => {
    for (const tab of ['search', 'follows']) {
      $('source-' + tab).setAttribute('aria-pressed', String(tab === source));
      $(tab + '-panel').hidden = tab !== source;
    }
  };
}
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
  status.textContent = 'Chargement des chaînes suivies…';
  button.disabled = $('profile-logout').disabled = true;
  try {
    const r = await fetch('/api/profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'alert-follows', id, ...credentials }),
    });
    const data = await r.json();
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
  update(await api('save', { subscription: subscription.toJSON(), channels }));
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

async function refresh() {
  if (busy) return;
  try {
    const result = token ? await api('read') : await fetch('/api/alerts').then(r => r.json());
    if (busy || typeof result.paused !== 'boolean') return;
    if (token) update(result);
    else { paused = result.paused; render(); }
  } catch { /* la prochaine vérification reprendra */ }
}
async function init() {
  let local;
  try { local = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { local = {}; }
  try {
    const previous = JSON.parse(localStorage.getItem('twprofile') || 'null');
    if (previous?.id) $('profile-id').value = previous.id;
  } catch { /* la connexion reste manuelle */ }
  token = local.token;
  channels = Array.isArray(local.channels) ? local.channels.filter(login => loginPattern.test(login)).slice(0, 12) : [];
  render();
  if (!supported) return notice('Les notifications Push sont indisponibles dans ce navigateur ou sur cette adresse.', true);
  try {
    const [reg, key] = await Promise.all([
      navigator.serviceWorker.register('/alerte-sw.js', { scope: '/alerte' }).then(() => navigator.serviceWorker.ready),
      fetch('/api/alerts').then(r => r.json()),
    ]);
    if (!key.publicKey) throw new Error('Clé Push indisponible.');
    registration = reg;
    publicKey = key.publicKey;
    paused = key.paused === true;
    if (token) await refresh();
    if (active && !await registration.pushManager.getSubscription()) {
      update(await api('stop'));
      notice('Ton abonnement a expiré. Réactive les notifications.', true);
    }
    render();
    setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
  } catch { notice('Impossible de préparer les notifications. Recharge la page pour réessayer.', true); }
}
init();
