import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { INK, Mark, MUTED, ORANGE, PANEL } from './mark';

// The preview card a page shares, drawn as the site is: the white mark and
// the name on the orange frame, and the page's title and description on the
// cream panel a page is read on, in Inter.
const font = (weight: 500 | 700) => ({
  name: 'Inter',
  weight,
  style: 'normal' as const,
  data: readFileSync(join(process.cwd(), `node_modules/@fontsource/inter/files/inter-latin-${weight}-normal.woff`)),
});

export const cardOptions = { width: 1200, height: 630, fonts: [font(500), font(700)] };

export function card(title: ReactNode, description: ReactNode, site: string) {
  // A source file's path is long: it is set smaller, so its file name shows.
  const long = typeof title === 'string' && title.length > 28;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: 48, background: ORANGE, fontFamily: 'Inter' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '0 8px 36px', color: 'white' }}>
        <Mark size={64} />
        <div style={{ fontSize: 44, fontWeight: 700 }}>{site}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 24, flexGrow: 1, padding: '48px 64px', borderRadius: 28, background: PANEL, color: INK }}>
        <div style={{ display: 'block', fontSize: long ? 54 : 76, fontWeight: 700, lineHeight: 1.1, letterSpacing: long ? -1 : -1.5, wordBreak: 'break-word', lineClamp: long ? 3 : 2 }}>{title}</div>
        {description ? <div style={{ display: 'block', fontSize: 36, fontWeight: 500, lineHeight: 1.35, color: MUTED, lineClamp: 3 }}>{description}</div> : null}
      </div>
    </div>
  );
}
