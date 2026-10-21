# Google Home Sleep Routine Logger (ghrlog)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Platform-Cloudflare_Workers_%2B_D1-orange.svg)](https://workers.cloudflare.com/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-green.svg)](https://nodejs.org/)

バージョン 2026.1012.1 ・ Copyright (C) 2026 GORRY. ・ Apache License 2.0 ・ https://github.com/gorry/ghrlog

Google Home（Nest Hub 等）の「おはよう」「おやすみ」ルーティン実行時刻を自動記録・可視化する Cloudflare Worker です。

<img width="1580" height="1650" alt="Image" src="https://github.com/user-attachments/assets/cda057ff-6a4f-44b1-950f-065e9ecfbc5b" />

---

## 概要と開発の背景

### 課題
Google Home では就寝時や起床時に「おやすみ」「おはよう」ルーティンを実行できますが、以下の仕様上の制約があります：
- ルーティンの実行履歴がログとして残らない（マイアクティビティにも記録されない）。
- ルーティンから直接任意の Webhook や外部 API を呼び出すアクションが存在しない。

そのため、「実際に何時に寝て何時に起きたか」を Google Home から自動で記録・集計することが困難でした。

### 解決策
本プロジェクトでは **Google Home の Cloud-to-cloud 連携** を利用し、「おはようログ」「おやすみログ」という2つの**仮想シーン（仮想デバイス）**を Google Home に公開します。

ルーティンの先頭でこれらのシーンを有効化させることで、Cloudflare Workers がリクエストを受け取り、Cloudflare D1（SQLite）へ正確な実行時刻を自動記録します。
常時稼働の自宅サーバーや Matter ブリッジ機器を用意することなく、完全サーバーレス（Cloudflare の無料枠内）で運用できます。

---

## 主な特徴

- **完全サーバーレス＆維持費ゼロ**:
  Cloudflare Workers + D1 の無料枠内で動作。自宅サーバーの常時起動やポート開放は不要です。
- **睡眠ログの見やすい可視化（Webダッシュボード）**:
  ブラウザで `/logs?token=...` を開くだけで、直近の就寝・起床時刻、睡眠時間、時間帯バー、直近7晩の平均睡眠時間を一覧表示します。スマートフォンで「ホーム画面に追加」することでアプリ感覚で確認できます。
  おやすみと次のおはようを1回の睡眠とし、眠り始めた時刻で日本時間の18時から翌18時までの「一晩」に振り分けます（7時〜13時や15時〜21時のように朝や夕方に眠った場合も、眠り始めた夜に入ります）。一晩に何度か眠ったときは区間ごとにバーを表示し、睡眠時間はその合計です。おやすみから16時間を超えて次のおはようが来たときは、記録し忘れとみなして1回の睡眠にはしません。
- **月別表示**:
  `?month=YYYY-MM` パラメータで指定月の全日程と月平均睡眠時間を表示。
  平均は、睡眠時間が10分未満の日（おはよう・おやすみの片方しか記録がない日を含む）を除いて計算します。誤操作による記録で平均がずれないようにするためです。
- **統計**:
  `?view=stats` で、全期間の平均と、月別・曜日別の平均（おやすみ・おはよう・睡眠時間、平均に含めた夜の数）を表示。曜日はその夜の日付の曜日です（金曜の夜 = 金曜に寝て土曜の朝に起きた夜）。
- **データ連携（JSON / CSV）**:
  API やスプレッドシート連携用の JSON 出力、および Excel でそのまま開ける BOM 付き CSV エクスポートに対応。
- **個人利用に特化したミニマル設計**:
  シングルユーザー専用として設計されており、複雑な会員管理や外部認証サービスに依存せず、固定トークンによる堅牢でシンプルな運用が可能です。

---

## 仕組み（アーキテクチャ）

```text
[Google Home / Nest Hub]
       │ 「ねぇ Google、おやすみ」（ルーティン起動）
       ▼
[Google Home アシスタント]
       │ 「おやすみログを有効にして」（カスタム指示アクション）
       ▼
[Google Home Cloud-to-cloud]
       │ EXECUTE リクエスト (OAuth 認可)
       ▼
[Cloudflare Worker] (src/index.js)
       │ 時刻 (UTC) とイベントを記録
       ▼
[Cloudflare D1] (SQLite: logs テーブル)
       ▲
       │ 閲覧リクエスト (/logs?token=VIEW_TOKEN)
[ブラウザ / API / スプレッドシート] (JST変換・睡眠時間集計・UI描画)
```

---

## 前提条件

