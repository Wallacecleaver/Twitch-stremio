'use strict';
// Chat incrusté dans la vidéo (expérimental, CHAT_BURN=1) : un ffmpeg lit le live, superpose le panneau de chat (lib/chatimg.js, envoyé en brut à 4 images/s)
// en bas à droite puis ré-encode en HLS. Un ffmpeg par chaîne et qualité, partagé entre les lecteurs de cette qualité ; il s'arrête 20 s après le dernier lecteur.
// Pensé pour un petit serveur : encodage x264 « ultrafast », 30 images/s au plus, 720p au plus (BURN_HEIGHT), priorité basse (nice), un budget de CPU (BURN_BUDGET)
// qui refuse un nouveau flux plutôt que de ralentir tout le monde, et des segments écrits en mémoire (/dev/shm) plutôt que sur le disque.
const { randomBytes } = require('crypto');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chatLib = require('./chat');
const img = require('./chatimg');

const IDLE_MS = 20000;                       // arrêt du ffmpeg sans lecteur
const FRAME_MS = 250;                        // le panneau est envoyé à 4 images/s (le brut ne coûte presque rien : plus de PNG à compresser ni à décoder)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ANCHOR_MS = 5000;                      // sans date de segment au bout de ce délai : repli sur l'horloge du serveur
const PW = 340, PH_FULL = 720;               // panneau de référence (largeur, hauteur pleine à 720p), mis à l'échelle par ffmpeg
const BASE = process.env.BURN_DIR || (fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir());
const DIR = path.join(BASE, 'twitchio-burn');
const enabled = () => process.env.CHAT_BURN === '1';
const num = (v, d, lo, hi) => { const n = v == null || v === '' ? NaN : Number(v); return Number.isFinite(n) && n >= lo ? Math.min(hi, Math.max(lo, n)) : d; };
const maxJobs = () => Math.round(num(process.env.BURN_MAX, 3, 1, 16));
const maxHeight = () => Math.round(num(process.env.BURN_HEIGHT, 720, 160, 1080));
const budget = () => num(process.env.BURN_BUDGET, maxHeight() >= 1000 ? 2.4 : 1.2, 0.2, 16); // en « flux 720p30 » : 1,2 convient à 2 cœurs ; un 1080p30 vaut 2,25, donc 2,4 par défaut si le 1080p est autorisé
const panelPct = () => Math.round(num(process.env.BURN_PANEL, 50, 25, 100)); // hauteur du panneau, en % de la vidéo
const delayMs = () => num(process.env.BURN_DELAY_MS, 8000, 0, 60000);        // REPLI seulement (pas de dates dans la liste) : le chat est affiché après ce délai, pour coller à l'image
// Synchro sur l'image (défaut) : chaque image du panneau est calée sur l'heure de capture de l'image vidéo qu'elle recouvre (EXT-X-PROGRAM-DATE-TIME),
// et montre les messages envoyés au plus tard « CHAT_DELAY_MS » après cette image (les gens écrivent ~6 s après ce qu'ils ont vu : la réaction tombe sur l'image qui l'a provoquée).
const syncOn = () => process.env.BURN_SYNC !== '0';
// Départ de ffmpeg : nombre de segments en arrière du direct (défaut 4, ffmpeg prend 3). Plus en arrière = les premiers segments sont déjà « mûrs » pour le chat,
// donc la vidéo apparaît plus vite (le retard sur le direct ne dépend que du délai du chat et du départ, pas du rythme de lecture).
const startBack = () => Math.round(num(process.env.BURN_START, 4, 3, 6));
const lagMs = () => num(process.env.CHAT_DELAY_MS, 6000, 0, 30000);
const preset = () => (/^(ultrafast|superfast|veryfast)$/.test(process.env.BURN_PRESET || '') ? process.env.BURN_PRESET : 'ultrafast');
const side = () => (process.env.BURN_SIDE === 'left' ? 'left' : 'right');
// Coût d'un flux, en « flux 720p30 » (proportionnel au nombre de pixels par seconde)
const cost = (h, fps) => (h / 720) ** 2 * Math.min(30, fps > 0 ? fps : 30) / 30;
// En 1080p, adapte la cadence au budget configuré avant de retirer la source.
function burnFps(h, fps, limit = Infinity) {
  const target = Math.max(1, Math.min(30, Math.round(fps > 0 ? fps : 30)));
  if (cost(h, target) <= limit + 1e-6) return target;
  if (h < 1000) return 0;
  return [25, 24, 20, 15].find(f => f < target && cost(h, f) <= limit + 1e-6) || 0;
}
// Débit maximal par hauteur (kb/s) : un débit bas allège aussi l'encodage et le disque
const rate = h => (h >= 1000 ? 4500 : h >= 700 ? 3000 : h >= 450 ? 1600 : h >= 340 ? 900 : 350);

