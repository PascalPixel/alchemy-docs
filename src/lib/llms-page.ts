import { docsLlms, source } from './source';

// A page's Markdown, at its address with .md after it (vercel.json), for
// src/pages/_api/llms.mdx.
export async function markdownResponse(slugs: string[]) {
  const page = source.getPage(slugs);
  if (!page) return new Response(undefined, { status: 404 });
  return new Response(await docsLlms.page(page), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
}
