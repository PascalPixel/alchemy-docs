import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import { COLOURS_KEY } from '@/lib/shared';
import './global.css';

export const metadata: Metadata = {
  title: { template: '%s | Alchemy', default: 'Alchemy' },
};

const inter = Inter({
  subsets: ['latin'],
});

// The GBA's screen showed its colours darker and less saturated than a
// modern one does. This is Pokefan531's GBA colour matrix, the one the
// libretro gba-color shader applies: in linear light, which is how the shader
// works (it decodes the gamma, applies the matrix, then encodes again). Applied
// to the encoded values instead, the same matrix is 16 to 19 steps in 255 away
// from the shader on a place render; in linear light, under 1.
const GBA_MATRIX = ['0.4925 0.3100 0.1625 0 0.05', '0.3150 0.4825 0.1925 0 0.03', '0.1625 0.1925 0.6225 0 0.02', '0 0 0 1 0'].join(' ');

// Read before the first paint, so a reader who chose the raw colours never
// sees the filtered ones flash.
const colours = `try{if(localStorage.getItem(${JSON.stringify(COLOURS_KEY)})==='raw')document.documentElement.dataset.colours='raw'}catch(e){}`;

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: colours }} />
      </head>
      <body className="flex flex-col min-h-screen">
        <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
          <filter id="gba-colour" colorInterpolationFilters="linearRGB">
            <feColorMatrix type="matrix" values={GBA_MATRIX} />
          </filter>
        </svg>
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
