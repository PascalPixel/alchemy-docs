'use client';

import { useEffect } from 'react';

// Sends a link to an anchor a page no longer has (a folder page that once
// showed its files' members) on to where that anchor is now.
export function AnchorRedirect({ map, fallback }: { map: Record<string, string>; fallback?: string }) {
  useEffect(() => {
    const to = map[decodeURIComponent(window.location.hash.slice(1))] ?? fallback;
    if (to) window.location.replace(`${process.env.NEXT_PUBLIC_DOCS_BASE_PATH ?? ''}${to}`);
  }, [map, fallback]);
  return null;
}
