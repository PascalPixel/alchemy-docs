import { docsLlms } from '@/lib/source';
import { appName } from '@/lib/shared';

export const revalidate = false;

// The page tree has no name of its own; the index is the site's.
export async function GET() {
  return new Response((await docsLlms.index()).replace(/^# .*/, `# ${appName}`));
}
