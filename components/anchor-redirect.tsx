'use client';

import { useEffect } from 'react';

// The abilities were once one page with an anchor for each (#flare); a link
// to one of those anchors goes on to that ability's own page.
export function AnchorRedirect({ map }: { map: Record<string, string> }) {
  useEffect(() => {
    const to = map[decodeURIComponent(window.location.hash.slice(1))];
    if (to) window.location.replace(`${process.env.NEXT_PUBLIC_DOCS_BASE_PATH ?? ''}${to}`);
  }, [map]);
  return null;
}
