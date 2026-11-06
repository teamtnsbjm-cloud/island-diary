// 무인도 일기 서비스 워커: 항상 최신 게임을 먼저 받아오고, 인터넷이 끊겼을 때만 저장해 둔 화면을 보여줘요.
const CACHE = "island-diary-v1";
const SHELL = ["/", "/icons/icon-192.png", "/icons/icon-512.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/ws") || url.pathname.startsWith("/api")) return;
  // 네트워크 우선: 업데이트가 바로 반영되도록 하고, 실패하면 저장본을 씀
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (url.pathname === "/" || url.pathname.startsWith("/icons/"))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(url.pathname === "/" ? "/" : req, copy));
        }
        return res;
      })
      .catch(() => caches.match(url.pathname === "/" || req.mode === "navigate" ? "/" : req))
  );
});
