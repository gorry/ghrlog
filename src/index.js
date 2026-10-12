// Google Home Sleep Routine Logger（ghrlog）
// Google Home ルーティン実行時刻ロガー（Cloudflare Workers + D1）
// アプリ名・バージョン・著作権表記は Profile.ini から生成した src/profile.js を使う。
//
// Google Home の Cloud-to-cloud 連携として動作し、「おはようログ」「おやすみログ」の
// 2つのシーン型仮想デバイスを公開する。ルーティンからシーンが有効化されると
// EXECUTE リクエストが届くので、その時刻を D1 に記録する。
//
// エンドポイント:
//   GET  /oauth/authorize  アカウントリンク（認可）
//   POST /oauth/token      アカウントリンク（トークン発行・更新）
//   POST /fulfillment      SYNC / QUERY / EXECUTE / DISCONNECT
//   GET  /logs             記録の閲覧（?token=VIEW_TOKEN または Bearer）
//                          ブラウザでは一覧ページ、format=json / csv でデータ

import PROFILE from "./profile.js";

const DEVICES = [
  { id: "ohayo", name: "おはようログ", event: "おはよう" },
  { id: "oyasumi", name: "おやすみログ", event: "おやすみ" },
];

// 自分専用なので認可コードは固定値。トークン発行時に client_secret で保護される。
const AUTH_CODE = "routine-logger-auth-code";
const TOKEN_TTL = 86400;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/oauth/authorize" && req.method === "GET") {
        return authorize(url, env);
      }
      if (url.pathname === "/oauth/token" && req.method === "POST") {
        return await token(req, env);
      }
      if (url.pathname === "/fulfillment" && req.method === "POST") {
        return await fulfillment(req, env);
      }
      if (url.pathname === "/logs" && req.method === "GET") {
        return await logs(req, url, env);
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return new Response("Internal error", { status: 500 });
    }
  },
};

// ---------- OAuth ----------

function authorize(url, env) {
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state") ?? "";
  const allowed = [
    `https://oauth-redirect.googleusercontent.com/r/${env.GOOGLE_PROJECT_ID}`,
    `https://oauth-redirect-sandbox.googleusercontent.com/r/${env.GOOGLE_PROJECT_ID}`,
  ];
  if (!safeEqual(clientId, env.CLIENT_ID) || !allowed.includes(redirectUri)) {
    return new Response("invalid request", { status: 400 });
  }
  const dest = new URL(redirectUri);
  dest.searchParams.set("code", AUTH_CODE);
  dest.searchParams.set("state", state);
  return Response.redirect(dest.toString(), 302);
}

async function token(req, env) {
  const form = await req.formData();
  let clientId = form.get("client_id");
  let clientSecret = form.get("client_secret");

  // client_secret_basic にも対応
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Basic ")) {
    const decoded = atob(auth.slice(6));
    const i = decoded.indexOf(":");
    clientId = decodeURIComponent(decoded.slice(0, i));
    clientSecret = decodeURIComponent(decoded.slice(i + 1));
  }

  if (!safeEqual(clientId, env.CLIENT_ID) || !safeEqual(clientSecret, env.CLIENT_SECRET)) {
    return json({ error: "invalid_client" }, 401);
  }

  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    if (form.get("code") !== AUTH_CODE) return json({ error: "invalid_grant" }, 400);
    return json({
      token_type: "Bearer",
      access_token: env.ACCESS_TOKEN,
      refresh_token: env.REFRESH_TOKEN,
      expires_in: TOKEN_TTL,
    });
  }
  if (grant === "refresh_token") {
    if (!safeEqual(form.get("refresh_token"), env.REFRESH_TOKEN)) {
      return json({ error: "invalid_grant" }, 400);
    }
    return json({ token_type: "Bearer", access_token: env.ACCESS_TOKEN, expires_in: TOKEN_TTL });
  }
  return json({ error: "unsupported_grant_type" }, 400);
}

