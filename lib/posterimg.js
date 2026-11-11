'use strict';
// Affiche d'un live en JPEG (vignette + badge spectateurs + jeu), pour Stremio mobile qui n'affiche pas les SVG.
// Sans dépendance npm : décodeur JPEG « baseline » (celui des vignettes Twitch), dessin du badge avec l'atlas de police Inter du chat
// (lib/assets/chatfont.json), puis encodeur JPEG baseline. Un JPEG progressif ou illisible → decode() renvoie null (l'appelant retombe sur la vignette seule).

const F = require('./assets/chatfont.json');

const ZZ = Uint8Array.from([0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]);
// cos[x*8+u] = c(u)/2 · cos((2x+1)uπ/16) : base commune à la DCT directe et inverse
const COS = (() => { const t = new Float64Array(64); for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) t[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) / 2 * Math.cos((2 * x + 1) * u * Math.PI / 16); return t; })();

/* ---------- décodeur ---------- */
function huffTable(bits, vals) { // tables canoniques (maxcode / valptr par longueur)
  const maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) { valptr[l] = k; mincode[l] = code; code += bits[l - 1]; k += bits[l - 1]; maxcode[l] = bits[l - 1] ? code - 1 : -1; code <<= 1; }
  return { maxcode, valptr, mincode, vals };
}

function decode(buf) {
  try { return decodeInner(buf); } catch { return null; }
}
function decodeInner(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const qt = [], dcT = [], acT = []; let fr = null, ri = 0, p = 2;
  while (p < buf.length - 1) {
    if (buf[p] !== 0xff) { p++; continue; }
    const m = buf[p + 1]; p += 2;
    if (m === 0xff) { p--; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0x00) continue;
    if (m === 0xd9) break;
    const len = buf.readUInt16BE(p), end = p + len;
    if (m === 0xdb) {
      let s = p + 2;
      while (s < end) { const pq = buf[s] >> 4, tq = buf[s] & 15, t = new Int32Array(64); s++; for (let i = 0; i < 64; i++) { t[ZZ[i]] = pq ? buf.readUInt16BE(s + 2 * i) : buf[s + i]; } s += pq ? 128 : 64; qt[tq] = t; }
    } else if (m === 0xc0 || m === 0xc1) {
      if (buf[p + 2] !== 8) return null;
      const nc = buf[p + 7]; if (nc !== 1 && nc !== 3) return null;
      fr = { h: buf.readUInt16BE(p + 3), w: buf.readUInt16BE(p + 5), comps: [] };
      for (let i = 0; i < nc; i++) fr.comps.push({ id: buf[p + 8 + 3 * i], hs: buf[p + 9 + 3 * i] >> 4, vs: buf[p + 9 + 3 * i] & 15, tq: buf[p + 10 + 3 * i], pred: 0 });
    } else if ((m >= 0xc2 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return null; // progressif, sans perte, arithmétique : non géré
    else if (m === 0xc4) {
      let s = p + 2;
      while (s < end) { const tc = buf[s] >> 4, th = buf[s] & 15, bits = buf.subarray(s + 1, s + 17); let n = 0; for (const b of bits) n += b; (tc ? acT : dcT)[th] = huffTable(bits, buf.subarray(s + 17, s + 17 + n)); s += 17 + n; }
    } else if (m === 0xdd) ri = buf.readUInt16BE(p + 2);
    else if (m === 0xda) {
      if (!fr || fr.w < 1 || fr.h < 1 || fr.w * fr.h > 4e6) return null;
      const ns = buf[p + 2]; if (ns !== fr.comps.length) return null; // un seul passage entrelacé (cas normal du baseline)
      for (let i = 0; i < ns; i++) { const c = fr.comps.find(x => x.id === buf[p + 3 + 2 * i]); if (!c) return null; c.dc = buf[p + 4 + 2 * i] >> 4; c.ac = buf[p + 4 + 2 * i] & 15; }
      return scan(buf, end, fr, qt, dcT, acT, ri);
    }
    p = end;
  }
  return null;
}

function scan(buf, pos, fr, qt, dcT, acT, ri) {
  const { w, h, comps } = fr, hmax = Math.max(...comps.map(c => c.hs)), vmax = Math.max(...comps.map(c => c.vs));
  const mx = Math.ceil(w / (8 * hmax)), my = Math.ceil(h / (8 * vmax));
  for (const c of comps) { c.bw = mx * c.hs; c.stride = c.bw * 8; c.plane = new Uint8Array(c.stride * my * c.vs * 8); if (!qt[c.tq] || !dcT[c.dc] || !acT[c.ac]) return null; }
  let bitbuf = 0, bitcnt = 0;
  const bit = () => {
    if (bitcnt === 0) {
      if (pos >= buf.length) throw new Error('fin');
      let b = buf[pos++];
      if (b === 0xff) { const n = buf[pos]; if (n === 0) pos++; else throw new Error('marqueur'); }
      bitbuf = b; bitcnt = 8;
    }
    bitcnt--; return (bitbuf >> bitcnt) & 1;
  };
  const rcv = n => { let v = 0; while (n--) v = (v << 1) | bit(); return v; };
  const ext = (v, n) => (v < (1 << (n - 1)) ? v - (1 << n) + 1 : v);
  const huff = t => { let code = 0; for (let l = 1; l <= 16; l++) { code = (code << 1) | bit(); if (t.maxcode[l] >= 0 && code <= t.maxcode[l] && code >= t.mincode[l]) return t.vals[t.valptr[l] + code - t.mincode[l]]; } throw new Error('code'); };
  const blk = new Float64Array(64), tmp = new Float64Array(64);
  const block = (c, bx, by) => {
    blk.fill(0); const q = qt[c.tq], t = huff(dcT[c.dc]);
    c.pred += t ? ext(rcv(t), t) : 0; blk[0] = c.pred * q[0];
    for (let k = 1; k < 64;) { const rs = huff(acT[c.ac]), s = rs & 15, r = rs >> 4; if (!s) { if (r < 15) break; k += 16; continue; } k += r; if (k > 63) break; const i = ZZ[k]; blk[i] = ext(rcv(s), s) * q[i]; k++; }
    // IDCT séparable : lignes puis colonnes
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { let s = 0; for (let u = 0; u < 8; u++) s += COS[x * 8 + u] * blk[y * 8 + u]; tmp[y * 8 + x] = s; }
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) { let s = 0; for (let v = 0; v < 8; v++) s += COS[y * 8 + v] * tmp[v * 8 + x]; const o = (by * 8 + y) * c.stride + bx * 8 + x, val = Math.round(s + 128); c.plane[o] = val < 0 ? 0 : val > 255 ? 255 : val; }
  };
  let n = 0;
  for (let j = 0; j < my; j++) for (let i = 0; i < mx; i++) {
    if (ri && n && n % ri === 0) { // redémarrage : on saute jusqu'au marqueur RSTn
      bitcnt = 0; while (pos < buf.length - 1 && !(buf[pos] === 0xff && buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7)) pos++; pos += 2;
      for (const c of comps) c.pred = 0;
    }
    for (const c of comps) for (let v = 0; v < c.vs; v++) for (let u = 0; u < c.hs; u++) block(c, i * c.hs + u, j * c.vs + v);
    n++;
  }
  const rgb = new Uint8Array(w * h * 3), cl = v => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = c => c.plane[Math.floor(y * c.vs / vmax) * c.stride + Math.floor(x * c.hs / hmax)], o = (y * w + x) * 3;
    if (comps.length === 1) { rgb[o] = rgb[o + 1] = rgb[o + 2] = s(comps[0]); continue; }
    const Y = s(comps[0]), cb = s(comps[1]) - 128, cr = s(comps[2]) - 128;
    rgb[o] = cl(Math.round(Y + 1.402 * cr)); rgb[o + 1] = cl(Math.round(Y - 0.344136 * cb - 0.714136 * cr)); rgb[o + 2] = cl(Math.round(Y + 1.772 * cb));
  }
  return { w, h, rgb };
}

