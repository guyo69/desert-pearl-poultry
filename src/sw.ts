/// <reference lib="webworker" />
// Service worker: offline app shell + phone notifications.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
// the app shell is served offline; the API never is (no caching of data or sign-in answers)
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }));

self.addEventListener('message', (e) => { if (e.data?.type === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('push', (event) => {
  let p: { title?: string; body?: string; tag?: string; sev?: string; url?: string } = {};
  try { p = event.data?.json() ?? {}; } catch { p = { title: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(p.title ?? 'Desert Pearl', {
    body: p.body ?? '', tag: p.tag, icon: '/icon-192.png', badge: '/badge-72.png',
    data: { url: p.url ?? '/' }, requireInteraction: p.sev === 'red',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data?.url as string) ?? '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { await (w as WindowClient).focus(); (w as WindowClient).postMessage({ type: 'refresh' }); return; } }
    await self.clients.openWindow(url);
  })());
});
