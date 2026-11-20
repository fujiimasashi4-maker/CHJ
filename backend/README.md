# ニュースのコメント・写真投稿 API

`preview/_worker.js` を Cloudflare Pages の Advanced Mode Worker として使います。静的ファイルは `env.ASSETS.fetch(request)` に渡し、コメントと写真を1つのD1データベースに保存します。日本語・英語の画面で同じAPIを利用できます。

## 必要な設定

Cloudflare上で次の設定が必要です。この実装には稼働環境の認証値を含めていません。

1. Cloudflareの **Storage & databases → D1** で、このサイト用のデータベースを用意します。D1 Consoleで `backend/comments-schema.sql` のDDLを実行してください。画像のBLOBをSQL本文に埋め込む操作は不要です。
2. 対象Pagesプロジェクトの **Settings → Bindings** で、そのD1データベースを **`COMMENTS_DB`** という変数名にバインドします。プレビューと本番を利用する場合は、それぞれの設定対象を確認してください。
3. Pagesの **Settings → Variables and Secrets** に次の値を設定します。設定後は、その設定を利用するデプロイが必要です。

| 設定名 | 値 |
| --- | --- |
| `COMMENTS_RATE_LIMIT_SECRET` | 管理者が用意する32文字以上の秘密値。Secretとして保存します。IPをHMAC-SHA256に変換するために使います。 |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Zero Trustの実際のチームドメイン。形式は `<team>.cloudflareaccess.com`。同じHTTPS URL形式も受け付けます。 |
| `ACCESS_AUD` | 下記Accessアプリケーションに表示される **Application Audience (AUD)** の値。アプリ名やチーム名とは別の値です。 |
| `ADMIN_EMAILS` | `fujii.masashi.4@gmail.com`。複数管理者を設定する場合はメールアドレスをカンマ区切りで指定します。 |

4. Cloudflare Zero Trustの **Access → Applications** でSelf-hosted applicationを用意し、公開ホストの管理画面 **`/admin/` とその配下** および **`/api/admin/*`** を同一アプリケーションで保護します。Allow policyの対象を上記管理者メールに限定してください。管理画面へ移動した時点でログインさせ、認証された同一アプリケーションのセッションでAPIを呼び出します。認証後のAPIリクエストに `Cf-Access-Jwt-Assertion` が渡る構成にします。
5. サイトのアップロード対象ルートに `_worker.js` と `_routes.json` を含めてPagesへデプロイします。`_routes.json` では `/api/*` だけをWorkerに渡し、静的ページ・画像のリクエストを不要にWorkerへ渡しません。D1バインディング、スキーマ、変数がプレビュー／本番それぞれの想定環境に揃っていることを確認してください。

