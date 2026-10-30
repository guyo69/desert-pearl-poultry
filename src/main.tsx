import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// Service worker: offline app shell and phone notifications.
// A new version is picked up on its own: the app checks for one when it
// opens and whenever it comes back to the screen, switches to it, and
// reloads once, so phones never keep running an old version.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { type: 'module' });
      const hadController = Boolean(navigator.serviceWorker.controller);
      const activate = (w: ServiceWorker | null) => { if (w && hadController) w.postMessage({ type: 'SKIP_WAITING' }); };
      activate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed') activate(w); });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController && !reloaded) { reloaded = true; location.reload(); }
      });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    } catch { /* the app still works without offline support */ }
  });
}
