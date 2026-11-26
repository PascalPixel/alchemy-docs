import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import { Lit } from '@/components/lit';
import { siteUrl } from '@/lib/shared';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = { metadataBase: new URL(siteUrl), icons: '/icon.svg' };

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Lit />
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
