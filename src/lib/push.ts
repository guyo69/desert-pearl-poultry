// Phone notifications through the app's service worker (Web Push).
import { callFn, rpc } from './api';

const b64ToBytes = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function pushStatus(): Promise<'unsupported' | 'denied' | 'on' | 'off'> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('This phone or browser cannot receive notifications. On iPhone, first add the app to the Home Screen.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them in the browser or phone settings.');
  const reg = await navigator.serviceWorker.ready;
  const { public_key } = await callFn<{ public_key: string }>('push-notify', undefined, 'GET');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(public_key) });
  const j = sub.toJSON();
  await rpc('rpc_save_push', { p_endpoint: sub.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth });
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await sub.unsubscribe();
}
