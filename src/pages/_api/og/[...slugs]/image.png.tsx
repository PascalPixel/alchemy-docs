import type { ApiContext } from 'waku/router';
import { ogResponse } from '@/lib/og';
import { ogPages } from '@/lib/source';

export async function GET(_req: Request, { params }: ApiContext<'/og/[...slugs]/image.png'>) {
  return ogResponse(params.slugs);
}

export async function getConfig() {
  return {
    render: 'static',
    staticPaths: ogPages()
      .map((page) => page.slugs)
      .filter((slugs) => slugs.length),
  } as const;
}
