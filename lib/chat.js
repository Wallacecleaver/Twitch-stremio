'use strict';
// Chat Twitch en sous-titres (EXPÉRIMENTAL) : le chat devient une piste WebVTT « Chat Twitch » dans la liste de lecture HLS.
// Désactivé par défaut : CHAT_SUBS=1 (Paramètres › Configuration du dashboard) pour l'activer. Aucune dépendance npm (IRC Twitch via tls).
// La connexion au chat n'existe que tant que quelqu'un lit la piste (coupée après IDLE_MS), et il y a au plus CHAT_MAX_ROOMS chaînes en même temps.
const tls = require('tls');

const SEG_MS = 2000;                                           // durée d'un segment de sous-titres
const WINDOW = 6;                                              // segments annoncés
const KEEP_MS = 180000;                                        // historique gardé par chaîne
const IDLE_MS = 90000;                                         // coupe l'IRC si plus personne ne lit
const RECAL_MS = 60000;                                        // recalage vidéo/horloge
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const delayMs = () => Number(process.env.CHAT_DELAY_MS) || 6000; // retard entre ce que les gens voient et ce qu'ils écrivent
const maxRooms = () => Number(process.env.CHAT_MAX_ROOMS) || 20;
const enabled = () => process.env.CHAT_SUBS === '1';

const rooms = new Map(); // login -> { sock, msgs, lastUse, cal, variant, closed, timer, retry, err, ... }

/* ---------- IRC Twitch anonyme ---------- */
// Retire du message les mots d'émotes (Twitch donne leurs positions dans la balise « emotes ») : en texte seul ils ne font que du bruit
function clean(text, emotes) {
  let t = text;
  if (t.startsWith('\x01ACTION ')) t = t.slice(8).replace(/\x01$/, '');
  if (emotes && process.env.CHAT_EMOTES !== '1') {
    const cp = Array.from(t), cut = [];
    for (const grp of emotes.split('/')) for (const rg of (grp.split(':')[1] || '').split(',')) { const [x, y] = rg.split('-').map(Number); if (Number.isFinite(x) && Number.isFinite(y)) cut.push([x, y]); }
    for (const [x, y] of cut) for (let i = x; i <= y && i < cp.length; i++) cp[i] = '';
    t = cp.join('');
  }
  return t.replace(/\s+/g, ' ').trim();
}

