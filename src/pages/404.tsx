import { NearestPage } from '@/components/nearest-page';
import { appName } from '@/lib/shared';

// The page for an address the site doesn't have, in the sidebar every page
// has (src/pages/_layout.tsx). Pages are renamed as the source is understood,
// and old addresses aren't kept: a visit goes on to the nearest page above it,
// or the search finds where the page went.
export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-16">
      <title>{`This page has moved | ${appName}`}</title>
      <h1 className="mb-4 text-2xl font-semibold">This page has moved</h1>
      <p className="mb-4 text-fd-muted-foreground">
        The page at this address was renamed or folded into another. The search (⌘K) finds it by name.
      </p>
      <NearestPage />
    </main>
  );
}

export async function getConfig() {
  return { render: 'static' } as const;
}
