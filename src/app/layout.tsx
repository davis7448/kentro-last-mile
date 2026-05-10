import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kentro",
  description: "Centro operativo para ultima milla, Shopify, transportistas y wallets"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