function parse(line) {
  const m = line.match(/^(?:@(\S+) )?:(\S+?)!\S+ PRIVMSG #\S+ :(.*)$/);
  if (!m) return null;
  const tags = {};
  if (m[1]) for (const kv of m[1].split(';')) { const i = kv.indexOf('='); tags[kv.slice(0, i)] = kv.slice(i + 1); }
  const text = clean(m[3], tags.emotes);
  if (!text) return null; // message fait uniquement d'émotes
  return { user: String(tags['display-name'] || m[2]).replace(/\\s/g, ' '), text: text.slice(0, 200), color: /^#[0-9a-f]{6}$/i.test(tags.color || '') ? tags.color : '', sent: Number(tags['tmi-sent-ts']) || 0 };
}

function connect(login, r) {
  if (r.closed) return;
  let buf = '';
  const sock = tls.connect({ host: 'irc.chat.twitch.tv', port: 6697, servername: 'irc.chat.twitch.tv' });
  r.sock = sock;
  sock.setEncoding('utf8');
  sock.setTimeout(6 * 60000, () => sock.destroy());
  sock.on('secureConnect', () => {
    r.retry = 0; r.err = null;
    sock.write('CAP REQ :twitch.tv/tags\r\nPASS SCHMOOPIIE\r\nNICK justinfan' + (10000 + Math.floor(Math.random() * 89999)) + '\r\nJOIN #' + login + '\r\n');
  });
  sock.on('data', d => {
    buf += d;
    const lines = buf.split('\r\n'); buf = lines.pop();
    for (const l of lines) {
      if (l.startsWith('PING')) { sock.write('PONG :tmi.twitch.tv\r\n'); continue; }
      const m = parse(l);
      if (m) {
        const now = Date.now(), ok = m.sent && Math.abs(now - m.sent) < 120000;
        // ts = heure d'envoi donnée par Twitch (même horloge que les dates des segments vidéo, sans la gigue du réseau) ; t = heure de réception
        r.msgs.push({ t: now, ts: ok ? m.sent : now, user: m.user, text: m.text, color: m.color }); r.n++;
        if (ok) { r.lat.push(now - m.sent); if (r.lat.length > 40) r.lat.shift(); }
        if (r.msgs.length > 300) r.msgs.splice(0, r.msgs.length - 300);
      }
    }
  });
  sock.on('error', e => { r.err = e.message; });
  sock.on('close', () => {
    if (r.closed) return;
    r.retry = Math.min((r.retry || 0) + 1, 6);
    setTimeout(() => connect(login, r), Math.min(30000, 2000 * 2 ** r.retry)).unref();
  });
}

function close(login) {
  const r = rooms.get(login);
  if (!r) return;
  r.closed = true; clearInterval(r.timer);
  try { r.sock && r.sock.destroy(); } catch { /* déjà fermé */ }
  rooms.delete(login);
}

function open(login) {
  let r = rooms.get(login);
  if (r) { r.lastUse = Date.now(); return r; }
  if (rooms.size >= maxRooms()) return null;
  r = { sock: null, msgs: [], lat: [], n: 0, lastUse: Date.now(), cal: null, variant: null, closed: false, timer: null, retry: 0, err: null, calBusy: false, calErr: null };
  rooms.set(login, r);
  connect(login, r);
  r.timer = setInterval(() => {
    const now = Date.now();
    r.msgs = r.msgs.filter(m => now - m.t < KEEP_MS);
    if (now - r.lastUse > IDLE_MS) close(login);
  }, 10000);
  r.timer.unref();
  return r;
}

/* ---------- Recalage vidéo (PTS) <-> horloge murale ---------- */
// PTS (90 kHz) de la première image vidéo d'un segment MPEG-TS (se resynchronise si le flux ne commence pas sur un paquet)
function readFirstPts(buf) {
  let o = 0;
  while (o < 188 && !(buf[o] === 0x47 && buf[o + 188] === 0x47 && (buf[o + 376] === 0x47 || buf.length < o + 377))) o++;
  if (o >= 188) return null;
  let audio = null; // repli pour les flux « audio seul »
  for (let i = o; i + 188 <= buf.length; i += 188) {
    if (buf[i] !== 0x47) continue;
    const pusi = buf[i + 1] & 0x40, afc = (buf[i + 3] >> 4) & 3;
    let p = i + 4;
    if (afc & 2) p += 1 + buf[i + 4];
    if (!pusi || !(afc & 1)) continue;
    if (buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1 && (buf[p + 7] & 0x80)) {
      const k = buf[p + 3] & 0xf0, b = buf.subarray(p + 9, p + 14);
      const v = ((b[0] >> 1) & 7) * 2 ** 30 + b[1] * 2 ** 22 + (b[2] >> 1) * 2 ** 15 + b[3] * 2 ** 7 + (b[4] >> 1);
      if (k === 0xe0) return v;
      if ((k === 0xc0 || k === 0xd0) && audio === null) audio = v;
    }
  }
  return audio;
}

// Segment fMP4 (CMAF) : temps de décodage (tfdt) de la piste VIDÉO converti en 90 kHz ; piste et échelle de temps (hdlr/tkhd/mdhd) lues dans le segment d'initialisation
function videoTrack(init) {
  let from = 0;
  for (;;) {
    const t = init.indexOf('trak', from);
    if (t < 4) return null;
    const end = Math.min(init.length, t - 4 + (init.readUInt32BE(t - 4) || init.length));
    const h = init.indexOf('hdlr', t), k = init.indexOf('tkhd', t), m = init.indexOf('mdhd', t);
    if (h > 0 && h < end && k > 0 && k < end && m > 0 && m < end && init.toString('latin1', h + 12, h + 16) === 'vide') {
      return { id: init.readUInt32BE(init[k + 4] === 1 ? k + 24 : k + 16), ts: init.readUInt32BE(init[m + 4] === 1 ? m + 24 : m + 16) };
    }
    from = t + 4;
  }
}
function readMp4Pts(buf, init) {
  const vt = init ? videoTrack(init) : null;
  if (vt && vt.ts) {
    let from = 0;
    for (;;) {
      const tf = buf.indexOf('traf', from);
      if (tf < 4) break;
      const end = Math.min(buf.length, tf - 4 + (buf.readUInt32BE(tf - 4) || buf.length));
      const h = buf.indexOf('tfhd', tf), d = buf.indexOf('tfdt', tf);
      if (h > 0 && h < end && d > 0 && d < end && d + 16 <= buf.length && buf.readUInt32BE(h + 8) === vt.id) {
        const time = buf[d + 4] === 1 ? Number(buf.readBigUInt64BE(d + 8)) : buf.readUInt32BE(d + 8);
        return Math.round(time * 90000 / vt.ts);
      }
      from = tf + 4;
    }
  }
  // repli : premier tfdt et premier mdhd
  const t = buf.indexOf('tfdt');
  if (t < 0 || t + 16 > buf.length) return null;
  const time = buf[t + 4] === 1 ? Number(buf.readBigUInt64BE(t + 8)) : buf.readUInt32BE(t + 8);
  const src = init && init.indexOf('mdhd') >= 0 ? init : buf, m = src.indexOf('mdhd');
  if (m < 0) return null;
  const ts = src[m + 4] === 1 ? src.readUInt32BE(m + 24) : src.readUInt32BE(m + 16);
  return ts ? Math.round(time * 90000 / ts) : null;
}

// Plus petite qualité vidéo d'une liste principale (légère à interroger) : adresse absolue de sa liste de segments
function pickVariant(master) {
  const L = String(master).split(/\r?\n/);
  let best = null;
  for (let i = 0; i < L.length - 1; i++) {
    if (!L[i].startsWith('#EXT-X-STREAM-INF') || !/^https?:\/\//.test(L[i + 1] || '')) continue;
    const h = Number((L[i].match(/RESOLUTION=\d+x(\d+)/) || [])[1] || 0);
    if (h && (!best || h < best.h)) best = { h, url: L[i + 1].trim() };
  }
  return best && best.url;
}

async function calibrateFrom(r) {
  if (r.calBusy || !r.variant) return;
  r.calBusy = true; r.calErr = null;
  try {
    const txt = await fetch(r.variant, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) }).then(x => x.text());
    let pdt = null, titre = '', seg = null, map = null, pubs = 0;
    for (const l of txt.split(/\r?\n/)) {
      if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(l.slice(25));
      else if (l.startsWith('#EXTINF:')) titre = l.slice(l.indexOf(',') + 1).trim();
      else if (l.startsWith('#EXT-X-MAP:')) map = (l.match(/URI="([^"]+)"/) || [])[1] || null;
      else if (l && !l.startsWith('#')) {
        if (titre && !/^live$/i.test(titre)) pubs++; // segment de publicité : sa chronologie n'est pas celle du live
        else seg = { url: new URL(l.trim(), r.variant).href, pdt };
        pdt = null; titre = '';
      }
    }
    if (!seg) throw new Error(pubs ? 'la liste ne contient que des segments de publicité (réessai à la prochaine lecture)' : 'aucun segment dans la liste');
    if (!seg.pdt || Number.isNaN(seg.pdt)) throw new Error('pas de EXT-X-PROGRAM-DATE-TIME dans la liste (relais ?)');
    const res = await fetch(seg.url, { headers: { 'User-Agent': UA, Range: 'bytes=0-131071' }, signal: AbortSignal.timeout(8000) });
    const buf = Buffer.from(await res.arrayBuffer());
    let sync = 0; for (let i = 0; i < buf.length; i += 188) if (buf[i] === 0x47) sync++;
    const fmp4 = buf.indexOf('moof') >= 0 || buf.indexOf('ftyp') >= 0;
    r.calInfo = { http: res.status, type_mime: res.headers.get('content-type'), octets: buf.length, debut_hex: buf.subarray(0, 8).toString('hex'), paquets_ts: sync, fmp4, init: !!map, pubs_ignorees: pubs, hote: new URL(seg.url).host, ext: (new URL(seg.url).pathname.match(/\.[a-z0-9]{2,5}$/i) || [''])[0] };
    let pts = fmp4 ? null : readFirstPts(buf);
    if (pts == null && fmp4) {
      const init = map ? Buffer.from(await fetch(new URL(map, r.variant).href, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }).then(x => x.arrayBuffer())) : null;
      pts = readMp4Pts(buf, init);
    }
    if (pts == null) throw new Error('PTS introuvable dans le segment (voir diagnostic_recalage)');
    r.cal = { wall: seg.pdt, pts, at: Date.now() };
  } catch (e) { r.calErr = e.message; } finally { r.calBusy = false; }
}

