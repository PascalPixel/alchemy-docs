import { source } from '@/lib/source';

export const dynamic = 'force-static';

// Every page's title, headings and text (a reference page's headings only), read one page at a time.
export async function GET() {
  const pages = [];
  for (const page of source.getPages()) {
    const { headings, contents } = await page.data.structuredData();
    const text = /^\/(tbs|tla)\/source/.test(page.url) ? [] : contents.map((c) => [c.heading ?? '', c.content, 0]);
    pages.push([page.url, page.data.title, [...headings.map((h) => [h.id, h.content, 1]), ...text]]);
  }
  return Response.json(pages);
}
