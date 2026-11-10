'use strict';
// Chat incrusté dans la vidéo (expérimental, CHAT_BURN=1) : un ffmpeg lit le live, superpose le panneau de chat (lib/chatimg.js, envoyé en PNG à 2 images/s)
// puis ré-encode en HLS. Un seul ffmpeg par chaîne, partagé entre toutes les personnes qui la regardent ; il s'arrête 30 s après le dernier lecteur.
// Coût : le ré-encodage (≈ 0,5 à 1 cœur en 720p30) et ~10 s de retard en plus. BURN_MAX limite le nombre de chaînes en même temps (défaut 1).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chatLib = require('./chat');
const img = require('./chatimg');

const IDLE_MS = 30000;                       // arrêt du ffmpeg sans lecteur
const FRAME_MS = 500;                        // le panneau est envoyé à 2 images/s
const PW = 340, PH = 720;                    // taille de référence du panneau (mise à l'échelle par ffmpeg)
const DIR = process.env.BURN_DIR || path.join(os.tmpdir(), 'twitchio-burn');
const enabled = () => process.env.CHAT_BURN === '1';
const maxJobs = () => Math.max(1, Math.round(Number(process.env.BURN_MAX) || 1));
const delayMs = () => Number(process.env.BURN_DELAY_MS) || 8000;   // le chat est affiché après ce délai, pour coller à l'image (la vidéo a ~8 s de retard de plus)
const preset = () => (/^(ultrafast|superfast|veryfast|faster|fast)$/.test(process.env.BURN_PRESET || '') ? process.env.BURN_PRESET : 'superfast');
const side = () => (process.env.BURN_SIDE === 'left' ? 'left' : 'right');

let ff = null;
function available() {
  if (ff === null) { const r = spawnSync('ffmpeg', ['-version'], { timeout: 5000 }); ff = !r.error && r.status === 0; }
  return ff;
}

const jobs = new Map(); // chaîne -> { dir, proc, lastUse, ... }

// Qualité à incruster : la plus haute sous BURN_HEIGHT (720 par défaut) et sous le plafond de la personne, de préférence à 30 images/s
function pickVariant(vars, cfg) {
  const video = vars.filter(v => !v.audio && v.h > 0);
  if (!video.length) return null;
  const maxH = Math.min(Number(process.env.BURN_HEIGHT) || 720, (cfg && cfg.cap) || Infinity);
  const ok = video.filter(v => v.h <= maxH);
  return (ok.length ? ok : [video.sort((a, b) => a.h - b.h)[0]]).sort((a, b) => b.h - a.h || (a.fps || 30) - (b.fps || 30))[0];
}

function stop(job) {
  if (!job || job.stopped) return;
  job.stopped = true;
  clearInterval(job.feed); clearInterval(job.idle);
  try { job.proc.stdin.destroy(); } catch { /* déjà fermé */ }
  try { job.proc.kill('SIGTERM'); } catch { /* déjà arrêté */ }
  setTimeout(() => { try { job.proc.kill('SIGKILL'); } catch { /* arrêté */ } fs.rm(job.dir, { recursive: true, force: true }, () => {}); }, 3000).unref();
  if (jobs.get(job.login) === job) jobs.delete(job.login);
}

