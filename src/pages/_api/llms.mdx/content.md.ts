import { markdownResponse } from '@/lib/llms-page';

// The front page's Markdown; [...slugs] has every other page's.
export async function GET() {
  return markdownResponse([]);
}

export async function getConfig() {
  return { render: 'static' } as const;
}
