/*
 * PINIT Scan service worker. It does NOT cache anything and does not change a single response: every request goes
 * straight to the network exactly as before. It exists because some browsers only offer "Add to home screen" /
 * "Install app" for a page that has a service worker with a fetch handler.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // Intentionally empty: the browser handles the request normally.
});
