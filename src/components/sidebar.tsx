'use client';
import { createElement, type ReactNode } from 'react';
import type { Node, Root } from 'fumadocs-core/page-tree';
import { DocsLayout } from 'fumadocs-ui/layouts/spacious';
import { baseOptions } from '@/lib/layout.shared';
import tree from '../../build/sidebar.json';
import * as icons from '../../build/sidebar-icons';

// The page tree comes in the site's script, loaded once, rather than in every page (scripts/sidebar.ts).
const icon = (name: unknown) => (typeof name === 'string' && name in icons ? createElement(icons[name as keyof typeof icons]) : undefined);
const withIcons = (nodes: Node[]): Node[] =>
  nodes.map((node) => (node.type === 'folder' ? { ...node, icon: icon(node.icon), index: node.index && { ...node.index, icon: icon(node.index.icon) }, children: withIcons(node.children) } : { ...node, icon: icon(node.icon) }));
const sidebar = { ...tree, children: withIcons((tree as Root).children) } as Root;

export function Sidebar({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={sidebar} {...baseOptions()}>
      {children}
    </DocsLayout>
  );
}
