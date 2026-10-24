import type { Metadata, Viewport } from "next";
import { Analytics } from '@vercel/analytics/next';
import "./globals.css";

export const metadata: Metadata = {
  title: "Smart Cabinet",
  description: "Scan · unlock · take · tracked. QR-controlled cabinet access.",
};

export const viewport: Viewport = {
  themeColor: "#1D1A16",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="smart-root">
        <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
          {children}
        </div>
        <Analytics />
      </body>
    </html>
  );
}
