"use client";

import {
  arrayBufferToBase64,
  downsampleBuffer,
  floatTo16BitPCM,
} from "@/lib/audioPcm";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

const liveWsUrl = () =>
  process.env.NEXT_PUBLIC_LIVE_WS_URL ?? "ws://localhost:3001";

function staggerStyle(i: number): CSSProperties | undefined {
  if (i === 0) return undefined;
  return { animationDelay: `${i * 75}ms` };
}

export function CopilotClient() {
  const [rawDoc, setRawDoc] = useState("");
  const [knowledgeBrief, setKnowledgeBrief] = useState("");
  const [briefLoading, setBriefLoading] = useState(false);
  const [enableInputTx, setEnableInputTx] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [interviewerText, setInterviewerText] = useState("");
  const [selfText, setSelfText] = useState("");
  const [answer, setAnswer] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [micOn, setMicOn] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** startSession 内で同期的に参照する（OPEN でも session_ready 前は false のことがある） */
  const sessionActiveRef = useRef(false);
  const micOnRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  /** Strict Mode 開発時の「疑似アンマウント」では Live を切らない（0ms 後にキャンセル） */
  const teardownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const appendLog = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString("ja-JP");
    setLog((prev) => [...prev.slice(-180), `[${stamp}] ${line}`]);
  }, []);

  const runBrief = async () => {
    setBriefLoading(true);
    setBriefError(null);
    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText: rawDoc }),
      });

      const rawBody = await res.text();
      let data: { brief?: string; error?: string; modelUsed?: string } = {};
      try {
        data = JSON.parse(rawBody) as typeof data;
      } catch {
        throw new Error(
          res.ok
            ? "サーバー応答が JSON ではありません。開発サーバー（npm run dev）を起動し直してください。"
            : `HTTP ${res.status}: ${rawBody.slice(0, 200)}`,
        );
      }

      if (!res.ok) {
        if (rawBody.trim().startsWith("<!DOCTYPE") || rawBody.trim().startsWith("<html")) {
          throw new Error(
            "サーバーが JSON ではなく HTML エラーページを返しました。ターミナルで Next の赤いエラーを確認し、`npm run clean` のあと `npm run dev` を再起動してください。",
          );
        }
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const brief = data.brief ?? "";
      if (!brief.trim()) {
        throw new Error("要約テキストが空です。API の応答をログに確認してください。");
      }

      setKnowledgeBrief(brief);
      appendLog(
        `要約ナレッジを更新しました（${brief.length} 文字${data.modelUsed ? ` / ${data.modelUsed}` : ""}）`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBriefError(msg);
      appendLog(`要約エラー: ${msg}`);
    } finally {
      setBriefLoading(false);
    }
  };

  const stopMic = useCallback(() => {
    setMicOn(false);
    micOnRef.current = false;
    workletRef.current?.disconnect();
    workletRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
  }, []);

  const stopSession = useCallback(() => {
    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
    stopMic();
    try {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "close" }));
      }
    } catch {
      /* ignore */
    }
    wsRef.current?.close();
    wsRef.current = null;
    setSessionActive(false);
    sessionActiveRef.current = false;
  }, [stopMic]);

  useEffect(() => {
    sessionActiveRef.current = sessionActive;
  }, [sessionActive]);

  const startSession = () => {
    const existing = wsRef.current;
    if (existing) {
      const rs = existing.readyState;
      if (rs === WebSocket.CONNECTING) {
        appendLog("接続処理中です。完了をお待ちください");
        return;
      }
      if (rs === WebSocket.CLOSING) {
        appendLog("切断処理中です。少し待ってから再度「Live セッション開始」を押してください");
        return;
      }
      if (rs === WebSocket.OPEN) {
        if (sessionActiveRef.current) {
          appendLog("既に接続中です");
          return;
        }
        appendLog(
          "WebSocket は開いたままですが Live が未確立です。再接続します（前回は init 失敗や応答欠落の可能性があります）",
        );
        if (connectTimerRef.current) {
          clearTimeout(connectTimerRef.current);
          connectTimerRef.current = null;
        }
        stopMic();
        try {
          existing.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
        setSessionActive(false);
        sessionActiveRef.current = false;
      }
      if (rs === WebSocket.CLOSED) {
        wsRef.current = null;
      }
    }

    setLiveError(null);
    setAnswer("");
    const url = liveWsUrl();
    appendLog(`WebSocket 接続試行: ${url}`);

    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    connectTimerRef.current = setTimeout(() => {
      connectTimerRef.current = null;
      if (ws.readyState !== WebSocket.OPEN) {
        const msg =
          "WebSocket が開きませんでした。ターミナルに「[live-proxy] ws://localhost:3001」が表示されているか確認し、**`npm run dev`**（Next と Live プロキシの同時起動）で起動してください。`npm run dev:next` だけでは Live は使えません。";
        setLiveError(msg);
        appendLog(msg);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (wsRef.current === ws) wsRef.current = null;
      }
    }, 12_000);

    ws.onopen = () => {
      if (connectTimerRef.current) {
        clearTimeout(connectTimerRef.current);
        connectTimerRef.current = null;
      }
      appendLog("WebSocket 接続済み。Gemini Live へ init を送信中…");
      ws.send(
        JSON.stringify({
          type: "init",
          knowledgeBrief,
          enableInputTranscription: enableInputTx,
        }),
      );
    };

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string) as Record<string, unknown>;
        if (data.type === "status") {
          appendLog(`status: ${String(data.status)}`);
          if (data.status === "session_ready") {
            setSessionActive(true);
            sessionActiveRef.current = true;
            setLiveError(null);
          }
          if (data.status === "closed" || data.status === "live_close") {
            setSessionActive(false);
            sessionActiveRef.current = false;
            if (data.status === "live_close" && data.reason) {
              appendLog(`Live 終了: ${String(data.reason)}`);
            }
          }
        } else if (data.type === "live") {
          if (typeof data.modelText === "string" && data.modelText) {
            setAnswer((prev) => prev + data.modelText);
          }
          if (typeof data.inputTranscription === "string") {
            appendLog(`入力認識: ${data.inputTranscription}`);
          }
          if (typeof data.outputTranscription === "string") {
            setAnswer((prev) => prev + data.outputTranscription);
          }
          if (data.turnComplete) {
            appendLog("ターン完了");
            setAnswer((prev) => (prev.endsWith("\n\n") ? prev : prev + "\n\n"));
          }
        } else if (data.type === "error") {
          const em = String(data.message ?? "不明なエラー");
          setLiveError(em);
          appendLog(`APIエラー: ${em}`);
        }
      } catch {
        appendLog(`受信: ${String(ev.data)}`);
      }
    };

    ws.onerror = () => {
      if (connectTimerRef.current) {
        clearTimeout(connectTimerRef.current);
        connectTimerRef.current = null;
      }
      const msg =
        "WebSocket でエラーが発生しました（接続拒否・タイムアウトなど）。`npm run dev` を実行しているターミナルに [live-proxy] の行があるか確認してください。";
      setLiveError(msg);
      appendLog(msg);
    };

    ws.onclose = (ev) => {
      if (connectTimerRef.current) {
        clearTimeout(connectTimerRef.current);
        connectTimerRef.current = null;
      }
      setSessionActive(false);
      sessionActiveRef.current = false;
      appendLog(`WebSocket 切断 (code=${ev.code}${ev.reason ? `, ${ev.reason}` : ""})`);
      if (wsRef.current === ws) wsRef.current = null;
    };
  };

  const sendText = (role: "interviewer" | "self") => {
    const text = role === "interviewer" ? interviewerText : selfText;
    if (!text.trim()) return;
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendLog("セッション未接続です");
      return;
    }
    socket.send(JSON.stringify({ type: "text", role, text }));
    if (role === "interviewer") setInterviewerText("");
    else setSelfText("");
  };

  useEffect(() => {
    micOnRef.current = micOn;
  }, [micOn]);

  const startMic = async () => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendLog("先に Live セッションを開始してください");
      return;
    }
    try {
      const AC =
        window.AudioContext ||
        (
          window as unknown as {
            webkitAudioContext: typeof AudioContext;
          }
        ).webkitAudioContext;
      const ctx = new AC({ sampleRate: 48000 });
      await ctx.audioWorklet.addModule("/pcm-processor.js");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      mediaStreamRef.current = stream;
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "pcm-processor");

      node.port.onmessage = (ev) => {
        if (
          !micOnRef.current ||
          !wsRef.current ||
          wsRef.current.readyState !== WebSocket.OPEN
        )
          return;
        const float32 = ev.data as Float32Array;
        const down = downsampleBuffer(float32, ctx.sampleRate, 16000);
        if (down.length === 0) return;
        const pcm = floatTo16BitPCM(down);
        const b64 = arrayBufferToBase64(pcm);
        wsRef.current.send(JSON.stringify({ type: "audio", data: b64 }));
      };

      source.connect(node);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(ctx.destination);

      audioContextRef.current = ctx;
      workletRef.current = node;
      setMicOn(true);
      micOnRef.current = true;
      appendLog("マイク送信開始（PCM 16kHz）");
    } catch (e) {
      appendLog(`マイク開始失敗: ${e instanceof Error ? e.message : e}`);
    }
  };

  useEffect(() => {
    if (teardownTimerRef.current !== null) {
      clearTimeout(teardownTimerRef.current);
      teardownTimerRef.current = null;
    }

    const onPageHide = () => {
      stopSession();
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      teardownTimerRef.current = setTimeout(() => {
        teardownTimerRef.current = null;
        stopSession();
      }, 0);
    };
  }, [stopSession]);

  return (
    <div className="flex flex-col gap-8 md:gap-10">
      <section className="copilot-card animate-fade-rise p-5 md:p-6">
        <div className="flex flex-wrap items-start gap-3">
          <span className="step-badge shrink-0">1</span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-lg font-semibold text-[var(--text)]">
              準備ドキュメント
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted)] md:text-sm">
              長文を貼り付け、「要約して反映」でナレッジに圧縮します。生成後のテキストは次のステップでそのまま編集できます。
            </p>
          </div>
        </div>
        <textarea
          value={rawDoc}
          onChange={(e) => {
            setRawDoc(e.target.value);
            setBriefError(null);
          }}
          placeholder="職務経歴・志望動機・想定QA など..."
          rows={8}
          className="copilot-input mt-4"
        />
        {briefError ? (
          <p
            className="mt-3 rounded-lg border border-[var(--danger)]/50 bg-[var(--danger)]/10 px-3 py-2 text-sm text-[#f0c4c4]"
            role="alert"
          >
            {briefError}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void runBrief()}
          disabled={briefLoading || !rawDoc.trim()}
          className="btn-primary mt-4"
        >
          {briefLoading ? "要約中…" : "要約してナレッジに反映"}
        </button>
      </section>

      <section
        className="copilot-card animate-fade-rise p-5 md:p-6"
        style={staggerStyle(1)}
      >
        <div className="flex flex-wrap items-start gap-3">
          <span className="step-badge shrink-0">2</span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-lg font-semibold text-[var(--text)]">
              面談ナレッジ（Live に渡す要約）
            </h2>
          </div>
        </div>
        <textarea
          value={knowledgeBrief}
          onChange={(e) => setKnowledgeBrief(e.target.value)}
          rows={10}
          className="copilot-input mt-4"
        />
        <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm text-[var(--muted)]">
          <input
            type="checkbox"
            checked={enableInputTx}
            onChange={(e) => setEnableInputTx(e.target.checked)}
            className="mt-1 accent-[var(--accent)]"
          />
          <span>
            音声入力の文字起こしも受け取る（
            <code className="text-[11px] text-[var(--accent)]">
              inputAudioTranscription
            </code>
            ・課金に影響することがあります）
          </span>
        </label>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button type="button" onClick={startSession} className="btn-live">
            Live セッション開始
          </button>
          <button type="button" onClick={stopSession} className="btn-ghost">
            切断
          </button>
          <span
            className={`inline-flex items-center rounded-full border px-3.5 py-1 text-xs font-semibold ${
              sessionActive
                ? "border-[var(--live)]/50 bg-[var(--live)]/15 text-[var(--live)]"
                : "border-[var(--border)] text-[var(--muted)]"
            }`}
          >
            <span
              className={`mr-2 h-1.5 w-1.5 rounded-full ${
                sessionActive ? "animate-pulse bg-[var(--live)]" : "bg-[var(--muted)]"
              }`}
              aria-hidden
            />
            {sessionActive ? "接続中" : "未接続"}
          </span>
        </div>
        {liveError ? (
          <p
            className="mt-4 rounded-lg border border-[var(--danger)]/50 bg-[var(--danger)]/10 px-3 py-2 text-sm text-[#f0c4c4]"
            role="alert"
          >
            {liveError}
          </p>
        ) : null}
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">
          Live は <code className="text-[var(--accent)]">ws://localhost:3001</code>{" "}
          のプロキシ経由です。<strong className="text-[var(--text)]">
            npm run dev
          </strong>{" "}
          で Next とプロキシを同時起動してください（.env.local の API
          キーはプロキシ側でも読み込みます）。
        </p>
      </section>

      <section
        className="copilot-card animate-fade-rise p-5 md:p-6"
        style={staggerStyle(2)}
      >
        <div className="flex flex-wrap items-start gap-3">
          <span className="step-badge shrink-0">3</span>
          <div>
            <h2 className="font-display text-lg font-semibold text-[var(--text)]">
              入力（テキスト / マイク）
            </h2>
          </div>
        </div>
        <div className="mt-4 grid gap-6 md:grid-cols-2 md:gap-8">
          <div>
            <label className="text-xs font-medium tracking-wide text-[var(--accent)]">
              先方の発言
            </label>
            <textarea
              value={interviewerText}
              onChange={(e) => setInterviewerText(e.target.value)}
              rows={4}
              className="copilot-input mt-2"
            />
            <button
              type="button"
              onClick={() => sendText("interviewer")}
              className="btn-primary mt-3 text-xs"
            >
              送信
            </button>
          </div>
          <div>
            <label className="text-xs font-medium tracking-wide text-[var(--muted)]">
              こちらの補足
            </label>
            <textarea
              value={selfText}
              onChange={(e) => setSelfText(e.target.value)}
              rows={4}
              className="copilot-input mt-2"
            />
            <button
              type="button"
              onClick={() => sendText("self")}
              className="btn-ghost mt-3 text-xs"
            >
              補足を送る
            </button>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap gap-3 border-t border-[var(--border)] pt-6">
          {!micOn ? (
            <button
              type="button"
              onClick={() => void startMic()}
              disabled={!sessionActive}
              className="btn-mic"
            >
              マイク送信開始
            </button>
          ) : (
            <button type="button" onClick={stopMic} className="btn-ghost">
              マイク停止
            </button>
          )}
        </div>
      </section>

      <section
        className="copilot-card animate-fade-rise p-5 md:p-6"
        style={staggerStyle(3)}
      >
        <div className="flex flex-wrap items-start gap-3">
          <span className="step-badge shrink-0">4</span>
          <div>
            <h2 className="font-display text-lg font-semibold text-[var(--text)]">
              回答案
            </h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              ストリーミングで追記されます。
            </p>
          </div>
        </div>
        <pre className="copilot-input mt-4 max-h-[min(420px,50vh)] overflow-auto whitespace-pre-wrap text-[13px] leading-relaxed md:text-sm">
          {answer || "セッション開始後、ここに表示されます。"}
        </pre>
        <button
          type="button"
          onClick={() => setAnswer("")}
          className="mt-3 text-xs text-[var(--muted)] underline decoration-[var(--border)] underline-offset-4 transition hover:text-[var(--text)]"
        >
          回答欄をクリア
        </button>
      </section>

      <section
        className="copilot-card animate-fade-rise border-dashed opacity-95 p-4 md:p-5"
        style={staggerStyle(4)}
      >
        <h2 className="font-display text-xs font-semibold tracking-wider text-[var(--muted)]">
          ログ
        </h2>
        <pre className="mt-3 max-h-36 overflow-auto font-mono text-[10px] leading-snug text-[var(--muted)]">
          {log.length ? log.join("\n") : "—"}
        </pre>
      </section>
    </div>
  );
}