let ff = null;
function available() {
  if (ff === null) { const r = spawnSync('ffmpeg', ['-version'], { timeout: 5000 }); ff = !r.error && r.status === 0; }
  return ff;
}

const jobs = new Map(); // chaîne + qualité -> session FFmpeg
const sessions = new Map(); // identifiant de session -> session FFmpeg

/* ---------- Horloge de la vidéo source ---------- */
const keyOf = u => { try { return new URL(u).pathname; } catch { return String(u); } };
// Liste de segments -> [{ key, pdt (ms, heure de capture de la 1re image), dur }]
function parseMedia(txt, base) {
  const out = []; let pdt = null, dur = 2, prev = null;
  for (const l of String(txt).split(/\r?\n/)) {
    if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) { const t = Date.parse(l.slice(25).trim()); pdt = Number.isNaN(t) ? null : t; }
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || dur;
    else if (l && !l.startsWith('#')) {
      let url; try { url = new URL(l.trim(), base).href; } catch { continue; }
      const t = pdt != null ? pdt : prev && prev.pdt != null ? prev.pdt + prev.dur * 1000 : null;
      prev = { key: keyOf(url), pdt: t, dur }; out.push(prev); pdt = null;
    }
  }
  return out;
}
async function fetchMedia(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return parseMedia(await r.text(), url);
}
// Relit la liste du live : mémorise la date de chaque segment (ffmpeg dit lequel il ouvre en premier, on en déduit l'heure de l'image 0)
async function poll(job) {
  if (job.stopped || job.polling) return job.polling;
  job.polling = (async () => {
    try {
      for (const sg of await fetchMedia(job.src)) { const e = job.map.get(sg.key); if (!e) job.map.set(sg.key, sg); else if (e.pdt == null && sg.pdt != null) e.pdt = sg.pdt; }
      while (job.map.size > 80) job.map.delete(job.map.keys().next().value);
      job.srcErr = null;
    } catch (e) { job.srcErr = e.message; }
  })().finally(() => { job.polling = null; });
  return job.polling;
}
// Premier segment ouvert par ffmpeg : son heure de capture est l'heure de l'image 0 de la vidéo (et du panneau)
async function anchor(job, key) {
  if (job.clock) return;
  let e = job.map.get(key);
  if (!e) { await poll(job); e = job.map.get(key); }
  if (job.clock || job.stopped) return;
  if (e && e.pdt != null) job.clock = { mode: 'video', w0: e.pdt, seg: key };
  else useWall(job, e ? 'pas de EXT-X-PROGRAM-DATE-TIME dans la liste (relais ?)' : 'segment de départ introuvable dans la liste');
}
function useWall(job, why) { if (!job.clock) job.clock = { mode: 'horloge', raison: why }; }
// Saut de date entre deux segments lus (publicité, trou) : signalé dans /burn/debug
function noteOpen(job, url) {
  const key = keyOf(url), e = job.map.get(key);
  if (!e || job.lastSeg?.key === key) return;
  if (job.lastSeg && e.pdt != null && job.lastSeg.pdt != null) { const gap = e.pdt - (job.lastSeg.pdt + job.lastSeg.dur * 1000); if (Math.abs(gap) > 1500) { job.sauts++; job.lastSaut = Math.round(gap); } }
  job.lastSeg = e;
  if (!job.clock && !job.anchoring) { job.anchoring = true; anchor(job, key).finally(() => { job.anchoring = false; }); }
}
const used = () => [...jobs.values()].reduce((t, j) => t + j.cost, 0);