// Variante : adresse de la liste de segments d'une qualité (flux « qualité fixe »)
function watchUrl(login, url) {
  if (!enabled() || !/^https:\/\//.test(url)) return;
  const r = open(login);
  if (r) r.variant = url;
}

// Appelée à chaque liste principale servie : mémorise une qualité de référence pour le recalage
function watch(login, masterText) {
  if (!enabled()) return;
  const r = open(login), v = pickVariant(masterText);
  if (r && v) r.variant = v;
}

/* ---------- Playlist de sous-titres + segments WebVTT ---------- */
function playlist(login) {
  const r = open(login);
  if (r && r.variant && (!r.cal || Date.now() - r.cal.at > RECAL_MS)) calibrateFrom(r);
  // seuls des segments complets sont annoncés : tous leurs messages sont déjà arrivés
  const last = Math.floor((Date.now() - delayMs() - latencyMs(login)) / SEG_MS) - 1, first = last - WINDOW + 1;
  let out = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' + SEG_MS / 1000 + '\n#EXT-X-MEDIA-SEQUENCE:' + first + '\n';
  for (let s = first; s <= last; s++) out += '#EXTINF:' + (SEG_MS / 1000).toFixed(1) + ',\n' + login + '/' + s + '.vtt\n'; // adresses relatives à /chat/<login>.m3u8
  return out;
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = sec => {
  const ms = Math.round(sec * 1000), p = (n, w) => String(n).padStart(w, '0');
  return p(Math.floor(ms / 3600000), 2) + ':' + p(Math.floor(ms / 60000) % 60, 2) + ':' + p(Math.floor(ms / 1000) % 60, 2) + '.' + p(ms % 1000, 3);
};

// Deux façons de donner l'heure d'un message au lecteur :
//  · absolu (défaut) : l'heure du message est le temps de la vidéo (PTS/90000 s) et X-TIMESTAMP-MAP vaut l'identité (MPEGTS:0 = LOCAL 0) :
//    marche que le lecteur applique X-TIMESTAMP-MAP ou l'ignore.
//  · CHAT_TIMING=map : norme HLS, heure locale au segment + MPEGTS du début du segment.
const timing = () => (process.env.CHAT_TIMING === 'map' ? 'map' : 'abs');
const absSec = (cal, wallMs) => (cal.pts + (wallMs - cal.wall) * 90) / 90000;

// Mise en page : un sous-titre est centré par le lecteur. Pour coller le chat à gauche, chaque ligne est complétée par des espaces insécables
// jusqu'à une largeur fixe (CHAT_WIDTH, en « em » de la police à 100 %) : les lignes ont toutes la même largeur et le bloc occupe presque tout l'écran,
// donc le texte démarre au bord gauche. Largeur estimée : les polices sont proportionnelles, d'où quelques pixels d'écart.
const NBSP = '\u00a0';
const emOf = ch => {
  if (/[ijl.,:;!|'`]/.test(ch)) return 0.24;
  if (/[ftrI()\[\]{}\-"\/\\]/.test(ch)) return 0.33;
  if (ch === ' ' || ch === NBSP) return 0.28;
  if (/[mw]/.test(ch)) return 0.8;
  if (/[MW@%]/.test(ch)) return 0.95;
  if (/[A-Z]/.test(ch)) return 0.67;
  if (/[0-9]/.test(ch)) return 0.56;
  if (/[a-z]/.test(ch)) return 0.55;
  return 1; // emojis, caractères larges
};
const emW = (str, k = 1) => { let w = 0; for (const ch of str) w += emOf(ch) * k; return w; };
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d; };
const layout = () => (process.env.CHAT_LAYOUT === 'center' ? 'center' : process.env.CHAT_LAYOUT === 'right' ? 'right' : 'left');

function lineOf(m) {
  const side = layout(), left = side !== 'center', W = num(process.env.CHAT_WIDTH, 55, 20, 140), nick = m.user + ': ';
  let text = m.text;
  if (left) { // tronque pour ne jamais dépasser la largeur (sinon le lecteur coupe la ligne en deux)
    let cut = false;
    while (text.length > 1 && emW(nick, 1.08) + emW(text) + (cut ? 1 : 0) > W - 0.5) { text = Array.from(text).slice(0, -1).join(''); cut = true; }
    if (cut) text = text.trimEnd() + '…';
  }
  let out = '<b>' + esc(m.user) + '</b>: ' + esc(text);
  if (left) { const pad = NBSP.repeat(Math.max(0, Math.round((W - emW(nick, 1.08) - emW(text)) / emOf(NBSP)))); out = side === 'right' ? pad + out : out + pad; }
  return out;
}

function segment(login, s) {
  const r = rooms.get(login);
  if (r) r.lastUse = Date.now();
  const a = s * SEG_MS, b = a + SEG_MS; // fenêtre en « temps vidéo » (horloge murale de la capture)
  const map = timing() === 'map', cal = r && r.cal;
  const mpegts = map && cal ? ((Math.round(cal.pts + (a - cal.wall) * 90) % 2 ** 33) + 2 ** 33) % 2 ** 33 : 0;
  let out = 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:' + mpegts + '\n\n';
  if (!r || !cal) return out; // sans recalage : aucun message (des heures fausses seraient pires)
  const d = delayMs(), life = num(process.env.CHAT_LIFE_MS, 15000, 3000, 60000), nLines = Math.round(num(process.env.CHAT_LINES, 8, 1, 15));
  let list = r.msgs.map(m => ({ tv: m.ts - d, user: m.user, text: m.text })); // le chat réagit à ce que les gens ont vu plus tôt
  if (process.env.CHAT_TEST === '1') { // messages factices toutes les 3 s : vérifie l'affichage sans dépendre du chat
    for (let k = Math.floor((a - life) / 3000) * 3000; k < b; k += 3000) list.push({ tv: k, user: 'TEST', text: 'chat ' + new Date(k).toISOString().slice(11, 19) + ' UTC' });
  }
  list = list.filter(m => m.tv < b && m.tv + life > a).sort((x, y) => x.tv - y.tv);
  // Le chat est un bloc de nLines lignes qui change à chaque nouveau message ou quand un message expire : un sous-titre par état, sans jamais dépasser le segment
  const bp = new Set([a, b]);
  for (const m of list) { if (m.tv > a && m.tv < b) bp.add(m.tv); if (m.tv + life > a && m.tv + life < b) bp.add(m.tv + life); }
  const pts = [...bp].sort((x, y) => x - y), tm = t => fmt(map ? (t - a) / 1000 : absSec(cal, t));
  for (let i = 0; i + 1 < pts.length; i++) {
    const x = pts[i], alive = list.filter(m => m.tv <= x && x < m.tv + life).slice(-nLines);
    if (alive.length) out += tm(x) + ' --> ' + tm(pts[i + 1]) + '\n' + alive.map(lineOf).join('\n') + '\n\n';
  }
  return out;
}

// Derniers messages (affichés avec un retard de delay ms) pour le panneau incrusté dans la vidéo ; garde la connexion ouverte
function recent(login, n, delay) {
  const r = open(login);
  if (!r) return null;
  const lim = Date.now() - (delay === undefined ? delayMs() : delay);
  return r.msgs.filter(m => m.t <= lim).slice(-n);
}

// Latence IRC (réception - envoi Twitch, écart d'horloge compris), prudente : tous les messages envoyés avant (maintenant - latence) sont arrivés
function latencyMs(login) {
  const r = rooms.get(login);
  if (!r || r.lat.length < 5) return 800;
  const a = [...r.lat].sort((x, y) => x - y), p = a[Math.min(a.length - 1, Math.floor(a.length * 0.9))];
  return Math.min(4000, Math.max(300, Math.round(p + 150)));
}

// Derniers messages envoyés (heure Twitch) au plus tard à tc : sert à dessiner le chat pour une image précise de la vidéo ; garde la connexion ouverte
function upTo(login, n, tc) {
  const r = open(login);
  if (!r) return null;
  const out = [];
  for (let i = r.msgs.length - 1; i >= 0 && out.length < n; i--) if (r.msgs[i].ts <= tc) out.unshift(r.msgs[i]);
  return out;
}

// Pour /chat/<login>/debug
function status(login) {
  const r = rooms.get(login);
  const base = { actif: enabled(), chaines_ouvertes: rooms.size, delai_ms: delayMs() };
  if (!r) return { ...base, chaine: login, connectee: false, note: 'aucune lecture récente : la connexion s\'ouvre à la première lecture de la piste' };
  return { ...base, chaine: login, connectee: !!(r.sock && !r.sock.destroyed && r.sock.authorized), messages_recus: r.n, en_memoire: r.msgs.length, erreur_irc: r.err, qualite_reference: !!r.variant, recalage: r.cal ? { pts: r.cal.pts, age_s: Math.round((Date.now() - r.cal.at) / 1000), temps_video_s_maintenant: Math.round(absSec(r.cal, Date.now() - delayMs())) } : null, mode_heure: timing(), disposition: layout(), test: process.env.CHAT_TEST === '1', erreur_recalage: r.calErr, diagnostic_recalage: r.calInfo || null };
}

// Pour le dashboard (onglet Chat) : salles ouvertes et test de connexion IRC
function overview() {
  return { sous_titres: enabled(), delai_ms: delayMs(), max_salles: maxRooms(), salles: [...rooms].map(([login, r]) => ({ chaine: login, connectee: !!(r.sock && !r.sock.destroyed && r.sock.authorized), messages_recus: r.n, latence_irc_ms: latencyMs(login), inactif_s: Math.round((Date.now() - r.lastUse) / 1000), erreur: r.err })) };
}
async function probe(login) {
  const r = open(login);
  if (!r) return { ok: false, erreur: 'trop de chaînes ouvertes (CHAT_MAX_ROOMS)' };
  const n0 = r.n;
  await new Promise(res => setTimeout(res, 5000));
  const st = status(login);
  return { ok: !!st.connectee, connectee: st.connectee, messages_en_5s: r.n - n0, latence_irc_ms: latencyMs(login), erreur_irc: st.erreur_irc || null };
}

module.exports = { overview, probe, _parse: parse, recent, upTo, latencyMs, delayMs, enabled, watch, watchUrl, playlist, segment, status, readFirstPts, readMp4Pts, pickVariant, _rooms: rooms };