function start(login, p) {
  const dir = path.join(DIR, login + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const H = Math.max(240, Math.min(1080, Math.round(p.h / 2) * 2)), pw = Math.round(PW * H / PH / 2) * 2, fps = Math.min(30, p.f > 0 ? Math.round(p.f) : 30);
  const filter = '[0:v:0]scale=-2:' + H + ',fps=' + fps + ',format=yuv420p[bg];[1:v]format=rgba,scale=' + pw + ':' + H + '[pn];[bg][pn]overlay=x=' + (side() === 'left' ? '0' : 'W-w') + ':y=0:eof_action=repeat:format=auto[o]';
  const args = ['-hide_banner', '-loglevel', 'warning', '-thread_queue_size', '64', '-i', p.u,
    '-thread_queue_size', '64', '-f', 'image2pipe', '-framerate', String(1000 / FRAME_MS), '-c:v', 'png', '-i', 'pipe:0',
    '-filter_complex', filter, '-map', '[o]', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', preset(), '-tune', 'zerolatency', '-crf', '25', '-maxrate', '4500k', '-bufsize', '9000k', '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
    '-c:a', 'copy',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '8', '-hls_flags', 'delete_segments+omit_endlist+independent_segments', '-hls_segment_filename', path.join(dir, 's%d.ts'), path.join(dir, 'index.m3u8')];
  const niceBin = ['/usr/bin/nice', '/bin/nice'].find(x => fs.existsSync(x));
  const proc = niceBin ? spawn(niceBin, ['-n', '10', 'ffmpeg', ...args], { stdio: ['pipe', 'ignore', 'pipe'] }) : spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  const job = { login, dir, proc, started: Date.now(), lastUse: Date.now(), stopped: false, err: [], h: H, fps, frames: 0, exit: null, png: null, sig: '' };
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', d => { job.err.push(...String(d).split('\n').filter(Boolean)); job.err = job.err.slice(-12); });
  proc.stdin.on('error', () => {});
  proc.on('error', e => { job.err.push('démarrage : ' + e.message); stop(job); });
  proc.on('exit', (code, sig) => { job.exit = { code, sig }; stop(job); });

  // Panneau : on ne redessine que si le chat a changé ; on envoie exactement 2 images par seconde (rattrapage si un tour a du retard),
  // sinon la vidéo serait ralentie par l'écart de chronologie entre la vidéo et le panneau.
  const render = () => {
    const items = chatLib.recent(login, 40, delayMs()) || [];
    const last = items[items.length - 1], sig = items.length + ':' + (last ? last.t : 0);
    if (!job.png || sig !== job.sig) { job.png = img.render(items.map(m => ({ user: m.user, text: m.text, color: m.color })), PW, PH); job.sig = sig; }
    return job.png;
  };
  const t0 = Date.now();
  const tick = () => {
    if (job.stopped) return;
    const due = Math.floor((Date.now() - t0) / FRAME_MS) + 1;
    if (job.frames >= due || proc.stdin.writableLength > 4e6) return;
    const buf = render();
    while (job.frames < due && proc.stdin.writableLength <= 4e6) { proc.stdin.write(buf); job.frames++; }
  };
  tick();
  job.feed = setInterval(tick, 200);
  job.idle = setInterval(() => { if (Date.now() - job.lastUse > IDLE_MS) stop(job); }, 5000);
  job.feed.unref(); job.idle.unref();
  return job;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Liste HLS de la chaîne : démarre ffmpeg au besoin et attend les premiers segments. p = { u: liste de segments de la qualité, h, f }
async function playlist(login, p) {
  if (!enabled() || !available()) return { code: 404, msg: 'Chat incrusté indisponible (CHAT_BURN=1 et ffmpeg nécessaires)' };
  let job = jobs.get(login);
  if (!job) {
    if (jobs.size >= maxJobs()) return { code: 503, msg: 'Trop de flux avec chat en même temps (limite du serveur). Réessaie plus tard ou choisis une autre source.' };
    if (!p || !/^https?:\/\//.test(p.u)) return { code: 400, msg: 'Lien invalide' };
    job = start(login, p); jobs.set(login, job);
  }
  job.lastUse = Date.now();
  const file = path.join(job.dir, 'index.m3u8');
  for (let i = 0; i < 100; i++) { // jusqu'à 25 s
    if (job.stopped) return { code: 502, msg: 'ffmpeg s\'est arrêté : ' + (job.err.slice(-2).join(' · ') || 'raison inconnue') };
    try { const t = fs.readFileSync(file, 'utf8'); if ((t.match(/#EXTINF/g) || []).length >= 2) return { code: 200, body: t }; } catch { /* pas encore prêt */ }
    await sleep(250);
  }
  return { code: 504, msg: 'Le flux avec chat met trop de temps à démarrer' };
}

function segment(login, name) {
  const job = jobs.get(login);
  if (!job || !/^s\d+\.ts$/.test(name)) return null;
  job.lastUse = Date.now();
  try { return fs.readFileSync(path.join(job.dir, name)); } catch { return null; }
}

function refresh(login) { const j = jobs.get(login); if (j) j.lastUse = Date.now(); }

function status() {
  return { actif: enabled(), ffmpeg: enabled() ? available() : null, max: maxJobs(), preset: preset(), cote: side(), delai_ms: delayMs(),
    flux: [...jobs.values()].map(j => ({ chaine: j.login, hauteur: j.h, images_s: j.fps, depuis_s: Math.round((Date.now() - j.started) / 1000), sans_lecteur_s: Math.round((Date.now() - j.lastUse) / 1000), panneaux_envoyes: j.frames, sortie: j.exit, ffmpeg: j.err.slice(-4) })) };
}

function stopAll() { for (const j of [...jobs.values()]) stop(j); }
process.on('exit', () => { for (const j of jobs.values()) { try { j.proc.kill('SIGKILL'); } catch { /* arrêté */ } } });
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* rien à nettoyer */ }

module.exports = { enabled, available, pickVariant, playlist, segment, refresh, status, stopAll };
