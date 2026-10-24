import { Card, Cards } from 'fumadocs-ui/components/card';
import type { Folder, Node } from 'fumadocs-core/page-tree';
import type { ReactNode } from 'react';
import { source } from '@/lib/source';

// A guide page as a card: its title, what it holds and, where it has a
// recording, the still of the first (lib/stills.ts), which loads only as it
// scrolls into view; on a narrow screen the still sits small beside the
// text, which stops at four lines. The text is the page's first sentence
// unless the card brings its own, or none (bare).
export function PageCard({ href, title, bare, children }: { href: string; title?: string; bare?: string; children?: ReactNode }) {
  const page = source.getPageByHref(href)?.page;
  const image = page?.data.image;
  const base = process.env.NEXT_PUBLIC_DOCS_BASE_PATH ?? '';
  return (
    <Card href={href} title={title ?? page?.data.title} description={bare ? undefined : (children ?? page?.data.description)} className="flex flex-col overflow-hidden [&>div:last-child]:order-first @max-lg:has-[img]:grid @max-lg:has-[img]:grid-cols-[6rem_1fr] @max-lg:has-[img]:content-start @max-lg:has-[img]:gap-x-3 @max-lg:[&>div:last-child]:row-span-2 @max-lg:[&>p]:line-clamp-4">
      {image && <img src={`${base}${image}`} alt="" width={240} height={160} loading="lazy" decoding="async" className="still -mx-4! -mt-4! mb-3! block aspect-[3/2] w-[calc(100%+2rem)] max-w-none object-cover @max-lg:m-0! @max-lg:w-full @max-lg:rounded-md" />}
    </Card>
  );
}

export function PageCardList({ children }: { children: ReactNode }) {
  return <Cards className="not-prose my-6">{children}</Cards>;
}

// A folder of more pages than this (the places) lists them in its own text.
const MOST = 24;

function folderOf(nodes: Node[], url: string): Folder | undefined {
  for (const node of nodes) {
    if (node.type !== 'folder') continue;
    if (node.index?.url === url) return node;
    const found = folderOf(node.children, url);
    if (found) return found;
  }
}

// The pages a guide page holds, its children in the sidebar, as cards at its
// end, except those its text already shows as cards: a list item opening
// with a link to the page (lib/remark-components.ts).
export async function PageCards({ url }: { url: string }) {
  const page = source.getPage(url.split('/').filter(Boolean));
  const folder = folderOf(source.getPageTree().children, url);
  if (!page || !folder) return null;
  const raw = await page.data.getText('raw');
  const listed = new Set([...raw.matchAll(/^\s*[-*+] \[[^\]]*\]\(([^)#\s]+)\)/gm)].map((m) => m[1]));
  const urls = folder.children
    .map((n) => (n.type === 'folder' ? n.index?.url : n.type === 'page' ? n.url : undefined))
    .filter((u) => u !== undefined && u !== url && source.getPageByHref(u));
  if (urls.length > MOST) return null;
  const shown = urls.filter((u) => !listed.has(u!));
  if (!shown.length) return null;
  return (
    <Cards className="not-prose mt-12">
      {shown.map((u) => (
        <PageCard key={u} href={u!} />
      ))}
    </Cards>
  );
}
