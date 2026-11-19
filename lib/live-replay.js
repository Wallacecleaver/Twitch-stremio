'use strict';

const WINDOW_SECONDS = 5 * 60;
const LIVE_SECONDS = 60;
const LIVE_IDLE_MS = 45 * 1000;
const PLAYLIST_HEADER = /^#(?:EXTM3U$|EXT-X-(?:VERSION|TARGETDURATION|INDEPENDENT-SEGMENTS)(?::|$))/;
const REQUIRES_CONTEXT = /^#EXT-X-(?:KEY|MAP|BYTERANGE):/;
const START_TAG = '#EXT-X-START:';

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
  let duration = 0, mediaSequence = 0, discontinuitySequence, at = NaN, block = [], startTag = '', ended = false;
  for (const line of lines) {
    if (PLAYLIST_HEADER.test(line)) { tags.push(line); continue; }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { mediaSequence = Number(line.split(':')[1]); continue; }
    if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) { discontinuitySequence = Number(line.split(':')[1]); continue; }
    if (line.startsWith(START_TAG)) { startTag = line; continue; }
    if (line === '#EXT-X-ENDLIST') { ended = true; continue; }
    if (/^#EXT-X-(?:PLAYLIST-TYPE|PART(?:-INF)?|PRELOAD-HINT|RENDITION-REPORT|SERVER-CONTROL)(?::|$)/.test(line)) continue;
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
  if (!items.length || ![mediaSequence, discontinuitySequence ?? 0].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  return { tags, items, mediaSequence, discontinuitySequence, startTag, ended, needsContext: lines.some(line => REQUIRES_CONTEXT.test(line)) };
}

const total = items => items.reduce((sum, item) => sum + item.duration, 0);
const endTime = item => item.at + item.duration * 1000;
const breaksIn = item => item.block.filter(line => line === '#EXT-X-DISCONTINUITY').length;
function renderReplay({ tags, items, mediaSequence, discontinuitySequence = 0, needsContext }, windowSeconds) {
  let start = 0, seconds = total(items);
  // Garder le contexte entier si un segment dépend d’une clé, d’une initialisation ou d’une plage précédente.
  if (!needsContext) {
    while (start < items.length - 1 && seconds - items[start].duration >= windowSeconds) {
      const removed = items[start++];
      discontinuitySequence += breaksIn(removed);
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

function renderLive({ tags, items, startTag }) {
  const head = items[0];
  return [...tags, '#EXT-X-MEDIA-SEQUENCE:' + head.sequence, '#EXT-X-DISCONTINUITY-SEQUENCE:' + head.discontinuity,
    ...(startTag ? [startTag] : []), ...items.flatMap(item => item.block), ''].join('\n');
}

// Seules les références à des morceaux récents sont gardées. Le lecteur les télécharge depuis Twitch ou son relais configuré.
function createLiveBuffer() {
  const tracks = new Map();
  function playlist(scope, url, text, now = Date.now()) {
    const media = parseMedia(text);
    if (!media || media.ended || media.needsContext || media.items.some(item => !Number.isFinite(item.at))) return text;
    for (let i = 1; i < media.items.length; i++) {
      if (Math.abs(endTime(media.items[i - 1]) - media.items[i].at) > 120) return text;
    }
    const key = scope + '|' + url;
    const previous = tracks.get(key);
    const fresh = previous && now - previous.now <= LIVE_IDLE_MS ? previous : null;
    if (fresh?.items.at(-1).at > media.items.at(-1).at) return fresh.text; // réponse amont en retard
    const [head] = media.items;
    const sequence = media.mediaSequence;
    const overlap = fresh?.items.find(item => item.sequence === sequence && Math.abs(item.at - head.at) <= 120);
    const prefix = fresh?.items.filter(item => item.sequence < sequence && endTime(item) <= head.at + 120) || [];
    const last = prefix.at(-1);
    const contiguous = last?.sequence === sequence - 1 && Math.abs(endTime(last) - head.at) <= 120;
    const preceding = contiguous ? last.discontinuity + breaksIn(last) : undefined;
    const adjacent = contiguous && (media.discontinuitySequence === undefined || preceding === media.discontinuitySequence);
    // Certains flux Twitch omettent la séquence de discontinuité dans leurs listes glissantes.
    let discontinuity = media.discontinuitySequence ?? overlap?.discontinuity ?? preceding ?? 0;
    for (const [index, item] of media.items.entries()) {
      item.sequence = sequence + index;
      item.discontinuity = discontinuity;
      discontinuity += breaksIn(item);
    }
    const items = adjacent ? prefix.concat(media.items) : media.items;
    const cutoff = endTime(media.items.at(-1)) - LIVE_SECONDS * 1000;
    const retained = items.filter(item => endTime(item) > cutoff).slice(-120);
    // La liste live d’origine reste prioritaire si Twitch offre déjà une fenêtre plus large.
    const extend = retained[0].sequence < sequence;
    const live = extend || (media.discontinuitySequence ?? 0) !== head.discontinuity
      ? renderLive({ ...media, items: extend ? retained : media.items }) : text;
    tracks.delete(key);
    if (tracks.size >= 180) tracks.delete(tracks.keys().next().value);
    tracks.set(key, { ...media, items: retained, scope, now, text: live });
    return live;
  }
  function snapshot(scope, now = Date.now()) {
    const available = [...tracks.values()].filter(track => track.scope === scope && now - track.now <= LIVE_IDLE_MS);
    const best = available.sort((a, b) => total(b.items) - total(a.items) || b.now - a.now)[0];
    return best ? renderReplay({ ...best, mediaSequence: best.items[0].sequence, discontinuitySequence: best.items[0].discontinuity }, LIVE_SECONDS) : null;
  }
  return { playlist, snapshot };
}

module.exports = { currentArchive, replayPlaylist, createLiveBuffer, LIVE_SECONDS };
