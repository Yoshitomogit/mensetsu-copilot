/**
 * ブラウザからの WebSocket を受け、Gemini Live API に中継するローカルプロキシ。
 * API キーはこのプロセス環境変数のみに置く（ブラウザに出さない）。
 *
 * 注意: Next.js は .env.local を自動読込するが、このファイルは別プロセスで動くため、
 * 起動時に dotenv で .env.local / .env を読み込む。
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { GoogleGenAI, Modality, type LiveServerMessage } from "@google/genai";
import { WebSocketServer, type WebSocket } from "ws";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

const PORT = Number(process.env.LIVE_PROXY_PORT ?? 3001);
const apiKey = process.env.GEMINI_API_KEY?.trim();
const MODEL = process.env.GEMINI_LIVE_MODEL?.trim() ?? "gemini-2.0-flash-live-001";

/**
 * gemini-3.1-flash-live-preview 等のネイティブ音声 Live モデルは responseModalities: [TEXT] 非対応で、
 * 接続直後に 1011 "Internal error encountered" で閉じる（公式・SDK issue 参照）。
 * 既定: AUDIO + outputAudioTranscription でテキストを画面に出す。
 * 2.0 系など TEXT 直出しが動くモデルだけ使う場合は GEMINI_LIVE_TEXT_MODALITY=true
 */
const useLiveTextModality =
  String(process.env.GEMINI_LIVE_TEXT_MODALITY ?? "").toLowerCase() === "true";

if (!apiKey) {
  console.error(
    "[live-proxy] GEMINI_API_KEY が未設定です。.env.local にキーを書き、プロキシを再起動してください。",
  );
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

function buildSystemInstruction(knowledgeBrief: string): string {
  return `あなたは面接・面談のコパイロットです。ユーザーから届くテキストは「先方の発言（文字起こし・メモ）」または「こちらの補足メモ」です。

【面談用ナレッジ（ユーザーが貼り付けた要約・抜粋）】
${knowledgeBrief || "（未設定：ユーザーにナレッジの登録を促してください）"}

ルール:
- 先方への「回答のたたき台」を日本語で、フォーマルかつ自然な話し言葉で出す。
- ナレッジにない事実は捏造しない。「資料にないため確認が必要」などと明記する。
- まず短い段落で答え、必要なら箇条書きの要点を続ける。
- ユーザーが [先方の発言] と明示した行は、質問への回答を最優先する。`;
}

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function forwardModelMessage(ws: WebSocket, message: LiveServerMessage) {
  const sc = message.serverContent;
  const payload: Record<string, unknown> = { type: "live" };

  const t = message.text;
  if (t) payload.modelText = t;

  if (sc?.inputTranscription?.text) {
    payload.inputTranscription = sc.inputTranscription.text;
  }
  if (sc?.outputTranscription?.text) {
    payload.outputTranscription = sc.outputTranscription.text;
  }
  if (sc?.turnComplete) payload.turnComplete = true;
  if (sc?.interrupted) payload.interrupted = true;

  if (
    payload.modelText ||
    payload.inputTranscription ||
    payload.outputTranscription ||
    payload.turnComplete ||
    payload.interrupted
  ) {
    send(ws, payload);
  }
}

const wss = new WebSocketServer({ port: PORT });
console.log(
  `[live-proxy] ws://localhost:${PORT} (model: ${MODEL}, reply: ${useLiveTextModality ? "TEXT" : "AUDIO+transcription"})`,
);

wss.on("connection", (ws) => {
  let session: Awaited<ReturnType<typeof ai.live.connect>> | null = null;

  ws.on("message", async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      send(ws, { type: "error", message: "JSON として解析できません" });
      return;
    }

    try {
      if (msg.type === "init") {
        if (session) {
          try {
            session.close();
          } catch {
            /* ignore */
          }
          session = null;
        }

        const knowledgeBrief = String(msg.knowledgeBrief ?? "");
        const useInputTx = Boolean(msg.enableInputTranscription);

        try {
          session = await ai.live.connect({
            model: MODEL,
            callbacks: {
              onopen: () => send(ws, { type: "status", status: "live_open" }),
              onmessage: (m) => forwardModelMessage(ws, m),
              onerror: (e) =>
                send(ws, {
                  type: "error",
                  message: e?.message ?? String(e),
                }),
              onclose: (e) =>
                send(ws, {
                  type: "status",
                  status: "live_close",
                  reason: e?.reason ?? "",
                }),
            },
            config: {
              responseModalities: useLiveTextModality
                ? [Modality.TEXT]
                : [Modality.AUDIO],
              ...(!useLiveTextModality
                ? { outputAudioTranscription: {} }
                : {}),
              systemInstruction: buildSystemInstruction(knowledgeBrief),
              ...(useInputTx ? { inputAudioTranscription: {} } : {}),
            },
          });

          send(ws, { type: "status", status: "session_ready" });
        } catch (e) {
          session = null;
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error("[live-proxy] live.connect failed", e);
          send(ws, {
            type: "error",
            message: `Gemini Live 接続に失敗しました: ${errMsg}（モデル: ${MODEL}。.env.local の GEMINI_LIVE_MODEL を公式の Live 対応モデルに更新してください。）`,
          });
        }
        return;
      }

      if (!session) {
        send(ws, {
          type: "error",
          message: "セッションがありません。先に init を送ってください。",
        });
        return;
      }

      if (msg.type === "text") {
        const text = String(msg.text ?? "");
        const role = msg.role === "self" ? "self" : "interviewer";
        const prefix =
          role === "interviewer" ? "[先方の発言] " : "[こちらの補足] ";
        session.sendRealtimeInput({ text: prefix + text });
        return;
      }

      if (msg.type === "audio") {
        session.sendRealtimeInput({
          audio: {
            data: String(msg.data ?? ""),
            mimeType: "audio/pcm;rate=16000",
          },
        });
        return;
      }

      if (msg.type === "ping") {
        send(ws, { type: "pong" });
        return;
      }

      if (msg.type === "close") {
        session.close();
        session = null;
        send(ws, { type: "status", status: "closed" });
        return;
      }

      send(ws, { type: "error", message: `未知の type: ${msg.type}` });
    } catch (e) {
      send(ws, { type: "error", message: String(e) });
    }
  });

  ws.on("close", () => {
    if (session) {
      try {
        session.close();
      } catch {
        /* ignore */
      }
      session = null;
    }
  });
});
