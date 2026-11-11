# 設計ナレッジ / Knowledge Studio

設計ナレッジ入庫基盤のデモアプリです。画面は日本語、フロントエンドは React + Vite、API は Express で構成しています。データ保存先はローカル JSON または Supabase PostgreSQL です。AI/OCR などの外部 API は使用しません。

ログインは Express + SimpleWebAuthn の Passkey に更新しました。最新要件に合わせ、個別招待ではなく会社メール確認によるセルフ登録を標準にします。[中文部署・迁移・自助注册操作手册](docs/LOGIN_SECURITY.md)を参照してください。`npm run dev:passkey` は一時的なテスト DB と模擬メール受信箱を使い、本番 DB や実メールには接続しません。

## 公開範囲と情報管理

- GitHub リポジトリは ABIST 関係者向けの Private として管理します。リポジトリの公開設定は、ソースコードを閲覧できる人を制限するものであり、デプロイした Web サイトのアクセス制限とは別です。
- Vercel/Render に公開 URL を設定しても、Supabase モードではログインと `memberships` の登録が必要です。API は認証済みユーザーの所属プロジェクトを確認してからデータを返します。未認証ユーザーにもログイン画面や静的ファイルは表示されます。
- ABIST の Google Workspace、SSO、GitHub チームなどとの自動連携はありません。会社メール `@abist.co.jp` に届く8桁コードを確認した後に Passkey を作成し、既定 workspace へ `designer` として参加します。日常登録に管理者招待は不要です。実メールには SMTP2GO Free の設定と送信者検証が必要です。
- `DEMO_MODE=true` はローカル JSON と組み込みデモアカウントを使います。Supabase に接続する場合は `DEMO_MODE=false` にしてください。
- パスワードログインと未確認メールの即時登録は無効です。セッションは DB に永続化し、ブラウザーには HttpOnly / Secure / SameSite=Lax Cookie のみ保存します。変更 API は Origin と CSRF トークンを検証します。HTTP loopback の開発時のみ Secure を省略します。
- `CLIENT_ORIGIN` はブラウザーからのクロスオリジン通信を制御しますが、ユーザー認証やアクセス許可の代わりにはなりません。
- Supabase の `service_role` キーは Render のサーバー環境変数だけに設定します。GitHub、Vercel、ブラウザー、README に登録しないでください。`.env` とローカルデータは Git の対象外です。
- Vercel、Render、Supabase のプロジェクトは、継続運用できる ABIST 管理アカウント/チームに所有させ、複数の管理者と MFA を設定してください。ユーザー名を `sakura050601` に統一する必要はありませんが、今回は各サービスを `sakura050601` の管理下に作成する方針です。

## ローカル起動

Node.js 22 以降を使用します。

```sh
npm ci
cp .env.example .env
npm run dev
```

フロントエンド: http://127.0.0.1:5173
API: http://127.0.0.1:3001

ローカルデモの初期パスワードは `knowledge-demo` です。`DEMO_PASSWORD` で変更できます。データは `.data/state.json` に保存されます。Supabase モードではデモ用アカウントは使えません。

| アカウント | ロール | 用途 |
|---|---|---|
| 藤井 美咲 | designer | 投稿、前段確認、改訂 |
| 田中 健一 | designer | 最終確認 |
| 佐藤 直樹 | senior | シニア設計者として最終確認 |
| 山本 葵 | viewer | 読み取り専用の確認 |

デモには架空の資料だけを使用してください。

## デモ手順

1. 藤井でログインし、「新規登録」を開きます。
2. 「サンプル」を選び、保存への同意後にデモ抽出を開始します。
3. 条件、判断、理由、根拠、未確認事項を確認します。候補を選択して確認するか、「どちらでもない・保留」を選んで草案として保存します。
4. 確認経路を設定します。最終確認者には田中と佐藤を指定します。前段ステップの追加、順序、担当者の変更もできます。
5. 申請後、藤井で前段の確認を完了します。
6. 田中、佐藤の順にログインし、重要度・優先度・主/副を選んで承認します。両者の選択が一致すると、承認済みのコア知識が登録されます。
7. 前段で理由を入力して差し戻すこともできます。藤井で補足を追加して新しい版を作成し、再申請します。承認済みのスナップショットは上書きされません。

