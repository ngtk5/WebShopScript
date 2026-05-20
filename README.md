# Netmarble Shop 自動受け取り

Netmarble Shop 日本版で、次の無料受け取りを GitHub Actions から自動実行します。

- 毎日: `毎日の魔法石ガチャ`
- 毎週: `ラグジュアリーガチャ`

## 仕組み

- Playwright で `https://slvshop.netmarble.com/ja/item` を開きます。
- ログイン済みブラウザセッションを `storage/state.json` として使います。
- GitHub Actions の cron でクラウド実行します。
- コード上に ID、パスワード、Cookie を直接書きません。

## 初回セットアップ

1. 依存関係を入れます。

```bash
npm install
npx playwright install chromium
```

2. ローカルでログイン状態を保存します。

```bash
npm run login
```

ブラウザが開いたら Netmarble Shop に手動ログインし、ターミナルで Enter を押してください。
最後に表示される長い文字列をコピーします。

3. GitHub リポジトリの Secret に追加します。

Secret 名:

```text
PLAYWRIGHT_STORAGE_STATE_BASE64
```

値:

```text
npm run login の最後に表示された base64 文字列
```

4. `.github/workflows/claim-netmarble-shop.yml` を含めて GitHub に push します。

## 実行時刻

GitHub Actions の cron は UTC です。この設定では日本時間で実行されます。

- 毎日 00:05 JST: `毎日の魔法石ガチャ`
- 毎週 月曜 00:10 JST: `ラグジュアリーガチャ`

時刻を変える場合は `.github/workflows/claim-netmarble-shop.yml` の cron を編集してください。

## 手動実行

GitHub Actions の `Run workflow` から `daily`、`weekly`、`both` を選べます。

ローカルで試す場合:

```bash
npm run claim:daily
npm run claim:weekly
```

クリックせず検出だけ確認する場合:

```bash
DRY_RUN=true npm run claim:daily
```

## 注意

- ログインセッションが切れたら、もう一度 `npm run login` を実行して Secret を更新してください。
- GitHub Actions は無料枠で使えますが、プライベートリポジトリではアカウントの無料分の実行時間を消費します。
- サイト側の UI 文言や仕様が変わると、セレクタ調整が必要になる場合があります。
- 自動化がサービス規約に反しない範囲で使ってください。
