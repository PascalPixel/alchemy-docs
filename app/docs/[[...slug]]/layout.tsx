import { source } from '@/lib/source';
import { treeFor } from '@/lib/tree';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';

export default async function Layout({ children, params }: LayoutProps<'/docs/[[...slug]]'>) {
  const { slug } = await params;
  return (
    <DocsLayout tree={treeFor(source.getPageTree(), slug)} {...baseOptions()}>
      {children}
    </DocsLayout>
  );
}
