export const SESSION_COLORS = ["red", "amber", "green", "blue", "violet", "pink"] as const;
export type SessionColor = typeof SESSION_COLORS[number];
export type SessionLabel = { id: string; name: string; color: SessionColor; defaultName?: "investigation" | "feature" | "fix" };
export type SessionFilter = { labelIds: string[]; color?: SessionColor };
export const DEFAULT_SESSION_LABELS: SessionLabel[] = [
  { id: "investigation", name: "Investigation", color: "blue", defaultName: "investigation" },
  { id: "feature", name: "Feature", color: "green", defaultName: "feature" },
  { id: "fix", name: "Fix", color: "amber", defaultName: "fix" },
];
export function sessionColor(value: unknown): SessionColor | undefined {
  return typeof value === "string" && (SESSION_COLORS as readonly string[]).includes(value) ? value as SessionColor : undefined;
}
export function labelIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string =>
    typeof id === "string" && id.length > 0 && id.length <= 128))].slice(0, 128) : [];
}
export function cleanSessionLabels(value: unknown): SessionLabel[] {
  if (!Array.isArray(value)) return DEFAULT_SESSION_LABELS.map(row => ({ ...row }));
  const seen = new Set<string>();
  return value.slice(0, 128).flatMap((raw): SessionLabel[] => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const color = sessionColor(row.color);
    if (typeof row.id !== "string" || !row.id || row.id.length > 128 || seen.has(row.id) ||
      typeof row.name !== "string" || !row.name.trim() || !color) return [];
    seen.add(row.id);
    const defaultName = row.defaultName === "investigation" || row.defaultName === "feature" || row.defaultName === "fix" ? row.defaultName : undefined;
    return [{ id: row.id, name: [...row.name.trim()].slice(0, 80).join(""), color, ...(defaultName ? { defaultName } : {}) }];
  });
}
export function cleanSessionFilter(value: unknown): SessionFilter {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const color = sessionColor(row.color);
  return { labelIds: labelIds(row.labelIds), ...(color ? { color } : {}) };
}
export function matchesSessionFilter(meta: { labelIds?: string[]; color?: SessionColor } | undefined, filter: SessionFilter): boolean {
  return (!filter.color || meta?.color === filter.color) &&
    (!filter.labelIds.length || filter.labelIds.some(id => meta?.labelIds?.includes(id)));
}