// ---------- Fulfillment ----------

async function fulfillment(req, env) {
  if (!safeEqual(bearer(req), env.ACCESS_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }
  const { requestId, inputs = [] } = await req.json();
  const input = inputs[0] ?? {};

  switch (input.intent) {
    case "action.devices.SYNC":
      return json({
        requestId,
        payload: {
          agentUserId: "owner",
          devices: DEVICES.map((d) => ({
            id: d.id,
            type: "action.devices.types.SCENE",
            traits: ["action.devices.traits.Scene"],
            name: { name: d.name },
            willReportState: false,
            attributes: { sceneReversible: false },
            deviceInfo: {
              manufacturer: PROFILE.Copyright.Name,
              model: PROFILE.Title.ShortText,
              swVersion: PROFILE.Version.Text,
            },
          })),
        },
      });

    case "action.devices.QUERY": {
      const devices = {};
      for (const d of input.payload?.devices ?? []) {
        devices[d.id] = { online: true, status: "SUCCESS" };
      }
      return json({ requestId, payload: { devices } });
    }

    case "action.devices.EXECUTE": {
      const commands = await execute(input.payload?.commands ?? [], requestId, env);
      return json({ requestId, payload: { commands } });
    }

    case "action.devices.DISCONNECT":
      return json({});

    default:
      return json({ requestId, payload: { errorCode: "notSupported" } });
  }
}

async function execute(commands, requestId, env) {
  const at = new Date().toISOString();
  const results = [];
  for (const cmd of commands) {
    const activates = (cmd.execution ?? []).some(
      (e) => e.command === "action.devices.commands.ActivateScene" && !e.params?.deactivate,
    );
    const ok = [];
    const ng = [];
    for (const { id } of cmd.devices ?? []) {
      const dev = DEVICES.find((d) => d.id === id);
      if (dev && activates) {
        await env.DB.prepare(
          "INSERT INTO logs (event, device_id, at, request_id) VALUES (?, ?, ?, ?)",
        )
          .bind(dev.event, id, at, requestId ?? null)
          .run();
        ok.push(id);
      } else {
        ng.push(id);
      }
    }
    if (ok.length) results.push({ ids: ok, status: "SUCCESS" });
    if (ng.length) results.push({ ids: ng, status: "ERROR", errorCode: "functionNotSupported" });
  }
  return results;
}

// ---------- 閲覧 ----------

const JST = 9 * 3600 * 1000;

async function logs(req, url, env) {
  const t = url.searchParams.get("token") ?? bearer(req);
  if (!safeEqual(t, env.VIEW_TOKEN)) return json({ error: "unauthorized" }, 401);

  // format の指定がなくブラウザで開かれたときは、見やすい一覧ページを返す
  const accept = req.headers.get("Accept") ?? "";
  const format =
    url.searchParams.get("format")?.toLowerCase() ?? (accept.includes("text/html") ? "html" : "json");
  if (format === "html") return await logsPage(url, t, env);

  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 1000);
  const { results } = await env.DB.prepare(
    "SELECT event, at FROM logs ORDER BY id DESC LIMIT ?",
  )
    .bind(limit)
    .all();

  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "short",
    timeStyle: "medium",
  });
  const rows = results.map((r) => ({ ...r, local: fmt.format(new Date(r.at)) }));

  if (format === "csv") {
    const csv = ["event,at,local", ...rows.map((r) => `${r.event},${r.at},${r.local}`)].join("\n");
    // Excel が UTF-8 と認識するよう BOM を付ける
    return new Response("\uFEFF" + csv + "\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="logs.csv"',
      },
    });
  }
  return json(rows);
}

