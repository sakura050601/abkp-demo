# 設計ナレッジ / Knowledge Studio

設計ナレッジ入庫基盤のデモアプリです。画面は日本語、フロントエンドは React + Vite、API は Express で構成しています。データ保存先はローカル JSON または Supabase PostgreSQL です。AI/OCR などの外部 API は使用しません。

## 公開範囲と情報管理

- GitHub リポジトリは ABIST 関係者向けの Private として管理します。リポジトリの公開設定は、ソースコードを閲覧できる人を制限するものであり、デプロイした Web サイトのアクセス制限とは別です。
- Vercel/Render に公開 URL を設定しても、Supabase モードではログインと `memberships` の登録が必要です。API は認証済みユーザーの所属プロジェクトを確認してからデータを返します。未認証ユーザーにもログイン画面や静的ファイルは表示されます。
- ABIST の Google Workspace、SSO、GitHub チームなどとの自動連携はありません。Supabase の `app_users` と `memberships` でアカウントと権限を管理します。登録したユーザーはデフォルトのワークスペースに `designer` として参加します。
- `DEMO_MODE=true` はローカル JSON と組み込みデモアカウントを使います。Supabase に接続する場合は `DEMO_MODE=false` にしてください。
- Supabase モードの簡易登録はメール認証なしで、誰でも登録できます。テスト専用です。本番公開前に招待制、メール確認、パスワード再設定、永続セッションを追加してください。
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
- 権限はプロジェクト単位の `designer` / `senior` / `viewer` です。ファイル単位の機密区分、組織 SSO、MFA、細かな ACL は未実装です。プロジェクトメンバーは同じプロジェクトの資料を閲覧できます。
- 各ユーザーが利用できるのは最初に参加したプロジェクトです。プロジェクト切り替え、複雑な分岐、代理承認、通知、催促はありません。
- 操作履歴は業務記録であり、改ざん防止を保証する監査ログではありません。承認済みコアの有効版切り替えも未実装です。

## Supabase の準備

1. Supabase SQL Editor で `supabase/schema.sql` を実行します。旧 schema から `app_users` へ移行し、`memberships.user_id` は Supabase Auth ではなく自前のユーザー表を参照します。再実行可能です。
2. ローカル `.env` に `SUPABASE_URL` とサーバー専用の `SUPABASE_SERVICE_ROLE_KEY` を設定し、`DEMO_MODE=false` にします。
3. `npm run seed:demo` を一度実行します。workspace、UUID 自動生成の demo アカウント、初期カードを作成します。既存のデモユーザーのパスワードや既存のカードデータは上書きしません。
4. Render に同じ Supabase URL/service-role key を設定し、`DEMO_MODE=false` にしてデプロイします。

```dotenv
DEMO_MODE=false
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_SERVICE_ROLE_KEY
CLIENT_ORIGIN=https://YOUR_FRONTEND.vercel.app
```

デモログインは `author@example.test`、`reviewer@example.test`、`senior@example.test`、`viewer@example.test`、初期パスワードはすべて `knowledge-demo` です。公開環境で seed を実行すると既知のテストアカウントが作られるため、テスト後は削除またはパスワード変更してください。RLS は有効ですが、サーバーの `service_role` は RLS を迂回するため、Render 以外には登録しないでください。

## Render へのデプロイ

1. Render に `sakura050601` が管理するアカウント/チームでログインし、Private GitHub リポジトリへのアクセスを許可します。
2. New Web Service から `sakura050601/abkp-demo` を選択します。Blueprint を使う場合は `render.yaml` を使用します。
3. Blueprint の build command は依存関係を入れて Vite をビルドし、Start command は `npm start`、Health check は `/api/health` です。Node.js 22 を使用します。
4. Supabase の `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` と `DEMO_MODE=false` を Render に設定します。`CLIENT_ORIGIN` には利用するフロントエンド origin を設定します。
5. Render は `/` でフロントエンド、`/api/*` で API を提供します。`/api/health` が `mode: supabase` を返すことを確認します。

本番データを Render のローカル JSON ファイルに保存しないでください。インスタンスのファイルは永続ストレージではありません。

## Vercel へのフロントエンドデプロイ

1. Vercel に `sakura050601` が管理するアカウント/チームでログインし、同じ Private GitHub リポジトリへのアクセスを許可します。
2. リポジトリを Import します。Framework は Vite、Build command は `npm run build`、Output Directory は `dist` です。`vercel.json` を含みます。
3. `VITE_API_URL=https://YOUR_API.onrender.com` を環境変数に設定します。末尾に `/` は付けません。変更後は再デプロイします。
4. `SUPABASE_SERVICE_ROLE_KEY` は Vercel に設定しません。アカウント登録と認証は Render API が処理します。

Vercel は任意の独立 frontend として使えます。Render 上の frontend/API は同一 origin です。Vercel を使う場合は `VITE_API_URL=https://YOUR_API.onrender.com` を設定します。

## 検証

```sh
npm test
npm run build
```

10件のテストで、独自アカウント登録、パスワードハッシュ、ログイン、権限、承認経路、同時更新、差し戻し、拒否、ログアウトなどを検証します。Supabase の実プロジェクトへの migration/seed は手順に沿って実行してください。

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