'use client';

import { useEffect, useState } from 'react';

// An address the site no longer has (a page renamed or folded into another)
// goes to the nearest page above it that exists: /tbs/source/structs/old-name
// to /tbs/source/structs, /tbs/abilities/flare to /tbs. The site keeps no list
// of old addresses; it asks for each parent in turn.
export function NearestPage() {
  const [to, setTo] = useState<string>();
  useEffect(() => {
    const parts = window.location.pathname.split('/').filter(Boolean);
    let cancelled = false;
    (async () => {
      while (parts.length) {
        parts.pop();
        const path = `/${parts.join('/')}`;
        const res = await fetch(path, { method: 'HEAD' }).catch(() => undefined);
        if (cancelled) return;
        if (res?.ok) {
          setTo(path);
          window.location.replace(path);
          return;
        }
      }
      setTo('/');
      window.location.replace('/');
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return to ? (
    <p>
      Going on to <a href={to}>{to}</a>.
    </p>
  ) : (
    <p>Looking for the nearest page that exists…</p>
  );
}