/* ---------- encodeur (baseline, 4:4:4, qualité ~80) ---------- */
const QL = [6, 4, 5, 6, 5, 4, 6, 6, 5, 6, 7, 7, 6, 8, 10, 16, 10, 10, 9, 9, 10, 20, 14, 15, 12, 16, 23, 20, 24, 24, 23, 20, 22, 22, 26, 29, 37, 31, 26, 27, 35, 28, 22, 22, 32, 44, 32, 35, 38, 39, 41, 42, 41, 25, 31, 45, 48, 45, 40, 48, 37, 40, 41, 40]; // ordre zigzag
const QC = [7, 7, 7, 10, 8, 10, 19, 10, 10, 19, 40, 26, 22, 26, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40];
// tables de Huffman standard (annexe K de la norme JPEG)
const H = {
  dcL: { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  dcC: { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  acL: { bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125], vals: [1, 2, 3, 0, 4, 17, 5, 18, 33, 49, 65, 6, 19, 81, 97, 7, 34, 113, 20, 50, 129, 145, 161, 8, 35, 66, 177, 193, 21, 82, 209, 240, 36, 51, 98, 114, 130, 9, 10, 22, 23, 24, 25, 26, 37, 38, 39, 40, 41, 42, 52, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73, 74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105, 106, 115, 116, 117, 118, 119, 120, 121, 122, 131, 132, 133, 134, 135, 136, 137, 138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167, 168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195, 196, 197, 198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250] },
  acC: { bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119], vals: [0, 1, 2, 3, 17, 4, 5, 33, 49, 6, 18, 65, 81, 7, 97, 113, 19, 34, 50, 129, 8, 20, 66, 145, 161, 177, 193, 9, 35, 51, 82, 240, 21, 98, 114, 209, 10, 22, 36, 52, 225, 37, 241, 23, 24, 25, 26, 38, 39, 40, 41, 42, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73, 74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105, 106, 115, 116, 117, 118, 119, 120, 121, 122, 130, 131, 132, 133, 134, 135, 136, 137, 138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167, 168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195, 196, 197, 198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218, 226, 227, 228, 229, 230, 231, 232, 233, 234, 242, 243, 244, 245, 246, 247, 248, 249, 250] },
};
const codes = t => { const code = new Uint16Array(256), size = new Uint8Array(256); let c = 0, k = 0; for (let l = 1; l <= 16; l++) { for (let i = 0; i < t.bits[l - 1]; i++) { code[t.vals[k]] = c; size[t.vals[k]] = l; c++; k++; } c <<= 1; } return { code, size }; };
const E = { dcL: codes(H.dcL), dcC: codes(H.dcC), acL: codes(H.acL), acC: codes(H.acC) };

