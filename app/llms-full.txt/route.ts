import { docsLlms, source } from '@/lib/source';
import { isList } from '@/lib/shared';

export const revalidate = false;

export async function GET() {
  const pages = source.getPages().filter((page) => !isList(page.url));
  return new Response((await Promise.all(pages.map((page) => docsLlms.page(page)))).join('\n\n'));
}
