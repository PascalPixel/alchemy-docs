'use client';

import { ThemeSwitch, type ThemeSwitchProps } from 'fumadocs-ui/layouts/shared/slots/theme-switch';
import { useEffect, useState } from 'react';
import { COLOURS_KEY } from '@/lib/shared';

// The renders are the GBA's own colours, which its screen showed darker and
// less saturated. By default the site shows them as that screen did, through
// the #gba-colour filter (app/layout.tsx); this switches between that and
// the colours as stored, and remembers the choice in the browser.

export function ColourToggle() {
  const [raw, setRaw] = useState(false);
  useEffect(() => setRaw(document.documentElement.dataset.colours === 'raw'), []);
  const toggle = () => {
    const next = !raw;
    setRaw(next);
    if (next) document.documentElement.dataset.colours = 'raw';
    else delete document.documentElement.dataset.colours;
    try {
      if (next) localStorage.setItem(COLOURS_KEY, 'raw');
      else localStorage.removeItem(COLOURS_KEY);
    } catch {
      // Storage can be unavailable; the choice then lasts for this page only.
    }
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={!raw}
      title={raw ? 'Showing the colours as stored; show them as a GBA screen did' : 'Showing the colours as a GBA screen did; show them as stored'}
      className="inline-flex items-center rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors hover:text-fd-accent-foreground hover:bg-fd-accent"
    >
      {raw ? 'Raw colours' : 'GBA colours'}
    </button>
  );
}

// The sidebar's theme switch, with the colour toggle beside it.
export function ThemeAndColours(props: ThemeSwitchProps) {
  return (
    <div className="ms-auto flex items-center gap-1">
      <ColourToggle />
      <ThemeSwitch {...props} />
    </div>
  );
}