function encode(w, h, rgb) {
  const out = [];
  const u16 = v => [v >> 8, v & 255];
  const seg = (m, data) => out.push(0xff, m, ...u16(data.length + 2), ...data);
  out.push(0xff, 0xd8);
  seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]); // JFIF
  seg(0xdb, [0, ...QL, 1, ...QC]);
  seg(0xc0, [8, ...u16(h), ...u16(w), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  for (const [tc, t] of [[0x00, H.dcL], [0x10, H.acL], [0x01, H.dcC], [0x11, H.acC]]) seg(0xc4, [tc, ...t.bits, ...t.vals]);
  seg(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  let bb = 0, bc = 0;
  const put = (v, n) => { if (!n) return; bb = (bb << n) | (v & ((1 << n) - 1)); bc += n; while (bc >= 8) { const b = (bb >> (bc - 8)) & 255; out.push(b); if (b === 255) out.push(0); bc -= 8; } bb &= (1 << bc) - 1; };
  const preds = [0, 0, 0], f = new Float64Array(64), tmp = new Float64Array(64), co = new Int32Array(64);
  const bw = Math.ceil(w / 8), bh = Math.ceil(h / 8);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) for (let ci = 0; ci < 3; ci++) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const px = Math.min(w - 1, bx * 8 + x), py = Math.min(h - 1, by * 8 + y), o = (py * w + px) * 3, r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
      f[y * 8 + x] = (ci === 0 ? 0.299 * r + 0.587 * g + 0.114 * b : ci === 1 ? -0.168736 * r - 0.331264 * g + 0.5 * b + 128 : 0.5 * r - 0.418688 * g - 0.081312 * b + 128) - 128;
    }
    for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) { let s = 0; for (let x = 0; x < 8; x++) s += COS[x * 8 + u] * f[y * 8 + x]; tmp[y * 8 + u] = s; }
    const q = ci ? QC : QL;
    for (let k = 0; k < 64; k++) { const i = ZZ[k], u = i & 7, v = i >> 3; let s = 0; for (let y = 0; y < 8; y++) s += COS[y * 8 + v] * tmp[y * 8 + u]; co[k] = Math.round(s / q[k]); }
    const dc = ci ? E.dcC : E.dcL, ac = ci ? E.acC : E.acL, diff = co[0] - preds[ci]; preds[ci] = co[0];
    let a = Math.abs(diff), cat = 0; while (a) { cat++; a >>= 1; }
    put(dc.code[cat], dc.size[cat]); put(diff < 0 ? diff - 1 : diff, cat);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = co[k]; if (!v) { run++; continue; }
      while (run > 15) { put(ac.code[0xf0], ac.size[0xf0]); run -= 16; }
      let m = Math.abs(v), c2 = 0; while (m) { c2++; m >>= 1; }
      const sym = (run << 4) | c2; put(ac.code[sym], ac.size[sym]); put(v < 0 ? v - 1 : v, c2); run = 0;
    }
    if (run) put(ac.code[0], ac.size[0]);
  }
  if (bc) put(0x7f, 8 - bc); // bourrage à 1
  out.push(0xff, 0xd9);
  return Buffer.from(out);
}

