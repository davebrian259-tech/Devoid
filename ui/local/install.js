// Installing the web wallet on a device, and keeping the installed copy up to date.
//
// Installed, Devoid opens from the home screen in its own window, with no browser chrome and no
// address bar, and it opens without a connection: the service worker (../sw.js) holds the app's
// files, and the wallet itself is already in this browser. Nothing is sent anywhere to install it;
// there is no account and no store.
import { WEB } from '../lib.js';

let deferred = null;              // Chromium hands us the install prompt to use when we like
let waitingVersion = false;       // a new version has downloaded and is ready to take over
const watchers = new Set();
const announce = () => { for (const cb of watchers) cb(); };

if (WEB && typeof addEventListener === 'function') {
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; announce(); });
  addEventListener('appinstalled', () => { deferred = null; announce(); });
}

/** True when Devoid is running as an installed app rather than a browser tab. */
export const standalone = () => Boolean(matchMedia('(display-mode: standalone)').matches
  || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone);

/** True when a new version has downloaded and is waiting for the app to let the old one go. */
export const updateWaiting = () => waitingVersion;

/** True when this browser has offered us its install prompt. */
export const canPrompt = () => Boolean(deferred);

export function onInstallChange(cb) { watchers.add(cb); return () => watchers.delete(cb); }

/** Shows the browser's install prompt. Returns 'accepted', 'dismissed' or 'unavailable'. */
export async function promptInstall() {
  if (!deferred) return 'unavailable';
  const prompt = deferred; deferred = null; announce();
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome;
}

/** What to do by hand, in the browsers that offer no prompt of their own. */
export function installSteps() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    return 'In Safari, press Share, then “Add to Home Screen”.';
  }
  if (/Firefox/.test(ua)) return 'In Firefox, open the menu and choose “Install” on Android, or “Add to Home screen”.';
  return 'In your browser’s menu, choose “Install Devoid” or “Add to Home screen”.';
}

/**
 * Registers the service worker, and calls back once a new version has downloaded and is waiting.
 * A new version only takes over when the old one lets go, so every file swaps at the same moment
 * and the app never runs half of one build and half of another.
 */
export function keepFresh(onUpdate) {
  if (!WEB || !('serviceWorker' in navigator)) return;
  const fresh = Boolean(navigator.serviceWorker.controller); // false on the very first visit
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!fresh || reloading) return;  // the first worker claiming this page is not an update
    reloading = true; location.reload();
  });
  addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
      const waiting = () => {
        if (!reg.waiting || !navigator.serviceWorker.controller || waitingVersion) return;
        waitingVersion = true; announce(); onUpdate?.();
      };
      const watch = (worker) => worker?.addEventListener('statechange', waiting);
      waiting(); watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
    } catch { /* no service worker (private windows block it): the wallet runs, it just needs the network to open */ }
  }, { once: true });
}

/** Lets the waiting version take over; the page reloads itself when it does. */
export async function applyUpdate() {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg?.waiting) reg.waiting.postMessage('devoid-update');
  else location.reload();
}
