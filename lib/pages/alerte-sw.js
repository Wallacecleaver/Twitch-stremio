'use strict';

self.addEventListener('push', event => {
  let message = {};
  try { message = event.data?.json() || {}; } catch { /* notification générique */ }
  const login = /^[a-z0-9_]{3,25}$/.test(message.login || '') ? message.login : '';
  event.waitUntil(self.registration.showNotification(message.title || 'Alerte TwitchIO', {
    body: message.body || '',
    icon: '/logo.png',
    tag: login ? login + ':' + message.id : 'twitchio-test',
    data: { login },
  }));
});

self.addEventListener('notificationclick', event => {
  const login = event.notification.data?.login;
  event.notification.close();
  const url = /^[a-z0-9_]{3,25}$/.test(login || '') ? 'https://www.twitch.tv/' + login : new URL('/alerte', self.location.origin).href;
  event.waitUntil(clients.openWindow(url));
});
