import type { MetadataRoute } from 'next';
import { appName } from '@/lib/shared';

export const dynamic = 'force-static';

// What an Android phone uses when the site is added to its home screen.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${appName} Docs`,
    short_name: appName,
    start_url: '/',
    display: 'browser',
    background_color: 'hsl(32, 55%, 96%)',
    theme_color: 'hsl(26, 100%, 57%)',
    icons: [
      { src: '/home-icon/192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/home-icon/512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/home-icon/512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
