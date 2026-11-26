import { llms, loader } from 'fumadocs-core/source';
import { docsRoute } from './shared';
import { docs } from '../../.source/dynamic';

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [],
});

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${page.data.description && page.data.lead !== 'body' ? `${page.data.description}\n\n` : ''}${await page.data.getText('processed')}`,
  // link to the files under `/llms.mdx`
  renderUrl: (item) => (/^\/.*\.(md|txt)$/.test(item.url) ? `/llms.mdx${item.url}` : item.url),
});
