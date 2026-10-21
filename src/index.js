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
//   POST /logs/import      記録の置き換え（VIEW_TOKEN、本文は format=json と同じ形）
//                          一覧ページの「インポート: JSON」から呼ぶ

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
      if (url.pathname === "/logs/import" && req.method === "POST") {
        return await importLogs(req, url, env);
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

  // limit=all は全件（一覧ページの JSON リンク。復元に使うので欠けないようにする）
  const all = url.searchParams.get("limit") === "all";
  const n = Math.floor(Number(url.searchParams.get("limit")));
  const limit = n > 0 ? n : 100;
  const { results } = await (all
    ? env.DB.prepare("SELECT event, at FROM logs ORDER BY id DESC")
    : env.DB.prepare("SELECT event, at FROM logs ORDER BY id DESC LIMIT ?").bind(limit)
  ).all();

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
  const since = Date.now() - (days + 1) * 86400e3;
  // 最初の夜の区間が欠けないよう、その前の記録も読んで組にしてから外す
  const { results } = await env.DB.prepare(
    "SELECT event, at FROM logs WHERE at >= ? ORDER BY at",
  )
    .bind(new Date(since - MAX_SEGMENT_MIN * 60000).toISOString())
    .all();
  const nights = toNights(results).filter((n) => n.date >= nightDate(since));
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
    // 月の境目をまたぐ区間が欠けないよう、前後に区間の最長の分だけ広げて読む
    .bind(
      new Date(Date.parse(`${month}-01T${NIGHT_START_H}:00:00+09:00`) - MAX_SEGMENT_MIN * 60000).toISOString(),
      new Date(Date.parse(`${next}-01T${NIGHT_START_H}:00:00+09:00`) + MAX_SEGMENT_MIN * 60000).toISOString(),
    )
    .all();

  const byDate = new Map(toNights(results).map((n) => [n.date, n]));
  const tonight = nightDate(Date.now());
  const nights = [];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = 1; d <= lastDay; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    if (date > tonight) break;
    nights.push(byDate.get(date) ?? emptyNight(date));
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

// 一晩の区切り（日本時間）。朝から昼過ぎまで眠る日（7:00〜13:00 など）も一晩に収まるよう 18 時にする
const NIGHT_START_H = 18;

function nightDate(ms) {
  return new Date(ms + JST - NIGHT_START_H * 3600e3).toISOString().slice(0, 10);
}

// segments: おやすみと次のおはようの組（眠っていた区間）
// lone: 組にならなかったおやすみ・おはよう（グラフでは点で示す）
// sleep / wake: 一覧の「おやすみ」「おはよう」の列。最初の区間の開始と最後の区間の終了
function emptyNight(date) {
  return { date, segments: [], lone: [], sleep: null, wake: null, total: 0 };
}

// おやすみと次のおはようの間がこれより長いときは、記録し忘れとみなして組にしない
const MAX_SEGMENT_MIN = 16 * 60;

// おやすみと次のおはようを組にしてから、組を眠り始めた時刻の夜に入れる。
// 夜は日本時間の 18 時で区切り、日付はその夜の日付
// （10/11 23:41 就寝 → 10/12 6:52 起床 は 10/11 の夜。15:00〜21:00 のように区切りをまたいでも、眠り始めた夜に入る）。
// 一晩に何度か眠ったときは区間ごとに残し、睡眠時間はその合計にする。
function toNights(rows) {
  const nights = new Map();
  const night = (ms) => {
    const date = nightDate(ms);
    if (!nights.has(date)) nights.set(date, emptyNight(date));
    return nights.get(date);
  };
  const lone = (event, ms) => night(ms).lone.push({ event, ms });
  let pending = null; // まだおはようが来ていないおやすみ
  let prev = null;
  for (const r of [...rows].sort((a, b) => a.at.localeCompare(b.at))) {
    const ms = Date.parse(r.at);
    if (r.event === "おやすみ") {
      // 寝直したときは最後のおやすみを採り、その後のおはようを待つ
      pending = ms;
    } else if (r.event === "おはよう") {
      if (pending !== null && ms - pending <= MAX_SEGMENT_MIN * 60000) {
        night(pending).segments.push({ sleep: pending, wake: ms });
      } else if (pending !== null) {
        lone("おやすみ", pending);
        lone("おはよう", ms);
      } else if (prev !== "おはよう") {
        // おはようが続いたときは最初のものを採り、残りは重複とみなして捨てる
        lone("おはよう", ms);
      }
      pending = null;
    }
    prev = r.event;
  }
  if (pending !== null) lone("おやすみ", pending);
  for (const n of nights.values()) {
    n.lone.sort((a, b) => a.ms - b.ms);
    const first = n.segments[0];
    const last = n.segments.at(-1);
    n.sleep = first?.sleep ?? n.lone.find((x) => x.event === "おやすみ")?.ms ?? null;
    n.wake = last?.wake ?? n.lone.find((x) => x.event === "おはよう")?.ms ?? null;
    n.total = n.segments.reduce((a, x) => a + (x.wake - x.sleep) / 60000, 0);
  }
  return [...nights.values()].reverse();
}

// グラフの横軸: その夜の 18:00 から翌 18:00 まで（24時間。一晩の区切りと同じ）
const AXIS_START_H = NIGHT_START_H;
const AXIS_MIN = 24 * 60;

// 睡眠時間がこれより短い夜（片方しか記録がない夜を含む）は、誤操作とみなして平均から外す
const MIN_SLEEP_MIN = 10;

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
  // 平均（就寝・起床は横軸上の位置で平均し、0時をまたいでも崩れないようにする）
  const counted = statsNights.filter((n) => n.total >= MIN_SLEEP_MIN);
  const avgSleep = average(counted.map((n) => axisMin(n, n.segments[0].sleep)));
  const avgWake = average(counted.map((n) => axisMin(n, n.segments.at(-1).wake)));
  const avgDur = average(counted.map((n) => n.total));
  const stat = (label, value) =>
    `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value ?? "—"}</div></div>`;

  const ticks = [18, 21, 0, 3, 6, 9, 12, 15, 18]
    .map((h, i) => `<span style="left:${i * 12.5}%">${h}時</span>`)
    .join("");

  const rows = nights
    .map((n) => {
      const bars = n.segments.map(({ sleep, wake }) => {
        const l = pct(axisMin(n, sleep));
        const r = pct(axisMin(n, wake));
        const tip = `${dateLabel(n.date)}の夜 ${hm(sleep)} → ${hm(wake)}（${duration((wake - sleep) / 60000)}）`;
        return `<div class="bar" style="left:${l}%;width:${(r - l).toFixed(2)}%" title="${tip}"></div>`;
      });
      const dots = n.lone.map(({ event, ms }) => {
        const tip = `${dateLabel(n.date)}の夜 ${event} ${hm(ms)}`;
        return `<div class="dot" style="left:${pct(axisMin(n, ms))}%" title="${tip}"></div>`;
      });
      const mark = [...bars, ...dots].join("");
      return `<div class="row">
  <div class="c-date">${dateLabel(n.date)}</div>
  <div class="c-time">${n.sleep ? hm(n.sleep) : "—"}</div>
  <div class="c-time">${n.wake ? hm(n.wake) : "—"}</div>
  <div class="c-dur">${n.segments.length ? duration(n.total) : "—"}</div>
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
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 8px; }
.note { color: var(--text-2); font-size: .8rem; margin: 0 0 24px; }
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
  background-image: repeating-linear-gradient(to right, var(--grid) 0 1px, transparent 1px 12.5%);
}
.bar { position: absolute; top: 2px; height: 10px; min-width: 4px; border-radius: 4px; background: var(--series); }
.dot {
  position: absolute; top: 3px; width: 8px; height: 8px; margin-left: -4px;
  border-radius: 50%; border: 2px solid var(--series); background: var(--card);
}
.ticks { position: relative; height: 1.2em; }
.ticks span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
.ticks span:first-child { transform: none; }
.ticks span:last-child { transform: translateX(-100%); }
.empty { color: var(--text-2); padding: 24px 0; text-align: center; }
footer { margin-top: 20px; color: var(--text-2); font-size: .85rem; display: flex; flex-wrap: wrap; gap: 8px 24px; }
footer .app { flex-basis: 100%; color: var(--muted); font-size: .8rem; }
.restore { color: var(--series); text-decoration: underline; cursor: pointer; }
.msg { flex-basis: 100%; color: var(--text); }
.msg:empty { display: none; }
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
<p class="note">睡眠時間が${MIN_SLEEP_MIN}分未満の日は、平均に含めていません。</p>
<section class="list">
<div class="row head">
  <div>日付</div><div class="c-time">おやすみ</div><div class="c-time">おはよう</div><div class="c-dur">睡眠</div>
  <div class="c-bar"><div class="ticks">${ticks}</div></div>
</div>
${rows || `<div class="empty">記録がありません</div>`}
</section>
<footer>
<div>表示期間: ${range} ・ 月別: ${monthLink}</div>
<div>エクスポート: <a href="${q({ format: "csv" })}">CSV（Excel 用）</a> ・ <a href="${q({ format: "json", limit: "all" })}" download="logs.json">JSON</a> | インポート: <label class="restore">JSON<input type="file" id="restore" accept=".json,application/json" hidden></label></div>
<div class="msg" id="restore-msg" role="status"></div>
<div class="app"><a href="${esc(PROFILE.URL.Project)}">${esc(PROFILE.Title.Text)}</a> ${esc(PROFILE.Version.Text)} ・ ${esc(PROFILE.Copyright.Text)}</div>
</footer>
</main>
<script>
const TOKEN = ${JSON.stringify(token).replace(/</g, "\\u003c")};
const input = document.getElementById("restore");
const msg = document.getElementById("restore-msg");
input.addEventListener("change", async () => {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  if (!confirm("いまの記録はすべて削除され、「" + file.name + "」の内容に置き換わります。よろしいですか？")) return;
  msg.textContent = "復元しています…";
  try {
    const r = await fetch("/logs/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: await file.text(),
    });
    const res = await r.json().catch(() => ({}));
    if (r.ok) {
      msg.textContent = res.imported + "件の記録を復元しました。";
      setTimeout(() => location.reload(), 1500);
      return;
    }
    msg.textContent =
      res.error === "invalid_record"
        ? (res.index + 1) + "件目の記録が正しくないため、復元できませんでした。記録は変更していません。ファイルの内容を確認してください。"
        : res.error === "invalid_json" || res.error === "invalid_body"
          ? "このファイルは復元に使えません。記録は変更していません。この画面の「エクスポート」の「JSON」で保存したファイルを選んでください。"
          : r.status === 401
            ? "復元する権限がありません。記録は変更していません。ページのアドレスを確認してください。"
            : "復元できませんでした。記録は変更していません。時間をおいてもう一度お試しください。";
  } catch {
    msg.textContent = "復元できませんでした。記録は変更していません。通信状態を確認して、もう一度お試しください。";
  }
});
</script>
</body>
</html>
`;
}

// ---------- インポート ----------

// format=json の出力と同じ形（[{ event, at, local }]）を受け取り、記録をすべて置き換える。
// local は表示用なので読まない。1件でも不正なら何も変えない。
async function importLogs(req, url, env) {
  const t = url.searchParams.get("token") ?? bearer(req);
  if (!safeEqual(t, env.VIEW_TOKEN)) return json({ error: "unauthorized" }, 401);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!Array.isArray(body) || body.length === 0) return json({ error: "invalid_body" }, 400);

  const records = [];
  for (const [index, r] of body.entries()) {
    const dev = DEVICES.find((d) => d.event === r?.event);
    const ms = typeof r?.at === "string" ? Date.parse(r.at) : NaN;
    if (!dev || Number.isNaN(ms)) return json({ error: "invalid_record", index }, 400);
    records.push({ event: dev.event, device_id: dev.id, at: new Date(ms).toISOString() });
  }
  // エクスポートは新しい順なので、id が時刻順になるよう古い順に入れる
  records.sort((a, b) => a.at.localeCompare(b.at));

  const insert = env.DB.prepare("INSERT INTO logs (event, device_id, at, request_id) VALUES (?, ?, ?, NULL)");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM logs"),
    ...records.map((r) => insert.bind(r.event, r.device_id, r.at)),
  ]);
  return json({ imported: records.length });
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
