import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { getCurrentSession } from "@/lib/auth";
import { ImpersonationBanner } from "./ImpersonationBanner";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Snapcast Studio",
  description: "AI-powered content generation for event and photography businesses",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const session = await getCurrentSession();

  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {session?.impersonatedByAccountId && <ImpersonationBanner clientName={session.account.businessName} />}
        {children}
      </body>
    </html>
  );
}
