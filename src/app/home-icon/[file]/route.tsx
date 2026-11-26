import { homeIcon } from '@/lib/mark';

// The home-screen icons: 180 pixels for an iPhone or iPad, 192 and 512 for the
// web manifest an Android phone reads.
export const dynamic = 'force-static';

export async function GET(_req: Request, { params }: RouteContext<'/home-icon/[file]'>) {
  const { file } = await params;
  return homeIcon(Number.parseInt(file, 10));
}

export function generateStaticParams() {
  return [{ file: '180.png' }, { file: '192.png' }, { file: '512.png' }];
}
