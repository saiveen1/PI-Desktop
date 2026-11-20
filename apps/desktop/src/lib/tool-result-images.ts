import { MAX_INLINE_IMAGE_BYTES } from "@pi-desktop/shared";

export type ToolResultImage = {
  path: string;
  index: number;
  mimeType?: string;
  dataUrl?: string;
  label?: string;
  allowThumbnail?: true;
};
export type ImageInputIssueCode = "MODEL_NO_VISION" | "IMAGE_TOO_LARGE" | "IMAGE_INVALID";
export type ToolImageSet = {
  generated: boolean;
  images: ToolResultImage[];
  issueCodes: ImageInputIssueCode[];
  /** Display-budget omission, never an authoritative model-input rejection. */
  displayOmitted: boolean;
  /** Valid binary omitted from a bounded history projection, even with a path fallback. */
  inlineOmitted: boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function candidates(value: unknown): unknown[] {
  const source = record(value);
  const images = Array.isArray(source?.images) ? source.images : [];
  const arrays = Array.isArray(value) ? [value] : [source?.blocks, source?.content];
  return [...images, ...arrays.flatMap((blocks) => Array.isArray(blocks)
    ? blocks.filter((block) => record(block)?.type === "image") : [])];
}

const rasterMime = /^image\/(?:png|jpeg|gif|webp)$/;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;

function displayClipped(value: unknown): boolean {
  return typeof value === "string" && value.includes("[truncated for display");
}

/** No URL fetching or arbitrary path inference: file refs still pass through Host containment. */
function localRef(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.trim();
  if (displayClipped(path) || /[\x00-\x1f]/.test(path)) return "";
  return /^(?:[a-z][a-z\d+.-]*:)/i.test(path) && !/^[a-z]:[\\/]/i.test(path) ? "" : path;
}

const cache = new WeakMap<object, ToolImageSet>();

/** Live and restored results share the same value contract, independent of tool names. */
export function toolResultImageSet(message: { toolResult?: unknown }): ToolImageSet {
  const cached = cache.get(message);
  if (cached) return cached;
  const raw = message.toolResult;
  const envelope = record(raw);
  const payload = envelope?.details ?? raw;
  const details = record(payload);
  const result: ToolImageSet = {
    generated: details?.kind === "generated-images" || details?.kind === "image-generation-error",
    images: [], issueCodes: [], displayOmitted: false, inlineOmitted: false,
  };
  const issues = record(details?.imageInput)?.issues;
  const addIssue = (code: ImageInputIssueCode) => {
    if (!result.issueCodes.includes(code)) result.issueCodes.push(code);
  };
  if (Array.isArray(issues)) for (const issue of issues) {
    const code = record(issue)?.code;
    if (code === "MODEL_NO_VISION" || code === "IMAGE_TOO_LARGE" || code === "IMAGE_INVALID") addIssue(code);
  }
  // Older bounded projections may have a clipped details mirror but intact
  // provider content. Validate both independently; never let a broken mirror
  // mask a usable original, or promote a clipped ref/base64 prefix into a URL.
  const original = candidates(payload);
  const fallback = payload === raw ? [] : candidates(raw);
  const groups = [original, fallback];
  const entries = groups.flatMap((group, source) => group.map((value, index) => ({
    value, index, source, defaultPath: group.length === 1 ? details?.path : undefined,
  })));
  const inline = [new Set<number>(), new Set<number>()];
  const omittedInline: Array<{ source: number; index: number }> = [];
  const byData = new Map<string, ToolResultImage>();
  const byRef = new Map<string, ToolResultImage>();
  const visible = [new Set<number>(), new Set<number>()];
  const omissions: Array<{ source: number; index: number }> = [];
  entries.forEach(({ value, index, source, defaultPath }) => {
    const omit = () => omissions.push({ source, index });
    const image = record(value);
    const mimeType = typeof image?.mimeType === "string" ? image.mimeType.toLowerCase() : "";
    const ref = image?.path ?? image?.ref ?? defaultPath;
    const path = localRef(ref);
    const data = image?.data;
    const clipped = displayClipped(value) || image?._truncated === true || displayClipped(data) || displayClipped(ref) || displayClipped(mimeType);
    const omitted = image?.displayImageOmitted === true;
    if (!rasterMime.test(mimeType)) {
      if (clipped && (!mimeType || displayClipped(mimeType))) omit();
      else addIssue("IMAGE_INVALID");
      return;
    }
    let dataUrl: string | undefined;
    if (typeof data === "string" && !displayClipped(data)) {
      if (data.length > Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4) {
        addIssue("IMAGE_TOO_LARGE");
      } else if (!data || !base64.test(data) || data.length % 4 === 1) {
        addIssue("IMAGE_INVALID");
      } else {
        dataUrl = `data:${mimeType};base64,${data}`;
      }
    }
    if (!dataUrl && omitted && data === undefined) omittedInline.push({ source, index });
    if (!dataUrl && !path) {
      if (clipped || omitted && data === undefined) omit();
      else addIssue("IMAGE_INVALID");
      return;
    }
    if (dataUrl) inline[source].add(index);
    visible[source].add(index);
    const refIdentity = path ? `${mimeType}:${path}` : undefined;
    const duplicate = dataUrl ? byData.get(dataUrl) : refIdentity ? byRef.get(refIdentity) : undefined;
    if (duplicate) {
      if (refIdentity) byRef.set(refIdentity, duplicate);
      return;
    }
    const referenced = refIdentity ? byRef.get(refIdentity) : undefined;
    if (dataUrl && referenced && !referenced.dataUrl) {
      referenced.dataUrl = dataUrl;
      byData.set(dataUrl, referenced);
      return;
    }
    const next = { path, index: result.images.length, mimeType, ...(dataUrl ? { dataUrl } : {}) };
    if (dataUrl) byData.set(dataUrl, next);
    if (refIdentity) byRef.set(refIdentity, next);
    result.images.push(next);
  });
  // Equal-length mirrors can recover the same omitted position. Do not hide
  // an extra missing original when provider content contains fewer images.
  result.displayOmitted = omissions.some(({ source, index }) =>
    original.length !== fallback.length || !visible[1 - source].has(index));
  result.inlineOmitted = omittedInline.some(({ source, index }) =>
    original.length !== fallback.length || !inline[1 - source].has(index));
  cache.set(message, result);
  return result;
}

/** Strip binary fields only from image-result display projections, never durable results. */
export function withoutToolImageData(value: unknown, imageEntry = false): unknown {
  if (typeof value === "string" && /^\s*[[{]/.test(value) &&
    (value.includes("image/") || value.includes('"blob"'))) {
    try {
      const parsed: unknown = JSON.parse(value);
      const clean = JSON.stringify(withoutToolImageData(parsed));
      return clean === JSON.stringify(parsed) ? value : clean;
    } catch {
      // Narrative text that only resembles JSON is not a result mirror.
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((child) => withoutToolImageData(child, imageEntry));
  const source = record(value);
  if (!source) return value;
  return Object.fromEntries(Object.entries(source)
    .filter(([key]) => key !== "imageInput" && !(key === "data" &&
      (imageEntry || source.type === "image" || typeof source.mimeType === "string" && source.mimeType.startsWith("image/"))) &&
      !(key === "blob" && typeof source.blob === "string"))
    .map(([key, child]) => [key, withoutToolImageData(child, key === "images")]));
}
