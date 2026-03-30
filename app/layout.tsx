import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LinkedIn automation",
  description: "Daily Buffer queue via Vercel cron endpoint",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 24 }}>
        {children}
      </body>
    </html>
  );
}
