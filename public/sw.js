// StuCal service worker: shows reminder notifications and opens StuCal when one is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  // iPhones turn notifications off for apps that receive a push without showing one, so always show something.
  const title = data.title || 'StuCal';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'You have an assignment coming up.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if ('focus' in w) { await w.focus(); if ('navigate' in w) w.navigate(url); return; }
    }
    await self.clients.openWindow(url);
  })());
});
