// Service worker do Despensei — cache básico do "app shell" pra permitir abrir
// o app (mesmo offline, mostrando a última tela salva) e pra instalação como PWA.
// Chamadas à API (Apps Script) NUNCA são cacheadas: dados de despensa/lista têm
// que vir sempre da rede, senão a família vê estoque desatualizado.

// v2 (2026-08-23): força todo cliente antigo a esvaziar o cache acumulado —
// ver mudança da estratégia de fetch abaixo (era cache-primeiro, virou
// rede-primeiro) pra parar de servir versões velhas do app depois de cada
// publicação nova.
const CACHE_NAME = 'despensei-v2';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './api.js',
  './auth.js',
  './barcode.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(
        nomes.filter(function (n) { return n !== CACHE_NAME; }).map(function (n) { return caches.delete(n); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  const url = new URL(event.request.url);

  // Só intercepta requisições GET de mesma origem (o app shell). Chamadas POST à
  // API do Apps Script (outra origem) passam direto pela rede, sem cache.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Rede primeiro: sempre busca a versão mais nova quando online (e atualiza o
  // cache pra próxima vez offline). Só cai pro cache se a rede falhar de
  // verdade (sem internet) — isso evita ficar preso numa versão antiga do app
  // depois de cada publicação nova no GitHub Pages.
  event.respondWith(
    fetch(event.request).then(function (resposta) {
      if (resposta && resposta.ok) {
        const copia = resposta.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copia); });
      }
      return resposta;
    }).catch(function () {
      return caches.match(event.request);
    })
  );
});