- **Node.js**（v22 以降。wrangler 4 の要件）および **npm**
- **Cloudflare アカウント**（Workers および D1 が利用可能であること）
- **Google アカウント** および Google Home アプリ／対応デバイス（Nest Hub 等）
- **Google Home Developer Console** の利用権限

---

## セットアップ手順

セットアップは「Cloudflare 側の構築」「Google Home Developer Console の設定」「Google Home アプリの連携」の 3 ステップで行います。

### 1. Cloudflare Worker と D1 のデプロイ

```sh
# 依存関係のインストール
npm install

# 設定ファイルの準備（wrangler.toml は git 管理外）
cp wrangler.toml.sample wrangler.toml

# Cloudflare へのログイン
npx wrangler login

# D1 データベースの作成
npx wrangler d1 create routine-logger
```

1. `wrangler d1 create routine-logger` の出力に表示される `database_id` を `wrangler.toml` の `database_id` に記入します。
   > [!NOTE]
   > `binding = "DB"` は変更しないでください（コード側で `env.DB` を参照しています）。

2. データベースのテーブルを作成します：
   ```sh
   npx wrangler d1 execute routine-logger --remote --file=schema.sql
   ```

3. 初回デプロイを行います：
   ```sh
   npx wrangler deploy
   ```
   デプロイ完了後に表示される Worker の URL（`https://routine-logger.<サブドメイン>.workers.dev`）を控えておきます。

4. シークレットを登録します：
   ローカルに `.dev.vars` ファイル（git 管理外）を作成し、以下のランダムな文字列（例: `openssl rand -hex 32` など）を設定します：
   ```env
   CLIENT_ID=任意のOAuthクライアントID
   CLIENT_SECRET=任意のOAuthクライアントシークレット
   ACCESS_TOKEN=任意のアクセストークン
   REFRESH_TOKEN=任意のリフレッシュトークン
   VIEW_TOKEN=ログ閲覧用トークン
   ```
   設定後、Cloudflare に一括登録します：
   ```sh
   npx wrangler secret bulk .dev.vars
   ```

---

### 2. Google Home Developer Console の設定

