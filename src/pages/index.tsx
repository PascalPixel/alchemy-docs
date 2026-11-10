import { DocPage } from '@/components/doc-page';

export default function Page() {
  return <DocPage slugs={[]} />;
}

export async function getConfig() {
  return { render: 'static' } as const;
}
