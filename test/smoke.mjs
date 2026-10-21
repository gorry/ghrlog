// D1 をモックして Worker の主要経路を確認するスモークテスト
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import PROFILE from "../src/profile.js";

// package.json のバージョンは Profile.ini と手で合わせる
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(pkg.version, PROFILE.Version.Text, "package.json の version を Profile.ini に合わせる");

const rows = [];
const env = {
  CLIENT_ID: "cid",
  CLIENT_SECRET: "sec",
  ACCESS_TOKEN: "at",
  REFRESH_TOKEN: "rt",
  VIEW_TOKEN: "vt",
  GOOGLE_PROJECT_ID: "p1",
  DB: {
    prepare: (sql) => ({
      sql,
      all: async () => ({ results: rows.slice().reverse() }),
      bind: (...a) => ({
        sql,
        args: a,
        run: async () => rows.push({ event: a[0], device_id: a[1], at: a[2] }),
        // 期間の指定（at >= ? / at < ?）だけを解釈する
        all: async () => ({
          results: rows
            .filter((r) => !sql.includes("at >= ?") || r.at >= a[0])
            .filter((r) => !sql.includes("at < ?") || r.at < a[1])
            .reverse(),
        }),
      }),
    }),
    // DELETE と INSERT だけを解釈する
    batch: async (stmts) => {
      for (const s of stmts) {
        if (s.sql.startsWith("DELETE")) rows.length = 0;
        else rows.push({ event: s.args[0], device_id: s.args[1], at: s.args[2] });
      }
    },
  },
};

const call = (path, init) => worker.fetch(new Request("https://x" + path, init), env);
const fulfill = (body, token = "at") =>
  call("/fulfillment", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

// authorize
let r = await call(
  "/oauth/authorize?client_id=cid&redirect_uri=https://oauth-redirect.googleusercontent.com/r/p1&state=s",
);
assert.equal(r.status, 302);
assert.match(r.headers.get("location"), /code=routine-logger-auth-code&state=s/);

r = await call("/oauth/authorize?client_id=cid&redirect_uri=https://evil.example/&state=s");
assert.equal(r.status, 400);

// token
r = await call("/oauth/token", {
  method: "POST",
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: "routine-logger-auth-code",
    client_id: "cid",
    client_secret: "sec",
  }),
});
assert.equal((await r.json()).access_token, "at");

r = await call("/oauth/token", {
  method: "POST",
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt", client_id: "cid", client_secret: "sec" }),
});
assert.equal((await r.json()).access_token, "at");

// SYNC
r = await fulfill({ requestId: "1", inputs: [{ intent: "action.devices.SYNC" }] });
const sync = await r.json();
assert.deepEqual(sync.payload.devices.map((d) => d.id), ["ohayo", "oyasumi"]);
assert.equal(sync.payload.devices[0].deviceInfo.swVersion, PROFILE.Version.Text);

// EXECUTE
r = await fulfill({
  requestId: "2",
  inputs: [{
    intent: "action.devices.EXECUTE",
    payload: { commands: [{ devices: [{ id: "ohayo" }], execution: [{ command: "action.devices.commands.ActivateScene", params: { deactivate: false } }] }] },
  }],
});
assert.equal((await r.json()).payload.commands[0].status, "SUCCESS");
assert.equal(rows.length, 1);
assert.equal(rows[0].event, "おはよう");

// 認証失敗
r = await fulfill({}, "bad");
assert.equal(r.status, 401);

// logs
r = await call("/logs?token=vt&format=csv");
const bytes = new Uint8Array(await r.arrayBuffer());
assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]); // BOM
assert.match(new TextDecoder().decode(bytes), /^event,at,local\nおはよう,/);
r = await call("/logs?token=vt&format=CSV");
assert.match(await r.text(), /^event,at,local\n/);
r = await call("/logs?token=wrong");
assert.equal(r.status, 401);

