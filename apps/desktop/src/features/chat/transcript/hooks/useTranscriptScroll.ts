import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ContextCompactionMark,
  PlanningState,
  UiMessage,
} from "@pi-desktop/shared";
import type { PendingPermission } from "../../../../lib/pending-permissions";
import { transcriptEntryMessages } from "../../../../lib/assistant-turns";
import { getTranscriptProjection } from "../../../../lib/transcript-projection";
import {
  createTranscriptSettleState,
  reduceTranscriptSettle,
  TRANSCRIPT_VEIL_FADE_MS,
} from "../../../../lib/transcript-settle";
import {
  growTranscriptWindow,
  reduceTranscriptWindow,
  TRANSCRIPT_INITIAL_MOUNT,
  TRANSCRIPT_WINDOW_MIN,
  TRANSCRIPT_WINDOW_STEP,
} from "../../../../lib/transcript-window";
import {
  isHistoryRevealPosition,
  isHistoryPrefetchPosition,
  isRecentScrollGesture,
  isScrollGestureInput,
  reduceTranscriptScroll,
  transcriptHasLayout,
  TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX,
  type ScrollInputType,
} from "../../../../lib/transcript-scroll";
import { readScrollInputContext, stopSmoothScroll } from "../../../../lib/scroll-input";
import { useDisclosureAnchor } from "../../../../hooks/use-disclosure-anchor";
import { TRANSCRIPT_PAGE_SIZE, type TranscriptSearchTarget } from "../../../../lib/transcript-reading";
import { useTranscriptSearchFocus } from "../../../../hooks/use-transcript-search-focus";
import {
  getTranscriptReadingPosition,
  transcriptRevealOwnership,
} from "../../../../lib/transcript-reading-position";
import { useTranscriptReadingPosition, type RestoreTranscriptReading } from "../../../../hooks/use-transcript-reading-position";
import { useTurnCompletionScroll } from "./useTurnCompletionScroll";
import { useTranscriptHistoryPaging } from "./useTranscriptHistoryPaging";
import { useTranscriptLatestNavigation } from "./useTranscriptLatestNavigation";

type UseTranscriptScrollOptions = {
  sessionId: string | undefined;
  messages: UiMessage[];
  compactions?: ContextCompactionMark[];
  hasMoreBefore: boolean;
  onLoadOlder?: (options?: import("../../../../lib/transcript-reading").TranscriptEarlierRead) => Promise<void>;
  onLoadNewer?: () => Promise<void>;
  isRunning: boolean;
  pendingPermission?: PendingPermission;
  askPending: boolean;
  approvalPending: boolean;
  planningState?: PlanningState;
  paneVisible: boolean;
  searchTarget: TranscriptSearchTarget | null;
  readingWindow: boolean;
  navigationLoading?: boolean;
  onRestoreReading?: RestoreTranscriptReading;
};

