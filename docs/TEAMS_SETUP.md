# Teams チャネルのインポート：ローカル起動とデプロイ

初版では、現在のアプリのアカウントに Microsoft の職場・学校アカウントを接続し、チームとチャネルを選択できます。スレッドのページ表示、1回につき最大10スレッド（返信を含む）の原資料・草案への取り込み、登録済みスレッドのスキップ、接続解除に対応します。チャネルのインポートでは個人チャット、添付ファイル本体、自動同期、知識抽出は対象外です。メッセージの HTML はエスケープされたテキストとして表示し、元のメッセージと返信は `source.messages` に保持します。登録済みスレッドを再選択してもスキップされ、後から追加された返信は自動更新しません。

## Microsoft Entra の設定

1. 会社の Entra テナントでシングルテナントの Web アプリを登録し、Web リダイレクト URI を設定します。ローカルでは `http://localhost:3001/` を推奨します。本番では実際のアプリの HTTPS ルート URL（末尾の `/` を含む）を指定します。SPA ではなく Web として登録してください。
2. Microsoft Graph の**委任されたアクセス許可（Delegated）**として `User.Read`、`Team.ReadBasic.All`、`Channel.ReadBasic.All`、`ChannelMessage.Read.All` を追加します。認証時には `offline_access` も要求します。必要な同意をテナント管理者に依頼してください。Microsoft の個人アカウントではチャネルを読み取れません。
3. クライアントシークレットを作成し、サーバー専用の `.env` に保存します。`TEAMS_TENANT_ID`、`TEAMS_CLIENT_ID`、`TEAMS_CLIENT_SECRET`、`TEAMS_REDIRECT_URI` を設定してください。
4. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` で `TEAMS_TOKEN_KEY` を生成し、`.env` に保存します（64桁の16進数）。トークンは AES-256-GCM で暗号化して DB に保存します。この鍵を失うと再接続が必要です。Git にコミットしないでください。
5. Supabase SQL Editor で [teams.sql](../supabase/teams.sql) を実行します。接続テーブルを読み取れるのは `service_role` のみです。接続情報は現在のアプリの `user_id` ごとに分離します。

## ローカル起動

既存の Supabase・ログイン設定を使用し、`DEMO_MODE=false`、`AUTH_ORIGIN=http://localhost:3001`、`TEAMS_REDIRECT_URI=http://localhost:3001/` を設定し、`VITE_API_URL` は空にします。`WEBAUTHN_RP_ID` は未設定または `localhost` にしてください。`npm run build` の後に `npm start` を実行し、http://localhost:3001 にアクセスします。Passkey はサイトに紐づくため、本番サイトの Passkey をそのまま localhost では使用できません。ローカル用の登録・認証が必要です。実際の Supabase に接続した場合、操作はその DB に反映されます。

`DEMO_MODE=true` では、参加しているチャットの読み取り専用プレビューを利用できます。チャネルのインポートは利用できず、表示したチャットメッセージは保存しません。このモードでは Entra に `User.Read` と `Chat.Read` の委任されたアクセス許可を設定してください。`offline_access` は要求せず、有効期限が切れた場合は再接続します。接続情報はログインセッションごとにプロセスのメモリに保持し、再起動すると失われます。実際の Teams 認証には Entra の設定が必要です。デモモードを本番にデプロイしないでください。

Supabase モードでは、ヘッダーのアバターまたはサイドバーのアカウント表示から「個人設定」を開き、「プラットフォーム連携」の「Azure / Microsoft Entra」で Teams の接続ボタンを押します。Microsoft で同意すると自動的にアプリへ戻ります。チームとチャネルを選択して投稿を読み込み、最大10スレッドと共有・保存への同意を選択して取り込みます。「原資料ライブラリ」で原文を、「知識カード」で草案を確認できます。AWS と Team Cloud は準備中です。

## 検証とデプロイ

`npm test` と `npm run build` を実行します。実際のテナントでは、認証の成功・拒否、アカウントごとの接続情報の分離、ページ表示、返信付きスレッド、重複取り込み、`viewer` による取り込みの禁止、接続解除と再接続を確認してください。デモモードでは、ログインセッションごとの分離、チャットのページ表示、有効期限切れによる再接続を確認してください。Entra の認証情報がない場合は準備中の表示となり、実テナントとの接続成功を確認したことにはなりません。

ローカルで確認してからコミット・デプロイします。デプロイ前に `teams.sql` を適用し、バックエンドのデプロイ先で必要な `TEAMS_*` 環境変数と本番のリダイレクト URI を設定してください。ビルド・起動方法は既存のプロジェクト設定を使用します。シークレットとトークン暗号化鍵は環境ごとに別のものを使用してください。

現在は、各バッチの読み取りと処理が完了した後に業務状態を一括保存します。エラー時はそのバッチを保存しません。HTTP 429 の場合は時間を置いて再試行するよう案内します。1スレッドあたり最大1000返信・250000文字までで、上限を超える場合はエラーを表示して取り込みを拒否します。大規模なバックグラウンド処理や差分同期は今後の拡張が必要です。

## 公式資料

- https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/chatmessage-list-replies
