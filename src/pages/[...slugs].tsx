import type { PageProps } from 'waku/router';
import { DocPage } from '@/components/doc-page';
import { source } from '@/lib/source';

export default function Page({ slugs }: PageProps<'/[...slugs]'>) {
  return <DocPage slugs={slugs} />;
}

// Every page but the front page (src/pages/index.tsx), written at build.
export async function getConfig() {
  return {
    render: 'static',
    staticPaths: source
      .getPages()
      .map((page) => page.slugs)
      .filter((slugs) => slugs.length),
  } as const;
}
