'use strict';
// Dessine le panneau de chat (pseudos colorés, fond translucide, messages qui défilent vers le haut) en PNG, sans dépendance npm.
// Le texte vient d'un atlas de glyphes pré-rendus (lib/assets/chatfont.json, police Inter, licence SIL OFL, voir tools/make-chatfont.py).
// Le PNG est ensuite superposé à la vidéo par ffmpeg (lib/burn.js).
const zlib = require('zlib');
const F = require('./assets/chatfont.json');

const PAD = 12, GAP = 8, FADE = 90, RADIUS = 14;   // marge, espace entre messages, hauteur du fondu en haut, rayon des coins (px, à 720p)
const LH = F.asc + F.desc + 3;                     // hauteur d'une ligne
const BG = [8, 8, 12, 150];                        // fond du panneau : presque noir, translucide
const WHITE = [240, 240, 245];
const PALETTE = ['#FF4040', '#5B8CFF', '#3DDC84', '#FF8A5B', '#B6E04D', '#FF6FB5', '#9B7BFF', '#35D0C8', '#FFC247', '#6FA8FF', '#E0699B', '#5FDB6F'];

/* ---------- glyphes ---------- */
const cache = new Map();
function glyph(bold, ch) {
  const key = (bold ? 'b' : 'r') + ch;
  let g = cache.get(key);
  if (g !== undefined) return g;
  const e = (bold ? F.bold : F.regular)[ch];
  g = e ? { adv: e[0], w: e[1], h: e[2], ox: e[3], oy: e[4], a: e[5] ? Buffer.from(e[5], 'base64') : null } : null;
  cache.set(key, g);
  return g;
}
const norm = s => String(s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ').replace(/\s+/g, ' ');
function width(str, bold) { let w = 0; for (const ch of str) { const g = glyph(bold, ch); if (g) w += g.adv; } return w; }

/* ---------- couleurs ---------- */
function hexToRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null; }
function readable(rgb) { // éclaircit les couleurs trop sombres pour le fond foncé
  const y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2], k = Math.min(0.75, Math.max(0, (150 - y) / 150));
  return rgb.map(c => Math.round(c + (255 - c) * k));
}
function nickColor(user, hex) {
  let c = hexToRgb(hex);
  if (!c) { let h = 0; for (const ch of String(user)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; c = hexToRgb(PALETTE[h % PALETTE.length]); }
  return readable(c);
}

/* ---------- mise en page ---------- */
// Un message = pseudo en gras coloré + texte, coupé aux mots (ou aux lettres pour un mot plus large que le panneau)
function wrap(item, maxW) {
  const runs = [{ t: norm(item.user) + ': ', bold: true, color: nickColor(item.user, item.color) }, { t: norm(item.text), bold: false, color: WHITE }];
  const lines = [[]]; let x = 0;
  const put = (t, bold, color, w) => { const l = lines[lines.length - 1]; l.push({ t, bold, color, x }); x += w; };
  const brk = () => { lines.push([]); x = 0; };
  for (const r of runs) {
    for (const word of r.t.match(/\S+\s*|\s+/g) || []) {
      let w = width(word, r.bold);
      if (x > 0 && x + width(word.trimEnd(), r.bold) > maxW) { brk(); if (!word.trim()) continue; w = width(word, r.bold); }
      if (w > maxW) { // mot trop large : coupé lettre par lettre
        let chunk = '', cw = 0;
        for (const ch of word) {
          const g = glyph(r.bold, ch), a = g ? g.adv : 0;
          if (x + cw + a > maxW && (chunk || x > 0)) { if (chunk) put(chunk, r.bold, r.color, cw); brk(); chunk = ''; cw = 0; }
          chunk += ch; cw += a;
        }
        if (chunk) put(chunk, r.bold, r.color, cw);
      } else put(word, r.bold, r.color, w);
    }
  }
  return lines.filter(l => l.length);
}

/* ---------- dessin ---------- */
function blit(buf, W, H, g, gx, gy, color, fadeFor) {
  if (!g || !g.a) return;
  for (let j = 0; j < g.h; j++) {
    const y = gy + j; if (y < 0 || y >= H) continue;
    const fk = fadeFor(y); if (fk <= 0) continue;
    for (let i = 0; i < g.w; i++) {
      const x = gx + i; if (x < 0 || x >= W) continue;
      const cov = g.a[j * g.w + i]; if (!cov) continue;
      const sa = (cov / 255) * fk, p = (y * W + x) * 4, da = buf[p + 3] / 255, oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      for (let c = 0; c < 3; c++) buf[p + c] = Math.round((color[c] * sa + buf[p + c] * da * (1 - sa)) / oa);
      buf[p + 3] = Math.round(oa * 255);
    }
  }
}

// items : du plus ancien au plus récent ; renvoie un tampon RGBA W×H
function renderRGBA(items, W = 340, H = 720) {
  const buf = Buffer.alloc(W * H * 4), px = new Uint32Array(buf.buffer, buf.byteOffset, W * H);
  px.fill((BG[0] | (BG[1] << 8) | (BG[2] << 16) | (BG[3] << 24)) >>> 0);
  const fade = Math.min(FADE, H / 3), fadeFor = y => (y >= fade ? 1 : Math.max(0, y / fade));
  let bottom = H - PAD;
  for (let i = items.length - 1; i >= 0 && bottom > 0; i--) {
    const lines = wrap(items[i], W - 2 * PAD), top = bottom - lines.length * LH;
    lines.forEach((l, k) => { for (const r of l) { let x = PAD + r.x; for (const ch of r.t) { const g = glyph(r.bold, ch); if (!g) continue; blit(buf, W, H, g, Math.round(x) + g.ox, top + k * LH + F.asc + 1 + g.oy, r.color, fadeFor); x += g.adv; } } });
    bottom = top - GAP;
  }
  roundCorners(buf, W, H, RADIUS);
  return buf;
}

// Coins arrondis : l'alpha tombe à 0 hors du quart de cercle de chaque coin (bord adouci)
function roundCorners(buf, W, H, r) {
  for (let j = 0; j < r; j++) for (let i = 0; i < r; i++) {
    const d = Math.hypot(r - i - 0.5, r - j - 0.5), k = Math.min(1, Math.max(0, r - d + 0.5));
    if (k >= 1) continue;
    for (const [x, y] of [[i, j], [W - 1 - i, j], [i, H - 1 - j], [W - 1 - i, H - 1 - j]]) { const p = (y * W + x) * 4 + 3; buf[p] = Math.round(buf[p] * k); }
  }
}

/* ---------- PNG ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(rgba, W, H) {
  const rows = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { rows[y * (W * 4 + 1)] = 0; rgba.copy(rows, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 3 })), chunk('IEND', Buffer.alloc(0))]);
}

const render = (items, W = 340, H = 720) => png(renderRGBA(items, W, H), W, H);

module.exports = { render, renderRGBA, png, nickColor, wrap, width };
