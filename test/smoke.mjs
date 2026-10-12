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
    prepare: () => ({
      bind: (...a) => ({
        run: async () => rows.push({ event: a[0], device_id: a[1], at: a[2] }),
        all: async () => ({ results: rows.slice().reverse() }),
      }),
    }),
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

console.log("smoke test: OK");
