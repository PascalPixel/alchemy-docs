'use client';

// The table of contents above the page on a phone or tablet, as fumadocs'
// TOCPopover draws it, but naming the section being read. Fumadocs names the
// first heading fully on screen, so a section's name changed to the next one
// as soon as that heading came up from the bottom of the screen, and while no
// heading was on screen it named whichever was nearest, often the next. Here
// the section being read is the last one whose heading has scrolled up to the
// bar, worked out on every scroll.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { TOCScrollArea, useTOCItems } from 'fumadocs-ui/components/toc';
import { TOCEmpty, TOCItem, TOCItems } from 'fumadocs-ui/components/toc/default';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from 'fumadocs-ui/components/ui/collapsible';
import { useTreePath } from 'fumadocs-ui/contexts/tree';
import { cn } from '@/lib/cn';

// How far below the bar a heading still counts as reached, in pixels: one
// that has just been scrolled to by a link sits a little below it.
const REACHED = 16;

function useReading(ids: string[], bar: React.RefObject<HTMLElement | null>): number {
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
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // The bar grows while the list is open and shrinks back when it closes.
    const resized = new ResizeObserver(schedule);
    if (bar.current) resized.observe(bar.current);
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [ids, bar]);
  return index;
}

function Progress({ value }: { value: number }) {
  const size = 18;
  const radius = size / 2 - 1.5;
  const length = 2 * Math.PI * radius;
  const circle = { cx: size / 2, cy: size / 2, r: radius, fill: 'none', strokeWidth: 1.5 };
  return (
    <svg role="progressbar" viewBox={`0 0 ${size} ${size}`} aria-valuenow={value} aria-valuemin={0} aria-valuemax={1} className="shrink-0" style={{ width: size, height: size }}>
      <circle {...circle} className="stroke-current/25" />
      <circle {...circle} stroke="currentColor" strokeDasharray={length} strokeDashoffset={length * (1 - value)} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} className="transition-all" />
    </svg>
  );
}

export function TOCPopover() {
  const items = useTOCItems();
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const ids = useMemo(() => items.map((item) => item.url.replace(/^#/, '')), [items]);
  const reading = useReading(ids, ref);
  const page = useTreePath().at(-1)?.name;
  const showItem = reading !== -1 && !open;

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (open && e.target instanceof Node && ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-toc-popover=""
      className="sticky top-(--fd-docs-row-2) z-10 [grid-area:toc-popover] h-(--fd-toc-popover-height) xl:hidden max-xl:layout:[--fd-toc-popover-height:--spacing(10)]"
    >
      <header ref={ref} className={cn('border-b backdrop-blur-sm transition-colors bg-fd-background/80', open && 'shadow-lg')}>
        <CollapsibleTrigger
          data-toc-popover-trigger=""
          className="flex w-full h-10 items-center text-sm text-fd-muted-foreground gap-2.5 px-4 py-2.5 text-start focus-visible:outline-none [&_svg]:size-4 md:px-6"
        >
          <Progress value={(reading + 1) / Math.max(1, items.length)} />
          <span className="grid flex-1 *:my-auto *:row-start-1 *:col-start-1">
            <span className={cn('truncate transition-[opacity,translate,color]', open && 'text-fd-foreground', showItem && 'opacity-0 -translate-y-full pointer-events-none')}>{page ?? 'On this page'}</span>
            <span className={cn('truncate transition-[opacity,translate]', !showItem && 'opacity-0 translate-y-full pointer-events-none')}>{items[reading]?.title}</span>
          </span>
          <ChevronDown className={cn('shrink-0 transition-transform mx-0.5', open && 'rotate-180')} />
        </CollapsibleTrigger>
        <CollapsibleContent data-toc-popover-content="">
          <div className="flex flex-col px-4 max-h-[50vh] md:px-6">
            <TOCScrollArea className="ms-px">
              <TOCItems>
                {items.length === 0 && <TOCEmpty />}
                {items.map((item) => (
                  <TOCItem key={item.url} item={item} onClick={() => setOpen(false)} />
                ))}
              </TOCItems>
            </TOCScrollArea>
          </div>
        </CollapsibleContent>
      </header>
    </Collapsible>
  );
}
