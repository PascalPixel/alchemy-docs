// alchemy-lit, the colours the renders are shown in: the game's own, with
// yellows turned a little towards red and greens towards yellow, both a little
// desaturated. Its definition is alchemy-devtools' `lit` command (src/lit.rs);
// this is the closest filter a browser can apply, fitted to it.
const MATRIX = '0.8708 0.3184 -0.1892 0 0 -0.0056 0.8879 0.1177 0 0 0.0884 0.0671 0.8444 0 0 0 0 0 1 0';
const CURVES = {
  r: '0 0.0713 0.1309 0.1879 0.2466 0.3131 0.3685 0.4413 0.5138 0.5764 0.6312 0.6918 0.769 0.8387 0.9135 0.9954 1',
  g: '0 0.0596 0.1147 0.1527 0.2245 0.2931 0.3642 0.4413 0.5023 0.559 0.6202 0.683 0.7372 0.8035 0.8522 0.9301 1',
  b: '0 0.0618 0.1167 0.1654 0.2429 0.3097 0.4003 0.4547 0.5071 0.5726 0.6399 0.6954 0.7593 0.8227 0.8864 0.9689 1',
};

const gamma = (exponent: number) => (
  <feComponentTransfer>
    <feFuncR type="gamma" exponent={exponent} />
    <feFuncG type="gamma" exponent={exponent} />
    <feFuncB type="gamma" exponent={exponent} />
  </feComponentTransfer>
);

export function Lit() {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
      <filter id="alchemy-lit" colorInterpolationFilters="sRGB">
        {gamma(2)}
        <feColorMatrix type="matrix" values={MATRIX} />
        {gamma(0.5)}
        <feComponentTransfer>
          <feFuncR type="table" tableValues={CURVES.r} />
          <feFuncG type="table" tableValues={CURVES.g} />
          <feFuncB type="table" tableValues={CURVES.b} />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}