## 実装範囲と制約

- 実際の AI/OCR、動画・図面解析はありません。内蔵サンプルのみ固定の模擬結果を返します。任意の資料は保存できますが、不完全な抽出結果を承認して入庫することはできません。
- カード本文は読み取り専用です。補足資料は未確認事項などに反映され、新しい版になります。
- raw、cards、cores は Supabase の単一 JSONB 集約内に保存されます。小規模デモ向けの構成です。大量データや本番業務では、独立テーブルとトランザクションへの移行を検討してください。
- 添付ファイルは Base64 で原資料と一緒に保存します。少量デモ向けです。本番では非公開 Storage、署名付き URL、ウイルススキャン、容量制限を導入してください。
- 権限はプロジェクト単位の `designer` / `senior` / `viewer` / `it` です。本人確認後に自分の `designer` / `it` を切り替えられます。IT は投稿や自分の資料改訂は可能ですが承認・差戻し・却下はできず、担当する待審査カードは役割変更時に申請者へ差し戻します。ユーザーによる senior 昇格は認めません。Passkey では UV を必須にします。
- 各ユーザーが利用できるのは最初に参加したプロジェクトです。プロジェクト切り替え、複雑な分岐、代理承認、通知、催促はありません。
- 操作履歴は業務記録であり、改ざん防止を保証する監査ログではありません。承認済みコアの有効版切り替えも未実装です。

## Supabase の準備

1. 既存 DB をバックアップしてから、Supabase SQL Editor で `supabase/schema.sql` を実行します。既存のユーザー ID、メンバー権限、資料は維持します。再実行可能です。
2. ローカル `.env` に `SUPABASE_URL`、サーバー専用の `SUPABASE_SERVICE_ROLE_KEY`、固定の `AUTH_ORIGIN` を設定し、`DEMO_MODE=false` にします。
3. `npm run auth:init` で空の workspace を初期化します。既存データは上書きせず、デモアカウントも作成しません。本番では `seed:demo` を使いません。
4. SMTP2GO Free で送信者を検証し、サーバー専用の `MAIL_FROM`、`SMTP2GO_API_KEY`、32文字以上のランダムな `EMAIL_CODE_SECRET` を設定します。未設定や送信障害では新規登録を拒否します。既存 Render の Environment に手動で追加してください。
5. 最新コードを GitHub に反映して Render にデプロイし、同一 origin で frontend/API を提供します。利用者は「会社メールで新規登録」から登録します。旧招待/復旧コマンドは移行・緊急運用用に残っていますが通常登録には使いません。

```dotenv
DEMO_MODE=false
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_SERVICE_ROLE_KEY
AUTH_ORIGIN=https://YOUR_SERVICE.onrender.com
NODE_ENV=production
VITE_API_URL=
MAIL_FROM=YOUR_VERIFIED_SENDER_EMAIL
SMTP2GO_API_KEY=YOUR_SERVER_ONLY_MAIL_KEY
EMAIL_CODE_SECRET=YOUR_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
```

旧 `seed:demo` の `.test` アカウントは会社メール登録対象外です。不要なテストメンバーを公開前に削除してください。既存の会社メールのアカウントと権限は維持します。RLS は有効ですがサーバー用 Secret / service-role key は RLS を迂回するため、API サーバーと運用担当者の環境以外には登録しないでください。

## Render へのデプロイ

