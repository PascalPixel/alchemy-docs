import { readFileSync } from 'node:fs';
import { ImageResponse } from '@vercel/og';
import { source } from './source';
import { appName } from './shared';
import { stillPng } from './renders';

// A page's preview image, as a link to it shows on social media and in
// chats: its title and first sentence on the site's dark look, beside the
// still (lib/stills.ts) where it has one. @vercel/og smooths a picture it
// scales, so the still comes already scaled by a whole number, each of the
// game's pixels a square block, and is drawn at its own size.
export function ogResponse(slugs: string[]) {
  const page = source.getPage(slugs);
  if (!page) return new Response(undefined, { status: 404 });
  const png = page.data.image ? readFileSync(stillPng(process.cwd(), page.data.image)) : undefined;
  const still = png && `data:image/png;base64,${png.toString('base64')}`;
  // The PNG's size, from its header; a still too big for the room is fitted.
  const [width, height] = png ? [png.readUInt32BE(16), png.readUInt32BE(20)] : [0, 0];
  const fits = width <= 480 && height <= 320;
  return new ImageResponse(
    (
      <div style={{ display: 'flex', width: '100%', height: '100%', padding: 64, gap: 56, alignItems: 'center', background: '#0a0a0a', color: '#fafafa' }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 24 }}>
          <div style={{ fontSize: 30, color: '#a3a3a3' }}>{`${appName} Docs`}</div>
          <div style={{ fontSize: page.data.title.length > 24 ? 60 : 76, fontWeight: 700, lineHeight: 1.1 }}>{page.data.title}</div>
          {page.data.description && <div style={{ fontSize: 28, lineHeight: 1.4, color: '#d4d4d4', display: 'block', lineClamp: 4 }}>{page.data.description}</div>}
        </div>
        {still && <img src={still} width={fits ? width : 480} height={fits ? height : 320} style={{ borderRadius: 16, objectFit: 'cover' }} />}
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
