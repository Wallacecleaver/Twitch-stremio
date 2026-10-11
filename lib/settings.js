'use strict';
// Réglages personnels, stockés dans l'adresse d'installation : /c/<pseudo>/<réglages>/manifest.json
// Aucun compte ni base de données : l'adresse EST la configuration (le pseudo sert à retrouver la personne dans le journal).
const PSEUDO_RE = /^[a-z0-9_]{2,20}$/;
const DEFAULTS = { cap: 0, fps60: true, relay: true, fixed: 3, audio: false, device: '' };
const CAPS = [0, 1080, 720, 480, 360];

const cleanPseudo = p => String(p || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_]/g, '').slice(0, 20);
const cleanDevice = d => String(d || '').replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 24);

function normalize(o = {}) {
  const c = { ...DEFAULTS };
  if (CAPS.includes(Number(o.cap))) c.cap = Number(o.cap);
  if (typeof o.fps60 === 'boolean') c.fps60 = o.fps60;
  if (typeof o.relay === 'boolean') c.relay = o.relay;
  if (Number.isInteger(Number(o.fixed)) && Number(o.fixed) >= 0 && Number(o.fixed) <= 6) c.fixed = Number(o.fixed);
  if (typeof o.audio === 'boolean') c.audio = o.audio;
  c.device = cleanDevice(o.device);
  return c;
}
const encode = o => Buffer.from(JSON.stringify(normalize(o))).toString('base64url');
function decode(s) { try { return normalize(JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'))); } catch { return null; } }
const heightOf = name => Number((String(name).match(/(\d{3,4})p/) || [])[1]) || 0;
const fpsOf = name => Number((String(name).match(/\d{3,4}p(\d{2,3})/) || [])[1]) || 30;

// retire d'une liste de lecture principale les qualités au-dessus du plafond choisi (si tout est retiré, on garde l'original)
function filterMaster(text, cfg) {
  if (!cfg || (!cfg.cap && cfg.fps60)) return text;
  const lines = text.split(/\r?\n/), out = [], kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const res = lines[i].match(/RESOLUTION=\d+x(\d+)/), fr = lines[i].match(/FRAME-RATE=([\d.]+)/);
      const h = res ? Number(res[1]) : 0, f = fr ? Number(fr[1]) : 30, audioOnly = /audio_only/i.test(lines[i + 1] + lines[i]) || !res;
      const ok = audioOnly || ((!cfg.cap || h <= cfg.cap) && (cfg.fps60 || f < 50));
      if (ok) { out.push(lines[i], lines[i + 1]); kept.push(h); }
      i++;
    } else out.push(lines[i]);
  }
  return kept.some(h => h > 0) ? out.join('\n') : text;
}
const keepVariant = (v, cfg) => { const h = heightOf(v.name); return (!cfg.cap || !h || h <= cfg.cap) && (cfg.fps60 || fpsOf(v.name) < 50); };

module.exports = { PSEUDO_RE, DEFAULTS, CAPS, cleanPseudo, cleanDevice, normalize, encode, decode, filterMaster, keepVariant, heightOf };
