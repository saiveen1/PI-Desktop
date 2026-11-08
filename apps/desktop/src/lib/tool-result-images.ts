import { MAX_INLINE_IMAGE_BYTES } from "@pi-desktop/shared";

export type ToolResultImage = {
  path: string;
  index: number;
  mimeType?: string;
  dataUrl?: string;
  label?: string;
};
export type ImageInputIssueCode = "MODEL_NO_VISION" | "IMAGE_TOO_LARGE" | "IMAGE_INVALID";
export type ToolImageSet = {
  generated: boolean;
  images: ToolResultImage[];
  issueCodes: ImageInputIssueCode[];
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

/** No URL fetching or arbitrary path inference: file refs still pass through Host containment. */
function localRef(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.trim();
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
    images: [], issueCodes: [],
  };
  const issues = record(details?.imageInput)?.issues;
  const addIssue = (code: ImageInputIssueCode) => {
    if (!result.issueCodes.includes(code)) result.issueCodes.push(code);
  };
  if (Array.isArray(issues)) for (const issue of issues) {
    const code = record(issue)?.code;
    if (code === "MODEL_NO_VISION" || code === "IMAGE_TOO_LARGE" || code === "IMAGE_INVALID") addIssue(code);
  }
  // Details retain originals; provider content can be a filtered mirror of those images.
  const original = candidates(payload);
  const entries = original.length ? original : candidates(raw);
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const image = record(entry);
    const mimeType = typeof image?.mimeType === "string" ? image.mimeType.toLowerCase() : "";
    const path = localRef(image?.path ?? image?.ref ?? (entries.length === 1 ? details?.path : undefined));
    const data = image?.data;
    if (!rasterMime.test(mimeType)) { addIssue("IMAGE_INVALID"); return; }
    let dataUrl: string | undefined;
    if (typeof data === "string") {
      if (data.length > Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4) {
        addIssue("IMAGE_TOO_LARGE");
      } else if (!data || !base64.test(data) || data.length % 4 === 1) {
        addIssue("IMAGE_INVALID");
      } else {
        dataUrl = `data:${mimeType};base64,${data}`;
      }
    }
    if (!dataUrl && !path) { addIssue("IMAGE_INVALID"); return; }
    const identity = dataUrl ?? `${mimeType}:${path}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    result.images.push({ path, index, mimeType, ...(dataUrl ? { dataUrl } : {}) });
  });
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
