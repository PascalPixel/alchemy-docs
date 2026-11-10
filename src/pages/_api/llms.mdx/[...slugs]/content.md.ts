import type { ApiContext } from 'waku/router';
import { markdownResponse } from '@/lib/llms-page';
import { source } from '@/lib/source';

export async function GET(_req: Request, { params }: ApiContext<'/llms.mdx/[...slugs]/content.md'>) {
  return markdownResponse(params.slugs);
}

export async function getConfig() {
  return {
    render: 'static',
    staticPaths: source
      .getPages()
      .map((page) => page.slugs)
      .filter((slugs) => slugs.length),
  } as const;
}
