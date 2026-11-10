import { ogResponse } from '@/lib/og';

// The front page's preview image; [...slugs] has every other page's.
export async function GET() {
  return ogResponse([]);
}

export async function getConfig() {
  return { render: 'static' } as const;
}
