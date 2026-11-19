'use strict';

const byId = id => document.getElementById(id);
const player = byId('player');
const video = byId('video');
const timeline = byId('timeline');
const position = byId('position');
const quality = byId('quality');
const screenMessage = byId('screen-message');
const message = byId('message');
const action = byId('action');
const audioOnly = byId('audio-only');
const live = byId('live');
const play = byId('play');
const back = byId('back');
const forward = byId('forward');
const mute = byId('mute');
const fullscreen = byId('fullscreen');

let sources = [];
let hls;
let preview = false;
let failed = false;
let loading = false;
let ready = false;
let reconnects = 0;
let stablePlayback;
let wantsPlayback = true;

function showMessage(text, label, onClick) {
  screenMessage.hidden = !text;
  message.textContent = text;
  action.hidden = !label;
  action.textContent = label || '';
  action.onclick = onClick || null;
}

function timeWindow() {
  if (!ready || !video.seekable.length) return null;
  const last = video.seekable.length - 1;
  const start = video.seekable.start(last);
  const latest = video.seekable.end(last) - .25;
  const sync = hls?.liveSyncPosition;
  const edge = Number.isFinite(sync) && sync > start ? Math.min(latest, sync) : latest;
  return Number.isFinite(edge) && edge - start >= 1 ? { start, edge } : null;
}

function delayLabel(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return '−' + minutes + ':' + String(total % 60).padStart(2, '0');
}

function updateControls() {
  const range = timeWindow();
  const delay = range ? Math.max(0, range.edge - video.currentTime) : 0;
  const atEdge = range && delay < 3;

  play.disabled = !ready || failed;
  play.textContent = video.paused ? 'Lecture' : 'Pause';
  live.disabled = !range || atEdge || failed;
  live.classList.toggle('at-edge', Boolean(atEdge) && !failed);
  live.textContent = atEdge && !failed ? 'En direct' : 'Revenir au direct';
  back.disabled = !range || failed || video.currentTime <= range.start + .5;
  forward.disabled = !range || failed || atEdge;
  timeline.disabled = !range || failed;

  if (!range) {
    position.textContent = failed ? 'Direct indisponible' : 'Tampon en cours de chargement';
    return;
  }

  if (!preview) {
    timeline.min = range.start;
    timeline.max = range.edge;
    timeline.value = Math.min(range.edge, Math.max(range.start, video.currentTime));
    timeline.setAttribute('aria-valuetext', atEdge ? 'En direct' : delayLabel(delay) + ' du direct');
    position.textContent = atEdge ? 'Au plus près du direct' : delayLabel(delay) + ' du direct';
  }
}

function seek(target, range = timeWindow()) {
  if (!range) return;
  video.currentTime = Math.max(range.start + .1, Math.min(range.edge, target));
  updateControls();
}

async function startPlayback() {
  wantsPlayback = true;
  try {
    await video.play();
  } catch (error) {
    if (error.name === 'NotAllowedError' && !failed && ready && video.paused) {
      showMessage('Le direct est prêt.', 'Lancer la lecture', startPlayback);
    }
  }
}

