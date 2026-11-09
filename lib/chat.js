'use strict';
// Chat Twitch en sous-titres (EXPÉRIMENTAL) : le chat devient une piste WebVTT « Chat Twitch » dans la liste de lecture HLS.
// Désactivé par défaut : CHAT_SUBS=1 (Paramètres › Configuration du dashboard) pour l'activer. Aucune dépendance npm (IRC Twitch via tls).
// La connexion au chat n'existe que tant que quelqu'un lit la piste (coupée après IDLE_MS), et il y a au plus CHAT_MAX_ROOMS chaînes en même temps.
const tls = require('tls');

const SEG_MS = 2000;                                           // durée d'un segment de sous-titres
const WINDOW = 6;                                              // segments annoncés
const SHOW_MS = 6000;                                          // durée d'affichage d'un message
const KEEP_MS = 60000;                                         // historique gardé par chaîne
const IDLE_MS = 90000;                                         // coupe l'IRC si plus personne ne lit
const RECAL_MS = 60000;                                        // recalage vidéo/horloge
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const delayMs = () => Number(process.env.CHAT_DELAY_MS) || 6000; // retard entre ce que les gens voient et ce qu'ils écrivent
const maxRooms = () => Number(process.env.CHAT_MAX_ROOMS) || 20;
const enabled = () => process.env.CHAT_SUBS === '1';

const rooms = new Map(); // login -> { sock, msgs, lastUse, cal, variant, closed, timer, retry, err, ... }

/* ---------- IRC Twitch anonyme ---------- */
function parse(line) {
  const m = line.match(/^(?:@(\S+) )?:(\S+?)!\S+ PRIVMSG #\S+ :(.*)$/);
  if (!m) return null;
  const tags = {};
  if (m[1]) for (const kv of m[1].split(';')) { const i = kv.indexOf('='); tags[kv.slice(0, i)] = kv.slice(i + 1); }
  return { user: String(tags['display-name'] || m[2]).replace(/\\s/g, ' '), text: m[3].slice(0, 140) };
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
      if (m) { r.msgs.push({ t: Date.now(), ...m }); r.n++; }
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
  r = { sock: null, msgs: [], n: 0, lastUse: Date.now(), cal: null, variant: null, closed: false, timer: null, retry: 0, err: null, calBusy: false, calErr: null };
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

// Segment fMP4 (CMAF) : temps de décodage (tfdt) converti en 90 kHz ; l'échelle de temps (mdhd) est lue dans le segment d'initialisation
function readMp4Pts(buf, init) {
  const t = buf.indexOf('tfdt');
  if (t < 0 || t + 16 > buf.length) return null;
  const v = buf[t + 4], time = v === 1 ? Number(buf.readBigUInt64BE(t + 8)) : buf.readUInt32BE(t + 8);
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
  const last = Math.floor((Date.now() - delayMs()) / SEG_MS) - 1, first = last - WINDOW + 1;
  let out = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' + SEG_MS / 1000 + '\n#EXT-X-MEDIA-SEQUENCE:' + first + '\n';
  for (let s = first; s <= last; s++) out += '#EXTINF:' + (SEG_MS / 1000).toFixed(1) + ',\n' + login + '/' + s + '.vtt\n'; // adresses relatives à /chat/<login>.m3u8
  return out;
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = sec => {
  const ms = Math.round(sec * 1000), p = (n, w) => String(n).padStart(w, '0');
  return p(Math.floor(ms / 3600000), 2) + ':' + p(Math.floor(ms / 60000) % 60, 2) + ':' + p(Math.floor(ms / 1000) % 60, 2) + '.' + p(ms % 1000, 3);
};

function segment(login, s) {
  const r = rooms.get(login);
  if (r) r.lastUse = Date.now();
  const a = s * SEG_MS, b = a + SEG_MS; // fenêtre en « temps vidéo » (horloge murale de la capture)
  const mpegts = r && r.cal ? ((Math.round(r.cal.pts + (a - r.cal.wall) * 90) % 2 ** 33) + 2 ** 33) % 2 ** 33 : 0;
  let out = 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:' + mpegts + '\n\n';
  if (!r) return out;
  const d = delayMs();
  for (const m of r.msgs) {
    const tv = m.t - d; // le chat réagit à ce que les gens ont vu plus tôt
    if (tv < a || tv >= b) continue;
    const st = (tv - a) / 1000;
    out += fmt(st) + ' --> ' + fmt(st + SHOW_MS / 1000) + '\n<b>' + esc(m.user) + '</b>: ' + esc(m.text) + '\n\n';
  }
  return out;
}

// Pour /chat/<login>/debug
function status(login) {
  const r = rooms.get(login);
  const base = { actif: enabled(), chaines_ouvertes: rooms.size, delai_ms: delayMs() };
  if (!r) return { ...base, chaine: login, connectee: false, note: 'aucune lecture récente : la connexion s\'ouvre à la première lecture de la piste' };
  return { ...base, chaine: login, connectee: !!(r.sock && !r.sock.destroyed && r.sock.authorized), messages_recus: r.n, en_memoire: r.msgs.length, erreur_irc: r.err, qualite_reference: !!r.variant, recalage: r.cal ? { pts: r.cal.pts, age_s: Math.round((Date.now() - r.cal.at) / 1000) } : null, erreur_recalage: r.calErr, diagnostic_recalage: r.calInfo || null };
}

module.exports = { enabled, watch, watchUrl, playlist, segment, status, readFirstPts, readMp4Pts, pickVariant, _rooms: rooms };
