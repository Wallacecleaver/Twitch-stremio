'use strict';

const WINDOW_SECONDS = 5 * 60;
const LIVE_SECONDS = 60;
const LIVE_IDLE_MS = 45 * 1000;
const PLAYLIST_HEADER = /^#(?:EXTM3U$|EXT-X-(?:VERSION|TARGETDURATION|INDEPENDENT-SEGMENTS)(?::|$))/;
const REQUIRES_CONTEXT = /^#EXT-X-(?:KEY|MAP|BYTERANGE):/;

function currentArchive(user) {
  const stream = user?.stream;
  const started = Date.parse(stream?.createdAt);
  if (!Number.isFinite(started)) return null;
  const linked = stream.archiveVideo?.id;
  if (typeof linked === 'string' && /^\d+$/.test(linked)) return linked;
  // Twitch peut publier l’archive dans la liste avant de la rattacher au direct.
  const recent = user.videos?.edges?.[0]?.node;
  const offset = Date.parse(recent?.createdAt) - started;
  return typeof recent?.id === 'string' && /^\d+$/.test(recent.id) && offset >= 0 && offset < 60000 ? recent.id : null;
}

function parseMedia(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U' || !lines.some(line => /^#EXT-X-TARGETDURATION:[1-9]\d*$/.test(line))) return null;
  if (lines.some(line => /^#EXT-X-(?:STREAM-INF|I-FRAMES-ONLY|SKIP)(?::|$)/.test(line))) return null;
  const tags = [], items = [];
  let duration = 0, mediaSequence = 0, discontinuitySequence = 0, at = NaN, block = [];
  for (const line of lines) {
    if (PLAYLIST_HEADER.test(line)) { tags.push(line); continue; }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { mediaSequence = Number(line.split(':')[1]); continue; }
    if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) { discontinuitySequence = Number(line.split(':')[1]); continue; }
    if (/^#EXT-X-(?:PLAYLIST-TYPE|ENDLIST|START|PART(?:-INF)?|PRELOAD-HINT|RENDITION-REPORT|SERVER-CONTROL)(?::|$)/.test(line)) continue;
    if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) at = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
    if (line.startsWith('#')) { block.push(line); continue; }
    if (!/^https:\/\//.test(line) || !Number.isFinite(duration) || duration <= 0) return null;
    block.push(line);
    items.push({ duration, block, at });
    at += duration * 1000;
    duration = 0;
    block = [];
  }
  if (!items.length || ![mediaSequence, discontinuitySequence].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  return { tags, items, mediaSequence, discontinuitySequence, needsContext: lines.some(line => REQUIRES_CONTEXT.test(line)) };
}

const total = items => items.reduce((sum, item) => sum + item.duration, 0);
const endTime = item => item.at + item.duration * 1000;
function renderReplay({ tags, items, mediaSequence, discontinuitySequence, needsContext }, windowSeconds) {
  let start = 0, seconds = total(items);
  // Garder le contexte entier si un segment dépend d’une clé, d’une initialisation ou d’une plage précédente.
  if (!needsContext) {
    while (start < items.length - 1 && seconds - items[start].duration >= windowSeconds) {
      const removed = items[start++];
      discontinuitySequence += removed.block.filter(line => line === '#EXT-X-DISCONTINUITY').length;
      seconds -= removed.duration;
    }
  }
  return [...tags, '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:' + (mediaSequence + start),
    '#EXT-X-DISCONTINUITY-SEQUENCE:' + discontinuitySequence, '#EXT-X-START:TIME-OFFSET=-' + Math.min(45, seconds).toFixed(3),
    ...items.slice(start).flatMap(item => item.block), '#EXT-X-ENDLIST', ''].join('\n');
}

function replayPlaylist(text, windowSeconds = WINDOW_SECONDS) {
  const media = parseMedia(text);
  return media && renderReplay(media, windowSeconds);
}

// Les morceaux restent chez Twitch. On retient seulement une minute de références au direct regardé.
function createLiveBuffer() {
  const tracks = new Map();
  function track(scope, url, text, now = Date.now()) {
    const media = parseMedia(text);
    if (!media || media.needsContext || media.items.some(item => !Number.isFinite(item.at))) return;
    for (let i = 1; i < media.items.length; i++) {
      if (Math.abs(endTime(media.items[i - 1]) - media.items[i].at) > 120) return;
    }
    const key = scope + '|' + url;
    const previous = tracks.get(key);
    if (previous?.items.at(-1).at > media.items.at(-1).at) return; // réponse amont en retard
    const first = media.items[0].at;
    const prefix = previous?.items.filter(item => item.at < first && endTime(item) <= first + 120) || [];
    if (prefix.length && Math.abs(endTime(prefix.at(-1)) - first) <= 120) media.items = prefix.concat(media.items);
    const cutoff = endTime(media.items.at(-1)) - LIVE_SECONDS * 1000;
    media.items = media.items.filter(item => endTime(item) > cutoff).slice(-120);
    // Le tampon est servi comme un extrait indépendant, sans numéros de séquence de la liste mouvante.
    media.mediaSequence = media.discontinuitySequence = 0;
    tracks.delete(key);
    if (tracks.size >= 180) tracks.delete(tracks.keys().next().value);
    tracks.set(key, { ...media, scope, now });
  }
  function snapshot(scope, now = Date.now()) {
    const available = [...tracks.values()].filter(track => track.scope === scope && now - track.now <= LIVE_IDLE_MS);
    const best = available.sort((a, b) => total(b.items) - total(a.items) || b.now - a.now)[0];
    return best ? renderReplay(best, LIVE_SECONDS) : null;
  }
  return { track, snapshot };
}

module.exports = { currentArchive, replayPlaylist, createLiveBuffer, LIVE_SECONDS };
