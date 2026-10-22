'use client';

import { useTheme } from 'next-themes';
import { useEffect, useId, useState } from 'react';

// A Mermaid diagram from a ```mermaid block of an Alchemy page, drawn in the
// browser in the site's light or dark colours. GitHub draws the same block
// from the README itself.
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState('');

  useEffect(() => {
    let current = true;
    void (async () => {
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        fontFamily: 'inherit',
        theme: resolvedTheme === 'dark' ? 'dark' : 'default',
      });
      const { svg } = await mermaid.render(`mermaid-${id}`, chart.replaceAll('\\n', '\n'));
      if (current) setSvg(svg);
    })();
    return () => {
      current = false;
    };
  }, [chart, id, resolvedTheme]);

  return <div className="my-6 flex justify-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />;
}
