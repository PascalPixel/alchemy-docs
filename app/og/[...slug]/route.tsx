import { readFileSync } from 'node:fs';
import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';
import { ogPages, source } from '@/lib/source';
import { appName } from '@/lib/shared';
import { stillPng } from '@/lib/renders';

export const revalidate = false;

// A page's preview image, as a link to it shows on social media and in
// chats: its title and first sentence on the site's dark look, beside the
// still of its first recording (lib/stills.ts) where it has one, drawn
// pixel for pixel at twice its size.
export async function GET(_req: Request, { params }: RouteContext<'/og/[...slug]'>) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();
  const still = page.data.image && `data:image/png;base64,${readFileSync(stillPng(process.cwd(), page.data.image)).toString('base64')}`;
  return new ImageResponse(
    (
      <div style={{ display: 'flex', width: '100%', height: '100%', padding: 64, gap: 56, alignItems: 'center', background: '#0a0a0a', color: '#fafafa' }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 24 }}>
          <div style={{ fontSize: 30, color: '#a3a3a3' }}>{`${appName} Docs`}</div>
          <div style={{ fontSize: page.data.title.length > 24 ? 60 : 76, fontWeight: 700, lineHeight: 1.1 }}>{page.data.title}</div>
          {page.data.description && <div style={{ fontSize: 28, lineHeight: 1.4, color: '#d4d4d4', display: 'block', lineClamp: 4 }}>{page.data.description}</div>}
        </div>
        {still && <img src={still} width={480} height={320} style={{ borderRadius: 16, imageRendering: 'pixelated', objectFit: 'cover' }} />}
      </div>
    ),
    { width: 1200, height: 630 },
  );
}

export function generateStaticParams() {
  return ogPages().map((page) => ({ slug: [...page.slugs, 'image.png'] }));
}