function stopPlayback() {
  clearTimeout(stablePlayback);
  video.onloadeddata = null;
  video.onerror = null;
  const previous = hls;
  hls = null;
  previous?.destroy();
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function playbackError(text) {
  if (failed) return;
  failed = true;
  ready = false;
  stopPlayback();
  showMessage(text, 'Réessayer', () => {
    reconnects = 0;
    loadSources();
  });
  updateControls();
}

function selectSource(index, delay = 0) {
  const source = sources[index];
  if (!source) return;
  ready = false;
  preview = false;
  failed = false;
  stopPlayback();
  audioOnly.hidden = !source.audio;
  showMessage('Chargement du direct…');
  updateControls();

  const start = () => {
    if (failed || ready) return;
    ready = true;
    const range = timeWindow();
    if (range && delay >= 3) seek(range.edge - delay, range);
    showMessage('');
    updateControls();
    if (wantsPlayback) startPlayback();
  };
  video.onloadeddata = start;
  const reconnect = () => {
    if (failed || loading) return;
    if (reconnects >= 2) return playbackError('Le direct a été interrompu.');
    const range = timeWindow();
    const label = reconnects === 0 || source.audio ? source.label : 'Auto';
    reconnects += 1;
    loadSources({
      label,
      delay: range ? range.edge - video.currentTime : delay,
      reconnecting: true,
    });
  };
  video.onerror = () => {
    if (video.error) reconnect();
  };

  if (window.Hls?.isSupported()) {
    const engine = new window.Hls({ liveDurationInfinity: true, lowLatencyMode: false, backBufferLength: 90 });
    hls = engine;
    engine.on(window.Hls.Events.ERROR, (_, data) => {
      if (engine === hls && data.fatal) reconnect();
    });
    engine.loadSource(source.url);
    engine.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = source.url;
  } else {
    playbackError('Ce navigateur ne prend pas en charge la lecture du direct.');
  }
}

async function loadSources({
  label = sources[Number(quality.value)]?.label, delay = 0, reconnecting = false,
} = {}) {
  if (loading) return;
  loading = true;
  failed = false;
  ready = false;
  if (reconnecting) stopPlayback();
  quality.disabled = true;
  showMessage(reconnecting ? 'Reconnexion au direct…' : 'Recherche du direct…');
  updateControls();
  try {
    const response = await fetch(player.dataset.sources);
    const data = await response.json();
    if (!response.ok) {
      playbackError(data.error || 'Le direct est temporairement indisponible.');
      return;
    }
    if (data.channel) byId('channel').textContent = data.channel;
    sources = data.sources;
    if (!sources.length) {
      playbackError('Cette chaîne est hors ligne.');
      return;
    }
    quality.replaceChildren(...sources.map((source, index) => new Option(source.label, index)));
    const index = Math.max(0, sources.findIndex(source => source.label === label));
    quality.value = index;
    quality.disabled = sources.length < 2;
    selectSource(index, delay);
  } catch {
    playbackError('Impossible de joindre TwitchIO pour le moment.');
  } finally {
    loading = false;
  }
}

quality.addEventListener('change', () => {
  reconnects = 0;
  const range = timeWindow();
  const delay = range ? range.edge - video.currentTime : 0;
  selectSource(Number(quality.value), delay);
});

play.addEventListener('click', () => {
  if (video.paused) startPlayback();
  else {
    wantsPlayback = false;
    video.pause();
  }
});
back.addEventListener('click', () => seek(video.currentTime - 10));
forward.addEventListener('click', () => seek(video.currentTime + 10));
live.addEventListener('click', () => {
  const range = timeWindow();
  if (!range) return;
  seek(range.edge, range);
  startPlayback();
});

timeline.addEventListener('input', () => {
  preview = true;
  const delay = Number(timeline.max) - timeline.valueAsNumber;
  position.textContent = delay < 3 ? 'En direct' : delayLabel(delay) + ' du direct';
  timeline.setAttribute('aria-valuetext', position.textContent);
});

timeline.addEventListener('change', () => {
  const delay = Number(timeline.max) - timeline.valueAsNumber;
  const range = timeWindow();
  preview = false;
  if (range) seek(range.edge - delay, range);
});

for (const event of ['pointercancel', 'blur']) {
  timeline.addEventListener(event, () => {
    preview = false;
    updateControls();
  });
}

mute.addEventListener('click', () => {
  video.muted = !video.muted;
});
video.addEventListener('volumechange', () => {
  mute.textContent = video.muted ? 'Activer le son' : 'Couper le son';
});
video.addEventListener('playing', () => {
  showMessage('');
  clearTimeout(stablePlayback);
  stablePlayback = setTimeout(() => { reconnects = 0; }, 15000);
});
for (const event of ['pause', 'waiting']) {
  video.addEventListener(event, () => clearTimeout(stablePlayback));
}
for (const event of ['timeupdate', 'durationchange', 'progress', 'seeked', 'play', 'pause']) {
  video.addEventListener(event, updateControls);
}

fullscreen.hidden = !document.fullscreenEnabled;
fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await player.requestFullscreen();
  } catch { /* Le navigateur peut refuser le plein écran. */ }
});
document.addEventListener('fullscreenchange', () => {
  fullscreen.textContent = document.fullscreenElement ? 'Quitter le plein écran' : 'Plein écran';
});

loadSources();
