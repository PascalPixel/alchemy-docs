import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/spacious';
import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';
import { sidebarTree } from '@/lib/tree';

// The sidebar, the same on every page: rendered once at build, and kept by
// the browser as a reader goes from page to page, which loads only the page.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={sidebarTree(source.getPageTree())} {...baseOptions()}>
      {children}
    </DocsLayout>
  );
}

export async function getConfig() {
  return { render: 'static' } as const;
}
