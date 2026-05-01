import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;
/** キャッシュや古い応答の混線を避ける */
export const dynamic = "force-dynamic";

/** response.text / candidates から本文を拾う（型は API 応答に依存するため寛容に扱う） */
function extractBriefText(response: unknown): string {
  if (!response || typeof response !== "object") return "";

  try {
    const r = response as {
      text?: string;
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const direct = typeof r.text === "string" ? r.text.trim() : "";
    if (direct) return direct;

    const parts = r.candidates?.[0]?.content?.parts;
    if (!parts?.length) return "";

    return parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
  } catch {
    return "";
  }
}

export async function POST(request: Request) {
  let model = process.env.GEMINI_BRIEF_MODEL?.trim() || "gemini-2.5-flash";

  try {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "GEMINI_API_KEY が設定されていません。.env.local にキーを書き、ターミナルで dev サーバーを停止してから `npm run dev` をやり直してください。",
        },
        { status: 500 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch (e) {
      return NextResponse.json(
        {
          error: `リクエスト本文が JSON として読めませんでした: ${e instanceof Error ? e.message : String(e)}`,
        },
        { status: 400 },
      );
    }

    const rawText =
      typeof body === "object" &&
      body !== null &&
      "rawText" in body &&
      typeof (body as { rawText: unknown }).rawText === "string"
        ? (body as { rawText: string }).rawText
        : null;

    if (!rawText?.trim()) {
      return NextResponse.json({ error: "rawText が必要です" }, { status: 400 });
    }

    model = process.env.GEMINI_BRIEF_MODEL?.trim() || "gemini-2.5-flash";

    let GoogleGenAI: typeof import("@google/genai").GoogleGenAI;
    try {
      ({ GoogleGenAI } = await import("@google/genai"));
    } catch (e) {
      console.error("[api/brief] import @google/genai failed", e);
      return NextResponse.json(
        {
          error: `Gemini SDK の読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}。node_modules を再インストールしてください（rm -rf node_modules && npm install）。`,
        },
        { status: 500 },
      );
    }

    const ai = new GoogleGenAI({ apiKey });
    const clipped = rawText.slice(0, 200_000);

    const prompt = `以下は面接・面談用の下書き・関連メモの全文です。
これを Live API の system instruction に埋め込めるよう、日本語で **8000 文字以内**の「面談ナレッジ」に再構成してください。

構成（見出し付き）:
1. 経歴・立場の要点
2. 志望・意欲
3. スキル・実績（箇条書き、STAR があれば）
4. 想定質問と回答の骨子
5. 逆質問の候補
6. 触れるべきでない事項・要確認事項

---
${clipped}
`;

    let response: unknown;
    try {
      response = await ai.models.generateContent({
        model,
        contents: prompt,
      });
    } catch (e) {
      console.error("[api/brief] generateContent", e);
      const message = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        {
          error: `${message}（モデル: ${model}。GEMINI_BRIEF_MODEL を gemini-3-flash-preview 等に変更して試してください。）`,
        },
        { status: 502 },
      );
    }

    const block =
      response &&
      typeof response === "object" &&
      "promptFeedback" in response &&
      (response as { promptFeedback?: { blockReason?: unknown } })
        .promptFeedback?.blockReason;

    if (block) {
      return NextResponse.json(
        {
          error: `入力が安全フィルタでブロックされました（${String(block)}）。内容を短くするか表現を変えて再度お試しください。`,
        },
        { status: 400 },
      );
    }

    const brief = extractBriefText(response);
    if (!brief) {
      const finish =
        response &&
        typeof response === "object" &&
        "candidates" in response &&
        Array.isArray((response as { candidates?: unknown[] }).candidates)
          ? (response as { candidates: Array<{ finishReason?: unknown }> })
              .candidates[0]?.finishReason
          : undefined;

      return NextResponse.json(
        {
          error: `モデルからテキストが取得できませんでした。finishReason: ${finish ?? "不明"}。モデル ${model} が利用可能か確認し、GEMINI_BRIEF_MODEL を変更してください。`,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ brief, modelUsed: model });
  } catch (fatal) {
    console.error("[api/brief] fatal", fatal);
    return NextResponse.json(
      {
        error:
          (fatal instanceof Error ? fatal.message : String(fatal)) +
          "（予期しないエラー。ターミナルのサーバーログを確認し、`npm run clean && npm run dev` を試してください。）",
      },
      { status: 500 },
    );
  }
}
