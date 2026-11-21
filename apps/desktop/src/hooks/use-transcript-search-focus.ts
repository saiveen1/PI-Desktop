import { useLayoutEffect, useRef, type RefObject } from "react";
import type { TranscriptSearchTarget } from "../lib/transcript-reading";
import { locateTranscriptSearch } from "../lib/transcript-search-highlight";

const READING_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const GESTURES = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"];

/** Both transcript surfaces share source mapping, highlighting, and scroll ownership. */
export function useTranscriptSearchFocus({
  target,
  source,
  visible = true,
  suspended = false,
  scrollRef,
  contentRef,
  contentVersion,
  onNavigate,
  onPosition,
  onAlignmentEnd,
}: {
  target: TranscriptSearchTarget | null;
  source: string;
  suspended?: boolean;
  visible?: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  contentVersion: unknown;
  onNavigate: (fresh: boolean) => void;
  onPosition?: (scrollTop: number) => void;
  onAlignmentEnd?: () => void;
}) {
  const position = useRef({ requestId: 0, alignUntil: 0 });
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!visible || !target || !scroller || !content) return;
    if (suspended && position.current.requestId === target.requestId) {
      // Explicit latest navigation owns the viewport. Keep the range/highlight
      // data, but do not restart an old alignment after reader interruption.
      position.current.alignUntil = 0;
      return;
    }
    return installTranscriptSearchFocus({
      target,
      source,
      scroller,
      content,
      position,
      onNavigate,
      onPosition,
      onAlignmentEnd,
    });
  }, [contentRef, contentVersion, onAlignmentEnd, onNavigate, onPosition, scrollRef, source, suspended, target, visible]);
}

type SearchPosition = { current: { requestId: number; alignUntil: number } };

/** Install one browser focus effect; cleanup is safe during StrictMode replay. */
export function installTranscriptSearchFocus({
  target,
  source,
  scroller,
  content,
  position,
  onNavigate,
  onPosition,
  onAlignmentEnd,
}: {
  target: TranscriptSearchTarget;
  source: string;
  scroller: HTMLElement;
  content: HTMLElement;
  position: SearchPosition;
  onNavigate: (fresh: boolean) => void;
  onPosition?: (scrollTop: number) => void;
  onAlignmentEnd?: () => void;
}) {
  const message = content.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(target.messageId)}"]`,
  );
  if (!message) return;
  const row = message.closest<HTMLElement>(".message-row") ?? message;
  row.classList.add("transcript-search-target");
  const fresh = position.current.requestId !== target.requestId;
  if (fresh)
    position.current = { requestId: target.requestId, alignUntil: performance.now() + 1500 };
  const boundary = target.kind === "history-boundary";
  if (!boundary || fresh) onNavigate(fresh);

  let match = boundary ? undefined : locateTranscriptSearch(message, target.query, source);
  let highlight: Highlight | undefined;
  const paint = () => {
    match?.sourceElement?.classList.add("transcript-search-source-match");
    if (match && typeof Highlight !== "undefined" && CSS.highlights && match.ranges.length) {
      highlight = new Highlight(...match.ranges);
      CSS.highlights.set("transcript-search", highlight);
    }
  };
  const unpaint = () => {
    match?.sourceElement?.classList.remove("transcript-search-source-match");
    if (highlight && CSS.highlights?.get("transcript-search") === highlight)
      CSS.highlights.delete("transcript-search");
  };
  const align = () => {
    if (performance.now() >= position.current.alignUntil) return;
    const rect =
      match?.ranges[0]?.getBoundingClientRect() ??
      (match?.sourceElement ?? message).getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    scroller.scrollTop += rect.top - viewport.top - Math.min(160, scroller.clientHeight / 3);
    onPosition?.(scroller.scrollTop);
  };
  paint();
  align();
  // Geometry changes reuse the match. Only a text mutation rebuilds ranges.
  const resize = new ResizeObserver(align);
  resize.observe(content);
  // The same native wheel can finish scrolling after a boundary page commits.
  if (boundary) scroller.addEventListener("scroll", align, { passive: true });
  const stopAlignment = () => {
    position.current.alignUntil = 0;
    resize.disconnect();
    if (boundary) scroller.removeEventListener("scroll", align);
    for (const event of GESTURES) scroller.removeEventListener(event, gesture);
  };
  const gesture = (event: Event) => {
    if (event.type !== "keydown" || READING_KEYS.has((event as KeyboardEvent).key)) stopAlignment();
  };
  for (const event of GESTURES) scroller.addEventListener(event, gesture, { passive: true });
  const timer = window.setTimeout(
    () => { stopAlignment(); onAlignmentEnd?.(); },
    Math.max(0, position.current.alignUntil - performance.now()),
  );
  const mutation = boundary ? undefined : new MutationObserver(() => {
    unpaint();
    match = locateTranscriptSearch(message, target.query, source);
    paint();
    align();
  });
  mutation?.observe(message, { childList: true, subtree: true, characterData: true });
  return () => {
    window.clearTimeout(timer);
    resize.disconnect();
    if (boundary) scroller.removeEventListener("scroll", align);
    for (const event of GESTURES) scroller.removeEventListener(event, gesture);
    mutation?.disconnect();
    row.classList.remove("transcript-search-target");
    unpaint();
  };
}