async function logsPage(url, token, env) {
  const month = url.searchParams.get("month") ?? "";
  const view = /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
    ? await monthView(month, env)
    : await recentView(Math.min(Number(url.searchParams.get("days")) || 30, 365), env);

  return new Response(renderPage({ ...view, token }), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}

// 直近 days 日の夜を新しい順に並べる
async function recentView(days, env) {
  const since = new Date(Date.now() - (days + 1) * 86400e3).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT event, at FROM logs WHERE at >= ? ORDER BY at",
  )
    .bind(since)
    .all();
  const nights = toNights(results);
  return {
    days,
    nights,
    subtitle: `直近${days}日`,
    statsTitle: "直近7晩の平均",
    statsNights: nights.slice(0, 7),
  };
}

// その月の夜（1日の夜〜末日の夜）を1日から順に、記録のない日も含めて並べる
async function monthView(month, env) {
  const [y, m] = month.split("-").map(Number);
  const ym = (yy, mm) => `${yy}-${String(mm).padStart(2, "0")}`;
  const prev = m === 1 ? ym(y - 1, 12) : ym(y, m - 1);
  const next = m === 12 ? ym(y + 1, 1) : ym(y, m + 1);
  const { results } = await env.DB.prepare(
    "SELECT event, at FROM logs WHERE at >= ? AND at < ? ORDER BY at",
  )
    .bind(
      new Date(`${month}-01T12:00:00+09:00`).toISOString(),
      new Date(`${next}-01T12:00:00+09:00`).toISOString(),
    )
    .all();

  const byDate = new Map(toNights(results).map((n) => [n.date, n]));
  const tonight = nightDate(Date.now());
  const nights = [];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = 1; d <= lastDay; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    if (date > tonight) break;
    nights.push(byDate.get(date) ?? { date, sleep: null, wake: null });
  }
  const recorded = nights.filter((n) => n.sleep || n.wake).length;
  const label = (s) => `${Number(s.slice(0, 4))}年${Number(s.slice(5))}月`;

  return {
    month,
    nights,
    subtitle: `${label(month)} ・ 記録のある夜 ${recorded} / ${nights.length}`,
    statsTitle: `${label(month)}の平均`,
    statsNights: nights,
    nav: { prev: [prev, label(prev)], next: next <= tonight.slice(0, 7) ? [next, label(next)] : null },
  };
}

function nightDate(ms) {
  return new Date(ms + JST - 12 * 3600e3).toISOString().slice(0, 10);
}

// 日本時間の正午で日付を区切り、おやすみと翌朝のおはようを「一晩」にまとめる。
// 日付はその夜の日付（10/11 23:41 就寝 → 10/12 6:52 起床 は 10/11 の夜）。
function toNights(rows) {
  const nights = new Map();
  for (const r of [...rows].sort((a, b) => a.at.localeCompare(b.at))) {
    const ms = Date.parse(r.at);
    const date = nightDate(ms);
    if (!nights.has(date)) nights.set(date, { date, sleep: null, wake: null });
    const n = nights.get(date);
    if (r.event === "おやすみ") {
      // 寝直したときは最後のおやすみを採り、その後のおはようを待つ
      n.sleep = ms;
      n.wake = null;
    } else if (r.event === "おはよう" && n.wake === null) {
      n.wake = ms;
    }
  }
  return [...nights.values()].reverse();
}

// グラフの横軸: その夜の 18:00 から翌 14:00 まで（20時間）
const AXIS_START_H = 18;
const AXIS_MIN = 20 * 60;

function axisMin(night, ms) {
  const start = Date.parse(`${night.date}T${AXIS_START_H}:00:00+09:00`);
  return (ms - start) / 60000;
}

function pct(min) {
  return ((Math.min(Math.max(min, 0), AXIS_MIN) / AXIS_MIN) * 100).toFixed(2);
}

