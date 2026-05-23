# Netmarble Shop 自動受け取り

Netmarble Shop 日本版で、次の無料受け取りを GitHub Actions から自動実行します。

- 毎日: `毎日の魔法石ガチャ`
- 毎週: `ラグジュアリーガチャ`

## 仕組み

- Playwright で `https://slvshop.netmarble.com/ja/item` を開きます。
- ログイン済みセッションがあれば `PLAYWRIGHT_STORAGE_STATE_BASE64` を使います。
- ログイン状態でない場合は `NETMARBLE_EMAIL` / `NETMARBLE_PASSWORD` で自動ログインを試みます。
- GitHub Actions の cron でクラウド実行します。
- メールアドレス、パスワード、Cookie はコードに直接書きません。

## GitHub Secrets

GitHub リポジトリの `Settings` → `Secrets and variables` → `Actions` に追加します。

必須:

```text
NETMARBLE_EMAIL
NETMARBLE_PASSWORD
```

任意:

```text
PLAYWRIGHT_STORAGE_STATE_BASE64
```

`PLAYWRIGHT_STORAGE_STATE_BASE64` はログイン済みセッションです。なくても、メールアドレスとパスワードがあれば自動ログインを試みます。

## 初回セットアップ

依存関係を入れます。

```bash
npm install
npx playwright install chromium
```

ローカルでログイン状態を保存する場合:

```bash
npm run login
```

または、自動保存を使う場合:

```powershell
$env:AUTO_SAVE='true'
npm run login
```

最後に表示される base64 文字列を `PLAYWRIGHT_STORAGE_STATE_BASE64` に登録できます。

## 実行時刻

GitHub Actions の cron は UTC です。この設定では次の日本時間で実行されます。

- 毎日 09:37 JST: `毎日の魔法石ガチャ`
- 毎週 木曜 09:42 JST: `ラグジュアリーガチャ`

GitHub Actions の schedule は遅延することがあるため、混みやすい毎時直後を避けた時刻にしています。
時刻を変える場合は `.github/workflows/claim-netmarble-shop.yml` の cron を編集してください。

## 手動実行

GitHub Actions の `Run workflow` から `daily`、`weekly`、`both` を選べます。

ローカルで試す場合:

```bash
npm run claim:daily
npm run claim:weekly
```

ブラウザ表示でゆっくり確認する場合:

```powershell
$env:HEADLESS='false'
$env:SLOW_MO='2000'
$env:PAUSE_AFTER_DONE='15000'
npm run claim:daily
```

クリックせず検出だけ確認する場合:

```bash
DRY_RUN=true npm run claim:daily
```

## 注意

- CAPTCHA、メール認証、2段階認証、端末確認が出た場合は完全自動化できないことがあります。
- GitHub Actions は無料枠で使えますが、プライベートリポジトリではアカウントの無料分の実行時間を消費します。
- サイト側の UI 文言や仕様が変わると、セレクタ調整が必要になる場合があります。
- 自動化がサービス規約に反しない範囲で使ってください。
