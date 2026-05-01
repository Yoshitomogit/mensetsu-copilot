import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

/** response.text が空でも、candidates から本文を拾う */
function extractBriefText(response: GenerateContentResponse): string {
  const direct = response.text?.trim();
  if (direct) return direct;

  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts?.length) return "";

  return parts
    .map((p) => ("text" in p && typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "GEMINI_API_KEY が設定されていません。.env.local にキーを書き、dev サーバーを再起動してください。",
      },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON が不正です" }, { status: 400 });
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

  const model =
    process.env.GEMINI_BRIEF_MODEL?.trim() || "gemini-2.5-flash";

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

  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
    });

    const block = response.promptFeedback?.blockReason;
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
      const finish = response.candidates?.[0]?.finishReason;
      return NextResponse.json(
        {
          error: `モデルからテキストが取得できませんでした。finishReason: ${finish ?? "不明"}。モデル ${model} が利用可能か（API キー・リージョン・提供終了）を確認し、必要なら .env.local の GEMINI_BRIEF_MODEL を変更してください。`,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ brief, modelUsed: model });
  } catch (e) {
    console.error("[api/brief]", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        error: `${message}（モデル: ${model}。gemini-2.0-flash は提供終了している場合があります。GEMINI_BRIEF_MODEL=gemini-2.5-flash または gemini-3-flash-preview などを試してください。）`,
      },
      { status: 502 },
    );
  }
}
