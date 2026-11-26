'use client';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';
import { experimental_useSearch as useSearch } from 'fumadocs-core/search/client';
import type { SortedResult } from 'fumadocs-core/search';

type Page = [url: string, title: string, entries: [anchor: string, text: string, heading: number][]];
let pages: Promise<Page[]> | undefined;

// A page or text holding every word; titles first, then headings, then text.
async function find(query: string): Promise<SortedResult[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  pages ??= fetch('/search.json').then((res) => res.json());
  const holds = (text: string) => words.every((word) => text.toLowerCase().includes(word));
  const found = (await pages).flatMap(([url, title, entries]) => {
    const hits = entries.filter(([, text]) => holds(text)).sort((a, b) => b[2] - a[2]);
    return holds(title) || hits.length ? [{ url, title, hits, rank: holds(title) ? 2 : hits[0][2] }] : [];
  });
  return found
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 20)
    .flatMap(({ url, title, hits }) => [
      { id: url, type: 'page', url, content: title },
      ...hits.slice(0, 5).map(([anchor, text, heading], i) => ({ id: `${url}-${i}`, type: heading ? 'heading' : 'text', url: anchor ? `${url}#${anchor}` : url, content: text }) as const),
    ]);
}

export default function DefaultSearchDialog(props: SharedProps) {
  const search = useSearch(find);

  return (
    <SearchDialog {...search} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList />
      </SearchDialogContent>
    </SearchDialog>
  );
}
