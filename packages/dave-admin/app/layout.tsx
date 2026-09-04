import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dave — Admin Panel",
  description: "Monitoring and configuration for Dave. Trading actions happen via Telegram only.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
