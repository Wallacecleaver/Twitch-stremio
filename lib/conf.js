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
  { k: 'TWITCH_SEGMENTS_PROXY', g: 'video', t: 'select', label: 'Mode « Automatique » des profils', help: 'Qui télécharge les morceaux quand une personne est réglée sur « Automatique ».', opts: [['', 'Par défaut (direct, sauf lecteurs mpv/ffmpeg : Worker)'], ['0', 'Toujours direct'], ['1', 'Toujours via le Worker']], fix: pattern(/^[01]$/, 'valeur inconnue') },
  { k: 'SEGMENTS_ADDON', g: 'video', t: 'select', label: 'Relais de vidéo par ce serveur', help: 'Autorisé : seules les personnes ayant une clé d\'accès (créée dans l\'onglet Vidéo) peuvent faire passer leur vidéo par ce serveur. Interdit : plus personne, même avec une clé (économise ta bande passante).', opts: [['', 'Autorisé avec une clé d\'accès (par défaut)'], ['0', 'Interdit']], fix: pattern(/^0$/, 'valeur inconnue') },
  { k: 'CF_API_TOKEN', g: 'video', t: 'secret', label: 'Jeton API Cloudflare', help: 'Permission Account → Account Analytics → Read. Sert à afficher la consommation du Worker.', ph: 'jeton', fix: pattern(/^[A-Za-z0-9_-]{20,200}$/, 'jeton non reconnu (caractères interdits ou trop court)') },
  { k: 'CF_ACCOUNT_ID', g: 'video', t: 'text', label: 'ID de compte Cloudflare', help: '32 caractères, visibles dans l\'adresse du tableau de bord Cloudflare.', ph: '0123456789abcdef0123456789abcdef', fix: pattern(/^[a-f0-9]{32}$/i, 'il faut exactement 32 caractères (0-9, a-f)') },
  { k: 'CF_WORKER_NAME', g: 'video', t: 'text', label: 'Nom du Worker', help: 'Seulement si tu l\'as renommé (par défaut twitchio-segments).', ph: 'twitchio-segments', fix: pattern(/^[A-Za-z0-9_-]{1,63}$/, 'lettres, chiffres, - et _ uniquement') },
  { k: 'TWITCH_CLIENT_ID', g: 'twitch', t: 'text', label: 'Client ID Twitch', help: 'Facultatif : active le catalogue « Lives populaires » (https://dev.twitch.tv/console).', fix: pattern(/^[A-Za-z0-9]{10,60}$/, 'identifiant non reconnu') },
  { k: 'TWITCH_CLIENT_SECRET', g: 'twitch', t: 'secret', label: 'Client Secret Twitch', help: 'Va avec le Client ID. Le compte Twitch de l\'administrateur se lie dans l\'onglet « Diagnostic » (section « Mon compte Twitch »).', fix: pattern(/^[A-Za-z0-9]{10,60}$/, 'secret non reconnu') },
  { k: 'PROXIES', g: 'relais', t: 'area', label: 'Liste de relais personnalisée', help: 'Un relais par ligne : « Nom | adresse avec {channel} ». Vide : la liste par défaut. L\'activation de chaque relais se règle dans la section « Relais ».', ph: 'Mon relais | https://exemple.com/live/{channel}', fix: v => { v.split('\n').forEach((l, i) => { if (l.trim() && !/^(?:[^|]*\|)?\s*https:\/\/\S*\{channel\}/.test(l.trim())) bad('ligne ' + (i + 1) + ' : il faut une adresse https contenant {channel}'); }); return v.split('\n').map(l => l.trim()).filter(Boolean).join('\n'); } },
  { k: 'PUBLIC_URL', g: 'net', t: 'text', label: 'Adresse publique de l\'addon', help: 'Tunnel ou nom de domaine, en https. Vide : déduite de la requête (http://localhost en local).', ph: 'https://exemple.trycloudflare.com', fix: httpsOrigin },
  { k: 'PORT', g: 'net', t: 'text', label: 'Port d\'écoute', help: 'Par défaut 7000.', ph: '7000', restart: true, fix: v => (/^\d{2,5}$/.test(v) && +v >= 1 && +v <= 65535 ? v : bad('port entre 1 et 65535')) },
  { k: 'HOST', g: 'net', t: 'text', label: 'Interface d\'écoute', help: '0.0.0.0 = accessible depuis le réseau local, 127.0.0.1 = ce PC uniquement.', ph: '0.0.0.0', restart: true, fix: pattern(/^[A-Za-z0-9.:-]{2,60}$/, 'adresse non reconnue') },
  { k: 'CHAT_SUBS', g: 'video', t: 'toggle', label: 'Autoriser le chat Twitch en sous-titres (expérimental)', help: 'Rend l\'option « Chat Twitch intégré » disponible sur la page /config : chaque personne l\'active pour elle. Une connexion au chat n\'est ouverte que pendant la lecture. Test : /chat/<chaîne>/debug.', fix: pattern(/^1$/, 'valeur inconnue') },
  { k: 'CHAT_DELAY_MS', g: 'video', t: 'text', label: 'Chat : retard (ms)', help: 'Décale les messages pour coller à l\'image (défaut 6000). Augmente si le chat arrive trop tôt, baisse s\'il arrive trop tard.', ph: '6000', fix: v => (/^\d{3,5}$/.test(v) && +v <= 30000 ? v : bad('entre 100 et 30000')) },
  { k: 'CHAT_TIMING', g: 'video', t: 'select', label: 'Chat : heure des messages', help: 'Absolu : marche avec ou sans X-TIMESTAMP-MAP (défaut). Norme HLS : à essayer si l\'absolu n\'affiche rien.', opts: [['', 'Absolu (par défaut)'], ['map', 'Norme HLS (X-TIMESTAMP-MAP)']], fix: pattern(/^map$/, 'valeur inconnue') },
  { k: 'CHAT_TEST', g: 'video', t: 'toggle', label: 'Chat : messages de test', help: 'Affiche un message factice toutes les 3 secondes pour vérifier l\'affichage des sous-titres, même si le chat est calme. À couper ensuite.', fix: pattern(/^1$/, 'valeur inconnue') },
  { k: 'CHAT_LAYOUT', g: 'video', t: 'select', label: 'Chat : disposition', help: 'Bas gauche ou bas droite : lignes complétées par des espaces pour coller le texte à un bord (astuce, voir « largeur »). Centré : sous-titre normal.', opts: [['', 'Bas gauche (par défaut)'], ['right', 'Bas droite'], ['center', 'Centré']], fix: pattern(/^(center|right)$/, 'valeur inconnue') },
  { k: 'CHAT_WIDTH', g: 'video', t: 'text', label: 'Chat : largeur (em)', help: 'Défaut 55 pour une taille de sous-titres de 100 %. Si tu réduis la taille dans Stremio, divise : à 60 % mets ≈ 92. Texte trop au centre : augmente. Lignes coupées en deux : diminue.', ph: '55', fix: v => (/^\d{2,3}$/.test(v) && +v >= 20 && +v <= 140 ? v : bad('entre 20 et 140')) },
  { k: 'CHAT_LINES', g: 'video', t: 'text', label: 'Chat : nombre de lignes', help: 'Messages visibles en même temps (défaut 8, de 1 à 15).', ph: '8', fix: v => (/^\d{1,2}$/.test(v) && +v >= 1 && +v <= 15 ? v : bad('entre 1 et 15')) },
  { k: 'CHAT_BURN', g: 'video', t: 'toggle', label: 'Autoriser le chat incrusté dans la vidéo (expérimental)', help: 'Rend l\'option « Incrusté dans la vidéo » disponible sur /config : une source « Chat » par qualité (jamais de 1440p). Le serveur ré-encode le live avec ffmpeg, partagé entre les personnes qui regardent la même chaîne. Test : /burn/debug.', fix: pattern(/^1$/, 'valeur inconnue') },
  { k: 'BURN_BUDGET', g: 'video', t: 'text', label: 'Chat incrusté : budget de processeur', help: 'En « flux 720p30 » : 1 flux 720p30 = 1, un 480p ≈ 0,45, un 360p ≈ 0,25. Défaut 1,2 (convient à 2 cœurs) : au-delà, un nouveau flux avec chat est refusé plutôt que de ralentir le serveur. Compte ≈ 0,3 à 0,5 cœur par unité.', ph: '1.2', fix: v => (/^\d{1,2}(\.\d)?$/.test(v) && +v >= 0.2 && +v <= 16 ? v : bad('entre 0.2 et 16')) },
  { k: 'BURN_MAX', g: 'video', t: 'text', label: 'Chat incrusté : chaînes en même temps', help: 'Nombre maximal de chaînes avec chat (un ffmpeg chacune), en plus du budget. Défaut 3.', ph: '3', fix: v => (/^\d{1,2}$/.test(v) && +v >= 1 && +v <= 16 ? v : bad('entre 1 et 16')) },
  { k: 'BURN_HEIGHT', g: 'video', t: 'select', label: 'Chat incrusté : qualité maximale', help: 'Les qualités au-dessus sont ré-encodées à ce plafond. 480p est le plus léger ; 1080p demande un serveur puissant (et un budget plus élevé).', opts: [['', '720p (par défaut)'], ['480', '480p (plus léger)'], ['1080', '1080p (serveur puissant)']], fix: pattern(/^(480|1080)$/, 'valeur inconnue') },
  { k: 'BURN_PANEL', g: 'video', t: 'text', label: 'Chat incrusté : hauteur du panneau (%)', help: 'Part de la hauteur de la vidéo occupée par le panneau, en bas (défaut 50).', ph: '50', fix: v => (/^\d{2,3}$/.test(v) && +v >= 25 && +v <= 100 ? v : bad('entre 25 et 100')) },
  { k: 'BURN_SIDE', g: 'video', t: 'select', label: 'Chat incrusté : côté', help: 'Coin de la vidéo où s\'affiche le panneau de chat.', opts: [['', 'Bas droite (par défaut)'], ['left', 'Bas gauche']], fix: pattern(/^left$/, 'valeur inconnue') },
  { k: 'BURN_PRESET', g: 'video', t: 'select', label: 'Chat incrusté : vitesse d\'encodage', help: 'Ultrafast : le plus léger pour le processeur (défaut). Superfast : meilleure image au même débit, environ 40 % de processeur en plus.', opts: [['', 'Ultrafast (par défaut)'], ['superfast', 'Superfast']], fix: pattern(/^superfast$/, 'valeur inconnue') },
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
    const tok = String(process.env.TWITCH_AUTH_TOKEN || '').trim().replace(/^oauth:?\s*/i, ''); // le compte Twitch de l'admin se lie dans Diagnostic → « Mon compte Twitch »
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
