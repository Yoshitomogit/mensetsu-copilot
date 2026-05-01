import { CopilotClient } from "@/components/CopilotClient";

export default function Home() {
  return (
    <main className="relative z-10 mx-auto max-w-4xl px-4 py-10 md:px-6 md:py-14">
      <header className="animate-fade-rise border-b border-[var(--border)] pb-10 md:pb-12">
        <p className="font-display text-xs font-medium tracking-[0.2em] text-[var(--accent)]">
          INTERVIEW COPILOT
        </p>
        <h1 className="font-display mt-3 text-3xl font-semibold leading-tight text-[var(--text)] md:text-4xl">
          面談コパイロット
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[var(--muted)] md:text-base">
          準備ドキュメントをナレッジに圧縮し、
          <span className="text-[var(--text)]">Gemini Live API</span>
          へつなぐ。先方の発言に追いつく回答案を、タイポと余白で集中して扱える画面です。
        </p>
      </header>
      <CopilotClient />
    </main>
  );
}
