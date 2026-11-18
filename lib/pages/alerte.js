'use strict';

const $ = id => document.getElementById(id);
const storageKey = 'twitchio-alerts';
const loginPattern = /^[a-z0-9_]{3,25}$/;
const supported = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let channels = [], saved = [], states = new Map(), token, active = false, paused = false, registration, publicKey, busy = false;
let results = [], suggestionsMessage = 'Chargement des profils Twitch…';
let tab = 'fr', discoverLimit = 8;
const lists = { fr: [], top: [] }, loadingTab = { fr: true, top: false }, loadedTab = { fr: false, top: false };
let followed = [], profile, followLimit = 8, searchRequest, searchTimer, manualLogin = '';
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
function remember() {
  const meta = {};
  for (const login of channels) {
    const item = known.get(login);
    if (item) meta[login] = { name: item.name || login, avatar: avatarPattern.test(item.avatar || '') ? item.avatar : '' };
  }
  try { localStorage.setItem(storageKey, JSON.stringify({ token, channels, meta })); } catch { /* stockage indisponible */ }
}
function infoFor(login) {
  const s = states.get(login);
  return s?.checked ? { ...known.get(login), ...s } : known.get(login);
}
function isFresh(info) { return Date.now() - (info?.checked || 0) < 180000; }
function render() {
  const changed = channels.join(',') !== saved.join(',');
  const liveNow = channels.filter(login => { const i = infoFor(login); return isFresh(i) && i.live; });
  $('count').textContent = channels.length + ' / 12';
  $('count').classList.toggle('warn', channels.length >= 12);
  $('meter').style.width = (channels.length / 12 * 100) + '%';
  $('state').textContent = paused ? 'En pause' : active ? 'Activées' : 'Désactivées';
  $('state').classList.toggle('active', active && !paused);
  $('state').classList.toggle('warn', paused);
  $('benefits').hidden = active;
  $('hint').textContent = paused
    ? 'Le serveur a mis les envois en pause. Les listes enregistrées seront réutilisées à la reprise.'
    : active && changed ? 'Enregistre tes modifications pour mettre à jour les alertes.' : 'Tes alertes sont propres à ce navigateur.';
  $('enable').textContent = busy ? 'Un instant…' : active ? 'Enregistrer la liste' : 'Activer les notifications';
  $('enable').disabled = paused || busy || !registration || !publicKey || !channels.length || (active && !changed);
  $('notification-actions').hidden = !active;
  $('test').disabled = busy || paused;
  $('stop').disabled = busy;
  $('empty').hidden = channels.length > 0;
  $('clear-all').hidden = channels.length < 2;
  $('savebar').classList.toggle('show', active && changed && !paused);
  $('savebar-save').disabled = busy || $('enable').disabled;
  document.title = (liveNow.length ? '(' + liveNow.length + ') ' : '') + baseTitle;
  $('eyebrow-text').innerHTML = liveNow.length
    ? '<b>' + liveNow.length + (liveNow.length > 1 ? ' de tes chaînes sont' : ' de tes chaînes est') + ' en direct</b>'
    : '<b>Alertes de live</b> · gratuit, sans compte';
  const ordered = [...channels].sort((a, b) => {
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
    channel.href = 'https://www.twitch.tv/' + login;
    channel.target = '_blank';
    channel.rel = 'noopener noreferrer';
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
    remove.onclick = () => {
      channels = channels.filter(channel => channel !== login);
      remember();
      render();
      if (!channels.length && active) notice('Désactive les notifications pour arrêter de surveiller la dernière chaîne.');
    };
    tail.append(badge, remove);
    row.append(avatarNode({ ...info, login }), channel, tail);
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
    if (selected.includes(item.login)) known.set(item.login, { ...item, checked: item.live !== undefined ? Date.now() : 0 });
  }
  channels.push(...selected);
  remember();
  render();
  notice(selected.length === 1 ? 'Chaîne ajoutée à ta liste.' : selected.length + ' chaînes ajoutées à ta liste.');
}
function resultRow(item, index = 0, card = false) {
  const row = document.createElement('li');
  row.className = 'result';
  row.style.setProperty('--i', Math.min(index, 12));
  const thumbbed = card && item.live && loginPattern.test(item.login);
  if (thumbbed) {
    const thumb = document.createElement('a');
    thumb.className = 'thumb';
    thumb.href = 'https://www.twitch.tv/' + item.login;
    thumb.target = '_blank';
    thumb.rel = 'noopener noreferrer';
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
  channel.href = 'https://www.twitch.tv/' + item.login;
  channel.target = '_blank';
  channel.rel = 'noopener noreferrer';
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
function renderSources() {
  const searching = searchTerm($('channel').value).length >= 2;
  const list = lists[tab];
  $('discovery-title').textContent = searching ? 'Résultats Twitch' : tab === 'top' ? 'Les plus regardés sur Twitch' : 'En direct en français';
  $('tabs').hidden = searching;
  $('refresh-suggestions').hidden = searching;
  if (!searching) $('search-status').textContent = suggestionsMessage;
  if (!searching && loadingTab[tab] && !list.length) {
    $('search-results').replaceChildren(...Array.from({ length: 4 }, () => Object.assign(document.createElement('li'), { className: 'skeleton' })));
  } else $('search-results').replaceChildren(...(searching ? results : list.slice(0, discoverLimit)).map((item, i) => resultRow(item, i, true)));
  $('discover-more').hidden = searching || list.length <= discoverLimit;
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
$('open-connection').onclick = () => $('connection').showModal();
$('close-connection').onclick = () => $('connection').close();
async function loadSuggestions() {
  const asked = tab;
  loadingTab[asked] = true;
  $('refresh-suggestions').classList.add('spin');
  $('refresh-suggestions').disabled = true;
  suggestionsMessage = '';
  renderSources();
  let message = '';
  try {
    const r = await fetch('/api/alerts/discover?mode=' + asked);
    const data = await r.json();
    if (!r.ok || !Array.isArray(data.channels)) throw new Error('Découverte indisponible');
    lists[asked] = data.channels.filter(item => loginPattern.test(item.login));
    message = lists[asked].length ? '' : 'Aucun live proposé pour le moment. Tu peux rechercher une chaîne au-dessus.';
  } catch { message = 'Les suggestions Twitch sont indisponibles. Tu peux toujours rechercher une chaîne.'; }
  loadingTab[asked] = false;
  loadedTab[asked] = true;
  if (asked === tab) {
    suggestionsMessage = message;
    $('refresh-suggestions').classList.remove('spin');
    $('refresh-suggestions').disabled = false;
    renderSources();
  }
}
function selectTab(next) {
  if (next === tab) return;
  tab = next;
  discoverLimit = 8;
  $('tab-fr').setAttribute('aria-selected', String(tab === 'fr'));
  $('tab-top').setAttribute('aria-selected', String(tab === 'top'));
  $('refresh-suggestions').classList.remove('spin');
  $('refresh-suggestions').disabled = false;
  suggestionsMessage = '';
  if (loadedTab[tab]) renderSources(); else loadSuggestions();
}
$('tab-fr').onclick = () => selectTab('fr');
$('tab-top').onclick = () => selectTab('top');
$('discover-more').onclick = () => { discoverLimit += 8; renderSources(); };
$('refresh-suggestions').onclick = loadSuggestions;
const syncSearchBox = () => $('add').classList.toggle('filled', $('channel').value.length > 0);
$('channel').addEventListener('input', syncSearchBox);
$('clear-search').onclick = () => {
  $('channel').value = '';
  $('channel').dispatchEvent(new Event('input'));
  $('channel').focus();
};
$('clear-all').onclick = () => {
  if (!channels.length || !confirm('Retirer les ' + channels.length + ' chaînes de ta liste ?')) return;
  channels = [];
  remember();
  render();
  if (active) notice('Liste vidée. Désactive les notifications pour arrêter la surveillance.');
};
$('savebar-save').onclick = () => $('enable').click();
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
  for (const login of channels) {
    const m = local.meta?.[login];
    if (m && typeof m === 'object') known.set(login, { login, name: String(m.name || login).slice(0, 40), avatar: avatarPattern.test(m.avatar || '') ? m.avatar : '', checked: 0 });
  }
  render();
  loadSuggestions();
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
