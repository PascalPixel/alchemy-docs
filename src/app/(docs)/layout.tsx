import { Sidebar } from '@/components/sidebar';

export default function Layout({ children }: LayoutProps<'/'>) {
  return <Sidebar>{children}</Sidebar>;
}
