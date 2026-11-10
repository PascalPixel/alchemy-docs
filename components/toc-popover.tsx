'use client';

// The table of contents in the page's bar, on a phone (TOCPopover) and on a
// screen too narrow for the column beside the page (TOCDropdown), as
// fumadocs' spacious layout draws them, but naming the section being read.
// Fumadocs names the first heading fully on screen, so a section's name
// changed to the next one as soon as that heading came up from the bottom of
// the screen, and while no heading was on screen it named whichever was
// nearest, often the next. Here the section being read is the last one whose
// heading has scrolled up to the bar, worked out on every scroll.
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { Popover } from '@base-ui/react/popover';
import { TOCScrollArea, useTOCItems } from 'fumadocs-ui/components/toc';
import { TOCEmpty, TOCItem, TOCItems } from 'fumadocs-ui/components/toc/block';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from 'fumadocs-ui/components/ui/collapsible';
import { useTreePath } from 'fumadocs-ui/contexts/tree';
import type { TOCDropdownProps, TOCPopoverProps } from 'fumadocs-ui/layouts/spacious/page/slots/toc';
import { cn } from '@/lib/cn';

// How far below the bar a heading still counts as reached, in pixels: one
// that has just been scrolled to by a link sits a little below it.
const REACHED = 16;

// The index of the section being read, -1 above the first heading. The page
// scrolls in its panel on a large screen and as a whole on a phone, so every
// scroll counts.
function useReading(bar: RefObject<HTMLElement | null>): number {
  const items = useTOCItems();
  const ids = useMemo(() => items.map((item) => item.url.replace(/^#/, '')), [items]);
  const [index, setIndex] = useState(-1);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = (bar.current?.getBoundingClientRect().bottom ?? 0) + REACHED;
      let at = -1;
      ids.forEach((id, i) => {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) at = i;
      });
      setIndex(at);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    // The bar grows while the list is open and shrinks back when it closes.
    const resized = new ResizeObserver(schedule);
    if (bar.current) resized.observe(bar.current);
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      document.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
    };
  }, [ids, bar]);
  return index;
}

// The section's name, rolling in from the direction of scrolling, as
// fumadocs' own does.
function Reading({ index, fallback, className, activeClassName }: { index: number; fallback: string; className?: string; activeClassName?: string }) {
  const items = useTOCItems();
  const active = items[index];
  const [shown, setShown] = useState({ index, roll: 1 });
  if (shown.index !== index) setShown({ index, roll: index >= shown.index ? 1 : -1 });
  return (
    <span className={cn('flex min-w-0 overflow-hidden', active && activeClassName, className)}>
      <span key={active?.url ?? ''} className="truncate motion-safe:animate-fd-roll-in" style={{ '--fd-roll': shown.roll } as React.CSSProperties}>
        {active ? active.title : fallback}
      </span>
    </span>
  );
}

function Progress({ index, size = 16, className }: { index: number; size?: number; className?: string }) {
  const items = useTOCItems();
  const value = (index + 1) / Math.max(1, items.length);
  const circle = { cx: size / 2, cy: size / 2, r: size / 2 - 1.5, fill: 'none', strokeWidth: 1.5 };
  const length = 2 * Math.PI * circle.r;
  return (
    <svg role="progressbar" viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-valuenow={value} aria-valuemin={0} aria-valuemax={1} className={className}>
      <circle {...circle} className="stroke-current/25" />
      <circle {...circle} stroke="currentColor" strokeLinecap="round" strokeDasharray={length} strokeDashoffset={length * (1 - value)} transform={`rotate(-90 ${circle.cx} ${circle.cy})`} className="transition-[stroke-dashoffset] duration-300" />
    </svg>
  );
}

function List({ className, onSelect }: { className?: string; onSelect: () => void }) {
  const items = useTOCItems();
  return (
    <TOCScrollArea className={className}>
      <TOCItems>
        {items.length === 0 && <TOCEmpty />}
        {items.map((item) => (
          <TOCItem key={item.url} item={item} onClick={onSelect} />
        ))}
      </TOCItems>
    </TOCScrollArea>
  );
}

/** the TOC bar for a phone */
export function TOCPopover({ container, trigger, content, header, footer }: TOCPopoverProps) {
  const page = useTreePath().at(-1);
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const reading = useReading(ref);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (e.target instanceof Node && !ref.current?.contains(e.target)) setOpen(false);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  return (
    <Collapsible open={open} onOpenChange={setOpen} {...container} className={cn('max-md:layout:[--fd-toc-popover-height:--spacing(10)]', container?.className)}>
      <header ref={ref} className="bg-fd-card">
        <CollapsibleTrigger {...trigger} className={cn('flex w-full h-10 items-center gap-2.5 px-4 text-start text-sm text-fd-muted-foreground focus-visible:outline-none', trigger?.className)}>
          <Progress index={reading} size={18} className={cn('shrink-0', open && 'text-fd-primary')} />
          <Reading index={reading} fallback={(page?.name as string | undefined) ?? 'On this page'} className={cn('flex-1 transition-colors', open && 'text-fd-foreground')} />
          <ChevronDownIcon className={cn('size-4 shrink-0 mx-0.5 transition-transform', open && 'rotate-180')} />
        </CollapsibleTrigger>
        <CollapsibleContent {...content}>
          <div className="flex flex-col px-4 max-h-[50vh]">
            {header}
            <List onSelect={() => setOpen(false)} />
            {footer}
          </div>
        </CollapsibleContent>
      </header>
    </Collapsible>
  );
}

/** the TOC dropdown in the page's bar, where the column beside the page doesn't fit */
export function TOCDropdown({ trigger, content, header, footer }: TOCDropdownProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const reading = useReading(ref);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        ref={ref}
        {...trigger}
        className={cn(
          'flex items-center gap-2 min-w-0 h-8 px-1.5 -mx-1.5 rounded-lg text-start text-sm transition-colors',
          open ? 'bg-fd-accent text-fd-accent-foreground' : 'text-fd-muted-foreground hover:bg-fd-accent/60 hover:text-fd-accent-foreground',
          trigger?.className,
        )}
      >
        <Progress index={reading} className="shrink-0" />
        <Reading index={reading} fallback={'On this page'} activeClassName="text-fd-foreground" />
        <ChevronDownIcon className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" sideOffset={8} positionMethod="fixed" className="z-50">
          <Popover.Popup
            {...content}
            className={cn(
              'flex flex-col w-88 max-w-(--available-width) max-h-[min(28rem,var(--available-height))] p-3 rounded-2xl border bg-fd-popover text-fd-popover-foreground shadow-xl outline-none origin-(--transform-origin) transition-[opacity,scale] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95 motion-reduce:transition-none',
              content?.className,
            )}
          >
            {header}
            <List className="py-1" onSelect={() => setOpen(false)} />
            {footer}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
