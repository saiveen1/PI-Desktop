import {
  resolveNotificationPolicy,
  type NotificationDeliveryResult,
  type NotificationSettings,
  type NotificationTarget,
} from "@pi-desktop/shared";

export type NotificationEntry = {
  id: string;
  target: NotificationTarget;
  title: string;
  body: string;
  createdAt?: string;
  expiresAt?: number;
  /** Suppress only the initial sound for a request restored from a host snapshot. */
  hydrated?: boolean;
};
type Dependencies = {
  settings: () => NotificationSettings | undefined;
  foreground: () => boolean;
  native: (entry: NotificationEntry) => Promise<NotificationDeliveryResult>;
  dismiss: (id: string, retire: boolean) => Promise<unknown>;
  inApp: (entry: NotificationEntry) => void;
  sound: (volume: number) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Kept by the application owner across view remounts, not by a component. */
  seen?: Set<string>;
  onError?: (error: unknown) => void;
  onPendingChanged?: () => void;
};
type Pending = { entry: NotificationEntry; deliveredAt: number; generation: number; delivering?: boolean };

/** Presentation only: source state and consent remain owned by their existing services. */
export function createNotificationDelivery(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const seen = deps.seen ?? new Set<string>();
  const pending = new Map<string, Pending>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const report = (error: unknown) => deps.onError?.(error);
  const dismiss = (id: string, retire: boolean) => {
    void deps.dismiss(id, retire).catch(report);
  };
  function remember(id: string) {
    seen.add(id);
    if (seen.size > 2048) {
      for (const key of seen) {
        if (!pending.has(key)) { seen.delete(key); break; }
      }
    }
  }
  function alive(row: Pending) {
    return !disposed && pending.get(row.entry.id) === row
      && (row.entry.expiresAt === undefined || row.entry.expiresAt > now());
  }
  async function deliver(entry: NotificationEntry, row?: Pending, silent = false): Promise<NotificationDeliveryResult> {
    if (row?.delivering) return { shown: false, reason: "duplicate" };
    if (row) row.delivering = true;
    try { return await present(entry, row, silent); }
    finally { if (row) row.delivering = false; }
  }
  async function present(entry: NotificationEntry, row?: Pending, silent = false): Promise<NotificationDeliveryResult> {
    const generation = row?.generation;
    const current = () => !disposed && (!row || alive(row) && row.generation === generation);
    const policy = resolveNotificationPolicy(deps.settings(), entry.target.kind);
    if (!current()) return { shown: false, reason: "stale" };
    if (!policy.enabled) return { shown: false, reason: "disabled" };
    let result: NotificationDeliveryResult = { shown: false, reason: "in-app" };
    if (policy.channel === "system" || policy.channel === "auto" && !deps.foreground()) {
      try { result = await deps.native(entry); }
      catch (error) { report(error); result = { shown: false, reason: "failed" }; }
    }
    const latest = resolveNotificationPolicy(deps.settings(), entry.target.kind);
    if (!current() || !latest.enabled) {
      dismiss(entry.id, Boolean(row && !alive(row)));
      return { shown: false, reason: "stale" };
    }
    if (result.reason === "disabled" || result.reason === "duplicate" || result.reason === "stale") return result;
    if (!result.shown) deps.inApp(entry);
    if (!silent && latest.sound && latest.volume > 0) {
      try { deps.sound(latest.volume); } catch (error) { report(error); }
    }
    return result;
  }
  function retire(id: string, row: Pending) {
    row.generation++;
    pending.delete(id);
    dismiss(id, true);
  }
  function arm() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (disposed) return;
    let deadline = Infinity;
    for (const row of pending.values()) {
      if (row.entry.expiresAt !== undefined) deadline = Math.min(deadline, row.entry.expiresAt);
      const policy = resolveNotificationPolicy(deps.settings(), row.entry.target.kind);
      if (policy.enabled && policy.repeatIntervalSeconds > 0) {
        deadline = Math.min(deadline, row.deliveredAt + policy.repeatIntervalSeconds * 1000);
      }
    }
    if (deadline !== Infinity) timer = setTimer(tick, Math.max(0, deadline - now()));
  }
  function tick() {
    timer = undefined;
    for (const [id, row] of pending) {
      if (!alive(row)) { retire(id, row); deps.onPendingChanged?.(); continue; }
      const policy = resolveNotificationPolicy(deps.settings(), row.entry.target.kind);
      if (policy.enabled && policy.repeatIntervalSeconds > 0
        && now() >= row.deliveredAt + policy.repeatIntervalSeconds * 1000) {
        row.deliveredAt = now();
        if (!row.delivering) {
          void deps.dismiss(id, false).then(() => { if (alive(row)) return deliver(row.entry, row); }).catch(report);
        }
      }
    }
    arm();
  }
  return {
    async once(entry: NotificationEntry): Promise<NotificationDeliveryResult> {
      if (seen.has(entry.id)) return { shown: false, reason: "duplicate" };
      remember(entry.id);
      return deliver(entry);
    },
    sync(entries: NotificationEntry[]) {
      if (disposed) return;
      const incoming = new Map(entries.filter(entry => entry.expiresAt === undefined || entry.expiresAt > now()).map(entry => [entry.id, entry]));
      for (const [id, row] of pending) if (!incoming.has(id)) retire(id, row);
      for (const [id, entry] of incoming) {
        const existing = pending.get(id);
        if (existing) { existing.entry = entry; continue; }
        const row = { entry, deliveredAt: now(), generation: 0 };
        pending.set(id, row);
        if (!seen.has(id)) { remember(id); void deliver(entry, row, entry.hydrated === true); }
      }
      arm();
    },
    refresh() {
      for (const [id, row] of pending) {
        row.generation++;
        // A policy save withdraws stale native objects, never the underlying request.
        dismiss(id, false);
        row.deliveredAt = now();
      }
      arm();
    },
    pending: () => [...pending.values()].filter(alive).map(row => row.entry),
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      for (const row of pending.values()) { row.generation++; dismiss(row.entry.id, false); }
      pending.clear();
    },
  };
}
