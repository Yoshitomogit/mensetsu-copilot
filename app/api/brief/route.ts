import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY が設定されていません" },
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
      model: "gemini-2.0-flash",
      contents: prompt,
    });
    const brief = response.text?.trim() ?? "";
    if (!brief) {
      return NextResponse.json(
        { error: "モデルから空の応答でした" },
        { status: 502 },
      );
    }
    return NextResponse.json({ brief });
  } catch (e) {
    console.error("[api/brief]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
