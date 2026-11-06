export type NotificationChannel = "auto" | "in-app" | "system";
export type NotificationCategory = "needsAction" | "failures" | "completions";
export type CoreNotificationSource = "ask" | "permission" | "plan" | "delegation-approval"
  | "task.failed" | "task.completed" | "delegation.failed" | "test";

export type NotificationPolicy = {
  enabled: boolean;
  channel: NotificationChannel;
  sound: boolean;
  /** 100 preserves the existing soft chime's gain. */
  volume: number;
  repeatIntervalSeconds: number;
};
export type NotificationSettings = {
  version: 1;
  enabled?: boolean;
  channel?: NotificationChannel;
  sound?: boolean;
  volume?: number;
  categories?: Partial<Record<NotificationCategory, boolean>>;
  /** Absence inherits the global needs-action policy. Never grants model consent. */
  delegation?: Partial<NotificationPolicy>;
};
export type NotificationTarget = {
  kind: CoreNotificationSource;
  sessionId: string;
  requestId?: string;
  hostKey?: string;
  revision?: number;
};
export type CoreNotificationRequest = {
  id: string;
  sessionId: string;
  kind?: "task" | "interactive";
  title: string;
  body?: string;
  createdAt?: string;
  target?: NotificationTarget;
};
export type NotificationDeliveryResult = {
  shown: boolean;
  reason?: "requested" | "in-app" | "disabled" | "unavailable" | "failed" | "duplicate" | "stale";
};

const sources: readonly string[] = ["ask", "permission", "plan", "delegation-approval",
  "task.failed", "task.completed", "delegation.failed", "test"];
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const integer = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const channel = (value: unknown) => value === "auto" || value === "in-app" || value === "system";
function validPolicy(value: Record<string, unknown>): boolean {
  return ["enabled", "sound"].every(key => value[key] === undefined || typeof value[key] === "boolean")
    && (value.channel === undefined || channel(value.channel))
    && (value.volume === undefined || integer(value.volume, 0, 100));
}
export function isNotificationSettings(value: unknown): value is NotificationSettings {
  if (!record(value) || value.version !== 1 || !keys(value, ["version", "enabled", "channel", "sound", "volume", "categories", "delegation"]) || !validPolicy(value)) return false;
  if (value.categories !== undefined && (!record(value.categories)
    || !keys(value.categories, ["needsAction", "failures", "completions"])
    || !Object.values(value.categories).every(row => typeof row === "boolean"))) return false;
  if (value.delegation !== undefined) {
    const override = value.delegation;
    if (!record(override) || !keys(override, ["enabled", "channel", "sound", "volume", "repeatIntervalSeconds"]) || !validPolicy(override)) return false;
    if (override.repeatIntervalSeconds !== undefined && override.repeatIntervalSeconds !== 0 && !integer(override.repeatIntervalSeconds, 10, 300)) return false;
  }
  return true;
}
export function notificationCategory(source: CoreNotificationSource): NotificationCategory {
  if (source === "task.completed") return "completions";
  return source === "task.failed" || source === "delegation.failed" ? "failures" : "needsAction";
}
export function resolveNotificationPolicy(settings: NotificationSettings | undefined, source: CoreNotificationSource): NotificationPolicy {
  const override = source === "delegation-approval" || source === "delegation.failed" ? settings?.delegation : undefined;
  return {
    enabled: settings?.enabled !== false && (override?.enabled ?? settings?.categories?.[notificationCategory(source)] ?? true),
    channel: override?.channel ?? settings?.channel ?? "auto",
    sound: override?.sound ?? settings?.sound ?? true,
    volume: override?.volume ?? settings?.volume ?? 100,
    repeatIntervalSeconds: override?.repeatIntervalSeconds ?? 0,
  };
}
export function isNotificationTarget(value: unknown): value is NotificationTarget {
  if (!record(value) || !keys(value, ["kind", "sessionId", "requestId", "hostKey", "revision"])
    || typeof value.kind !== "string" || !sources.includes(value.kind)) return false;
  const id = (text: unknown, max: number) => typeof text === "string" && text.length > 0 && text.length <= max && text.trim() === text;
  return id(value.sessionId, 256) && (value.requestId === undefined || id(value.requestId, 512))
    && (value.hostKey === undefined || id(value.hostKey, 256))
    && (value.revision === undefined || integer(value.revision, 0, Number.MAX_SAFE_INTEGER));
}