1. Render に `sakura050601` が管理するアカウント/チームでログインし、Private GitHub リポジトリへのアクセスを許可します。
2. New Web Service から `sakura050601/abkp-demo` を選択します。Blueprint を使う場合は `render.yaml` を使用します。
3. Build Command は `npm ci --include=dev && VITE_API_URL= npm run build`、Start Command は `npm start`、Health Check は `/api/health` です。`NODE_ENV=production` でもビルド時には Vite の開発依存が必要です。既存サービスの Settings も手動で更新してください。Node.js 22 を使用します。
4. Supabase の `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`DEMO_MODE=false`、`NODE_ENV=production` を設定します。`AUTH_ORIGIN` は Render の固定 HTTPS URL（末尾 `/` なし）です。`VITE_API_URL` は空にします。`WEBAUTHN_RP_ID` は省略時に origin の hostname を使用します。旧環境変数が残っている場合は削除するか同じ hostname にしてください。
5. Render は `/` でフロントエンド、`/api/*` で API を提供します。`/api/health` が `mode: supabase` を返すことを確認します。

本番データを Render のローカル JSON ファイルに保存しないでください。インスタンスのファイルは永続ストレージではありません。

## 同一 Origin の要件

Passkey 版は Render の単一 HTTPS URL を標準にします。旧構成の Vercel frontend → 別 origin の Render API への直接通信は利用できません。SameSite=Lax とホスト限定 Cookie を維持するためです。Vercel を残す場合は別途同一 origin の reverse proxy が必要で、今回の検証対象外です。`vercel.json` は旧静的 frontend 用に残していますが、Passkey 版のデプロイ手順では使いません。

Render Free は空閑時に停止し、Supabase Free は長期間不使用時に pause されます。無料枠内の小規模な公開試運用向けであり、24時間稼働や SLA は保証しません。課金、追加サービス、keep-alive による制限回避は導入しません。

## 検証

```sh
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

自動テストでメール確認、コード失効・回数制限、Passkey の実署名、CSRF、IT 権限、永続セッション、復旧、同時登録、承認フローを検証します。ブラウザーテストはセルフ登録、役割変更、固定メール接尾辞と desktop/mobile を検証します。実メール配送、Supabase migration、公開 HTTPS での実端末認証は別途確認が必要です。

## CAD 検証データ

[supabase/seed-cad-demo.sql](supabase/seed-cad-demo.sql) は、日本語の架空 CAD 設計ナレッジを追加する独立 SQL です。最新版の schema 適用と既定 workspace の初期化後、対象の Demo DB をバックアップしてから Supabase SQL Editor で全体を実行します。アプリの再デプロイは不要です。このファイルを生成しただけではオンライン DB にデータは入りません。

12件のカードと12件の原資料を追加し、干渉、公差、板金、工具空間、配線、BOM、図面改訂などを扱います。草案4件、確認待ち3件、差戻し1件、却下1件、模擬承認済み3件に加え、改訂前の版1を含む4件のコアスナップショットと操作履歴を作成します。すべて「検証用」であり、実製品の設計根拠や正式承認ではありません。

既存の資料・カードは保持し、同じ検証データの再実行はスキップします。ID や人物の衝突、必要な配列の欠落があれば処理を中止して全体をロールバックします。専用の `.invalid` メールの表示用人物4名を追加しますが、パスワード・Passkey は作成せず、実ユーザーの役割も変更しません。模擬人物へのログインはできません。実ユーザーで承認操作を試す際は、登録済みユーザーで別の資料を作成し、実際のメンバーを担当者として設定してください。

SQL の確認は `node --test tests/cad-demo.test.js` で実行できます。既存データの保持、再実行、承認条件、版管理、衝突時のロールバックを一時 PostgreSQL で検証します。

## Microsoft Teams 接続

Supabase モードでは、現在のアカウントに Microsoft Teams を接続し、チャネルの投稿と返信を原資料・草案として取り込めます。デモモードではチャットの読み取り専用プレビューを提供します。Entra の権限、環境変数、DB 設定、ローカル起動手順は [Teams 接続・インポート設定](docs/TEAMS_SETUP.md) を参照してください。

## 主なファイル

- `client/src/main.jsx`: 画面と操作
- `client/src/style.css`: レスポンシブスタイル
- `server/index.js`: API、認証、認可、データ保存
- `shared/domain.js`: 業務状態、承認、版管理
- `supabase/schema.sql`: テーブル、RLS、初期設定例
- `tests/`: ドメインテストと HTTP 統合テスト

## 参考

- [元資料: Google Slides](https://docs.google.com/presentation/d/1wnOicA2zf2KJPgIFTbBYNBGJ1xapCg7GmaaJZzQEp7E/edit)
- [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite)
- [Deploy Node Express on Render](https://render.com/docs/deploy-node-express-app)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase user management](https://supabase.com/docs/guides/auth/managing-user-data)