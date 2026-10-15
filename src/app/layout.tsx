import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";
import { RouteSync } from "@/components/route-sync";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TCMS — Test Case Management System",
  description: "Manage test cases, peer reviews, bugs, and daily QA work in one place.",
  keywords: ["TCMS", "test case", "QA", "reviews", "bugs"],
  authors: [{ name: "TCMS Team" }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <RouteSync />
        <Providers>{children}</Providers>
        <SonnerToaster position="top-right" />
      </body>
    </html>
  );
}
