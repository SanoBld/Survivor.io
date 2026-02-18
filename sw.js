const CACHE = 'survivor-beta-v1';
const ASSETS = ['/', '/index.html', '/style.css', '/script.js', '/manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
    const url = e.request.url;
    if (url.includes('unpkg.com') || url.includes('peerjs')) {
        e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
        return;
    }
    e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
            const clone = resp.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
    })));
});
