/**
 * Provider-bound image admission for user and tool-result content (issue #1913).
 *
 * Host Read and prompt attachments refuse oversized images before persistence,
 * but restored sessions, plugins, and MCP tools can still carry one. Keep this
 * final request boundary deterministic so every provider sees either a valid
 * image block or an explicit omission notice.
 */
import type { ImageContent, Message } from "@earendil-works/pi-ai";
import {
  imageExceedsInlineDimensions,
  MAX_INLINE_IMAGE_BYTES,
  omittedImageNotice,
  probeBase64ImageDimensions,
} from "@pi-desktop/shared";

export type ImageInputIssueCode =
  | "MODEL_NO_VISION"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_INVALID";

export type ImageInputIssue = {
  code: ImageInputIssueCode;
  message: string;
};

export type ImageInputAdmission =
  | { image: ImageContent }
  | { issue: ImageInputIssue };

type ContentBlock = Exclude<Message["content"], string>[number];

const MODEL_NO_VISION_NOTICE =
  "[Image omitted: the selected model does not support image input.]";
const IMAGE_INVALID_NOTICE = "[Image omitted: image input is invalid.]";
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function imageTooLargeNotice(bytes: number): string {
  return `[Image omitted: ${bytes} bytes exceeds the ${MAX_INLINE_IMAGE_BYTES} byte limit for model input.]`;
}

/** Returns a raw-byte count only for standard or unpadded base64. */
function base64ByteLength(data: string): number | undefined {
  if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (padding > 0 && data.length % 4 !== 0) return undefined;
  const unpadded = data.length - padding;
  if (unpadded % 4 === 1) return undefined;
  return Math.floor((unpadded * 3) / 4);
}

function imageMimeTypeFromBase64(data: string): string | undefined {
  if (data.startsWith("iVBORw0KGgo")) return "image/png";
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("R0lGOD")) return "image/gif";
  if (data.startsWith("UklGR")) return "image/webp";
  return undefined;
}

/**
 * Admit one untrusted image candidate at the same boundary every provider
 * request crosses. It accepts only recognized PNG, JPEG, GIF, and WebP headers
 * with a matching raster MIME type, then applies the shared byte and pixel limits.
 */
export function admitImageInput(
  candidate: unknown,
  supportsVision: boolean,
): ImageInputAdmission {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Reflect.get(candidate, "type") !== "image" ||
    typeof Reflect.get(candidate, "data") !== "string" ||
    typeof Reflect.get(candidate, "mimeType") !== "string" ||
    !Reflect.get(candidate, "mimeType").trim()
  ) {
    return { issue: { code: "IMAGE_INVALID", message: IMAGE_INVALID_NOTICE } };
  }
  const data = Reflect.get(candidate, "data") as string;
  const mimeType = (Reflect.get(candidate, "mimeType") as string).trim().toLowerCase();
  const bytes = base64ByteLength(data);
  const encodedMimeType = imageMimeTypeFromBase64(data);
  if (
    bytes === undefined ||
    !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) ||
    encodedMimeType !== mimeType
  ) {
    return { issue: { code: "IMAGE_INVALID", message: IMAGE_INVALID_NOTICE } };
  }
  if (bytes > MAX_INLINE_IMAGE_BYTES) {
    return {
      issue: {
        code: "IMAGE_TOO_LARGE",
        message: imageTooLargeNotice(bytes),
      },
    };
  }
  const dimensions = probeBase64ImageDimensions(data);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    return { issue: { code: "IMAGE_INVALID", message: IMAGE_INVALID_NOTICE } };
  }
  if (imageExceedsInlineDimensions(dimensions)) {
    return {
      issue: {
        code: "IMAGE_TOO_LARGE",
        message: omittedImageNotice(dimensions),
      },
    };
  }
  if (!supportsVision) {
    return { issue: { code: "MODEL_NO_VISION", message: MODEL_NO_VISION_NOTICE } };
  }
  return { image: { type: "image", data, mimeType } };
}

function admittedBlocks<T extends ContentBlock>(content: T[], supportsVision: boolean): T[] {
  let next: T[] | undefined;
  content.forEach((block, index) => {
    if (block.type !== "image") return;
    const admitted = admitImageInput(block, supportsVision);
    if ("image" in admitted) return;
    next ??= content.slice();
    next[index] = { type: "text", text: admitted.issue.message } as T;
  });
  return next ?? content;
}

/**
 * Replace every image the active provider cannot accept with a visible text
 * notice. Returns the input array when every existing image remains admissible.
 */
export function omitInadmissibleImages(
  messages: Message[],
  supportsVision: boolean,
): Message[] {
  let next: Message[] | undefined;
  messages.forEach((message, index) => {
    if (message.role !== "user" && message.role !== "toolResult") return;
    if (!Array.isArray(message.content)) return;
    const content = admittedBlocks(message.content as ContentBlock[], supportsVision);
    if (content === message.content) return;
    next ??= messages.slice();
    next[index] = { ...message, content } as Message;
  });
  return next ?? messages;
}

/** Legacy entry point: assume vision support and apply the same image validation. */
export function omitOversizedImages(messages: Message[]): Message[] {
  return omitInadmissibleImages(messages, true);
}
