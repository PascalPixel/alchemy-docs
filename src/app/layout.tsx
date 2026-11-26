import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import { Lit } from '@/components/lit';
import { siteUrl } from '@/lib/shared';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = { metadataBase: new URL(siteUrl), icons: { icon: '/icon.svg', apple: '/home-icon/180.png' } };

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <head>
        <script async src="/js/script.js" />
        <script dangerouslySetInnerHTML={{ __html: 'window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init({endpoint:"/api/event"})' }} />
      </head>
      <body className="flex flex-col min-h-screen">
        <Lit />
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
