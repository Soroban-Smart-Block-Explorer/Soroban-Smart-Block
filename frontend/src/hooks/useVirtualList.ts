import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Fixed row height in pixels for the virtualized event list.
 * Every row MUST be exactly this height so that absolute positioning
 * produces a seamless scroll experience. If row content overflows,
 * it is clipped with text-overflow: ellipsis.
 */
export const ROW_HEIGHT = 60;

/** Number of rows to render above / below the visible viewport. */
const OVERSCAN = 5;

/**
 * useVirtualList — lightweight windowed-list hook.
 *
 * Given an array of items and a scrollable container ref, returns only the
 * slice of items that should be rendered (plus an overscan buffer) along
 * with the absolute top-position for each visible row.
 *
 * The container element must have `overflow-y: auto` (or scroll) and a
 * fixed height so that the browser manages the scrollbar.
 */
export function useVirtualList<T>(
  items: T[],
  containerRef: React.RefObject<HTMLElement | null>,
) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const rafId = useRef(0);

  // ---------- scroll / resize listeners ----------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => {
      // Use rAF to coalesce rapid scroll events into a single paint.
      if (rafId.current) cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(() => {
        setScrollTop(el.scrollTop);
      });
    };

    const onResize = () => {
      setViewportHeight(el.clientHeight);
    };

    // Initial measurements
    setScrollTop(el.scrollTop);
    setViewportHeight(el.clientHeight);

    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (rafId.current) cancelAnimationFrame(rafId.current);
    };
  }, [containerRef]);

  // ---------- derived values ----------
  const totalHeight = items.length * ROW_HEIGHT;

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    items.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );

  const visibleItems = items.slice(startIndex, endIndex).map((item, i) => ({
    item,
    index: startIndex + i,
    style: {
      position: "absolute" as const,
      top: (startIndex + i) * ROW_HEIGHT,
      width: "100%",
      height: ROW_HEIGHT,
    },
  }));

  return { totalHeight, visibleItems };
}
