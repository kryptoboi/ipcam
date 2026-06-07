// AudioCam Service Worker – obsługa powiadomień push
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('push', event => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'AudioCam', body: event.data.text() }; }

  const options = {
    body: data.body || 'Wykryto dźwięk!',
    icon: '/camera/icon-192.png',
    badge: '/camera/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/', timestamp: data.timestamp },
    actions: [
      { action: 'view', title: '▶ Obejrzyj klip' },
      { action: 'dismiss', title: '✕ Odrzuć' }
    ],
    requireInteraction: false,
    silent: false
  };

  event.waitUntil(self.registration.showNotification(data.title || '🔊 AudioCam Alert', options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'view' && event.notification.data.url) {
    event.waitUntil(clients.openWindow(event.notification.data.url));
  } else if (event.action !== 'dismiss') {
    event.waitUntil(clients.openWindow('/receiver'));
  }
});
