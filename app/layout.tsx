import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import { COLOURS_KEY } from '@/lib/shared';
import './global.css';

export const metadata: Metadata = {
  // Where the preview images (app/og) are found from a link elsewhere.
  metadataBase: new URL('https://alchemy.pascalpixel.com'),
  title: { template: '%s | Alchemy', default: 'Alchemy' },
};

const inter = Inter({
  subsets: ['latin'],
});

// alchemy-lit, the site's palette for the renders: the game's own colours with
// yellows a little desaturated and turned towards red, and greens a little
// desaturated and turned towards yellow; every other colour and every lightness
// is the game's own. Its exact definition is alchemy-devtools' `lit` command
// (src/lit.rs). It chooses by hue, which an SVG filter cannot, so this is the
// closest filter of the shape the browser can apply: a gamma, a channel mix, a
// gamma back and a curve for each channel, fitted to it over the Vale, Xian and
// Tolbi place renders (yellows and golds weighted most) with the grey scale
// and a ring of saturated colours. Black and white stay exact and greys within
// a few steps; the mean difference on those renders is about 0.014 in OKLab,
// under a just-noticeable step, and the largest are purples, which lean
// towards blue (the Psynergy Stone), and deep blues. The filter works on the
// raw values (sRGB interpolation), as the fit did.
const LIT_DECODE = 2.0;
const LIT_MATRIX = [
  '0.8708 0.3184 -0.1892 0 0',
  '-0.0056 0.8879 0.1177 0 0',
  '0.0884 0.0671 0.8444 0 0',
  '0 0 0 1 0',
].join(' ');
const LIT_ENCODE = 0.5;
const LIT_CURVES = {
  r: '0 0.0713 0.1309 0.1879 0.2466 0.3131 0.3685 0.4413 0.5138 0.5764 0.6312 0.6918 0.769 0.8387 0.9135 0.9954 1',
  g: '0 0.0596 0.1147 0.1527 0.2245 0.2931 0.3642 0.4413 0.5023 0.559 0.6202 0.683 0.7372 0.8035 0.8522 0.9301 1',
  b: '0 0.0618 0.1167 0.1654 0.2429 0.3097 0.4003 0.4547 0.5071 0.5726 0.6399 0.6954 0.7593 0.8227 0.8864 0.9689 1',
};
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
          <filter id="alchemy-lit" colorInterpolationFilters="sRGB">
            {gamma(LIT_DECODE)}
            <feColorMatrix type="matrix" values={LIT_MATRIX} />
            {gamma(LIT_ENCODE)}
            <feComponentTransfer>
              <feFuncR type="table" tableValues={LIT_CURVES.r} />
              <feFuncG type="table" tableValues={LIT_CURVES.g} />
              <feFuncB type="table" tableValues={LIT_CURVES.b} />
            </feComponentTransfer>
          </filter>
        </svg>
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
