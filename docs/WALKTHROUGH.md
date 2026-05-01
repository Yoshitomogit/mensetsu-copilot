# 面談コパイロット Walkthrough

このドキュメントは、初回から **面談セッションで回答案を出すところ**までを手順追いで説明します。

## 前提

- Node.js 20 以上推奨
- [Google AI Studio](https://aistudio.google.com/) 等で取得した **Gemini API キー**（課金設定はご自身の枠に合わせて）
- ブラウザは Chrome / Edge / Safari 近傍（マイク利用時は許可ダイアログが出ます）

## 1. リポジトリと環境変数

**プロジェクトのルート**は、お手元では **`面接用アプリ` フォルダ**です（パス例: `…/ポートフォリオ/面接用アプリ`）。以降の `npm` コマンドは、このフォルダをカレントディレクトリにして実行してください。

初回だけ GitHub から取る場合は、既定ではフォルダ名が `mensetsu-copilot` になります。

```bash
git clone https://github.com/Yoshitomogit/mensetsu-copilot.git
cd mensetsu-copilot
cp .env.example .env.local
```

すでに **`面接用アプリ`** にコードがある場合は、そのフォルダへ移動してから同様にします。

```bash
cd "/Users/…/ポートフォリオ/面接用アプリ"   # ご自身のパスに合わせる
cp .env.example .env.local
```

`.env.local` を編集します。

| 変数 | 必須 | 説明 |
|------|------|------|
| `GEMINI_API_KEY` | はい | Gemini API キー |
| `GEMINI_LIVE_MODEL` | いいえ | 既定: `gemini-2.0-flash-live-001`（テキスト応答。公式のモデル一覧が変わったら更新） |
| `LIVE_PROXY_PORT` | いいえ | 既定: `3001` |
| `NEXT_PUBLIC_LIVE_WS_URL` | いいえ | 既定: `ws://localhost:3001` |

## 2. 依存関係と起動

```bash
npm install
npm run dev
```

以下が立ち上がります。

- **Next.js**: http://localhost:3000  
- **Live WebSocket プロキシ**: `ws://localhost:3001`（`LIVE_PROXY_PORT` で変更可）

ターミナルに `[live-proxy] ws://localhost:3001` と出ていればプロキシは正常です。

## 3. 画面の流れ（推奨操作順）

### 3.1 準備ドキュメントを貼る

1. セクション **「1. 準備ドキュメント」** に、職務経歴・志望動機・想定 Q&A など **長めの下書き**を貼り付けます。
2. **「要約してナレッジに反映」** をクリックします。  
   - 裏で `POST /api/brief` が動き、`gemini-2.0-flash` が **面談用の短いナレッジ**に圧縮します。
3. セクション **「2. 面談ナレッジ」** に結果が入ります。**そのまま手編集しても構いません**（重要事実の修正・追記はここで）。

### 3.2 Live セッションを開く

1. （任意）**「音声入力の文字起こしも受け取る」** にチェックを入れると、マイク経由入力の認識テキストもログに流れやすくなります（課金・レイテンシに影響し得ます）。
2. **「Live セッション開始」** をクリックします。
3. 下部 **ログ** に `status: session_ready` と出れば、Gemini Live とのセッションが開けています。

うまくいかない場合:

- `.env.local` の `GEMINI_API_KEY` を再確認
- `npm run dev:live` 単体のログにエラーが出ていないか確認
- 公式で **モデル名や Live の提供範囲**が変わっていないか [モデル一覧](https://ai.google.dev/gemini-api/docs/models) を確認し、`GEMINI_LIVE_MODEL` を更新

### 3.3 先方の発言を送る

**テキスト（推奨・確実）**

1. **「先方の発言（メモ）」** に、Zoom/Teams の字幕やメモから **コピペ**します。
2. **「送信」** をクリックします。

**マイク**

1. **「マイク送信開始」** をクリックし、ブラウザのマイク許可を出します。
2. 端末の入力デバイス次第では **会議相手の声より自分の声が強く**入ります。相手の声を拾いたい場合は OS の **仮想オーディオ（BlackHole 等）** で会議アプリの出力をマイクに割り当てる必要があります（上級者向け）。

### 3.4 回答案を読む

- **「4. 回答案」** に、モデルからのテキストがストリーミング風に追記されます。
- ターンの区切りではログに `ターン完了` が出ます。

### 3.5 終了

- **「切断」** で WebSocket とマイクを止めます。面談が長い場合は [セッション時間の制限](https://ai.google.dev/gemini-api/docs/live-guide) に注意し、必要なら再接続してください。

## 4. アーキテクチャ（理解用）

```
ブラウザ  ←→  ws://localhost:3001  ←→  server/live-proxy.ts  ←→  Gemini Live API
                （API キーはサーバー側のみ）

ブラウザ  ←→  http://localhost:3000/api/brief  ←→  Gemini generateContent（要約）
```

## 5. 関連ドキュメント

- [面談コパイロット実装計画.md](./面談コパイロット実装計画.md) … 背景・方針・リスク
- [Gemini Live API](https://ai.google.dev/gemini-api/docs/live)
- [料金](https://ai.google.dev/gemini-api/docs/pricing)
