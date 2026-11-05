// 무인도 일기 – 게임 페이지와 실시간 서버를 한 번에 띄우는 작은 Node.js 서버
// - http://주소/      → public/index.html (게임)
// - ws://주소/ws      → 실시간 접속 (섬마다 최대 CAP명)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const CAP = Number(process.env.ISLAND_CAP) || 100; // 섬 하나당 최대 인원
const MAX_ISLANDS = Number(process.env.MAX_ISLANDS) || 20; // 섬(채널) 개수
const PUB = path.join(__dirname, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".woff2": "font/woff2",
};

/* ---------- 정적 파일 ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") { res.end("ok"); return; }
  if (url.pathname === "/api/islands") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ cap: CAP, islands: counts(), total: wss.clients.size }));
    return;
  }
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end(); return; }
  if (p.endsWith("/")) p += "index.html";
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("페이지를 찾을 수 없어요"); return; }
    const ext = path.extname(file);
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(data);
  });
});

/* ---------- 실시간 ---------- */
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });
const islands = new Map(); // 섬 번호 → Map(id → client)
for (let n = 1; n <= MAX_ISLANDS; n++) islands.set(n, new Map());
let nextId = 1;

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function counts() { const c = {}; for (const [n, m] of islands) if (m.size) c[n] = m.size; return c; }
function toIsland(n, msg, except) {
  const s = JSON.stringify(msg);
  for (const o of islands.get(n).values()) if (o !== except && o.ws.readyState === 1) o.ws.send(s);
}
let countsDirty = true;
setInterval(() => {
  if (!countsDirty) return; countsDirty = false;
  const s = JSON.stringify({ t: "counts", c: counts(), cap: CAP });
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(s);
}, 2000);

// 다른 사람이 보낸 값은 믿지 않고 모양과 길이를 정리해서 전달
const INVIS = /[\u0000-\u001f\u007f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
function str(v, len) { return typeof v === "string" ? v.replace(INVIS, "").slice(0, len) : ""; }
function num(v, lim) { return typeof v === "number" && Number.isFinite(v) ? Math.max(-lim, Math.min(lim, v)) : 0; }
function clean(p) {
  if (!p || typeof p !== "object") return null;
  return {
    n: str(p.n, 12).trim() || "누군가", c: num(p.c, 99) | 0, h: num(p.h, 99) | 0,
    x: num(p.x, 200), z: num(p.z, 200), r: num(p.r, 10), a: str(p.a, 8),
    e: p.e ? str(p.e, 8) : null, et: num(p.et, 1e15), s: str(p.s, 40), st: num(p.st, 1e15), f: num(p.f, 1e15),
    j: num(p.j, 6), // 점프하거나 의자에 앉아 땅에서 떠 있는 높이
    ...(typeof p.bx === "number" && typeof p.bz === "number" ? { bx: num(p.bx, 300), bz: num(p.bz, 300) } : {}), // 낚시찌 위치
  };
}

function leave(cl) {
  if (!cl.island) return;
  islands.get(cl.island).delete(cl.id);
  toIsland(cl.island, { t: "left", id: cl.id });
  cl.island = 0; countsDirty = true;
}

wss.on("connection", (ws) => {
  const cl = { id: (nextId++).toString(36), ws, island: 0, p: null, tokens: 30, last: Date.now(), alive: true };
  ws.cl = cl;
  ws.on("pong", () => { cl.alive = true; });
  send(ws, { t: "counts", c: counts(), cap: CAP });

  ws.on("message", (raw) => {
    // 초당 약 20개까지만 받기 (도배 방지)
    const now = Date.now();
    cl.tokens = Math.min(30, cl.tokens + (now - cl.last) / 50); cl.last = now;
    if (cl.tokens < 1) return; cl.tokens--;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;

    if (m.t === "join") {
      let want = Number.isInteger(m.ch) && m.ch >= 1 && m.ch <= MAX_ISLANDS ? m.ch : 0;
      if (want && want === cl.island) return;
      if (!want && cl.island) return; // 이미 섬에 있으면 자동 배정은 건너뛰기
      if (want && islands.get(want).size >= CAP) {
        send(ws, { t: "full", ch: want });
        if (cl.island) return; // 이미 다른 섬에 있으면 그대로 있기
        want = 0;
      }
      if (!want) for (const [n, room] of islands) if (room.size < CAP) { want = n; break; }
      if (!want) { send(ws, { t: "full" }); return; }
      leave(cl);
      const room = islands.get(want);
      cl.island = want;
      send(ws, { t: "joined", ch: want, id: cl.id, peers: [...room.values()].filter((o) => o.p).map((o) => ({ id: o.id, p: o.p })) });
      room.set(cl.id, cl);
      if (cl.p) toIsland(want, { t: "peer", id: cl.id, p: cl.p }, cl);
      countsDirty = true;
    } else if (m.t === "p") {
      if (!cl.island) return;
      const p = clean(m.p); if (!p) return;
      cl.p = p;
      toIsland(cl.island, { t: "peer", id: cl.id, p }, cl);
    }
  });

  ws.on("close", () => leave(cl));
  ws.on("error", () => {});
});

// 끊긴 연결 정리
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.cl.alive) { ws.terminate(); continue; }
    ws.cl.alive = false; ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`🏝️  무인도 일기 서버가 열렸어요: http://localhost:${PORT}`);
  console.log(`   섬 ${MAX_ISLANDS}개 · 섬마다 최대 ${CAP}명`);
});
