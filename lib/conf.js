'use strict';
// Configuration du serveur modifiable depuis le dashboard (Paramètres → Configuration), à la place du fichier .env.
// Dans le .env il ne reste que ADMIN_PASSWORD, SECRET (et DATA_DIR si besoin) : ce sont eux qui ouvrent le dashboard et déchiffrent les données.
// Les valeurs saisies sont gardées dans data.json (clé « conf ») ; les jetons et mots de passe y sont chiffrés avec SECRET.
// Au tout premier démarrage avec ce système, les valeurs déjà présentes dans le .env sont reprises automatiquement : rien à ressaisir.
// Elles sont appliquées à process.env, donc le reste du code les lit comme avant (sans redémarrer, sauf PORT et HOST).
const store = require('./store');
const sealLib = require('./seal');

const KEY = 'conf';
const GROUPS = {
  video: 'Vidéo et Cloudflare',
  twitch: 'API Twitch',
  relais: 'Relais',
  net: 'Adresse et réseau',
  diag: 'Diagnostic',
};
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const bad = m => { throw new Error(m); };
const httpsOrigin = v => { v = v.replace(/\/+$/, ''); return /^https:\/\/[^\s/]+$/.test(v) ? v : bad('adresse https attendue, sans chemin (ex. https://exemple.com)'); };
const pattern = (re, m) => v => (re.test(v) ? v : bad(m));

// t : text | secret (chiffré, jamais renvoyé) | area | select | toggle · restart : pris en compte au prochain démarrage seulement
const FIELDS = [
  { k: 'SEGMENTS_ORIGIN', g: 'video', t: 'text', label: 'Adresse du Worker Cloudflare', help: 'Le Worker (dossier worker/) télécharge la vidéo à la place de ce PC. Sans slash final. Vide : pas de Worker.', ph: 'https://twitchio-segments.moncompte.workers.dev', fix: httpsOrigin },
  { k: 'TWITCH_SEGMENTS_PROXY', g: 'video', t: 'select', label: 'Mode « Automatique » des profils', help: 'Qui télécharge les morceaux quand une personne est réglée sur « Automatique ».', opts: [['', 'Par défaut (direct, sauf lecteurs mpv/ffmpeg)'], ['0', 'Toujours direct'], ['1', 'Toujours via le Worker / ce serveur']], fix: pattern(/^[01]$/, 'valeur inconnue') },
  { k: 'SEGMENTS_ADDON', g: 'video', t: 'select', label: 'Relais de vidéo par ce serveur', help: 'Interdit : ce PC ne relaie jamais la vidéo (économise ta bande passante).', opts: [['', 'Autorisé (par défaut)'], ['0', 'Interdit']], fix: pattern(/^0$/, 'valeur inconnue') },
  { k: 'CF_API_TOKEN', g: 'video', t: 'secret', label: 'Jeton API Cloudflare', help: 'Permission Account → Account Analytics → Read. Sert à afficher la consommation du Worker.', ph: 'jeton', fix: pattern(/^[A-Za-z0-9_-]{20,200}$/, 'jeton non reconnu (caractères interdits ou trop court)') },
  { k: 'CF_ACCOUNT_ID', g: 'video', t: 'text', label: 'ID de compte Cloudflare', help: '32 caractères, visibles dans l\'adresse du tableau de bord Cloudflare.', ph: '0123456789abcdef0123456789abcdef', fix: pattern(/^[a-f0-9]{32}$/i, 'il faut exactement 32 caractères (0-9, a-f)') },
  { k: 'CF_WORKER_NAME', g: 'video', t: 'text', label: 'Nom du Worker', help: 'Seulement si tu l\'as renommé (par défaut twitchio-segments).', ph: 'twitchio-segments', fix: pattern(/^[A-Za-z0-9_-]{1,63}$/, 'lettres, chiffres, - et _ uniquement') },
  { k: 'TWITCH_CLIENT_ID', g: 'twitch', t: 'text', label: 'Client ID Twitch', help: 'Facultatif : active le catalogue « Lives populaires » (https://dev.twitch.tv/console).', fix: pattern(/^[A-Za-z0-9]{10,60}$/, 'identifiant non reconnu') },
  { k: 'TWITCH_CLIENT_SECRET', g: 'twitch', t: 'secret', label: 'Client Secret Twitch', help: 'Va avec le Client ID. Le compte Twitch de l\'administrateur se lie dans l\'onglet « Compte Twitch ».', fix: pattern(/^[A-Za-z0-9]{10,60}$/, 'secret non reconnu') },
  { k: 'PROXIES', g: 'relais', t: 'area', label: 'Liste de relais personnalisée', help: 'Un relais par ligne : « Nom | adresse avec {channel} ». Vide : la liste par défaut. L\'activation de chaque relais se règle dans la section « Relais ».', ph: 'Mon relais | https://exemple.com/live/{channel}', fix: v => { v.split('\n').forEach((l, i) => { if (l.trim() && !/^(?:[^|]*\|)?\s*https:\/\/\S*\{channel\}/.test(l.trim())) bad('ligne ' + (i + 1) + ' : il faut une adresse https contenant {channel}'); }); return v.split('\n').map(l => l.trim()).filter(Boolean).join('\n'); } },
  { k: 'PUBLIC_URL', g: 'net', t: 'text', label: 'Adresse publique de l\'addon', help: 'Tunnel ou nom de domaine, en https. Vide : déduite de la requête (http://localhost en local).', ph: 'https://exemple.trycloudflare.com', fix: httpsOrigin },
  { k: 'PORT', g: 'net', t: 'text', label: 'Port d\'écoute', help: 'Par défaut 7000.', ph: '7000', restart: true, fix: v => (/^\d{2,5}$/.test(v) && +v >= 1 && +v <= 65535 ? v : bad('port entre 1 et 65535')) },
  { k: 'HOST', g: 'net', t: 'text', label: 'Interface d\'écoute', help: '0.0.0.0 = accessible depuis le réseau local, 127.0.0.1 = ce PC uniquement.', ph: '0.0.0.0', restart: true, fix: pattern(/^[A-Za-z0-9.:-]{2,60}$/, 'adresse non reconnue') },
  { k: 'DEBUG_HTTP', g: 'diag', t: 'toggle', label: 'Journal de chaque requête dans la console', help: 'Pour un diagnostic seulement : la console devient très bavarde.', fix: pattern(/^1$/, 'valeur inconnue') },
];
const BY = Object.fromEntries(FIELDS.map(f => [f.k, f]));

