import { docsLlms, source } from '@/lib/source';
import { isList } from '@/lib/shared';

export const revalidate = false;

// The prose pages in full; the source and reference pages are each in
// /llms.mdx/docs/<page>/content.md.
export async function GET() {
  const pages = source.getPages().filter((page) => !isList(page.url));
  return new Response((await Promise.all(pages.map((page) => docsLlms.page(page)))).join('\n\n'));
}
