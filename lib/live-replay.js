'use strict';

const WINDOW_SECONDS = 5 * 60;
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

function replayPlaylist(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U' || !lines.some(line => /^#EXT-X-TARGETDURATION:[1-9]\d*$/.test(line))) return null;
  if (lines.some(line => /^#EXT-X-(?:STREAM-INF|I-FRAMES-ONLY|SKIP)(?::|$)/.test(line))) return null;
  const tags = [], items = [];
  let duration = 0, mediaSequence = 0, discontinuitySequence = 0, seconds = 0, block = [];
  for (const line of lines) {
    if (PLAYLIST_HEADER.test(line)) { tags.push(line); continue; }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { mediaSequence = Number(line.split(':')[1]); continue; }
    if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) { discontinuitySequence = Number(line.split(':')[1]); continue; }
    if (/^#EXT-X-(?:PLAYLIST-TYPE|ENDLIST|START|PART(?:-INF)?|PRELOAD-HINT|RENDITION-REPORT|SERVER-CONTROL)(?::|$)/.test(line)) continue;
    if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    if (line.startsWith('#')) { block.push(line); continue; }
    if (!/^https:\/\//.test(line) || !Number.isFinite(duration) || duration <= 0) return null;
    block.push(line);
    items.push({ duration, block });
    seconds += duration;
    duration = 0;
    block = [];
  }
  if (!items.length || ![mediaSequence, discontinuitySequence].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  let start = 0;
  // Garder le contexte entier si un segment dépend d’une clé, d’une initialisation ou d’une plage précédente.
  if (!lines.some(line => REQUIRES_CONTEXT.test(line))) {
    while (start < items.length - 1 && seconds - items[start].duration >= WINDOW_SECONDS) {
      const removed = items[start++];
      discontinuitySequence += removed.block.filter(line => line === '#EXT-X-DISCONTINUITY').length;
      seconds -= removed.duration;
    }
  }
  return [...tags, '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:' + (mediaSequence + start),
    '#EXT-X-DISCONTINUITY-SEQUENCE:' + discontinuitySequence, '#EXT-X-START:TIME-OFFSET=-' + Math.min(45, seconds).toFixed(3),
    ...items.slice(start).flatMap(item => item.block), '#EXT-X-ENDLIST', ''].join('\n');
}

module.exports = { currentArchive, replayPlaylist };