// Qualités proposées avec le chat : une par qualité de la liste, jamais de 1440p ; au-dessus de BURN_HEIGHT (720p) on retombe sur la meilleure qualité permise
// (on ne ré-encode pas du 1080p sur un petit serveur), de préférence à 30 images/s. On écarte ce qui dépasse le budget de CPU.
function variants(video, cfg) {
  const maxH = Math.min(maxHeight(), (cfg && cfg.cap) || Infinity);
  const limit = budget(), byHeight = new Map();
  for (const v of video) {
    if (v.audio || !(v.h > 0) || v.h > maxH) continue;
    const sourceFps = v.fps > 0 ? v.fps : 30;
    const f = burnFps(Math.max(160, Math.round(v.h / 2) * 2), sourceFps, limit);
    if (!f) continue;
    const previous = byHeight.get(v.h);
    if (!previous || sourceFps < previous.sourceFps) byHeight.set(v.h, { v, h: v.h, f, sourceFps });
  }
  return [...byHeight.values()].sort((a, b) => b.h - a.h);
}

function stop(job) {
  if (!job || job.stopped) return;
  job.stopped = true;
  clearInterval(job.feed);
  clearInterval(job.idle);
  job.proc.stdin.destroy();
  job.proc.kill('SIGTERM');
  const killTimer = setTimeout(() => job.proc.kill('SIGKILL'), 3000);
  killTimer.unref();
  job.proc.once('close', () => {
    clearTimeout(killTimer);
    if (jobs.get(job.key) === job) jobs.delete(job.key);
    sessions.delete(job.id);
    fs.rm(job.dir, { recursive: true, force: true, maxRetries: 3 }, () => {});
  });
}