1. [Google Home Developer Console](https://console.home.google.com) にアクセスし、プロジェクトを新規作成します。表示された **プロジェクトID** を控えます。
   ここで付けた **プロジェクト名** は、「3. Google Home アプリでの連携とルーティン設定」のアカウントリンクで `[test] <プロジェクト名>` として表示されます。
2. `wrangler.toml` の `GOOGLE_PROJECT_ID` にプロジェクトIDを記入し、再度デプロイします：
   ```sh
   npx wrangler deploy
   ```
3. Developer Console で「Cloud-to-cloud」連携を追加し、以下のように設定します：
   - **Fulfillment URL**: `https://<worker-domain>/fulfillment`
   - **OAuth Client ID**: 上で決めた `CLIENT_ID`
   - **Client Secret**: 上で決めた `CLIENT_SECRET`
   - **Authorization URL**: `https://<worker-domain>/oauth/authorize`
   - **Token URL**: `https://<worker-domain>/oauth/token`
4. 「Test」タブで自分のテストアカウントに対して有効化します（個人利用のため Google による公開審査は不要です）。

---

### 3. Google Home アプリでの連携とルーティン設定

1. **アカウントリンク**:
   - スマートフォンの「Google Home」アプリを開きます。
   - 「デバイスを追加」→「Google Home と連携」を選択します。
   - `[test] <プロジェクト名>` を探して選択し、リンクを完了します。
     `<プロジェクト名>` は「2. Google Home Developer Console の設定」の手順 1 で作成したプロジェクトの名前です。
   > [!NOTE]
   > リンク完了直後、アプリ画面が読み込み中のまま戻らない場合がありますが、Worker 側で SYNC リクエストが成功していれば連携は正常に完了しています。一度アプリを再起動してください。
2. **シーンの確認**:
   - アカウントリンクが完了すると、「おはようログ」「おやすみログ」の 2 つのシーンが登録されます（ホーム画面の通常デバイス一覧には表示されないことがあります）。
3. **ルーティンの編集**:
   - 「おはよう」および「おやすみ」ルーティンの編集画面を開きます。
   - 先頭のアクションとして「**Google アシスタントに指示**」を追加し、それぞれ以下を入力します：
     - おはようルーティン: `おはようログを有効にして`
     - おやすみルーティン: `おやすみログを有効にして`
   > [!TIP]
   > Google Home アプリのルーティン設定画面にはシーンを直接一覧から選択する UI が存在しないため、「Google アシスタントに指示」で音声コマンドと同等のテキストを指定して起動します（音声で直接「OK Google, おやすみログを有効にして」と言っても記録されます）。

---

## ログの閲覧とデータ出力

ログの閲覧には、設定した `VIEW_TOKEN` を使用します。

### エンドポイント

```sh
# Webダッシュボード（ブラウザで開く）
https://<worker-domain>/logs?token=<VIEW_TOKEN>

# 月別表示（YYYY-MM 形式）
https://<worker-domain>/logs?token=<VIEW_TOKEN>&month=2026-10

# 統計（全期間の月別・曜日別）
https://<worker-domain>/logs?token=<VIEW_TOKEN>&view=stats

# JSON 形式（API連携・自動化用）
https://<worker-domain>/logs?token=<VIEW_TOKEN>&format=json

# CSV 形式（Excel対応・BOM付きUTF-8）
https://<worker-domain>/logs?token=<VIEW_TOKEN>&format=csv
```

### パラメータ一覧

| パラメータ | 形式 | 既定値 | 説明 |
|---|---|---|---|
| `token` | 文字列 | 必須 | 閲覧用シークレットトークン（`Authorization: Bearer <token>` ヘッダーでも可） |
| `format` | `html` / `json` / `csv` | `html` (ブラウザ) / `json` (curl等) | 出力フォーマット |
| `days` | 数値 | 30 | 一覧で表示する直近の日数（最大 365 日） |
| `month` | `YYYY-MM` | - | 指定した月の全日一覧および月間平均を表示 |
| `view` | `stats` | - | 全期間の月別・曜日別の統計を表示 |
| `limit` | 数値 / `all` | 100 | JSON / CSV 取得時の最大件数。`all` で全件 |

### インポート（記録の置き換え）

一覧ページ下部の「エクスポート: JSON」で保存したファイルを「インポート: JSON」で選ぶと、Worker が持っている記録を**すべて削除してから**ファイルの内容に置き換えます（確認のダイアログが出ます）。バックアップからの復元や、別の環境への移行に使います。

- 一覧ページの「JSON」リンクは全件（`limit=all`）を出力します。`limit` を指定して取得したファイルを使うと、含まれていない記録は失われます。
- ファイルは `format=json` の出力と同じ形（`[{"event":"おはよう","at":"2026-10-11T21:52:00.000Z","local":"..."}, ...]`）です。`event` は `おはよう` / `おやすみ`、`at` は日時の文字列で、`local` は読みません。
- 1件でも不正な記録がある場合や、記録が0件の場合は、何も変更しません。
- 実体は `POST /logs/import`（認証は `VIEW_TOKEN`）です。コマンドラインからも使えます：
  ```sh
  curl -X POST -H "Authorization: Bearer <VIEW_TOKEN>" -H "Content-Type: application/json"     --data-binary @logs.json https://<worker-domain>/logs/import
  ```

---

## セキュリティと設計思想

- **シングルユーザー専用設計**:
  本システムは個人専用ツールとして設計されています。OAuth 認証は固定のトークンペアを用いたダミー認可フローとなっており、第三者へのサービス提供やマルチテナント運用には適していません。
- **トークンの管理**:
  `VIEW_TOKEN` を知っている人は誰でもログを閲覧でき、復元（記録の置き換え）も行えます。URL を共有する際はトークンの扱いにご注意ください。

---

## 開発とテスト

### スモークテスト
D1 をインメモリでモックし、OAuth 認可、デバイス同期（SYNC）、コマンド実行（EXECUTE）、ログ閲覧（/logs）、インポート（/logs/import）の各エンドポイントを検証します：

```sh
npm test
```

### ローカル開発サーバー
ローカル開発ではローカルの D1（空）を使うため、初回にテーブルを作成してから起動します（シークレットは `.dev.vars` から読まれます）：
```sh
npx wrangler d1 execute routine-logger --local --file=schema.sql
npm run dev
```

### 本番リアルタイムログ監視
```sh
npx wrangler tail
```

---

## 他環境への移植性について

本ツールの本体（`src/index.js`）は外部 npm パッケージに依存せず、Web 標準の `Request` / `Response` API のみで実装されています。

Cloudflare Workers 固有の記述は以下の2点のみです：
1. エントリポイント: `export default { fetch(req, env) }`
2. データベースアクセス: `env.DB.prepare(...).bind(...).run() / .all()`

そのため、Deno、Bun、Node.js（Express や `@hono/node-server`、組み込み `node:sqlite`）への移植も、入出力および SQLite ラッパーを数十行追加するだけで容易に行えます。

---

## ライセンス

本ソフトウェアは [Apache License 2.0](LICENSE) の下で公開されています。
著作権表示については [NOTICE](NOTICE) を参照してください。
