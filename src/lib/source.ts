import { llms, loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { docsImageRoute, docsRoute, isList } from './shared';
// The collection is source.config.ts's, which the build writes to .source.
import { docs } from '../../.source/dynamic';

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: docsRoute,
  plugins: [lucideIconsPlugin()],
});

// The pages with a preview image of their own (src/lib/og.tsx): the guide's,
// and each reference's front page, whose image every page of that reference
// shares.
type Page = (typeof source)['$inferPage'];
const ownImage = (page: Page) => !isList(page.url) || page.slugs.length === 2;
export const ogPages = () => source.getPages().filter(ownImage);
export function ogImage(page: Page): string {
  const slugs = ownImage(page) ? page.slugs : page.slugs.slice(0, 2);
  return `${docsImageRoute}/${[...slugs, 'image.png'].join('/')}`;
}

// The site as Markdown, for language models and other readers of text:
// llms.txt lists every page, llms-full.txt holds the guide's pages whole (the
// reference repeats the source, which is on GitHub), and every page's own
// Markdown is at its address with .md after it (vercel.json).
export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText('processed')}`,
});