// 一覧ページ（ブラウザ）: 10/10 23:41 おやすみ → 10/11 6:52 おはよう（JST）が一晩になる
rows.length = 0;
rows.push(
  { event: "おやすみ", at: "2026-10-10T14:41:00.000Z" },
  { event: "おはよう", at: "2026-10-10T21:52:00.000Z" },
  { event: "おやすみ", at: "2026-10-11T15:05:00.000Z" },
);
r = await call("/logs?token=vt", { headers: { Accept: "text/html" } });
assert.match(r.headers.get("content-type"), /text\/html/);
const html = await r.text();
assert.match(html, /10\/10\(土\)の夜 23:41 → 6:52（7時間11分）/);
assert.match(html, /10\/11\(日\)の夜 おやすみ 0:05/);
assert.ok(html.includes(`${PROFILE.Title.Text}</a> ${PROFILE.Version.Text}`));
assert.match(html, /format=json(&amp;|&)limit=all" download="logs.json">JSON<\/a>/);
assert.match(html, /インポート: <label class="restore">JSON<input type="file"/);
assert.match(html, /const TOKEN = "vt";/);
r = await call("/logs?token=vt");
assert.match(r.headers.get("content-type"), /json/);

// 月別ページ: 記録のない日も並び、前月へのリンクがある
const page = async (q) => (await call(`/logs?token=vt&${q}`, { headers: { Accept: "text/html" } })).text();
const month = await page("month=2026-10");
assert.match(month, /2026年10月 ・ 記録のある夜 2 \/ \d+/);
assert.match(month, /<div class="c-date">10\/1\(木\)<\/div>/);
assert.match(month, /10\/10\(土\)の夜 23:41 → 6:52（7時間11分）/);
assert.match(month, /month=2026-09">‹ 2026年9月/);
assert.match(await page("month=2026-13"), /直近30日/);

// 平均: 睡眠時間が10分未満の夜（片方しか記録がない夜を含む）は外す
rows.push(
  { event: "おやすみ", at: "2026-10-12T13:00:00.000Z" },
  { event: "おはよう", at: "2026-10-12T13:05:00.000Z" },
);
const avg = await page("month=2026-10");
const statValue = (label) => avg.match(new RegExp(`${label}</div><div class="stat-value">([^<]*)<`))[1];
assert.equal(statValue("おやすみ"), "23:41");
assert.equal(statValue("おはよう"), "6:52");
assert.equal(statValue("睡眠時間"), "7時間11分");
assert.match(avg, /睡眠時間が10分未満の日は、平均に含めていません。/);
rows.splice(-2);

// 18時で区切る: 23:00〜3:00 と 7:00〜13:00 は同じ夜の2区間で、睡眠時間は合計
rows.push(
  { event: "おやすみ", at: "2026-10-13T14:00:00.000Z" },
  { event: "おはよう", at: "2026-10-13T18:00:00.000Z" },
  { event: "おやすみ", at: "2026-10-13T22:00:00.000Z" },
  { event: "おはよう", at: "2026-10-14T04:00:00.000Z" },
);
const twice = await page("month=2026-10");
assert.match(twice, /10\/13\(火\)の夜 23:00 → 3:00（4時間00分）/);
assert.match(twice, /10\/13\(火\)の夜 7:00 → 13:00（6時間00分）/);
assert.match(
  twice,
  /<div class="c-date">10\/13\(火\)<\/div>\s*<div class="c-time">23:00<\/div>\s*<div class="c-time">13:00<\/div>\s*<div class="c-dur">10時間00分<\/div>/,
);
assert.match(twice, /<div class="c-date">10\/14\(水\)<\/div>\s*<div class="c-time">—<\/div>/);
rows.splice(-4);

// 区切りの 18 時をまたいでも、眠り始めた夜の区間になる（グラフは右端で切る）
rows.push(
  { event: "おやすみ", at: "2026-10-15T06:00:00.000Z" },
  { event: "おはよう", at: "2026-10-15T12:00:00.000Z" },
);
const across = await page("month=2026-10");
assert.match(across, /left:87\.50%;width:12\.50%" title="10\/14\(水\)の夜 15:00 → 21:00（6時間00分）"/);
assert.match(across, /<div class="c-date">10\/15\(木\)<\/div>\s*<div class="c-time">—<\/div>\s*<div class="c-time">—<\/div>/);
rows.splice(-2);

// 16時間を超える組は記録し忘れとみなし、それぞれ点にする
rows.push(
  { event: "おやすみ", at: "2026-10-16T14:00:00.000Z" },
  { event: "おはよう", at: "2026-10-17T22:00:00.000Z" },
);
const apart = await page("month=2026-10");
assert.match(apart, /<div class="c-date">10\/16\(金\)<\/div>\s*<div class="c-time">23:00<\/div>\s*<div class="c-time">—<\/div>\s*<div class="c-dur">—<\/div>/);
assert.match(apart, /<div class="c-date">10\/17\(土\)<\/div>\s*<div class="c-time">—<\/div>\s*<div class="c-time">7:00<\/div>/);
rows.splice(-2);

// 月の境目: 10/1 15:00〜21:00 は 9 月の最後の夜になり、10 月の初日には入らない
rows.push(
  { event: "おやすみ", at: "2026-10-01T06:00:00.000Z" },
  { event: "おはよう", at: "2026-10-01T12:00:00.000Z" },
);
assert.match(await page("month=2026-09"), /9\/30\(水\)の夜 15:00 → 21:00（6時間00分）/);
assert.match(await page("month=2026-10"), /<div class="c-date">10\/1\(木\)<\/div>\s*<div class="c-time">—<\/div>\s*<div class="c-time">—<\/div>/);
rows.splice(-2);

// インポート: エクスポートと同じ形で受け取り、記録を置き換える
const importLogs = (body, token = "vt") =>
  call("/logs/import", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const exported = await (await call("/logs?token=vt&format=json&limit=all")).json();
rows.push({ event: "おはよう", at: "2026-10-12T21:00:00.000Z" });
r = await importLogs(exported);
assert.deepEqual(await r.json(), { imported: 3 });
assert.deepEqual(rows.map((x) => x.at), [
  "2026-10-10T14:41:00.000Z",
  "2026-10-10T21:52:00.000Z",
  "2026-10-11T15:05:00.000Z",
]);
assert.equal(rows[1].device_id, "ohayo");
const pick = (list) => list.map(({ event, at }) => ({ event, at }));
assert.deepEqual(pick(await (await call("/logs?token=vt&format=json")).json()), pick(exported));

// 不正な入力・認証失敗では何も変えない
for (const [body, error] of [
  ["{", "invalid_json"],
  [[], "invalid_body"],
  [{ event: "おはよう", at: "2026-10-12T21:00:00Z" }, "invalid_body"],
  [[...exported, { event: "こんにちは", at: "2026-10-12T21:00:00Z" }], "invalid_record"],
  [[{ event: "おはよう", at: "昨日" }], "invalid_record"],
]) {
  r = await importLogs(body);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, error);
}
assert.equal((await importLogs(exported, "bad")).status, 401);
assert.equal(rows.length, 3);

console.log("smoke test: OK");
