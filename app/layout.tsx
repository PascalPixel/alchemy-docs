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
// Pokefan531's GBA colour shader (hunterk's Color Mangler, public domain):
// decode with gamma 2.2 plus its darken_screen 0.5, mix the channels as the
// GBA's screen does, and encode back with gamma 2.2. The filter works on the
// raw values (sRGB interpolation) so the two gamma steps are the shader's own.
const GBA_DECODE = 2.2 + 0.5;
const GBA_ENCODE = 1 / 2.2;
const GBA_MATRIX = ['0.845 0.17 -0.015 0 0', '0.09 0.68 0.23 0 0', '0.16 0.085 0.755 0 0', '0 0 0 1 0'].join(' ');
const gamma = (exponent: number) => (
  <feComponentTransfer>
    <feFuncR type="gamma" amplitude={1} exponent={exponent} offset={0} />
    <feFuncG type="gamma" amplitude={1} exponent={exponent} offset={0} />
    <feFuncB type="gamma" amplitude={1} exponent={exponent} offset={0} />
  </feComponentTransfer>
);

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
          <filter id="gba-colour" colorInterpolationFilters="sRGB">
            {gamma(GBA_DECODE)}
            <feColorMatrix type="matrix" values={GBA_MATRIX} />
            {gamma(GBA_ENCODE)}
          </filter>
        </svg>
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
