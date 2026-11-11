'use client';

import { Box, DoorOpen, FileBraces, FileCode, Folder, List, MapPinned } from 'lucide-react';

// The sidebar's icons for the items that have one by kind rather than by
// name (src/lib/tree.ts): the places' towns and dungeons and their rooms, and
// the source's folders, files and structures. They are drawn here, in the
// browser, so the sidebar every page carries names only the kind of each of
// its hundreds of items, not its picture.
const ICONS = {
  place: MapPinned,
  room: DoorOpen,
  folder: Folder,
  c: FileCode,
  h: FileBraces,
  structure: Box,
  list: List,
};

export type TreeIconKind = keyof typeof ICONS;

export function TreeIcon({ kind }: { kind: TreeIconKind }) {
  const Icon = ICONS[kind];
  return <Icon />;
}
