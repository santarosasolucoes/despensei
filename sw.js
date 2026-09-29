// Service worker do Despensei — guarda o app no aparelho pra ele abrir e
// funcionar sem internet (os dados da família ficam no próprio app, ver
// web/app.js e a fila de envio em web/api.js).
//
// Estratégia "rede primeiro": com internet, sempre busca a versão mais nova
// (nunca fica preso numa versão antiga depois de uma publicação); sem
// internet, usa a cópia salva. Chamadas ao banco (Supabase) e à ponte do
// Apps Script NUNCA passam pelo cache.

// v3 (Supabase): mude junto com VERSAO em config.js a cada publicação.
const CACHE_NAME = 'despensei-v3.0.0';
const APP_SHELL = [
  './',
  './index.html',
  './config.js',
  './app.js',
  './api.js',
  './auth.js',
  './barcode.js',
  './vendor/supabase.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

// Bibliotecas externas que a tela precisa pra abrir offline (estilo, fonte,
// leitor de código de barras, botão do Google).
const EXTERNOS_CACHEAVEIS = [
  'cdn.tailwindcss.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'unpkg.com'
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
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const mesmaOrigem = url.origin === self.location.origin;
  const externoPermitido = EXTERNOS_CACHEAVEIS.indexOf(url.hostname) !== -1 ||
    (url.hostname === 'accounts.google.com' && url.pathname === '/gsi/client');
  if (!mesmaOrigem && !externoPermitido) return;

  event.respondWith(
    fetch(event.request).then(function (resposta) {
      if (resposta && (resposta.ok || resposta.type === 'opaque')) {
        const copia = resposta.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copia); });
      }
      return resposta;
    }).catch(function () {
      return caches.match(event.request, { ignoreSearch: mesmaOrigem }).then(function (r) {
        if (r) return r;
        if (mesmaOrigem && event.request.mode === 'navigate') {
          return caches.match('./index.html').then(function (i) { return i || Response.error(); });
        }
        return Response.error();
      });
    })
  );
});
