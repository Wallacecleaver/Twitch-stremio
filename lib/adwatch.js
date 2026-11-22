'use strict';
// Veille des pubs : « joue » quelques chaînes en direct côté serveur (sans vidéo : il suit la liste de lecture comme un lecteur)
// et prévient le dashboard dès que le flux SERVI AUX UTILISATEURS contient une pub.
//   - flux servi   = ce que l'addon donnerait (relais sans pub → lecteur de secours → flux officiel)
//   - flux officiel = ce que Twitch sert sans protection ; sert à savoir si une pub est en cours sur la chaîne
// États d'une chaîne : propre · bloquée (pub chez Twitch, pas chez nous) · SERVIE (pub dans notre flux : alerte) · hors ligne · erreur
const store = require('./store');

const K_CFG = 'adwatch', K_ALERTS = 'adwatch:alerts';
const MAX_CH = 5, MAX_ALERTS = 100, LOGIN = /^[a-z0-9_]{3,25}$/;
const EVERY = [15, 30, 60, 120];
const DEF = { on: false, channels: [], every: 30 };

// nom du marqueur trouvé : s'affiche dans l'alerte (mêmes marqueurs que AD_RE de index.js)
const MARKERS = [
  ['stitched-ad', /stitched-ad|twitch-stitched/i],
  ['X-TV-TWITCH-AD', /X-TV-TWITCH-AD/i],
  ['SCTE35 / CUE-OUT', /#EXT-X-SCTE35|CUE-OUT/i],
  ['segment « Amazon »', /#EXTINF:[\d.]+,\s*Amazon/i],
  ['segment /adsquared/', /^https?:\/\/\S*(?:\/adsquared\/|\/_404\/)/im],
];
const kindOf = text => { const m = MARKERS.find(([, re]) => re.test(text)); return m ? m[0] : null; };

module.exports = function createAdwatch({ pick, official, variantsOf, absolutize, UA }) {
  let cfg = { ...DEF }, alerts = [], timer = null, busy = false;
  const live = new Map(); // chaîne → dernier état connu
  try { cfg = { ...DEF, ...JSON.parse(store.peek(K_CFG) || '{}') }; } catch { /* réglages par défaut */ }
  try { alerts = JSON.parse(store.peek(K_ALERTS) || '[]'); } catch { alerts = []; }
  if (!Array.isArray(alerts)) alerts = [];
  const clean = c => ({
    on: !!c.on,
    channels: [...new Set((Array.isArray(c.channels) ? c.channels : []).map(x => String(x).toLowerCase().replace(/^@/, '').trim()).filter(x => LOGIN.test(x)))].slice(0, MAX_CH),
    every: EVERY.includes(Number(c.every)) ? Number(c.every) : DEF.every,
  });
  cfg = clean(cfg);
  const saveAlerts = () => store.setKey(K_ALERTS, JSON.stringify(alerts.slice(0, MAX_ALERTS))).catch(() => {});

  // la liste de segments de la plus basse qualité vidéo contient-elle une pub ? (la pub est collée dans toutes les qualités)
  async function mediaAd(r) {
    const v = variantsOf(absolutize(r.text, r.url)).filter(x => !x.audio).pop();
    if (!v) return { ad: false, kind: null };
    const t = await fetch(v.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) }).then(x => x.text());
    const kind = kindOf(t);
    return { ad: !!kind, kind };
  }

  async function scan(login) {
    const t0 = Date.now(), prev = live.get(login) || {};
    let st;
    try {
      const off = await official(login);
      if (off.offline) st = { status: 'offline' };
      else {
        const [o, served] = await Promise.all([mediaAd(off), pick(login)]);
        const s = served ? await mediaAd(served) : o; // aucune source de secours : les utilisateurs reçoivent le flux officiel
        const source = served ? served.name : 'Flux officiel';
        st = s.ad ? { status: 'served', source, kind: s.kind, official: o.ad }
          : { status: o.ad ? 'blocked' : 'clean', source, kind: o.kind };
      }
    } catch (e) { st = { status: 'error', error: String(e && e.message || e).slice(0, 120) }; }
    st = { login, ms: Date.now() - t0, t: Date.now(), ...st };
    // suivi de la pub servie : alerte au début, durée à la fin
    if (st.status === 'served') {
      st.since = prev.status === 'served' && prev.since ? prev.since : Date.now();
      if (prev.status !== 'served') {
        alerts.unshift({ id: Date.now().toString(36) + login, t: Date.now(), login, source: st.source, kind: st.kind, official: !!st.official, read: false });
        if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;
        store.log({ k: 'pub', lvl: 'WARN', ch: login, action: 'pub servie aux utilisateurs', source: st.source, marqueur: st.kind });
        await saveAlerts();
      }
    } else if (prev.status === 'served' && prev.since) {
      const a = alerts.find(x => x.login === login && !x.end);
      if (a && st.status !== 'error') { a.end = Date.now(); a.secs = Math.round((a.end - a.t) / 1000); await saveAlerts(); }
    }
    live.set(login, st);
    return st;
  }

  async function round() {
    if (busy) return;
    busy = true;
    try {
      const list = cfg.channels;
      for (const k of [...live.keys()]) if (!list.includes(k)) live.delete(k);
      await Promise.all(list.map(scan));
    } finally { busy = false; }
  }
  function restart() {
    clearInterval(timer); timer = null;
    if (!cfg.on || !cfg.channels.length) return;
    round().catch(() => {});
    timer = setInterval(() => round().catch(() => {}), cfg.every * 1000);
    if (timer.unref) timer.unref();
  }

  const unread = () => alerts.filter(a => !a.read).length;
  const active = () => [...live.values()].filter(s => s.status === 'served').map(s => s.login);
  return {
    start: restart,
    summary: () => ({ on: cfg.on && cfg.channels.length > 0, unread: unread(), active: active() }), // pour le badge de l'onglet
    view: () => ({
      cfg, running: !!timer, busy, now: Date.now(), max: MAX_CH, every: EVERY,
      channels: cfg.channels.map(c => live.get(c) || { login: c, status: 'wait' }),
      alerts: alerts.slice(0, 50), unread: unread(),
    }),
    async act(b) {
      if (b.action === 'save') {
        const next = clean({ on: b.on, channels: b.channels, every: b.every });
        if (b.on && !next.channels.length) return { ok: false, error: 'Ajoute au moins une chaîne à surveiller.' };
        cfg = next;
        await store.setKey(K_CFG, JSON.stringify(cfg));
        restart();
        return { ok: true, ...this.view() };
      }
      if (b.action === 'scan') {
        if (!cfg.channels.length) return { ok: false, error: 'Ajoute au moins une chaîne à surveiller.' };
        await round();
        return { ok: true, ...this.view() };
      }
      if (b.action === 'ack') { alerts.forEach(a => { a.read = true; }); await saveAlerts(); return { ok: true, ...this.view() }; }
      if (b.action === 'clear') { alerts = []; await saveAlerts(); return { ok: true, ...this.view() }; }
      return { ok: false, error: 'Action inconnue.' };
    },
  };
};
module.exports.kindOf = kindOf;
