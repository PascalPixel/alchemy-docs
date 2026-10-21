'use client';

import { useEffect } from 'react';

// The abilities were once one page with an anchor for each (#flare), then a
// page each; a link to one of those anchors goes on to the code that plays
// that ability, and any other visit to the chapter on how abilities resolve.
export function AnchorRedirect({ map, fallback }: { map: Record<string, string>; fallback?: string }) {
  useEffect(() => {
    const to = map[decodeURIComponent(window.location.hash.slice(1))] ?? fallback;
    if (to) window.location.replace(`${process.env.NEXT_PUBLIC_DOCS_BASE_PATH ?? ''}${to}`);
  }, [map, fallback]);
  return null;
}
