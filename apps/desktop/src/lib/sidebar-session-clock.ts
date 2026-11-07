const MINUTE_MS = 60_000;
const listeners = new Set<() => void>();
let snapshot = Date.now();
let interval: number | undefined;

function publish() {
  snapshot = Date.now();
  for (const listener of listeners) listener();
}

function stopInterval() {
  if (interval === undefined) return;
  window.clearInterval(interval);
  interval = undefined;
}

function resume() {
  if (document.hidden) {
    stopInterval();
    return;
  }
  if (interval === undefined) interval = window.setInterval(publish, MINUTE_MS);
  publish();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined" && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    resume();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size !== 0 || typeof window === "undefined" || typeof document === "undefined") return;
    stopInterval();
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("focus", resume);
  };
}

/** One visibility-aware clock shared by mounted session time labels, not Sidebar. */
export const sidebarSessionClock = {
  subscribe,
  getSnapshot: () => snapshot,
};
