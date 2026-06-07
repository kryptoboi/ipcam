// AudioCam Receiver Service Worker
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('push', event => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'AudioCam', body: event.data.text() }; }

  event.waitUntil(self.registration.showNotification(data.title || '🔊 AudioCam Alert', {
    body: data.body || 'Wykryto dźwięk!',
    icon: '/receiver/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/receiver' },
    requireInteraction: false
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/receiver'));
});