export function useTranscriptScroll({
  sessionId,
  messages,
  compactions,
  hasMoreBefore,
  onLoadOlder,
  onLoadNewer,
  isRunning,
  pendingPermission,
  askPending,
  approvalPending,
  planningState,
  paneVisible,
  searchTarget,
  readingWindow,
  navigationLoading = false,
  onRestoreReading,
}: UseTranscriptScrollOptions) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const seekingEarlierRef = useRef(false);
  const [savedReadingPosition] = useState(() => getTranscriptReadingPosition(sessionId));
  const pinnedRef = useRef(savedReadingPosition?.pinned ?? true);
  const lastScrollTopRef = useRef(0);
  const lastScrollAtRef = useRef(-Infinity);
  // Last offset sampled while the scroller had a real layout box. A hidden
  // pane's `content-visibility: hidden` box reports `scrollTop === 0`, so the
  // hide transition must restore this rather than the collapsed value.
  const lastLaidOutScrollTopRef = useRef(0);
  const lastScrollGestureAtRef = useRef(-Infinity);
  const wasRunningRef = useRef(isRunning);
  const followFrameRef = useRef(0);
  const [showJump, setShowJump] = useState(false);

  // Steady-state cap on mounted history rows (D261). Grows when the user
  // reaches the top of the window; reset per session below.
  const [windowSize, setWindowSize] = useState(() => savedReadingPosition?.pinned === false
    ? savedReadingPosition.windowSize : TRANSCRIPT_WINDOW_MIN);
  // Read by `reachTop`, which must stay referentially stable for the scroll
  // listener; the projection it describes is only known later in this render.
  const historyLengthRef = useRef(0);
  const foldedBoundaryRef = useRef(false);
  const boundaryRequest = useRef(0);
  const [boundaryTarget, setBoundaryTarget] = useState<TranscriptSearchTarget | null>(null);
  const clearBoundaryTarget = useCallback(() => setBoundaryTarget(null), []);
  useLayoutEffect(() => {
    if (!paneVisible || isRunning || searchTarget) clearBoundaryTarget();
  }, [clearBoundaryTarget, isRunning, paneVisible, searchTarget]);
  const promptReadRef = useRef<AbortController | null>(null);
  const cancelPromptRead = useCallback(() => { promptReadRef.current?.abort(); }, []);
  useLayoutEffect(() => cancelPromptRead, [cancelPromptRead, paneVisible]);
  const resumeEarlierRef = useRef<() => void>(() => {});
  const latestNavigation = useTranscriptLatestNavigation({ scrollRef, visible: paneVisible });

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    if (latestNavigation.isActive()) return;
    const el = scrollRef.current;
    if (!el || !transcriptHasLayout(el)) return;
    const targetTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({ top: targetTop, behavior });
    // `scrollTo({ behavior: "auto" })` is synchronous. Record the position the
    // scroller actually reached, not the one that was asked for: at a
    // fractional device pixel ratio the browser lands a fraction of a pixel
    // away (asked 841, got 840.909), and the intended value would make the
    // following native scroll event read as the user scrolling up.
    if (behavior === "auto") {
      lastScrollTopRef.current = el.scrollTop;
      lastLaidOutScrollTopRef.current = el.scrollTop;
    }
  }, [latestNavigation]);

  const cancelFollowScroll = useCallback(() => {
    cancelAnimationFrame(followFrameRef.current);
    followFrameRef.current = 0;
  }, []);
  const recordScrollPosition = useCallback((top: number) => {
    lastScrollTopRef.current = top;
    lastLaidOutScrollTopRef.current = top;
  }, []);
  const readingPositionMissing = useCallback(() => {
    pinnedRef.current = true;
    setShowJump(false);
    scrollToBottom();
  }, [scrollToBottom]);
  const {
    pendingRef: readingPositionPendingRef,
    remember: rememberReadingPosition,
    cancel: cancelReadingPosition,
  } = useTranscriptReadingPosition({
    sessionId, scrollRef, contentRef, pinnedRef, visible: paneVisible,
    windowSize, contentVersion: messages, loading: navigationLoading,
    onPosition: recordScrollPosition, onRestore: onRestoreReading, onMissing: readingPositionMissing,
  });

  // State transition only: completion calls this after starting its own
  // prompt navigation, which must be allowed to finish.
  const leaveFollow = useCallback(() => {
    seekingEarlierRef.current = false;
    cancelReadingPosition();
    cancelFollowScroll();
    pinnedRef.current = false;
    setShowJump(true);
  }, [cancelFollowScroll, cancelReadingPosition]);

  /*
    Leave follow mode. Every reader-driven move inside the transcript starts
    here: while the scroller is still pinned, a scroll that carries no input
    gesture is indistinguishable from a layout clamp, so the follow re-bottoms
    the view one frame later and undoes the move.
  */
  const releaseFollow = useCallback(() => {
    latestNavigation.cancel();
    stopSmoothScroll(scrollRef.current);
    leaveFollow();
  }, [latestNavigation, leaveFollow]);

  // A manual disclosure (a tool, thinking or activity title; #324) hands this
  // scroller the very title it was toggled from, before the expansion state
  // changes. Follow mode is left first — re-bottoming the expansion is exactly
  // what dragged the clicked title out of view — and the held position is
  // restored from the observer below for every frame of the height transition.
  const enterDisclosureReading = useCallback(() => {
    releaseFollow();
  }, [releaseFollow]);
  const {
    notifier: disclosureAnchorNotifier,
    restore: restoreDisclosureAnchor,
    release: releaseDisclosureAnchor,
    isHeld: isDisclosureAnchorHeld,
  } = useDisclosureAnchor(
    scrollRef,
    enterDisclosureReading,
    recordScrollPosition,
  );
  const startHistoryReading = useCallback(() => {
    releaseDisclosureAnchor();
    leaveFollow();
  }, [leaveFollow, releaseDisclosureAnchor]);
  const {
    loadingOlder, pending: historyPending, run: preserveHistory, retry: retryHistoryPaging,
    restore: restoreHistoryAnchor, isHeld: isHistoryPaging,
    track: trackHistoryPosition, cancel: cancelHistoryPaging, readLatency: historyReadLatency,
    setEarlierIntent,
  } = useTranscriptHistoryPaging({
    scrollRef, contentRef, visible: paneVisible, sourceHead: messages[0]?.id, onStart: startHistoryReading,
    canRetain: (paging) => paneVisible && !pinnedRef.current && (paging || (!latestNavigation.isActive() &&
      !readingPositionPendingRef.current && !isDisclosureAnchorHeld() && !searchTarget && !boundaryTarget)),
    onPosition: recordScrollPosition,
    onSettled: (resumeEarlier) => {
      rememberReadingPosition();
      if (resumeEarlier) resumeEarlierRef.current();
    },
  });
  const releaseNavigationFollow = useCallback(() => {
    cancelPromptRead();
    clearBoundaryTarget();
    cancelHistoryPaging();
    releaseFollow();
  }, [cancelPromptRead, cancelHistoryPaging, clearBoundaryTarget, releaseFollow]);
  const notifyDisclosure = useCallback<typeof disclosureAnchorNotifier>((title) => {
    cancelPromptRead();
    clearBoundaryTarget();
    cancelHistoryPaging();
    disclosureAnchorNotifier(title);
  }, [cancelPromptRead, cancelHistoryPaging, clearBoundaryTarget, disclosureAnchorNotifier]);

  useLayoutEffect(() => {
    if (!navigationLoading || !latestNavigation.isActive()) return;
    latestNavigation.cancel();
    leaveFollow();
    rememberReadingPosition();
  }, [latestNavigation, leaveFollow, navigationLoading, rememberReadingPosition]);

  const reachTop = useCallback((atBoundary = false, fromScroll = false) => {
    if (!paneVisible) return;
    if (isHistoryPaging()) {
      if (atBoundary) setEarlierIntent(true);
      return;
    }
    const grown = growTranscriptWindow(windowSize, historyLengthRef.current);
    if (!searchTarget && grown !== windowSize) {
      preserveHistory(() => setWindowSize(grown), windowSize);
      return;
    }
    if (!hasMoreBefore || !onLoadOlder) return;
    const oldestTurn = fromScroll && foldedBoundaryRef.current && contentRef.current?.querySelector(".assistant-turn");
    const folded = oldestTurn && oldestTurn.querySelector('.turn-process > button[aria-expanded="false"]') &&
      !oldestTurn.querySelector('.turn-process > button[aria-expanded="true"]');
    // Don't start raw prefetch before the same gesture can reach the folded edge.
    if (folded && !atBoundary) return;
    preserveHistory(() => {
      // Make the incoming rows reachable in the same action. Failed or empty
      // reads cannot grow the budget repeatedly against the same source.
      setWindowSize(Math.max(windowSize, historyLengthRef.current + TRANSCRIPT_WINDOW_STEP));
      if (!folded || !sessionId) return onLoadOlder();
      const request = new AbortController();
      promptReadRef.current = request;
      return onLoadOlder({ signal: request.signal, revealPrevious: (messageId) => {
        setBoundaryTarget({ sessionId, messageId, query: "", kind: "history-boundary", requestId: --boundaryRequest.current });
      } }).finally(() => {
        if (promptReadRef.current === request) promptReadRef.current = null;
      });
    }, windowSize, true);
  }, [hasMoreBefore, isHistoryPaging, onLoadOlder, paneVisible, preserveHistory, searchTarget, sessionId, setEarlierIntent, windowSize]);
  useLayoutEffect(() => {
    resumeEarlierRef.current = () => {
      const scroller = scrollRef.current;
      if (scroller && !pinnedRef.current && isHistoryPrefetchPosition(scroller)) {
        lastScrollGestureAtRef.current = -Infinity;
        reachTop();
      }
    };
  }, [reachTop]);

  // A user scroll-up gesture always emits input before its scroll events;
  // programmatic follow scrolling and layout clamps (composer collapse on
  // send, indicator mount/unmount) never do. Track the last real input so
  // `handleScroll` can tell the two apart and never let a clamp between a
  // follow `scrollTo` and its native event release follow mode. Only input
  // that can move *this* scroller counts: a press on a row control is an
  // ordinary click, a field owns its own keys, and a gesture a nested dock
  // consumes belongs to that dock.
  const markScrollGesture = useCallback(
    (event: Event) => {
      if (event instanceof WheelEvent && (event.ctrlKey || event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY))) return;
      const input = readScrollInputContext(
        event,
        scrollRef.current,
        contentRef.current,
      );
      if (!isScrollGestureInput(event.type as ScrollInputType, input)) return;
      clearBoundaryTarget();
      seekingEarlierRef.current = false;
      if (latestNavigation.isActive()) {
        latestNavigation.cancel(); leaveFollow(); rememberReadingPosition();
      }
      // Settle pending geometry before the browser applies this input. A recent
      // wheel timestamp cannot distinguish its movement from a same-frame clamp.
      restoreHistoryAnchor();
      if (!(event instanceof WheelEvent) || (!event.ctrlKey && event.deltaY !== 0)) retryHistoryPaging();
      // Minimap / jump navigation runs in the browser, independently of our
      // follow rAF. Real input must retire that animation at its current offset
      // before its queued frames can overwrite the reader's next movement.
      stopSmoothScroll(scrollRef.current);
      cancelReadingPosition();
      lastScrollGestureAtRef.current = performance.now();
      // Real input takes the viewport back from a held disclosure position.
      releaseDisclosureAnchor();
      // At the physical top, upward input produces no native scroll event.
      const el = scrollRef.current;
      if (!el || !(event.target instanceof Node) || !el.contains(event.target)) return;
      const upward = event instanceof WheelEvent ? event.deltaY < 0
        : event instanceof KeyboardEvent ? ["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)
        : undefined;
      if (upward === false) setEarlierIntent(false);
      if (upward && el.scrollTop <= 1 && transcriptHasLayout(el)) reachTop(true, true);
      if (upward === false) cancelPromptRead();
    },
    [cancelReadingPosition, clearBoundaryTarget, latestNavigation, leaveFollow, reachTop, releaseDisclosureAnchor, rememberReadingPosition, restoreHistoryAnchor, retryHistoryPaging, setEarlierIntent],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener("wheel", markScrollGesture, { passive: true });
    el.addEventListener("touchstart", markScrollGesture, { passive: true });
    el.addEventListener("touchmove", markScrollGesture, { passive: true });
    el.addEventListener("pointerdown", markScrollGesture, { passive: true });
    el.addEventListener("keydown", markScrollGesture, { passive: true });
    return () => {
      el.removeEventListener("wheel", markScrollGesture);
      el.removeEventListener("touchstart", markScrollGesture);
      el.removeEventListener("touchmove", markScrollGesture);
      el.removeEventListener("pointerdown", markScrollGesture);
      el.removeEventListener("keydown", markScrollGesture);
    };
  }, [markScrollGesture]);

  // Cold first visits still settle at the newest turn. A runtime bookmark wins
  // over initialization and progressive hydration when an evicted pane remounts.
  useLayoutEffect(() => {
    releaseDisclosureAnchor();
    cancelFollowScroll();
    pinnedRef.current = savedReadingPosition?.pinned ?? true;
    setShowJump(!pinnedRef.current);
    if (pinnedRef.current) scrollToBottom();
  }, [cancelFollowScroll, releaseDisclosureAnchor, savedReadingPosition, scrollToBottom]);

  // Revisits restore this pane's own position. A hidden scroller can be clamped
  // while its content grows off screen, so the offset is captured on the way out
  // and reapplied during the layout phase that reveals the pane: a pane the user
  // had scrolled up in returns to that offset, a pinned one returns to the
  // bottom, and neither shows an intermediate frame.
  const retainedScrollTopRef = useRef<number | null>(null);
  const wasPaneVisibleRef = useRef(paneVisible);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const becameHidden = wasPaneVisibleRef.current && !paneVisible;
    const becameVisible = !wasPaneVisibleRef.current && paneVisible;
    // The transition is only consumed once there is a scroller to read or
    // position. Committing it before this guard would swallow the edge and lose
    // the offset a pane hidden before its scroller existed should return to.
    if (!el) return;
    wasPaneVisibleRef.current = paneVisible;
    if (becameHidden) {
      seekingEarlierRef.current = false;
      lastScrollGestureAtRef.current = -Infinity;
      releaseDisclosureAnchor();
      cancelFollowScroll();
      // Do not read `el.scrollTop` here: the hide CSS has already skipped
      // rendering, so the box reports 0. Restore the last laid-out offset.
      retainedScrollTopRef.current = lastLaidOutScrollTopRef.current;
      return;
    }
    if (!becameVisible) return;
    const bookmark = getTranscriptReadingPosition(sessionId);
    const ownership = transcriptRevealOwnership(
      bookmark,
      Boolean(readingPositionPendingRef.current),
      pinnedRef.current,
    );
    if (ownership === "reading-position") {
      // The reading-position hook restores this bookmark (or reports it
      // missing). Bottoming here would race it and land on the newest turn.
      if (bookmark?.pinned === false) {
        pinnedRef.current = false;
        setShowJump(true);
      }
      return;
    }
    if (ownership === "pinned") {
      scrollToBottom();
      return;
    }
    const retained = retainedScrollTopRef.current;
    if (retained === null) return;
    el.scrollTop = retained;
    lastScrollTopRef.current = retained;
    lastLaidOutScrollTopRef.current = retained;
  }, [
    cancelFollowScroll,
    paneVisible,
    releaseDisclosureAnchor,
    scrollToBottom,
    sessionId,
  ]);

  // A hidden pane must not chase its stream: its scroller has no visible
  // viewport, and the measurements a follow scroll depends on are unreliable
  // while it is out of view. It re-anchors when it is revealed instead.
  const paneVisibleRef = useRef(paneVisible);
  paneVisibleRef.current = paneVisible;
  const scheduleFollowScroll = useCallback(() => {
    if (latestNavigation.isActive()) return;
    if (isHistoryPaging()) return;
    if (!paneVisibleRef.current) return;
    // A held disclosure position wins over a queued follow frame: re-asserting
    // the bottom here would move the title the reader just toggled even though
    // the observer below already refuses to.
    if (!pinnedRef.current || followFrameRef.current !== 0) return;
    if (isDisclosureAnchorHeld()) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = 0;
      if (paneVisibleRef.current && pinnedRef.current) scrollToBottom();
    });
  }, [isDisclosureAnchorHeld, isHistoryPaging, latestNavigation, scrollToBottom]);

  // Re-pins before the browser paints. A ResizeObserver callback runs after
  // layout and before paint, so a `requestAnimationFrame` requested from it
  // lands in the *next* frame: the current frame painted the grown content
  // unpinned and the next one snapped it back, which read as the transcript
  // twitching whenever a row changed height after mount (D287). Scrolling from
  // inside the callback costs nothing extra (layout is already clean) and
  // cannot resize the observed box, so it never re-triggers the observer.
  //
  // A manual disclosure holds the title the reader toggled (#324) and is
  // restored first: its height can keep changing for several frames, and
  // re-pinning on any one of them is what dragged that title out of view.
  const followScrollNow = useCallback(() => {
    if (paneVisibleRef.current && restoreHistoryAnchor()) return;
    if (paneVisibleRef.current && restoreDisclosureAnchor()) return;
    if (!paneVisibleRef.current || !pinnedRef.current) return;
    cancelFollowScroll();
    scrollToBottom();
  }, [cancelFollowScroll, restoreDisclosureAnchor, restoreHistoryAnchor, scrollToBottom]);

  useEffect(() => cancelFollowScroll, [cancelFollowScroll]);

  const loadNewer = useCallback(async () => {
    if (!paneVisibleRef.current || !onLoadNewer) return;
    if (searchTarget) return onLoadNewer();
    preserveHistory(async () => {
      // Keep the old reading rows mounted while the newer page joins them.
      setWindowSize((size) => size + TRANSCRIPT_PAGE_SIZE);
      await onLoadNewer();
    }, windowSize);
  }, [onLoadNewer, preserveHistory, searchTarget, windowSize]);

  // Follow the stream only while the user is pinned to the bottom; a manual
  // scroll up pauses following and surfaces the jump-to-latest pill.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const now = performance.now();
    const elapsed = now - lastScrollAtRef.current;
    lastScrollAtRef.current = now;
    const movementUp = lastScrollTopRef.current - el.scrollTop;
    const upwardSpeed = Math.max(0, movementUp) / (elapsed > 0 && elapsed <= 200 ? Math.max(8, elapsed) : 16);
    if (latestNavigation.isActive()) { recordScrollPosition(el.scrollTop); return; }
    trackHistoryPosition();
    if (paneVisibleRef.current && transcriptHasLayout(el)) {
      lastLaidOutScrollTopRef.current = el.scrollTop;
    }
    if (readingPositionPendingRef.current) {
      lastScrollTopRef.current = el.scrollTop;
      return;
    }
    const gesturing = isRecentScrollGesture(
      performance.now(),
      lastScrollGestureAtRef.current,
    );
    if (gesturing && movementUp < 0) { setEarlierIntent(false); cancelPromptRead(); }
    if (paneVisibleRef.current && seekingEarlierRef.current && isHistoryRevealPosition(el)) {
      seekingEarlierRef.current = false;
      reachTop(true);
    } else if (paneVisibleRef.current && gesturing && upwardSpeed > 0 &&
      isHistoryPrefetchPosition(el, false, { upwardSpeed, latencyMs: historyReadLatency() })) {
      reachTop(el.scrollTop <= 1, true);
    }
    if (readingWindow) {
      pinnedRef.current = false;
      lastScrollTopRef.current = el.scrollTop;
      setShowJump(true);
      rememberReadingPosition();
      return;
    }
    const wasPinned = pinnedRef.current;
    // Only a real gesture (wheel / trackpad / touch / scrollbar / keyboard,
    // on this scroller) releases follow. When the composer collapses or an
    // indicator row unmounts right after send, the browser clamps scrollTop
    // and emits a scroll event that looks like an upward gesture; without
    // this guard it would cancel follow and leave the transcript stuck above
    // the new turn. The tolerance is slack for the fractions a fractional
    // device pixel ratio leaves behind on programmatic corrections; anything a
    // gesture produced is compared exactly, so a one-pixel scroll still
    // unpins.
    // `gesturing` was read above, before the history-reveal question: a real
    // gesture is what makes a near-top offset the reader's own position.
    const transition = reduceTranscriptScroll({
      previousScrollTop: lastScrollTopRef.current,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      wasPinned,
      tolerancePx: gesturing ? 0 : TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX,
    });
    lastScrollTopRef.current = el.scrollTop;
    if (transition.releasedFollow) cancelFollowScroll();
    if (gesturing && transition.releasedFollow) {
      pinnedRef.current = false;
      setShowJump(true);
    } else if (transition.releasedFollow) {
      // Programmatic / layout noise: re-baseline the observed position and
      // keep the follow state unchanged instead of treating it as a user
      // gesture. A pinned transcript re-asserts the bottom; an unpinned one
      // stays unpinned.
      pinnedRef.current = wasPinned;
      setShowJump(!wasPinned);
      scheduleFollowScroll();
    } else {
      pinnedRef.current = transition.pinned;
      setShowJump(transition.showJump);
    }
    trackHistoryPosition(windowSize);
    rememberReadingPosition();
  }, [cancelFollowScroll, historyReadLatency, latestNavigation, reachTop, readingPositionPendingRef, readingWindow, recordScrollPosition, rememberReadingPosition, scheduleFollowScroll, setEarlierIntent, trackHistoryPosition, windowSize]);

  // Send / retry / regenerate always re-pins follow mode so the new prompt and
  // its stream stay in view, even if the user had scrolled up through history.
  // This must run in the layout phase: the send state is committed before the
  // persisted user-message event arrives, and a passive effect allows one
  // frame where a long transcript can remain at its old/top position.
  useLayoutEffect(() => {
    const turnStarted = isRunning && !wasRunningRef.current;
    wasRunningRef.current = isRunning;
    if (!turnStarted || !paneVisible || readingWindow) return;
    seekingEarlierRef.current = false;
    latestNavigation.cancel(true);
    cancelHistoryPaging();
    cancelReadingPosition();
    releaseDisclosureAnchor();
    cancelFollowScroll();
    pinnedRef.current = true;
    setWindowSize(TRANSCRIPT_WINDOW_MIN);
    setShowJump(false);
    scrollToBottom();
    rememberReadingPosition();
    scheduleFollowScroll();
  }, [
    cancelFollowScroll,
    cancelHistoryPaging,
    cancelReadingPosition,
    isRunning,
    latestNavigation,
    readingWindow,
    paneVisible,
    releaseDisclosureAnchor,
    rememberReadingPosition,
    scheduleFollowScroll,
    scrollToBottom,
  ]);

  // A completed turn the reader followed ends at its prompt, not its last line.
  useTurnCompletionScroll({
    isRunning, paneVisible, readingWindow, messages, scrollRef, contentRef,
    isFollowing: () => pinnedRef.current && !latestNavigation.isActive() && !isDisclosureAnchorHeld() && !isHistoryPaging(),
    onAnchored: leaveFollow,
  });

  useLayoutEffect(() => {
    scheduleFollowScroll();
  }, [
    messages,
    isRunning,
    pendingPermission?.requestId,
    askPending,
    approvalPending,
    planningState,
    scheduleFollowScroll,
  ]);

  // Streamed Markdown, expanded activity rows, late images, and diagrams change
  // the content height without a React commit, so pinned follow is kept in sync
  // from the observed layout. The content is observed on its border box: the
  // bottom padding is the composer's published height, and a multi-line draft
  // growing that padding must re-pin too, or the newest turn slides behind the
  // composer until the next commit happens to re-pin it. The content box does
  // not include padding and would miss that change entirely. The scroller is
  // observed as well so a window or work-panel resize keeps the bottom in view.
  useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (!content || !scroller || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(followScrollNow);
    ro.observe(content, { box: "border-box" });
    ro.observe(scroller, { box: "border-box" });
    return () => ro.disconnect();
  }, [followScrollNow]);

  // Defer one immutable projection, never messages and compaction boundaries
  // independently. First paint, reading, and pane reveal use the current source.
  const firstCommitRef = useRef(true);
  const firstCommit = firstCommitRef.current;
  const paneRevealed = paneVisible && !wasPaneVisibleRef.current;
  const projection = useMemo(
    () => getTranscriptProjection(messages, compactions),
    [messages, compactions],
  );
  const deferredProjection = useDeferredValue(projection);
  const renderedProjection =
    readingWindow || historyPending || boundaryTarget || firstCommit || paneRevealed ? projection : deferredProjection;
  const { entries, visible, history: allHistoryEntries } = renderedProjection;
  const tailEntry = entries.at(-1);
  // Published for `reachTop`, which is declared above this projection but only
  // runs from a scroll event, long after this render committed.
  historyLengthRef.current = allHistoryEntries.length;

  // Progressive hydration, now scoped to this pane's own first commit
  // (ADR 0137): mount only the bottom portion of the transcript when the pane
  // mounts, then expand to the steady-state window after paint, with a spacer
  // holding the scroll height. Because the instance belongs to one session, the
  // gate is plain local mount state rather than a comparison against whichever
  // session was rendered last.
  //
  // The gate has to be derived during render, not set from an effect. Deciding
  // it from a layout effect mounted the *whole* history first and only then cut
  // it back to the budget, so a long session built its entire DOM, discarded it,
  // and rebuilt it, which is the opposite of what bounding the first commit is
  // for.
  //
  // The expansion target is the mounted window (D261), not the whole history: a
  // paged-in session used to end up with every row mounted for good, retaining
  // its Markdown and highlighting for rows nobody was looking at.
  const [hydrationTick, setHydrationTick] = useState(0);
  const hydrationBounded =
    !readingWindow && firstCommit && savedReadingPosition?.pinned !== false &&
    allHistoryEntries.length > TRANSCRIPT_INITIAL_MOUNT;
  // The bounded commit and the expansion must show the transcript at the same
  // place. A spacer sized from a per-entry guess cannot match the rows it stands
  // in for, so the expansion moved the visible text by the estimate error - the
  // reported page-flip jitter on a session switch. The spacer now only reserves
  // enough height to make the bottom reachable, and the expansion re-pins the
  // exact bottom in the same layout phase it commits in.
  //
  // The "needs re-anchoring" flag is derived from which session was bounded, not
  // written during render: StrictMode double-renders and abandoned concurrent
  // renders would otherwise leave a plain boolean ref set and re-bottom a
  // transcript the user had scrolled up in.
  const boundedFirstCommitRef = useRef(false);
  useEffect(() => {
    if (!hydrationBounded) {
      // An empty first paint must not spend this gate: revalidation can still
      // land a long transcript that needs the bounded expand and re-bottom.
      if (allHistoryEntries.length > 0) firstCommitRef.current = false;
      return;
    }
    boundedFirstCommitRef.current = true;
    const frame = requestAnimationFrame(() => {
      firstCommitRef.current = false;
      setHydrationTick((tick) => tick + 1);
    });
    return () => cancelAnimationFrame(frame);
    // `hydrationTick` is a dependency so a pane whose expansion is still queued
    // re-evaluates instead of holding a stale frame.
  }, [allHistoryEntries.length, hydrationBounded, hydrationTick]);

  // Settle veil (D287). A bounded first commit means the transcript is long
  // enough for its geometry to keep moving for several frames after mount: the
  // expansion, then rows whose height resolves only once laid out. Rather than
  // painting that motion, an opaque skeleton covers the scroller until the
  // geometry has held still (or a hard time cap passes) and then fades out.
  // Short transcripts mount in one commit and never show the veil. The phase is
  // initialised from the first render's own gate so the veil is in the commit
  // that reveals the pane, not one frame later.
  const [veilPhase, setVeilPhase] = useState<"covering" | "leaving" | "off">(
    () => (hydrationBounded ? "covering" : "off"),
  );
  const veilCovering = veilPhase === "covering";

  const boundaryIndex = useMemo(() => boundaryTarget ? allHistoryEntries.findIndex((entry) =>
    transcriptEntryMessages([entry]).some((message) => message.id === boundaryTarget.messageId)) : -1,
  [allHistoryEntries, boundaryTarget]);
  const boundaryBudget = boundaryIndex < 0 ? 0 : allHistoryEntries.length - boundaryIndex;
  const transcriptWindow = reduceTranscriptWindow({
    historyLength: allHistoryEntries.length,
    windowSize: searchTarget ? allHistoryEntries.length : Math.max(windowSize, boundaryBudget),
    initialCommit: hydrationBounded,
  });
  // Memoized so unrelated re-renders (jump pill, loading row) hand
  // `TranscriptHistory` the same array and it can bail on identity instead of
  // walking every mounted row.
  const historyEntries = useMemo(
    () =>
      transcriptWindow.bounded
        ? allHistoryEntries.slice(-transcriptWindow.mounted)
        : allHistoryEntries,
    [allHistoryEntries, transcriptWindow.bounded, transcriptWindow.mounted],
  );

  const releaseSearchFollow = useCallback((fresh: boolean) => {
    seekingEarlierRef.current = false;
    if (fresh) lastScrollGestureAtRef.current = -Infinity;
    latestNavigation.cancel();
    stopSmoothScroll(scrollRef.current);
    cancelReadingPosition();
    if (fresh) cancelHistoryPaging();
    releaseDisclosureAnchor();
    cancelFollowScroll();
    pinnedRef.current = false;
    setShowJump(true);
  }, [cancelFollowScroll, cancelHistoryPaging, cancelReadingPosition, latestNavigation, releaseDisclosureAnchor]);
  useTranscriptSearchFocus({
    target: searchTarget ?? boundaryTarget,
    suspended: latestNavigation.isActive(),
    source: searchTarget
      ? messages.find((message) => message.id === searchTarget.messageId)?.content ?? ""
      : "",
    visible: paneVisible,
    scrollRef,
    contentRef,
    contentVersion: historyEntries,
    onNavigate: releaseSearchFollow,
    onPosition: recordScrollPosition,
    onAlignmentEnd: searchTarget ? undefined : clearBoundaryTarget,
  });
  useLayoutEffect(() => {
    if (!boundaryTarget || !paneVisible) return;
    setWindowSize((size) => Math.max(size, boundaryBudget));
  }, [boundaryBudget, boundaryTarget, paneVisible]);

  // Runs in the same layout phase the expansion commits in, before the browser
  // paints it, so mounting the remaining history cannot move the rows the user
  // is already looking at. A user who scrolled up during the bounded frame keeps
  // their position: only a still-pinned transcript is re-bottomed.
  useLayoutEffect(() => {
    if (hydrationBounded || !boundedFirstCommitRef.current) return;
    boundedFirstCommitRef.current = false;
    if (!pinnedRef.current) return;
    cancelFollowScroll();
    scrollToBottom();
  }, [cancelFollowScroll, hydrationBounded, hydrationTick, scrollToBottom]);

  // Sample the scroller once per frame from the expansion commit onward and
  // lift the veil once the geometry has stopped moving. The bounded commit
  // itself is not sampled: the expansion that follows it changes the height by
  // design. Each sample also re-pins a still-pinned transcript, so the frame the
  // veil reveals is already at the newest turn. A hidden pane pauses sampling
  // (its scroller reports no usable geometry) and resumes when revealed.
  useEffect(() => {
    if (!veilCovering || hydrationBounded || !paneVisible) return;
    const el = scrollRef.current;
    if (!el) return;
    let state = createTranscriptSettleState(performance.now());
    let frame = 0;
    const sample = () => {
      frame = 0;
      if (pinnedRef.current) scrollToBottom();
      const step = reduceTranscriptSettle(
        state,
        { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
        performance.now(),
      );
      state = step.state;
      if (step.settled) {
        setVeilPhase("leaving");
        return;
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    return () => cancelAnimationFrame(frame);
  }, [hydrationBounded, paneVisible, scrollToBottom, veilCovering]);

  useEffect(() => {
    if (veilPhase !== "leaving") return;
    const timer = window.setTimeout(
      () => setVeilPhase("off"),
      TRANSCRIPT_VEIL_FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [veilPhase]);

  // The minimap must describe the mounted rows, not every loaded message: it
  // resolves a click by looking up the marker's node in the scroller, so a dash
  // for a withheld row would jump nowhere (D261).
  const minimapMessages = useMemo(
    () =>
      transcriptWindow.bounded
        ? transcriptEntryMessages(
            tailEntry ? [...historyEntries, tailEntry] : historyEntries,
          )
        : visible,
    [historyEntries, tailEntry, transcriptWindow.bounded, visible],
  );
  const hasEarlierHistory = transcriptWindow.hiddenAbove > 0 || hasMoreBefore;
  foldedBoundaryRef.current = hasMoreBefore && !transcriptWindow.hiddenAbove && !isRunning && !readingWindow &&
    !searchTarget && Boolean(sessionId && !sessionId.startsWith("native-pi:") && !sessionId.startsWith("remote:") &&
      entries[0]?.kind === "assistant-turn" && entries[0].parts.some((part) =>
        part.kind === "activity" && part.items.some((item) => item.kind === "tool")));

  const revealEarlierHistory = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    retryHistoryPaging();
    lastScrollGestureAtRef.current = -Infinity;
    if (isHistoryRevealPosition(el)) {
      reachTop(true);
      return;
    }
    releaseDisclosureAnchor();
    releaseFollow();
    seekingEarlierRef.current = true;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollTo({
      top: 0,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [reachTop, releaseDisclosureAnchor, releaseFollow, retryHistoryPaging]);

  const jumpToLatest = useCallback((arrive?: () => void) => {
    // Retire the gesture and all competing owners before yielding any frames.
    seekingEarlierRef.current = false;
    lastScrollGestureAtRef.current = -Infinity;
    cancelPromptRead();
    clearBoundaryTarget();
    cancelReadingPosition();
    cancelHistoryPaging();
    cancelFollowScroll();
    releaseDisclosureAnchor();
    pinnedRef.current = true;
    setShowJump(false);
    // A hide/eviction must still retain the accepted follow intent.
    rememberReadingPosition();
    latestNavigation.start(() => {
      arrive?.();
      setWindowSize(TRANSCRIPT_WINDOW_MIN);
      scrollToBottom();
    });
  }, [cancelFollowScroll, cancelHistoryPaging, cancelPromptRead, cancelReadingPosition, clearBoundaryTarget, latestNavigation, releaseDisclosureAnchor, rememberReadingPosition, scrollToBottom]);

  useLayoutEffect(() => {
    if (paneVisible && pinnedRef.current && windowSize === TRANSCRIPT_WINDOW_MIN) scrollToBottom();
  }, [paneVisible, scrollToBottom, windowSize]);

  return {
    scrollRef,
    wrapRef,
    contentRef,
    loadingOlder,
    historyPending,
    showJump,
    historyEntries,
    tailEntry,
    minimapMessages,
    hasEarlierHistory,
    hydrationBounded,
    veilCovering,
    veilPhase,
    handleScroll,
    revealEarlierHistory,
    loadNewer,
    scrollToBottom,
    jumpToLatest,
    isLatestNavigationActive: latestNavigation.isActive,
    releaseFollow: releaseNavigationFollow,
    disclosureAnchorNotifier: notifyDisclosure,
  };
}
