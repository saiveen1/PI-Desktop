import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  captureTranscriptReadingPosition,
  getTranscriptReadingPosition,
  restoreTranscriptReadingPosition,
  sessionReadingState,
  type TranscriptReadingPosition,
  type TranscriptReadingRestoreResult,
} from "../lib/transcript-reading-position";

export type RestoreTranscriptReading = (
  position: TranscriptReadingPosition,
  signal: AbortSignal,
) => Promise<TranscriptReadingRestoreResult>;

/** A bounded initial alignment, cancelled by real input/navigation/new turns. */
export function useTranscriptReadingPosition({
  sessionId, scrollRef, contentRef, pinnedRef, visible, windowSize,
  contentVersion, loading, onPosition, onRestore, onMissing,
}: {
  sessionId: string | undefined;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  pinnedRef: RefObject<boolean>;
  visible: boolean;
  windowSize: number;
  contentVersion: unknown;
  loading: boolean;
  onPosition: (top: number) => void;
  onRestore?: RestoreTranscriptReading;
  onMissing: () => void;
}) {
  const [initialPosition] = useState(() => getTranscriptReadingPosition(sessionId));
  const pendingRef = useRef(initialPosition?.pinned === false ? initialPosition : undefined);
  const requestRef = useRef<AbortController | null>(null);
  const completedRestoreRef = useRef<TranscriptReadingPosition | null>(null);
  const restoreReadyRef = useRef(!onRestore);
  const deferredRef = useRef(false);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const alignmentUntilRef = useRef(0);
  const wasVisibleRef = useRef(visible);
  useLayoutEffect(() => {
    if (visible && !wasVisibleRef.current) {
      const bookmark = getTranscriptReadingPosition(sessionId);
      if (bookmark?.pinned === false) {
        pendingRef.current = bookmark;
        pinnedRef.current = false;
      } else if (!pinnedRef.current) {
        pendingRef.current = bookmark;
      }
      alignmentUntilRef.current = 0;
    }
    wasVisibleRef.current = visible;
  }, [pinnedRef, sessionId, visible]);
  const abortRequest = useCallback(() => {
    const controller = requestRef.current;
    requestRef.current = null;
    controller?.abort();
  }, []);
  const cancel = useCallback(() => {
    pendingRef.current = undefined;
    restoreReadyRef.current = false;
    deferredRef.current = false;
    abortRequest();
  }, [abortRequest]);
  const remember = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!sessionId || !visible || !scroller || !content || pendingRef.current) return;
    const position = captureTranscriptReadingPosition(scroller, content, pinnedRef.current, windowSize);
    if (position) sessionReadingState(sessionId).position = position;
  }, [contentRef, pinnedRef, scrollRef, sessionId, visible, windowSize]);
  const callbacks = useRef({ remember, onMissing });
  callbacks.current = { remember, onMissing };

  // Content/loading changes retry deferred paging without aborting an owned lookup.
  useLayoutEffect(() => abortRequest, [abortRequest, onRestore, visible]);
  useLayoutEffect(() => {
    const position = pendingRef.current;
    if (!visible || !position || !onRestore || requestRef.current || completedRestoreRef.current === position) return;
    restoreReadyRef.current = false;
    const controller = new AbortController();
    requestRef.current = controller;
    void onRestore(position, controller.signal).then((result) => {
      if (controller.signal.aborted || requestRef.current !== controller || pendingRef.current !== position) return;
      requestRef.current = null;
      if (result === "restored" || result === "pending") {
        deferredRef.current = result === "pending";
        if (!deferredRef.current) completedRestoreRef.current = position;
        restoreReadyRef.current = true;
        setRestoreRevision((revision) => revision + 1);
        return;
      }
      cancel();
      if (result === "missing") {
        callbacks.current.onMissing();
        callbacks.current.remember();
      }
    }, (error: unknown) => {
      if (controller.signal.aborted || requestRef.current !== controller) return;
      cancel();
      console.error("Transcript reading restoration failed", error);
    });
  }, [cancel, contentVersion, loading, onRestore, visible]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!visible) {
      alignmentUntilRef.current = 0;
      return;
    }
    if (!pendingRef.current || !scroller || !content) return;
    if (!restoreReadyRef.current) return;
    let timer = 0;
    const align = () => {
      const position = pendingRef.current;
      if (!position || !restoreReadyRef.current) return;
      if (alignmentUntilRef.current && performance.now() >= alignmentUntilRef.current) {
        cancel();
        callbacks.current.remember();
        return;
      }
      if (!restoreTranscriptReadingPosition(scroller, content, position)) return;
      onPosition(scroller.scrollTop);
      // An existing page owns IO; keep its visible anchor without timing it out.
      if (deferredRef.current) return;
      if (!alignmentUntilRef.current) {
        alignmentUntilRef.current = performance.now() + 1500;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        cancel();
        callbacks.current.remember();
      }, Math.max(0, alignmentUntilRef.current - performance.now()));
    };
    align();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(align);
    observer?.observe(content);
    return () => {
      window.clearTimeout(timer);
      observer?.disconnect();
    };
  }, [cancel, contentRef, contentVersion, onPosition, onRestore, restoreRevision, scrollRef, visible]);

  // Save laid-out geometry as well as native scrolls (e.g. disclosure changes).
  useLayoutEffect(() => {
    if (!visible) return;
    const content = contentRef.current;
    const observer = content && typeof ResizeObserver !== "undefined" ? new ResizeObserver(remember) : null;
    if (content) observer?.observe(content);
    remember();
    return () => observer?.disconnect();
  }, [contentRef, remember, visible]);

  return { initialPosition, pendingRef, remember, cancel };
}
