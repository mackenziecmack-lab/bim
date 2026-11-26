// Service worker do BIM: recebe as notificações push mesmo com o site fechado.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || 'BIM', {
    body: d.body || 'Você tem uma mensagem nova',
    icon: '/favicon.png',
    badge: '/favicon.png',
    tag: d.tag || 'bim',
    renotify: true
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista => {
    for (const c of lista) if ('focus' in c) return c.focus();
    return self.clients.openWindow('/');
  }));
});
