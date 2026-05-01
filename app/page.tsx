import { CopilotClient } from "@/components/CopilotClient";

export default function Home() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-8 border-b border-[var(--border)] pb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">
          面談コパイロット
        </h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          準備ドキュメントと Gemini Live API で、先方の発言に対する回答案をリアルタイムに生成します。
        </p>
      </header>
      <CopilotClient />
    </main>
  );
}
