import { docsLlms } from '@/lib/source';
import { appName } from '@/lib/shared';

// The page tree has no name of its own; the index is the site's.
export async function GET() {
  return new Response((await docsLlms.index()).replace(/^# .*/, `# ${appName}`));
}

export async function getConfig() {
  return { render: 'static' } as const;
}
