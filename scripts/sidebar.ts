// Writes the sidebar's page tree once, for src/components/sidebar.tsx, so it is not in every page.
import { mkdirSync, writeFileSync } from 'node:fs';
import { source } from '../src/lib/source';

const icons = new Set<string>();
const tree = JSON.stringify(source.getPageTree(), function (key, value) {
  if (key === 'icon' && value) icons.add(value);
  return key === '$ref' || key === 'fallback' || (key === 'description' && !this.root) ? undefined : value;
});
mkdirSync('build', { recursive: true });
writeFileSync('build/sidebar.json', tree);
writeFileSync('build/sidebar-icons.ts', `export { ${[...icons].sort().join(', ')} } from 'lucide-react';\n`);