function start(login, p, key, H, fps, seed) {
  const id = randomBytes(12).toString('hex');
  const dir = path.join(DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const k = H / PH_FULL, pct = panelPct();
  const hd = H >= 1000;
  const phRef = Math.round(PH_FULL * pct / 100), ph = Math.round(phRef * k / 2) * 2;
  // Aligne les lignes RGBA du panneau HD sur 32 octets pour le convertisseur SIMD de FFmpeg.
  const lvl = k >= 1.25 ? 1 : 0;
  const pw = hd ? Math.ceil(PW * k / 8) * 8 : Math.round(PW * k / 2) * 2;
  const nw = hd ? pw : Math.round(PW * (lvl ? 1.5 : 1)), nh = hd ? ph : Math.round(phRef * (lvl ? 1.5 : 1));
  // Applique le plafond à l'entrée du filtre : le coût et la durée du GOP suivent la cadence de sortie.
  const bg = 'fps=' + fps + (p.h !== H ? ',scale=-2:' + H : '');
  const pn = (nw !== pw || nh !== ph ? 'scale=' + pw + ':' + ph + ',' : '') + 'format=yuva420p';
  const x = side() === 'left' ? 'W*0.012' : 'W-w-W*0.012', y = 'H-h-H*0.06'; // un peu au-dessus du bas : la barre du lecteur ne le cache pas
  const filter = '[0:v:0]' + bg + '[bg];[1:v]' + pn + '[pn];[bg][pn]overlay=x=' + x + ':y=' + y + ':eof_action=repeat:format=yuv420[o]';
  // Panneau en vidéo brute RGBA : rien à compresser côté Node, rien à décoder côté ffmpeg ; « level+info » pour lire les segments ouverts (calage)
  const args = ['-hide_banner', '-nostats', '-loglevel', 'level+info',
    ...(hd ? ['-filter_complex_threads', '2'] : []),
    ...(hd ? ['-threads:v', '2'] : []), '-live_start_index', String(-startBack()), '-analyzeduration', '2000000', '-probesize', '2000000', '-thread_queue_size', '64', '-i', p.u,
    '-thread_queue_size', hd ? '8' : '64', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', nw + 'x' + nh, '-framerate', String(1000 / FRAME_MS), '-i', 'pipe:0',
    '-filter_complex', filter, '-map', '[o]', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', preset(), '-tune', 'zerolatency', '-crf', '27', '-maxrate', rate(H) + 'k', '-bufsize', rate(H) * 2 + 'k', '-threads', '2',
    '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0', '-c:a', 'copy',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6', '-hls_flags', 'delete_segments+omit_endlist+independent_segments+temp_file', '-hls_segment_filename', path.join(dir, id + '-s%d.ts'), path.join(dir, 'index.m3u8')];
  const niceBin = ['/usr/bin/nice', '/bin/nice'].find(f => fs.existsSync(f));
  const proc = niceBin ? spawn(niceBin, ['-n', '10', 'ffmpeg', ...args], { stdio: ['pipe', 'ignore', 'pipe'] }) : spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  const job = { login, key, id, dir, proc, waiters: 0, src: p.u, started: Date.now(), lastUse: Date.now(), stopped: false, err: [], h: H, fps, cost: cost(H, fps), frames: 0, exit: null, buf: null, sig: '', cache: new Map(),
    map: new Map(seed || []), clock: syncOn() ? null : { mode: 'horloge', raison: 'BURN_SYNC=0' }, polling: null, anchoring: false, srcErr: null, sauts: 0, lastSaut: null, lastSeg: null, rendus: 0 };
  let rest = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', d => {
    const lines = (rest + d).split('\n'); rest = lines.pop();
    for (const l of lines) {
      const m = /Opening '([^']+)' for reading/.exec(l);
      if (m) { if (syncOn()) noteOpen(job, m[1]); continue; }
      if (/\[(warning|error|fatal)\]/.test(l) && !/Thread message queue blocking/.test(l)) job.err.push(l.trim());
    }
    job.err = job.err.slice(-12);
  });
  proc.stdin.on('error', () => {});
  proc.on('error', e => { job.err.push('démarrage : ' + e.message); stop(job); });
  proc.on('exit', (code, sig) => { job.exit = { code, sig }; stop(job); });

  // Panneau : l'image k du panneau recouvre l'image vidéo k × FRAME_MS (ffmpeg les apparie par leurs horodatages, quelle que soit la vitesse d'encodage).
  // Mode « video » : cette image a été capturée à w0 + k × FRAME_MS (dates PROGRAM-DATE-TIME) ; on y affiche les messages envoyés au plus tard lagMs() après,
  // et on n'envoie l'image que lorsque tous ces messages sont arrivés (heure - latence IRC) : jamais de message « manqué » ni d'à-peu-près.
  // Mode « horloge » (repli sans dates) : comme avant, l'horloge du serveur moins BURN_DELAY_MS.
  const render = k => {
    const c = job.clock, items = (c.mode === 'video' ? chatLib.upTo(login, 40, c.w0 + k * FRAME_MS + lagMs()) : chatLib.recent(login, 40, delayMs())) || [];
    const sig = items.map(m => m.seq).join(',');
    if (!job.buf || sig !== job.sig) { job.buf = !items.length ? Buffer.alloc(nw * nh * 4) : img.renderRGBA(items.map(m => ({ user: m.user, text: m.text, color: m.color })), nw, nh, lvl); job.sig = sig; job.rendus++; }
    return job.buf;
  };
  chatLib.upTo(login, 0, 0); // ouvre l’IRC avant d’attendre le premier segment vidéo
  const t0 = Date.now();
  const tick = () => {
    if (job.stopped) return;
    if (!job.clock) { if (Date.now() - t0 > ANCHOR_MS) useWall(job, 'aucun segment lu à temps'); else return; }
    const c = job.clock, now = Date.now();
    const due = c.mode === 'video' ? Math.floor((now - chatLib.latencyMs(login) - lagMs() - c.w0) / FRAME_MS) + 1 : Math.floor((now - t0) / FRAME_MS) + 1;
    for (let n = 0; job.frames < due && n < 32 && !proc.stdin.writableNeedDrain && !proc.stdin.destroyed; n++) {
      proc.stdin.write(render(job.frames++));
    }
  };
  if (hd) proc.stdin.on('drain', tick);
  tick();
  job.feed = setInterval(tick, 80);
  job.idle = setInterval(() => {
    if (!job.waiters && Date.now() - job.lastUse > IDLE_MS) stop(job);
    if (syncOn()) poll(job);
  }, 2000);
  job.feed.unref(); job.idle.unref();
  return job;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Une qualité est partagée entre les lecteurs. Les segments identifient leur session, même après un redémarrage du flux.
