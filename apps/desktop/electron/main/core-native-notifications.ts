import { isNotificationTarget, resolveNotificationPolicy, type AppSettings, type CoreNotificationRequest,
  type NotificationDeliveryResult } from "@pi-desktop/shared";

type NativeObject = {
  show(): void;
  close(): void;
  once(event: "close" | "failed" | "click", listener: () => void): unknown;
};
type Window = {
  isDestroyed(): boolean; isVisible(): boolean; isFocused(): boolean; isMinimized(): boolean;
  restore(): void; show(): void; focus(): void;
};
type Dependencies = {
  settings(): Promise<AppSettings>;
  window(): Window | null;
  viewingSession(): string | null;
  supported(): boolean;
  create(options: { title: string; body: string; silent: true }): NativeObject;
  activate(request: CoreNotificationRequest): void;
  failed(request: CoreNotificationRequest): void;
};
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
function valid(value: unknown): value is CoreNotificationRequest & Required<Pick<CoreNotificationRequest, "target">> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => ["id", "sessionId", "kind", "title", "body", "createdAt", "target"].includes(key))
    && bounded(row.id, 2048) && bounded(row.sessionId, 256) && bounded(row.title, 200)
    && (row.body === undefined || typeof row.body === "string" && row.body.length <= 1000)
    && (row.createdAt === undefined || typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt)))
    && isNotificationTarget(row.target) && row.target.sessionId === row.sessionId
    && (row.kind === undefined || row.kind === (row.target.kind.startsWith("task.") ? "task" : "interactive"));
}

/** Native presentation only. No click path grants consent or changes a request. */
export function createCoreNativeNotifications(deps: Dependencies) {
  const live = new Map<string, { object: NativeObject; request: CoreNotificationRequest }>();
  const delivered = new Set<string>();
  const retired = new Set<string>();
  const versions = new Map<string, number>();
  let readBefore = 0;
  let disposed = false;
  const remember = (set: Set<string>, id: string) => {
    set.add(id);
    if (set.size > 2048) { const oldest = set.values().next().value; if (oldest !== undefined) set.delete(oldest); }
  };
  const dismiss = (id: string, retire = true) => {
    versions.set(id, (versions.get(id) ?? 0) + 1);
    if (retire) remember(retired, id); else delivered.delete(id);
    const entry = live.get(id);
    live.delete(id);
    if (entry) {
      try { entry.object.close(); }
      catch { console.warn("Core native notification cleanup failed"); }
    }
    if (versions.size > 2048) {
      for (const key of versions.keys()) if (!live.has(key) && key !== id) { versions.delete(key); break; }
    }
    return { ok: true };
  };
  return {
    dismiss,
    dispose() { disposed = true; for (const id of live.keys()) dismiss(id); },
    dismissTasks(before: number, id?: string) {
      if (id) { dismiss(id); return; }
      readBefore = Math.max(readBefore, before);
      for (const [key, entry] of live) if (entry.request.target?.kind.startsWith("task.")) dismiss(key);
    },
    async show(input: unknown): Promise<NotificationDeliveryResult> {
      if (!valid(input)) return { shown: false, reason: "failed" };
      const request = input;
      const version = versions.get(request.id) ?? 0;
      const createdAt = request.createdAt === undefined ? undefined : Date.parse(request.createdAt);
      const stale = () => disposed || retired.has(request.id) || (versions.get(request.id) ?? 0) !== version
        || request.target.kind.startsWith("task.") && createdAt !== undefined && createdAt <= readBefore;
      if (stale()) return { shown: false, reason: "stale" };
      let settings: AppSettings;
      try { settings = await deps.settings(); }
      catch { return { shown: false, reason: "unavailable" }; }
      if (stale()) return { shown: false, reason: "stale" };
      const policy = resolveNotificationPolicy(settings.notifications, request.target.kind);
      if (!policy.enabled) return { shown: false, reason: "disabled" };
      const window = deps.window();
      if (!window || window.isDestroyed() || !deps.supported()) return { shown: false, reason: "unavailable" };
      const foreground = window.isVisible() && window.isFocused() && !window.isMinimized();
      if (request.target.kind.startsWith("task.") && foreground && deps.viewingSession() === request.sessionId) {
        return { shown: false, reason: "stale" };
      }
      if (policy.channel === "in-app" || policy.channel === "auto" && foreground) return { shown: false, reason: "in-app" };
      if (live.has(request.id) || delivered.has(request.id)) return { shown: false, reason: "duplicate" };
      let object: NativeObject;
      try { object = deps.create({ title: request.title.replace(/[\r\n\t]/g, " ").slice(0, 100),
        body: (request.body ?? "").replace(/[\r\n\t]/g, " ").slice(0, 240), silent: true }); }
      catch { return { shown: false, reason: "failed" }; }
      live.set(request.id, { object, request });
      remember(delivered, request.id);
      let failed = false;
      const release = () => { if (live.get(request.id)?.object === object) live.delete(request.id); };
      object.once("close", release);
      object.once("failed", () => {
        failed = true;
        if (live.get(request.id)?.object !== object) return;
        release();
        if (!stale()) deps.failed(request);
      });
      object.once("click", () => {
        if (live.get(request.id)?.object !== object || stale()) return;
        const window = deps.window();
        if (!window || window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show(); window.focus();
        deps.activate(request);
        release();
      });
      try { object.show(); }
      catch { failed = true; release(); }
      return failed ? { shown: false, reason: "failed" } : { shown: true, reason: "requested" };
    },
  };
}
