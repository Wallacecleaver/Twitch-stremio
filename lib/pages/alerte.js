'use strict';

const $ = id => document.getElementById(id);
const storageKey = 'twitchio-alerts';
const loginPattern = /^[a-z0-9_]{3,25}$/;
const supported = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let channels = [], saved = [], states = new Map(), token, active = false, registration, publicKey, busy = false;

function notice(text, error = false) {
  $('message').textContent = text;
  $('message').toggleAttribute('data-error', error);
}
function remember() {
  localStorage.setItem(storageKey, JSON.stringify({ token, channels }));
}
function render() {
  const changed = channels.join(',') !== saved.join(',');
  $('state').textContent = active ? changed ? 'Modifications à enregistrer' : 'Activées' : 'Désactivées';
  $('state').classList.toggle('active', active);
  $('enable').textContent = active ? 'Enregistrer la liste' : 'Activer les notifications';
  $('enable').disabled = busy || !registration || !publicKey || !channels.length || (active && !changed);
  $('test').hidden = $('stop').hidden = !active;
  $('test').disabled = $('stop').disabled = busy;
  $('empty').hidden = channels.length > 0;
  $('channel').disabled = busy;
  $('add').querySelector('button').disabled = busy;
  $('channels').replaceChildren(...channels.map(login => {
    const row = document.createElement('li');
    const channel = document.createElement('a');
    channel.className = 'channel';
    channel.href = 'https://www.twitch.tv/' + login;
    channel.target = '_blank';
    channel.rel = 'noopener noreferrer';
    const info = states.get(login);
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

$('add').onsubmit = event => {
  event.preventDefault();
  const field = $('channel');
  let login = field.value.trim().toLowerCase().replace(/^@/, '');
  if (/^(?:https?:\/\/|(?:www\.)?twitch\.tv\/)/.test(login)) {
    try {
      const url = new URL(login.includes('://') ? login : 'https://' + login);
      login = /^(?:www\.|m\.)?twitch\.tv$/.test(url.hostname) ? url.pathname.split('/')[1] : '';
    } catch { login = ''; }
  }
  if (!loginPattern.test(login)) return notice('Entre un nom ou un lien de chaîne Twitch valide.', true);
  if (channels.includes(login)) return notice('Cette chaîne est déjà dans ta liste.', true);
  if (channels.length >= 12) return notice('Tu peux surveiller jusqu’à 12 chaînes.', true);
  channels.push(login);
  remember();
  field.value = '';
  notice('');
  render();
  field.focus();
};

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
  if (token && !busy) {
    try { const result = await api('read'); if (!busy) update(result); }
    catch { /* la prochaine vérification reprendra */ }
  }
}
async function init() {
  let local;
  try { local = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { local = {}; }
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
    await refresh();
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
