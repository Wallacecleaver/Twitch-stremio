'use strict';

const $ = id => document.getElementById(id);
const storageKey = 'twitchio-alerts';
const params = new URLSearchParams(location.search);
const mode = params.get('mode');
const destination = params.get('retour') || '';
const returnTo = /^\/alerte(?:\?|$)/.test(destination) ? destination : '/alerte';
const action = mode === 'inscription' ? 'register' : mode === 'recuperation' ? 'recover' : 'login';
const password = $('account-password');
const form = $('account-form');
const submit = $('account-submit');
let submitting = false;

$('open-alerts').href = returnTo;
if (destination) {
  for (const link of document.querySelectorAll('[data-login-link]')) {
    const url = new URL(link.href);
    url.searchParams.set('retour', returnTo);
    link.href = url.href;
  }
}

if (action !== 'login') {
  const recover = action === 'recover';
  $('heading').textContent = recover ? 'Récupérer mon compte' : 'Créer mon compte';
  $('description').textContent = recover
    ? 'Utilise ton code de récupération pour choisir un nouveau mot de passe.'
    : 'Ton compte récupère la liste et les alertes déjà configurées dans ce navigateur.';
  $('account-code-label').hidden = !recover;
  $('account-code').disabled = !recover;
  $('account-code').required = recover;
  $('account-password-label').textContent = recover ? 'Nouveau mot de passe' : 'Mot de passe';
  password.autocomplete = 'new-password';
  password.minLength = 10;
  password.placeholder = 'Au moins 10 caractères';
  submit.textContent = recover ? 'Changer le mot de passe' : 'Créer un compte';
  $('forgot').hidden = $('register-link').hidden = true;
  $('login-link').hidden = false;
}

$('password-toggle').onclick = event => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  event.currentTarget.setAttribute('aria-pressed', String(visible));
  event.currentTarget.setAttribute('aria-label', visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
  event.currentTarget.textContent = visible ? 'Masquer' : 'Afficher';
};

function browserDraft() {
  let draft = {};
  try { draft = JSON.parse(localStorage.getItem(storageKey) || 'null') || {}; } catch { /* Stockage indisponible. */ }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(draft.token || '')) {
    if (!crypto.randomUUID) throw new Error('Ouvre cette page en HTTPS pour utiliser un compte.');
    draft = { ...draft, token: crypto.randomUUID() };
    try { localStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Stockage indisponible. */ }
  }
  return draft;
}

async function request(path, body) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || 'Le serveur ne répond pas.');
  return result;
}

function showConnected(name, code) {
  $('signin').hidden = true;
  $('connected').hidden = false;
  $('connected-heading').textContent = code ? (action === 'register' ? 'Compte créé' : 'Mot de passe modifié') : 'Compte connecté';
  $('connected-details').textContent = code
    ? 'Garde ce code en lieu sûr. Il permet de changer ton mot de passe une seule fois.'
    : 'Tu es connecté avec le pseudo ' + name + '.';
  $('account-recovery').hidden = !code;
  $('account-recovery-value').value = code || '';
}

form.onsubmit = async event => {
  event.preventDefault();
  if (submitting) return;
  submitting = submit.disabled = true;
  $('account-status').textContent = '';
  const buttonLabel = submit.textContent;
  submit.textContent = 'Un instant…';
  try {
    const draft = browserDraft();
    const channels = Array.isArray(draft.channels) ? draft.channels.filter(login => /^[a-z0-9_]{3,25}$/.test(login)).slice(0, 12) : [];
    const result = await request('/api/alerts/account', {
      action, token: draft.token, name: $('account-name').value, password: password.value,
      code: action === 'recover' ? $('account-code').value : undefined,
      channels: action === 'register' ? channels : undefined,
    });
    if (action === 'register') {
      try { localStorage.setItem(storageKey, JSON.stringify({ token: draft.token, channels: [], listPending: false })); } catch { /* Stockage indisponible. */ }
    }
    form.reset();
    if (result.code) showConnected(result.account, result.code);
    else location.replace(returnTo);
  } catch (error) {
    $('account-status').textContent = error.message || 'Connexion impossible.';
  } finally {
    submit.textContent = buttonLabel;
    submitting = submit.disabled = false;
  }
};

$('copy-code').onclick = async () => {
  const field = $('account-recovery-value');
  try {
    await navigator.clipboard.writeText(field.value);
    $('copy-status').textContent = 'Code copié.';
  } catch {
    field.focus();
    field.select();
    $('copy-status').textContent = 'Le code est sélectionné.';
  }
};

async function restoreSession() {
  try {
    const result = await request('/api/alerts', { action: 'read', token: browserDraft().token, resume: true });
    if (submitting || !$('connected').hidden || !result.account) return;
    if (destination) location.replace(returnTo);
    else showConnected(result.account);
  } catch { /* Le formulaire reste utilisable. */ }
}
restoreSession();
