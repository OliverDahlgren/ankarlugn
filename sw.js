'use strict';

// Service worker: gör att sidan fungerar utan täckning ute i skärgården.
// - Själva sidan hämtas från nätet först (sparad kopia utan täckning). Övriga filer och data visas
//   direkt från det sparade och uppdateras i bakgrunden; de har versionsnummer i adressen.
// - SMHI:s prognos hämtas från nätet först; en sparad kopia används bara utan täckning.
//   Sidan visar själv hur gammal prognosen är (SMHI:s createdTime).
// - Kartbitar sparas när de visas (högst TILE_LIMIT); ingen förhandsnedladdning av områden.
// Höj VERSION när filerna i PRECACHE ändras; tests/test_sw.py kontrollerar att listan stämmer.
const VERSION = 'v3';
const SHELL = `ankarlugn-shell-${VERSION}`;
const FORECASTS = 'ankarlugn-forecasts';
const TILES = 'ankarlugn-tiles';
const LIBS = 'ankarlugn-libs';
const TILE_LIMIT = 800;
const FORECAST_TIMEOUT_MS = 8000;
const PAGE_TIMEOUT_MS = 4000;

const PRECACHE = [
  './',
  'index.html',
  'method.html',
  'style.css?v=21',
  'app.js?v=21',
  'validation.js?v=3',
  'data/profiles.json',
  'data/calibration.json',
  'data/validation.json',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];
const LIB_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(PRECACHE);
    const libs = await caches.open(LIBS);
    await Promise.all(LIB_URLS.map(u => libs.add(new Request(u, { mode: 'cors' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('ankarlugn-shell-') && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.host === 'opendata-download-metfcst.smhi.se') event.respondWith(networkFirst(req));
  else if (url.host === 'tile.openstreetmap.org' || url.host === 'tiles.openseamap.org') event.respondWith(tile(req));
  else if (url.host === 'cdnjs.cloudflare.com' || url.host.startsWith('fonts.g')) event.respondWith(cacheFirst(req, LIBS));
  else if (req.mode === 'navigate') event.respondWith(page(req));
  else if (url.origin === self.location.origin) event.respondWith(staleWhileRevalidate(req));
});

// Själva sidan: från nätet först så att uppdateringar syns direkt; sparad kopia utan täckning.
async function page(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PAGE_TIMEOUT_MS)),
    ]);
    if (res.ok) cache.put(new URL(req.url).pathname.endsWith('method.html') ? 'method.html' : './', res.clone());
    return res;
  } catch (e) {
    const name = new URL(req.url).pathname.endsWith('method.html') ? 'method.html' : './';
    return (await cache.match(name)) || (await cache.match(req, { ignoreSearch: true })) || Response.error();
  }
}

async function networkFirst(req) {
  const cache = await caches.open(FORECASTS);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), FORECAST_TIMEOUT_MS)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw e;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
  const update = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await update) || Response.error();
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') {
      await cache.put(req, res.clone());
      trim(cache);
    }
    return res;
  } catch (e) {
    return new Response('', { status: 504 });
  }
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - TILE_LIMIT; i++) await cache.delete(keys[i]);
}
