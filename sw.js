// sw.js — بيخزن كل حاجة (ملفات الأداة + مكتبات القراءة + بيانات اللغة العربية)
// في أول استخدام، عشان بعد كده الأداة تشتغل من غير إنترنت خالص.

const CACHE_NAME = "pdf2excel-cache-v1";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Cache-first لكل الطلبات: لو الملف موجود في الكاش (حتى لو من مكتبة خارجية
// زي pdf.js أو Tesseract.js أو ملف اللغة العربية) يترجع منه على طول من غير نت.
// لو مش موجود، يجيبه من الإنترنت ويحفظه في الكاش عشان المرة الجاية.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