let M = {}, lost = [];
const listeners = [];
const enc = (f, v) => (f.t === 'secret' && v !== '' ? 'enc:' + sealLib.seal(v) : v);
const dec = (f, s) => (f.t === 'secret' && String(s).startsWith('enc:') ? sealLib.open(String(s).slice(4)) : String(s));

function apply(map) {
  lost = [];
  for (const f of FIELDS) {
    if (!has(map, f.k)) continue;
    const v = dec(f, map[f.k]);
    if (v === null) { lost.push(f.k); continue; } // chiffré avec une autre clé SECRET : illisible, à ressaisir
    if (v === '') delete process.env[f.k]; else process.env[f.k] = v;
  }
}

// À appeler une fois, juste après le chargement du store et avant de lire PORT, HOST, etc.
function init() {
  let map = null;
  try { map = JSON.parse(store.peek(KEY) || 'null'); } catch { /* illisible : on repart du .env */ }
  if (!map || typeof map !== 'object') {
    map = {}; // premier démarrage : on reprend ce qui est déjà dans le .env
    for (const f of FIELDS) {
      const v = process.env[f.k];
      if (v === undefined || v === '') continue;
      if (f.t === 'secret' && !sealLib.available()) continue;
      map[f.k] = enc(f, v);
    }
    const tok = String(process.env.TWITCH_AUTH_TOKEN || '').trim().replace(/^oauth:?\s*/i, ''); // le compte Twitch de l'admin vit dans « Compte Twitch »
    if (tok && sealLib.available() && !store.peek('acct')) store.setKey('acct', sealLib.seal(tok)).catch(() => {});
    store.setKey(KEY, JSON.stringify(map)).catch(() => {});
  }
  M = map; apply(M);
}

function view() {
  return {
    sealed: sealLib.available(), lost,
    groups: GROUPS,
    fields: FIELDS.map(f => {
      const set = !!process.env[f.k], src = has(M, f.k) && set ? 'dashboard' : set ? '.env' : '';
      const o = { k: f.k, g: f.g, t: f.t, label: f.label, help: f.help, ph: f.ph || '', restart: !!f.restart, set, src, lost: lost.includes(f.k) };
      if (f.opts) o.opts = f.opts;
      if (f.t !== 'secret') o.value = process.env[f.k] || '';
      return o;
    }),
  };
}

// values : { CLE: texte } · clear : [CLE] à effacer. Un jeton laissé vide reste inchangé. Tout est vérifié avant d'enregistrer quoi que ce soit.
async function save(body) {
  const values = (body && body.values && typeof body.values === 'object') ? body.values : {}, clear = Array.isArray(body && body.clear) ? body.clear : [];
  const next = { ...M }, errors = {};
  for (const f of FIELDS) {
    if (clear.includes(f.k)) { next[f.k] = ''; continue; }
    if (!has(values, f.k)) continue;
    let v = String(values[f.k] ?? '').replace(/\r/g, '').trim();
    if (f.t === 'secret' && v === '') continue;
    if (f.t !== 'secret' && v === (process.env[f.k] || '')) continue; // inchangé
    if (v !== '') {
      try { v = f.fix(v); } catch (e) { errors[f.k] = e.message; continue; }
      if (f.t === 'secret' && !sealLib.available()) { errors[f.k] = 'ajoute SECRET (ou ADMIN_PASSWORD) dans le .env pour chiffrer ce jeton'; continue; }
    }
    next[f.k] = enc(f, v);
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  await store.setKey(KEY, JSON.stringify(next));
  M = next; apply(M);
  for (const fn of listeners) { try { fn(); } catch { /* sans effet sur l'enregistrement */ } }
  return { ok: true, ...view() };
}

const onChange = fn => { listeners.push(fn); };
module.exports = { init, view, save, onChange, FIELDS: BY };