async function playlist(login, p, signal) {
  if (!enabled() || !available()) return { code: 404, msg: 'Chat incrusté indisponible (CHAT_BURN=1 et ffmpeg nécessaires)' };
  if (!p || !/^https?:\/\//.test(p.u) || !Number.isFinite(p.h) || p.h <= 0) return { code: 400, msg: 'Lien invalide' };
  const height = Math.max(160, Math.min(maxHeight(), Math.round(p.h / 2) * 2));
  const fps = burnFps(height, p.f, height >= 1000 ? budget() : Infinity);
  const key = login + ':' + height + ':' + fps;
  const c = cost(height, fps);
  const atCapacity = () => jobs.size >= maxJobs() || used() + c > budget() + 1e-6;
  const busy = { code: 503, msg: 'Trop de flux avec chat en même temps pour ce serveur. Réessaie plus tard, ou choisis une source sans chat.' };
  if (!fps) return busy;
  let job = jobs.get(key);
  if (!job) {
    if (atCapacity()) return busy;
    let seed = null;
    if (syncOn()) {
      try { seed = (await fetchMedia(p.u)).map(x => [x.key, x]); } catch { /* sans liste : repli sur l'horloge */ }
    }
    if (signal?.aborted) return { code: 499, msg: 'Lecture annulée' };
    // D'autres demandes ont pu démarrer un encodeur pendant la récupération de la liste.
    job = jobs.get(key);
    if (!job) {
      if (atCapacity()) return busy;
      job = start(login, p, key, height, fps, seed);
      jobs.set(key, job);
      sessions.set(job.id, job);
    }
  }
  job.lastUse = Date.now();
  job.waiters++;
  const file = path.join(job.dir, 'index.m3u8');
  const deadline = Date.now() + 25000 + (syncOn() ? lagMs() : 0);
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) return { code: 499, msg: 'Lecture annulée' };
      if (job.stopped) return { code: 502, msg: 'ffmpeg s’est arrêté : ' + (job.err.slice(-2).join(' · ') || 'raison inconnue') };
      try {
        const body = await fs.promises.readFile(file, 'utf8');
        if (!job.stopped && (body.match(/#EXTINF/g) || []).length >= 2) return { code: 200, body };
      } catch { /* pas encore prêt */ }
      await sleep(250);
    }
    return { code: 504, msg: 'Le flux avec chat met trop de temps à démarrer' };
  } finally {
    job.waiters--;
  }
}

async function segment(login, name) {
  const match = /^([a-f0-9]{24})-s\d+\.ts$/.exec(name);
  const job = match && sessions.get(match[1]);
  if (!job || job.stopped || job.login !== login) return null;
  let pending = job.cache.get(name);
  if (!pending) {
    pending = fs.promises.readFile(path.join(job.dir, name));
    job.cache.set(name, pending);
    if (job.cache.size > 10) job.cache.delete(job.cache.keys().next().value);
  }
  try {
    const data = await pending;
    job.lastUse = Date.now();
    return data;
  } catch {
    if (job.cache.get(name) === pending) job.cache.delete(name);
    return null;
  }
}

function status() {
  return { actif: enabled(), ffmpeg: enabled() ? available() : null, budget: budget(), utilise: Math.round(used() * 100) / 100, max_chaines: maxJobs(), hauteur_max: maxHeight(), preset: preset(), panneau_pct: panelPct(), cote: side(), synchro: syncOn() ? 'sur l\'image' : 'horloge du serveur', delai_repli_ms: delayMs(), dossier: DIR,
    flux: [...jobs.values()].map(j => ({ chaine: j.login, hauteur: j.h, images_s: j.fps, cout: Math.round(j.cost * 100) / 100, depuis_s: Math.round((Date.now() - j.started) / 1000), sans_lecteur_s: Math.round((Date.now() - j.lastUse) / 1000), panneaux_envoyes: j.frames, panneaux_dessines: j.rendus,
      synchro: j.clock ? { mode: j.clock.mode, raison: j.clock.raison, image0: j.clock.w0 ? new Date(j.clock.w0).toISOString() : undefined, retard_chat_ms: lagMs(), latence_irc_ms: chatLib.latencyMs(j.login), retard_sur_le_direct_s: j.clock.w0 ? Math.round((Date.now() - (j.clock.w0 + j.frames * FRAME_MS)) / 100) / 10 : undefined, sauts_de_date: j.sauts, dernier_saut_ms: j.lastSaut, liste_source: j.srcErr } : 'calage en cours', sortie: j.exit, ffmpeg: j.err.slice(-4) })) };
}

function stopAll() { for (const j of [...jobs.values()]) stop(j); }
process.on('exit', () => { for (const j of jobs.values()) { try { j.proc.kill('SIGKILL'); } catch { /* arrêté */ } } });

module.exports = { enabled, available, variants, playlist, segment, status, stopAll };
