'use client';
import SearchDialog from '@/components/search';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { type ReactNode } from 'react';

export function Provider({ children }: { children: ReactNode }) {
  // A structure's fields (components/field-table.tsx) are fields, not props.
  return <RootProvider search={{ SearchDialog }} i18n={{ translations: { 'Prop(type table)': 'Field' } }}>{children}</RootProvider>;
}
