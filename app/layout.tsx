import type { Metadata } from "next";
import "@fontsource-variable/dm-sans";
import "@fontsource/dm-serif-text/latin-400.css";
import "@fontsource/dm-serif-text/latin-400-italic.css";
import "./globals.css";
import { AppFrame } from "@/components/frame";

export const metadata: Metadata = {
  title: "CityBuddy — Your City. Your AI Companion.",
  description:
    "Choose a location, explore nearby places, and keep your shopping checklist with CityBuddy.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