/* ---------- dessin du badge ---------- */
const glyphs = new Map();
function glyph(bold, ch) {
  const key = (bold ? 'b' : 'r') + ch; let g = glyphs.get(key);
  if (g === undefined) { const e = (bold ? F.bold : F.regular)[ch]; g = e ? { adv: e[0], w: e[1], h: e[2], ox: e[3], oy: e[4], a: e[5] ? Buffer.from(e[5], 'base64') : null } : null; glyphs.set(key, g); }
  return g;
}
const textW = (s, bold) => { let w = 0; for (const ch of s) { const g = glyph(bold, ch); if (g) w += g.adv; } return w; };
const clip = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function over(img, x, y, r, g, b, a) { // mélange un pixel (a : 0..1)
  if (a <= 0 || x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  const o = (y * img.w + x) * 3, d = img.rgb;
  d[o] = Math.round(d[o] * (1 - a) + r * a); d[o + 1] = Math.round(d[o + 1] * (1 - a) + g * a); d[o + 2] = Math.round(d[o + 2] * (1 - a) + b * a);
}
function pill(img, x, y, w, h, col, alpha) { // rectangle à bouts ronds, bord adouci
  const r = h / 2;
  for (let j = Math.floor(y) - 1; j <= y + h + 1; j++) for (let i = Math.floor(x) - 1; i <= x + w + 1; i++) {
    const dx = Math.max(Math.abs(i + 0.5 - (x + w / 2)) - (w / 2 - r), 0), dy = Math.abs(j + 0.5 - (y + h / 2)), d = Math.hypot(dx, dy) - r;
    over(img, i, j, col[0], col[1], col[2], alpha * Math.min(1, Math.max(0, 0.5 - d)));
  }
}
function disc(img, cx, cy, r, col, alpha) {
  for (let j = Math.floor(cy - r) - 1; j <= cy + r + 1; j++) for (let i = Math.floor(cx - r) - 1; i <= cx + r + 1; i++) over(img, i, j, col[0], col[1], col[2], alpha * Math.min(1, Math.max(0, r - Math.hypot(i + 0.5 - cx, j + 0.5 - cy) + 0.5)));
}
function text(img, s, x, base, bold, col) {
  for (const ch of s) {
    const g = glyph(bold, ch); if (!g) continue;
    if (g.a) for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) { const c = g.a[j * g.w + i]; if (c) over(img, Math.round(x) + g.ox + i, base + g.oy + j, col[0], col[1], col[2], c / 255); }
    x += g.adv;
  }
}
function eye(img, cx, cy) { // œil : contour en amande + pupille, suréchantillonné 4×4
  const lens = (x, y, hw, hh) => Math.abs(x) <= hw && Math.abs(y) <= hh * (1 - (x / hw) * (x / hw));
  for (let j = Math.floor(cy - 8); j <= cy + 8; j++) for (let i = Math.floor(cx - 12); i <= cx + 12; i++) {
    let n = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) { const x = i + (sx + 0.5) / 4 - cx, y = j + (sy + 0.5) / 4 - cy; if ((lens(x, y, 8.5, 5.2) && !lens(x, y, 6.9, 3.6)) || Math.hypot(x, y) <= 2.6) n++; }
    over(img, i, j, 255, 255, 255, n / 16);
  }
}

// vignette JPEG (Buffer) → affiche JPEG avec badge spectateurs (haut gauche) et jeu (bas gauche) ; null si la vignette n'est pas lisible
function poster(jpeg, viewers, game) {
  const img = decode(jpeg); if (!img) return null;
  const { w, h } = img;
  for (let y = 0; y < h; y++) { // dégradés : haut (0,5 → 0) et bas (0 → 0,78)
    const t = y / h, a = t < 110 / 360 ? 0.5 * (1 - t / (110 / 360)) : t > 220 / 360 ? 0.78 * (t - 220 / 360) / (140 / 360) : 0;
    if (a > 0) for (let x = 0; x < w; x++) over(img, x, y, 0, 0, 0, a);
  }
  const M = 10, PH = 30, DARK = [14, 14, 16];
  const nb = String(viewers), nw = textW(nb, true), tx = M + 28, ex = Math.round(tx + nw + 6 + 9), pw = ex + 9 + 10 - M;
  pill(img, M, M, pw, PH, DARK, 0.72);
  disc(img, M + 16, M + PH / 2, 8, [235, 4, 0], 0.28); disc(img, M + 16, M + PH / 2, 4.6, [255, 45, 42], 1);
  text(img, nb, tx, M + PH / 2 + 6, true, [255, 255, 255]);
  eye(img, ex, M + PH / 2);
  let gm = clip(game, 26); while (gm.length > 1 && 26 + textW(gm, true) + 12 > w - 2 * M) gm = clip(gm, gm.length - 1);
  if (gm) {
    const gy = h - M - PH; pill(img, M, gy, 26 + textW(gm, true) + 12, PH, DARK, 0.72);
    disc(img, M + 15, gy + PH / 2, 4.2, [169, 112, 255], 1); text(img, gm, M + 26, gy + PH / 2 + 6, true, [255, 255, 255]);
  }
  return encode(w, h, img.rgb);
}

module.exports = { poster, decode, encode };
