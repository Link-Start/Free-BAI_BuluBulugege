import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "号池机 — Bank of AI Pool",
  description: "Bank of AI API Key Pool Manager",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
