'use strict';

const LIVE_CATALOG = 'twitch-alerts-live';
const SCHEDULE_CATALOG = 'twitch-alerts-calendar';
const LIVE_PREFIX = 'twitchalert:';
const SCHEDULE_PREFIX = 'twitchschedule:';
const UPCOMING_MS = 14 * 86400000;

function scheduleId(login, event) {
  return SCHEDULE_PREFIX + login + ':' + Date.parse(event.startAt);
}

function isUpcoming(event, now) {
  const start = Date.parse(event.startAt);
  return start >= now && start < now + UPCOMING_MS;
}

function scheduleMeta(login, event, info, timeZone, logo) {
  const date = new Date(event.startAt);
  const short = new Intl.DateTimeFormat('fr-FR', {
    timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
  const when = new Intl.DateTimeFormat('fr-FR', {
    timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(date);
  const name = info?.name || login;
  return {
    id: scheduleId(login, event),
    type: 'tv',
    name: name + ' · ' + short,
    poster: info?.avatar || logo,
    posterShape: 'square',
    background: info?.banner || undefined,
    description: [event.title || 'Live Twitch prévu', name + ' · ' + when, event.game].filter(Boolean).join('\n\n'),
    releaseInfo: short,
    links: [{ name: 'Voir le planning Twitch', category: 'Twitch', url: 'https://www.twitch.tv/' + login + '/schedule' }],
  };
}

module.exports = { LIVE_CATALOG, SCHEDULE_CATALOG, LIVE_PREFIX, SCHEDULE_PREFIX, scheduleId, isUpcoming, scheduleMeta };
