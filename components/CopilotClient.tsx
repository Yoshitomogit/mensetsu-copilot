"use client";

import {
  arrayBufferToBase64,
  downsampleBuffer,
  floatTo16BitPCM,
} from "@/lib/audioPcm";
import { useCallback, useEffect, useRef, useState } from "react";

const liveWsUrl = () =>
  process.env.NEXT_PUBLIC_LIVE_WS_URL ?? "ws://localhost:3001";

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

  const wsRef = useRef<WebSocket | null>(null);
  const micOnRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  const appendLog = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString("ja-JP");
    setLog((prev) => [...prev.slice(-180), `[${stamp}] ${line}`]);
  }, []);

  const runBrief = async () => {
    setBriefLoading(true);
    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText: rawDoc }),
      });
      const data: { brief?: string; error?: string } = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setKnowledgeBrief(data.brief ?? "");
      appendLog("要約ナレッジを更新しました");
    } catch (e) {
      appendLog(`要約エラー: ${e instanceof Error ? e.message : e}`);
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
  }, [stopMic]);

  const startSession = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      appendLog("既に接続中です");
      return;
    }
    setAnswer("");
    const ws = new WebSocket(liveWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
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
          if (data.status === "session_ready") setSessionActive(true);
          if (data.status === "closed" || data.status === "live_close") {
            setSessionActive(false);
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
          appendLog(`APIエラー: ${String(data.message)}`);
        }
      } catch {
        appendLog(`受信: ${String(ev.data)}`);
      }
    };

    ws.onerror = () => appendLog("WebSocket エラー");
    ws.onclose = () => {
      setSessionActive(false);
      appendLog("WebSocket 切断");
      wsRef.current = null;
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
    return () => {
      stopSession();
    };
  }, [stopSession]);

  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/80 p-5 shadow-lg backdrop-blur">
        <h2 className="text-sm font-medium uppercase tracking-wider text-[var(--muted)]">
          1. 準備ドキュメント
        </h2>
        <p className="mt-1 text-xs text-[var(--muted)]">
          長文を貼り付け、「要約して反映」で Gemini が面談用ナレッジに圧縮します（右上のナレッジ欄を直接編集しても構いません）。
        </p>
        <textarea
          value={rawDoc}
          onChange={(e) => setRawDoc(e.target.value)}
          placeholder="職務経歴・志望動機・想定QA など..."
          rows={8}
          className="mt-3 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none ring-[var(--accent)] placeholder:text-[var(--muted)] focus:ring-2"
        />
        <button
          type="button"
          onClick={() => void runBrief()}
          disabled={briefLoading || !rawDoc.trim()}
          className="mt-3 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:bg-[var(--accent-dim)] disabled:opacity-40"
        >
          {briefLoading ? "要約中..." : "要約してナレッジに反映"}
        </button>
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/80 p-5 shadow-lg backdrop-blur">
        <h2 className="text-sm font-medium uppercase tracking-wider text-[var(--muted)]">
          2. 面談ナレッジ（Live に渡す要約）
        </h2>
        <textarea
          value={knowledgeBrief}
          onChange={(e) => setKnowledgeBrief(e.target.value)}
          rows={10}
          className="mt-3 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none ring-[var(--accent)] focus:ring-2"
        />
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-[var(--muted)]">
          <input
            type="checkbox"
            checked={enableInputTx}
            onChange={(e) => setEnableInputTx(e.target.checked)}
            className="rounded border-[var(--border)]"
          />
          音声入力の文字起こしも受け取る（inputAudioTranscription / 課金増の可能性あり）
        </label>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={startSession}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Live セッション開始
          </button>
          <button
            type="button"
            onClick={stopSession}
            className="rounded-lg border border-[var(--border)] bg-transparent px-4 py-2 text-sm text-[var(--text)] hover:bg-[var(--border)]/30"
          >
            切断
          </button>
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
              sessionActive
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-[var(--border)] text-[var(--muted)]"
            }`}
          >
            {sessionActive ? "セッション接続中" : "未接続"}
          </span>
        </div>
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/80 p-5 shadow-lg backdrop-blur">
        <h2 className="text-sm font-medium uppercase tracking-wider text-[var(--muted)]">
          3. 入力（テキスト / マイク）
        </h2>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-xs text-[var(--muted)]">先方の発言（メモ）</label>
            <textarea
              value={interviewerText}
              onChange={(e) => setInterviewerText(e.target.value)}
              rows={4}
              className="mt-1 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none ring-[var(--accent)] focus:ring-2"
            />
            <button
              type="button"
              onClick={() => sendText("interviewer")}
              className="mt-2 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs text-white"
            >
              送信
            </button>
          </div>
          <div>
            <label className="text-xs text-[var(--muted)]">こちらの補足メモ</label>
            <textarea
              value={selfText}
              onChange={(e) => setSelfText(e.target.value)}
              rows={4}
              className="mt-1 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none ring-[var(--accent)] focus:ring-2"
            />
            <button
              type="button"
              onClick={() => sendText("self")}
              className="mt-2 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text)]"
            >
              補足を送る
            </button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {!micOn ? (
            <button
              type="button"
              onClick={() => void startMic()}
              disabled={!sessionActive}
              className="rounded-lg bg-violet-600 px-4 py-2 text-sm text-white hover:bg-violet-700 disabled:opacity-40"
            >
              マイク送信開始
            </button>
          ) : (
            <button
              type="button"
              onClick={stopMic}
              className="rounded-lg border border-violet-400 px-4 py-2 text-sm text-violet-200"
            >
              マイク停止
            </button>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/80 p-5 shadow-lg backdrop-blur">
        <h2 className="text-sm font-medium uppercase tracking-wider text-[var(--muted)]">
          4. 回答案（モデル出力）
        </h2>
        <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 text-sm leading-relaxed text-[var(--text)]">
          {answer || "…セッション開始後、ここにストリーミングで溜まります"}
        </pre>
        <button
          type="button"
          onClick={() => setAnswer("")}
          className="mt-2 text-xs text-[var(--muted)] underline"
        >
          回答欄をクリア
        </button>
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 p-4">
        <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
          ログ
        </h2>
        <pre className="mt-2 max-h-40 overflow-auto font-mono text-[11px] text-[var(--muted)]">
          {log.length ? log.join("\n") : "—"}
        </pre>
      </section>
    </div>
  );
}
