export const SESSION_COLORS = ["red", "amber", "green", "blue", "violet", "pink"] as const;
export type SessionColor = typeof SESSION_COLORS[number] | `#${string}`;
export type HsvColor = { h: number; s: number; v: number };
const LEGACY_HEX = { red: "#ef4444", amber: "#f59e0b", green: "#22c55e", blue: "#3b82f6", violet: "#a855f7", pink: "#ec4899" } as const;
const LEGACY_CSS = { red: "var(--ds-error)", amber: "var(--ds-warning)", green: "var(--ds-success)", blue: "var(--ds-session-blue)", violet: "var(--ds-purple)", pink: "var(--ds-session-pink)" } as const;
export const EXTRA_SESSION_COLORS: readonly SessionColor[] = ["#f97316", "#eab308", "#84cc16", "#14b8a6", "#06b6d4", "#6366f1", "#d946ef", "#64748b", "#78716c", "#111827", "#e2e8f0", "#ffffff"];

export function sessionColor(value: unknown): SessionColor | undefined {
  if (typeof value !== "string") return undefined;
  if ((SESSION_COLORS as readonly string[]).includes(value)) return value as SessionColor;
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex as SessionColor;
  if (/^#[0-9a-f]{3}$/.test(hex)) return `#${[...hex.slice(1)].map(char => char + char).join("")}`;
  return undefined;
}
export function colorToHex(value: SessionColor): `#${string}` {
  const color = sessionColor(value) ?? "blue";
  return color.startsWith("#") ? color as `#${string}` : LEGACY_HEX[color as keyof typeof LEGACY_HEX];
}
export function sessionColorCss(value: SessionColor): string {
  const color = sessionColor(value) ?? "blue";
  return color.startsWith("#") ? color : LEGACY_CSS[color as keyof typeof LEGACY_CSS];
}
const clamp = (value: number, max = 100) => Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0));
export function hexToHsv(value: SessionColor): HsvColor {
  const hex = colorToHex(value).slice(1);
  const [r, g, b] = [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const delta = max - min;
  let hue = 0;
  if (delta > 0) hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: (hue * 60 + 360) % 360, s: max === 0 ? 0 : delta / max * 100, v: max * 100 };
}
export function hsvToHex({ h, s, v }: HsvColor): `#${string}` {
  const hue = ((Number.isFinite(h) ? h : 0) % 360 + 360) % 360 / 60;
  const saturation = clamp(s) / 100; const brightness = clamp(v) / 100;
  const chroma = saturation * brightness; const x = chroma * (1 - Math.abs(hue % 2 - 1));
  const rgb = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x]
    : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${rgb.map(channel => Math.round((channel + brightness - chroma) * 255).toString(16).padStart(2, "0")).join("")}`;
}