function hm(ms) {
  const d = new Date(ms + JST);
  return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function hmFromAxis(min) {
  const m = Math.round(AXIS_START_H * 60 + min) % 1440;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

function duration(min) {
  const m = Math.round(min);
  return `${Math.floor(m / 60)}時間${String(m % 60).padStart(2, "0")}分`;
}

function dateLabel(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${"日月火水木金土"[d.getUTCDay()]})`;
}

function average(list) {
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}

function renderPage({ nights, days, month, subtitle, statsTitle, statsNights, nav, token }) {
  const sleepMin = (n) => (n.sleep && n.wake && n.wake > n.sleep ? (n.wake - n.sleep) / 60000 : null);

  // 平均（就寝・起床は横軸上の位置で平均し、0時をまたいでも崩れないようにする）
  const avgSleep = average(statsNights.filter((n) => n.sleep).map((n) => axisMin(n, n.sleep)));
  const avgWake = average(statsNights.filter((n) => n.wake).map((n) => axisMin(n, n.wake)));
  const avgDur = average(statsNights.map(sleepMin).filter((m) => m !== null));
  const stat = (label, value) =>
    `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value ?? "—"}</div></div>`;

  const ticks = [18, 21, 0, 3, 6, 9, 12]
    .map((h, i) => `<span style="left:${i * 15}%">${h}時</span>`)
    .join("");

  const rows = nights
    .map((n) => {
      const dur = sleepMin(n);
      let mark = "";
      if (dur !== null) {
        const l = pct(axisMin(n, n.sleep));
        const r = pct(axisMin(n, n.wake));
        const tip = `${dateLabel(n.date)}の夜 ${hm(n.sleep)} → ${hm(n.wake)}（${duration(dur)}）`;
        mark = `<div class="bar" style="left:${l}%;width:${(r - l).toFixed(2)}%" title="${tip}"></div>`;
      } else if (n.sleep || n.wake) {
        const ms = n.sleep ?? n.wake;
        const tip = `${dateLabel(n.date)}の夜 ${n.sleep ? "おやすみ" : "おはよう"} ${hm(ms)}`;
        mark = `<div class="dot" style="left:${pct(axisMin(n, ms))}%" title="${tip}"></div>`;
      }
      return `<div class="row">
  <div class="c-date">${dateLabel(n.date)}</div>
  <div class="c-time">${n.sleep ? hm(n.sleep) : "—"}</div>
  <div class="c-time">${n.wake ? hm(n.wake) : "—"}</div>
  <div class="c-dur">${dur !== null ? duration(dur) : "—"}</div>
  <div class="c-bar"><div class="track">${mark}</div></div>
</div>`;
    })
    .join("\n");

  const q = (params) => `?${new URLSearchParams({ token, ...params })}`;
  const range = [7, 30, 90]
    .map((d) => (d === days ? `<strong>${d}日</strong>` : `<a href="${q({ days: d })}">${d}日</a>`))
    .join(" ・ ");
  const thisMonth = nightDate(Date.now()).slice(0, 7);
  const monthLink =
    month === thisMonth ? "<strong>今月</strong>" : `<a href="${q({ month: thisMonth })}">今月</a>`;
  const monthNav = nav
    ? `<nav class="months">
<a href="${q({ month: nav.prev[0] })}">‹ ${nav.prev[1]}</a>
${nav.next ? `<a href="${q({ month: nav.next[0] })}">${nav.next[1]} ›</a>` : "<span></span>"}
</nav>`
    : "";

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="generator" content="${esc(PROFILE.Title.ShortText)} ${esc(PROFILE.Version.Text)}">
<title>おはよう・おやすみ記録</title>
<style>
:root {
  color-scheme: light;
  --surface: #fcfcfb;
  --card: #ffffff;
  --text: #0b0b0b;
  --text-2: #52514e;
  --muted: #8a8984;
  --line: #e6e5e0;
  --grid: #ecebe7;
  --series: #2a78d6;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --surface: #1a1a19;
    --card: #222221;
    --text: #f0efec;
    --text-2: #c3c2b7;
    --muted: #8f8e88;
    --line: #333331;
    --grid: #2c2c2a;
    --series: #3987e5;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--surface);
  color: var(--text);
  font-family: system-ui, -apple-system, "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif;
  line-height: 1.5;
}
main { max-width: 880px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.4rem; margin: 0; }
.sub { color: var(--text-2); margin: 4px 0 20px; font-size: .9rem; }
.months { display: flex; justify-content: space-between; margin: -8px 0 20px; }
.months a { text-decoration: none; }
h2 { font-size: .85rem; font-weight: 600; color: var(--text-2); margin: 0 0 8px; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 24px; }
.stat { min-width: 0; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.stat-label { color: var(--text-2); font-size: .8rem; }
.stat-value { font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.list { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 4px 14px; }
.row {
  display: grid;
  grid-template-columns: 6.5rem 3.5rem 3.5rem 6rem 1fr;
  gap: 8px;
  align-items: center;
  padding: 8px 0;
  border-top: 1px solid var(--line);
  font-variant-numeric: tabular-nums;
}
.row.head { border-top: 0; color: var(--text-2); font-size: .8rem; }
.c-time, .c-dur { text-align: right; }
.c-dur { color: var(--text-2); }
.track {
  position: relative;
  height: 14px;
  background-image: repeating-linear-gradient(to right, var(--grid) 0 1px, transparent 1px 15%);
}
.bar { position: absolute; top: 2px; height: 10px; min-width: 4px; border-radius: 4px; background: var(--series); }
.dot {
  position: absolute; top: 3px; width: 8px; height: 8px; margin-left: -4px;
  border-radius: 50%; border: 2px solid var(--series); background: var(--card);
}
.ticks { position: relative; height: 1.2em; }
.ticks span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
.ticks span:first-child { transform: none; }
.empty { color: var(--text-2); padding: 24px 0; text-align: center; }
footer { margin-top: 20px; color: var(--text-2); font-size: .85rem; display: flex; flex-wrap: wrap; gap: 8px 24px; }
footer .app { flex-basis: 100%; color: var(--muted); font-size: .8rem; }
a { color: var(--series); }
@media (max-width: 560px) {
  .stats { gap: 8px; }
  .stat { padding: 10px; }
  .stat-value { font-size: 1.2rem; }
  .row { grid-template-columns: 1fr 3.5rem 3.5rem 5.5rem; row-gap: 4px; }
  .c-bar { grid-column: 1 / -1; }
}
</style>
</head>
<body>
<main>
<h1>おはよう・おやすみ記録</h1>
<p class="sub">${subtitle} ・ 日本時間 ・ 日付はその夜の日付</p>
${monthNav}
<h2>${statsTitle}</h2>
<section class="stats">
${stat("おやすみ", avgSleep === null ? null : hmFromAxis(avgSleep))}
${stat("おはよう", avgWake === null ? null : hmFromAxis(avgWake))}
${stat("睡眠時間", avgDur === null ? null : duration(avgDur))}
</section>
<section class="list">
<div class="row head">
  <div>日付</div><div class="c-time">おやすみ</div><div class="c-time">おはよう</div><div class="c-dur">睡眠</div>
  <div class="c-bar"><div class="ticks">${ticks}</div></div>
</div>
${rows || `<div class="empty">記録がありません</div>`}
</section>
<footer>
<div>表示期間: ${range} ・ 月別: ${monthLink}</div>
<div>データ: <a href="${q({ format: "csv" })}">CSV（Excel 用）</a> ・ <a href="${q({ format: "json" })}">JSON</a></div>
<div class="app"><a href="${esc(PROFILE.URL.Project)}">${esc(PROFILE.Title.Text)}</a> ${esc(PROFILE.Version.Text)} ・ ${esc(PROFILE.Copyright.Text)}</div>
</footer>
</main>
</body>
</html>
`;
}

// ---------- util ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function bearer(req) {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
