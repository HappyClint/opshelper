import type { Metadata } from "next";
import { DM_Sans, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import { Toaster } from "sonner";

import { DialogHost } from "@/components/ui/dialog-host";
import { UploadFloater } from "@/components/upload-floater";

import "./globals.css";
import "./chat.css";
import "./chat-theme.css";
import "./app-theme.css";

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
});

const body = DM_Sans({
  subsets: ["latin"],
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "小信运维助手",
  description: "小信运维助手 opencode 智能助理网关。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`${display.variable} ${body.variable}`}>
        {children}
        <DialogHost />
        <UploadFloater />
        <Toaster
          position="bottom-right"
          richColors
          closeButton
          toastOptions={{ style: { fontFamily: "var(--font-body)" } }}
        />
      </body>
    </html>
  );
}