WorkerはAccess JWTをWeb Cryptoで検証します。RS256署名、設定済みissuer、AUD、期限`exp`、有効開始`nbf`、許可メールがすべて必要です。鍵は設定済みチームの `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` だけから取得し、JWTの`kid`で選びます。JWTに含まれる別の鍵URLやメールヘッダーは認証根拠に使いません。証明書は5分キャッシュし、未知の`kid`では前回取得から60秒後に再取得できます。 JWKS取得には`redirect: manual`を指定し、転送応答も拒否します。Workersでは`redirect: error`が未実装のため、`manual`と応答ステータス検証を組み合わせます（[Request仕様](https://developers.cloudflare.com/workers/runtime-apis/request/#properties)）。

## 公開API

対象ニュースIDは **`fsf-ashiya-2026-12-12`** です。追加するニュースはWorker側とスキーマの許可値を合わせて変更します。

### `GET /api/comments?news=fsf-ashiya-2026-12-12`

承認済み投稿だけを、新しい順に返します。`limit`は既定20、最大50です。次ページは返された`next_cursor`を`cursor`パラメーターに渡してください。同一時刻の投稿もIDで安定して並びます。

```json
{
  "comments": [
    {
      "id": "投稿UUID",
      "name": "表示名",
      "comment": "コメント本文",
      "created_at": "2026-11-20T12:00:00.000Z",
      "photo_url": "/api/photos/投稿UUID"
    }
  ],
  "next_cursor": null
}
```

`photo_url`は写真がある投稿だけに含まれます。公開一覧には承認状態、IPハッシュ、写真BLOB、受付キー、内部の更新時刻を含めません。名前とコメントはプレーンテキストです。画面への挿入には`textContent`等を使ってください。

### `POST /api/comments`

同じオリジンの画面から`multipart/form-data`で送ります。`Origin`ヘッダーがリクエストURLのオリジンと完全一致する必要があります。通常はブラウザの`fetch`が付与します。ブラウザで`Content-Type`を手動設定するとboundaryが欠落するため、`FormData`をそのまま`body`に渡してください。

| フィールド | 条件 |
| --- | --- |
| `news` | 上記ニュースID。必須。 |
| `name` | 必須。前後の空白を除いて1〜80 Unicode文字。制御文字を拒否します。 |
| `comment` | 前後の空白を除いて最大2000 Unicode文字。空欄は写真がある場合に利用できます。 |
| `photo` | 任意。JPEG・PNG・WebP。宣言MIMEとマジックバイトの一致が必要です。最大750,000 bytes。 |
| `website` | honeypot。正規の利用者は空欄にします。 |
| `request_id` | 任意のUUID。同じ入力の再送時は同じ値を使います。 |

本文または写真を必須とし、リクエスト全体はmultipartの境界等を含めて1,000,000 bytes以内です。`Content-Length`がない場合も読み込み中に上限を検証します。画像は署名と基本的なコンテナ識別を検証し、画像全体のデコードや再圧縮は行いません。SVG・HTML・HEIC等は受け付けません。

成功時はHTTP **202** と `{ "id": "投稿UUID", "status": "pending" }` を返します。これは受付済みのreceiptです。初回保存時は必ず`pending`になります。同じ`request_id`、ニュース、IPのHMAC、本文・写真指紋の再送は、同じIDを返し、投稿制限を再加算しません。後から承認・却下されていても、再送のreceiptの`status`は`pending`です。受付キーを別IPや別内容に使うと409になります。キーなしの再送は新規投稿です。

honeypotが埋まった送信には同じ形式のreceiptを返し、保存しません。同じIPからの新規受付はローリング24時間で10件、10分で3件までです。制限の判定と保存を1つのSQLで行い、同時投稿時も上限を守ります。429の`Retry-After: 600`は再試行の目安であり、24時間制限ではその後も429になり得ます。

生のIPは保存・ログ出力しません。Cloudflareが渡す`CF-Connecting-IP`から秘密値を用いてHMACを作ります。次の新規／再送処理時に24時間より古いレコードの`ip_hash`をNULLにします。投稿がない期間には、この遅延消去は実行されません。ハッシュ消去後または秘密値変更後には以前の受付キーを照合できず、409を返します。

### `GET /api/photos/:id`

承認済み投稿の写真だけを返します。未承認・却下・存在しないIDは404です。保存時に判定した固定の`image/jpeg`・`image/png`・`image/webp`を返し、`nosniff`と`Cross-Origin-Resource-Policy: same-origin`を付与します。レスポンスを`no-store`にし、却下後にキャッシュ済み写真が新たに配信されることを防ぎます。

## 管理API

すべての管理APIは上記Access JWT検証を通過する必要があります。

| 操作 | リクエストとレスポンス |
| --- | --- |
| 一覧 | `GET /api/admin/comments?status=pending&limit=20&cursor=...`。status既定は`pending`、`approved`・`rejected`も指定可。各投稿に`status`・`news`・`moderated_at`（ISO日時またはnull）を追加。レスポンスの`counts`は全件の`pending`・`approved`・`rejected`・`total`で、ページング対象外の件数も含みます。写真URLは`/api/admin/photos/:id`です。 |
| 写真確認 | `GET /api/admin/photos/:id`。承認待ち・承認済み・却下済みの保存写真を認証付きで確認できます。 |
| 承認／却下 | `POST /api/admin/comments/:id`。`Content-Type: application/json`、同一オリジン必須。管理画面は`{"status":"approved","expected_status":"pending","expected_moderated_at":null}`のように、一覧で確認した状態と最終処理日時を必ず送信します。DB上の状態と一致した場合だけ保存。不一致は409 `state_conflict`。成功は`id`・`status`・`moderated_at`を返します。 |

最終処理日時は保存のたびに進むため、別画面で処理された古い確認内容による上書きを防ぎます。期待値は必ず2項目を組にし、日時は一覧が返した標準ISO文字列またはnullをそのまま使います。過去のクライアント向け`{"status":"approved"}`形式は互換性のため利用可能ですが、競合検出はありません。新規実装では必ず期待値を送信してください。日時・件数は一般公開APIには追加しません。

### 日常の確認手順

管理URLは https://chjapan.com/admin/ です。許可された本人のCloudflareアカウントでログインします。URLをブックマークし、定期的に「最新の投稿を確認」を押してください。新着メールの自動通知はありません。

1. 「確認待ち」の件数を押して一覧を開き、対象ニュース・表示名・本文・写真を確認します。
2. 「確認して公開」を押し、ダイアログの全文と写真を確認して「この内容で公開する」を押します。写真がある場合、画像の読込成功まで公開確定はできません。
3. 掲載しない投稿は「非公開にする」を選びます。削除せず保存し、後から再公開できます。
4. 取り下げは「公開済み」から「非公開にする」で行います。

処理後は状態と件数を再取得します。別画面で処理済み、通信失敗、ログインHTMLへの転送を保存成功として扱いません。保存結果が不明な場合は、ダイアログを閉じて最新一覧で状態を確認してください。最終処理日時は直近の処理を示し、操作の全履歴や処理者別の監査記録ではありません。

## エラーと未設定時の動作

JSONエラーは一貫して `{ "error": "安定したコード" }` を返します。画面はコードから表示言語を選べます。HTTPリダイレクト後のログインHTML等を成功扱いせず、期待するJSONとID・状態を確かめてください。

| HTTP | error |
| --- | --- |
| 400 | `invalid_news`, `invalid_name`, `invalid_comment`, `content_required`, `invalid_photo`, `invalid_form`, `invalid_request_id`, `invalid_cursor`, `invalid_limit`, `invalid_status`, `invalid_json`, `invalid_expectation` |
| 403 | `origin_required`, `forbidden` |
| 404 | `not_found` |
| 405 | `method_not_allowed` |
| 409 | `request_conflict`, `state_conflict` |
| 413 | `payload_too_large`, `photo_too_large` |
| 429 | `rate_limited` |
| 503 | `service_unavailable` |

D1未設定・スキーマ未適用・DB障害ではコメント／写真APIは503になります。投稿用秘密値やCloudflareのクライアントIPが利用できない場合も投稿は503です。Access設定不足、署名・claims不正、許可外メール、証明書取得失敗は管理APIを403で拒否します。API以外の静的ページは通常どおり配信します。CORSの許可ヘッダーを返さず、異なるオリジンからの更新を拒否します。

写真はD1に保存され、D1とWorkersには利用中プランの容量・実行上限が適用されます。投稿レコードと写真の自動削除機能は含めていません。データ確認用のSQLでは`SELECT id, name, comment, status, length(photo) AS photo_bytes FROM comments`などを使い、BLOB全体や秘密値をクエリログへ出力しないでください。

## ローカル検証

Node.js 24以降で、追加パッケージを入れずに実行できます。

```sh
node --test tests/comments-worker.test.mjs tests/comments-admin.test.mjs
```

テストは`node:sqlite`のインメモリDBに実スキーマを適用し、WorkerのSQLをそのまま実行します。D1のインターフェースだけをアダプターで再現します。RSA鍵はテストプロセス内の一時鍵です。Cloudflare上の実バインディング、実際のAccessログイン、Pagesへのアップロード後の動作は、実環境での設定と確認が必要です。

参考にした公式仕様は[Pages Advanced Mode](https://developers.cloudflare.com/pages/functions/advanced-mode/)、[D1 Prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)、[Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)です。
