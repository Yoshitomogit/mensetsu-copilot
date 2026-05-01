import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "面談コパイロット",
  description: "Gemini Live API を用いた面接・面談サポート",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className="antialiased">{children}</body>
    </html>
  );
}
