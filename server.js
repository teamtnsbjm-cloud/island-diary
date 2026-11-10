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
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".woff2": "font/woff2",
};

/* ---------- 정적 파일 ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") { res.end("ok"); return; }
  // 메타모아용: 지금 섬에 함께 있는 사람 수를 숫자 하나로 (봇·테스트 접속 제외, 이용자 정보 없음)
  if (url.pathname === "/api/live") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    res.end(String(livePlayers()));
    return;
  }
  // 메타모아 알림(웹훅) 받는 곳: 내용은 서버 기록에만 남겨요
  if (url.pathname === "/api/metamoa-hook" && req.method === "POST") {
    if (process.env.METAMOA_HOOK_TOKEN && url.searchParams.get("token") !== process.env.METAMOA_HOOK_TOKEN) { res.writeHead(403); res.end(); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on("end", () => { console.log("[메타모아 알림]", body.slice(0, 500)); res.writeHead(200); res.end("ok"); });
    return;
  }
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
      "Cache-Control": ext === ".html" || ext === ".webmanifest" || p === "/sw.js" ? "no-cache" : "public, max-age=86400", // 앱 설정과 서비스 워커는 항상 새로 확인
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
    hr: num(p.hr, 9) | 0, bd: num(p.bd, 9) | 0, // 헤어, 수염
    fi: num(p.fi, 30) | 0, // 마지막으로 불 피운 모닥불 번호
    pf: Array.isArray(p.pf) ? [num(p.pf[0], 200), num(p.pf[1], 200), num(p.pf[2], 1e15)] : null, // 아무 데나 피운 모닥불 [x, z, 꺼지는 시각]
    // 이 사람이 섬에 놓은 물건들: [종류, x, z, 방향] 최대 6개
    pl: Array.isArray(p.pl) ? p.pl.slice(0, 6).filter((a) => Array.isArray(a) && typeof a[0] === "string").map((a) => [str(a[0], 10), num(a[1], 200), num(a[2], 200), num(a[3], 10)]) : [],
    ...(typeof p.bx === "number" && typeof p.bz === "number" ? { bx: num(p.bx, 300), bz: num(p.bz, 300) } : {}), // 낚시찌 위치
  };
}

function leave(cl) {
  if (!cl.island) return;
  islands.get(cl.island).delete(cl.id);
  toIsland(cl.island, { t: "left", id: cl.id });
  cl.island = 0; countsDirty = true;
}

wss.on("connection", (ws, req) => {
  const cl = { id: (nextId++).toString(36), ws, island: 0, p: null, tokens: 30, last: Date.now(), alive: true };
  // 브라우저에서 이 게임 페이지로 들어온 접속만 사람으로 셈 (스크립트·봇은 Origin이 없거나 다름)
  const origin = req.headers.origin || "";
  try { cl.browser = !!origin && new URL(origin).host === req.headers.host; } catch { cl.browser = false; }
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

/* ---------- 메타모아 접속자 수 ---------- */
// 사람 = 브라우저로 들어와서, 시작 화면을 지나 섬에 들어가 움직임 정보를 보낸 접속
function livePlayers() {
  let n = 0;
  for (const ws of wss.clients) { const c = ws.cl; if (c && c.browser && c.island && c.p && ws.readyState === 1) n++; }
  return n;
}
// 공간 키가 있으면 10분마다 숫자만 보내요 (Render 환경변수 METAMOA_KEY, METAMOA_SPACE_ID)
async function pushLive() {
  const key = process.env.METAMOA_KEY, space = process.env.METAMOA_SPACE_ID;
  if (!key || !space) return;
  try {
    const r = await fetch(`https://metamoa.com/api/live/${encodeURIComponent(space)}`, {
      method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ count: livePlayers() }),
    });
    console.log(`[메타모아] 접속자 수 보냄: ${r.status}`);
  } catch (e) { console.log("[메타모아] 보내기 실패:", e.message); }
}
setTimeout(pushLive, 30 * 1000);
setInterval(pushLive, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`🏝️  무인도 일기 서버가 열렸어요: http://localhost:${PORT}`);
  console.log(`   섬 ${MAX_ISLANDS}개 · 섬마다 최대 ${CAP}명`);
});
