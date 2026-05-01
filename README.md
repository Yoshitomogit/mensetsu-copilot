# 面談コパイロット（Gemini Live API）

**リポジトリ**: https://github.com/Yoshitomogit/mensetsu-copilot

面接・面談中に、**準備ドキュメント**を根拠として **Gemini Live API** へリアルタイムに入力し、**回答のたたき台**をテキストで受け取るローカル向け Web アプリです。

- **Next.js 15**（UI・`/api/brief` でのナレッジ要約）
- **Node WebSocket プロキシ**（`server/live-proxy.ts`）で API キーをブラウザ外に保持し、Live API に中継

詳細なセットアップ手順は [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md) を参照してください。

## クイックスタート

プロジェクトルート（お手元では **`面接用アプリ` フォルダ**）で実行します。

```bash
cp .env.example .env.local
# .env.local に GEMINI_API_KEY を設定

npm install
npm run dev
```

ブラウザで http://localhost:3000 を開き、`docs/WALKTHROUGH.md` の順に操作してください。

## スクリプト

| コマンド | 説明 |
|----------|------|
| `npm run dev` | Next.js（3000）と Live プロキシ（3001）を同時起動 |
| `npm run dev:next` | Next のみ |
| `npm run dev:live` | プロキシのみ |
| `npm run build` | 本番ビルド |
| `npm run clean` | `.next` を削除（ビルドキャッシュ不整合の修復に使用） |
| `npm run build:clean` | `clean` のあと `next build` |

## トラブルシュート

### `Cannot find module './586.js'` などランタイムでチャンクが見つからない

`.next` のキャッシュと実体のズレが原因のことが多いです。

```bash
npm run clean
npm run dev
```

本番起動（`next start`）の前に不整合が出た場合は次でから作り直します。

```bash
npm run build:clean
npm start
```

コード変更や `npm install` のあとに古い `npm start` を動かし続けていると起きやすいです。**必ず同じ `.next` に対応したビルドを取ってから** `next start` してください。

## ライセンス・注意

面談の録音・文字起こしは相手・会議の方針に従ってください。API キーは `.env.local` のみに保存し、リポジトリにコミットしないでください。
