/**
 * Model-visible content blocks for a persisted tool result.
 *
 * Live Host results and restored parent/delegate history must apply the same
 * text/resource/image rules. This keeps image bytes on image blocks, preserves
 * MCP resource text, and gives the model a reason when an image is omitted.
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { isRecord } from "./agent-messages.js";
import {
  admitImageInput,
  type ImageInputIssue,
} from "./image-admission.js";

export type ImageInputDiagnostic = {
  imageCount: number;
  includedCount: number;
  issues: Array<ImageInputIssue & { index: number }>;
};

export type NormalizedToolResultContent = {
  content: ToolResultMessage["content"];
  imageInput?: ImageInputDiagnostic;
};

/**
 * Model-visible text for one host tool content block. Besides plain `text`
 * blocks, MCP servers return file bodies as embedded text resources and large
 * payloads as resource links (github-mcp-server `get_file_contents` sends a
 * status line plus one of these), so dropping them next to a sibling text
 * block hides the actual result from the model. Binary resources and other
 * block kinds have no text to show and stay out of the text channel.
 */
export function hostContentBlockText(block: unknown): string | undefined {
  if (!isRecord(block)) return undefined;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (
    block.type === "resource" &&
    isRecord(block.resource) &&
    typeof block.resource.text === "string"
  ) {
    return block.resource.text;
  }
  if (block.type === "resource_link" && typeof block.uri === "string") {
    const name = typeof block.name === "string" && block.name.trim()
      ? `${block.name.trim()}: `
      : "";
    return `[resource link] ${name}${block.uri}`;
  }
  return undefined;
}

function withoutInlineBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutInlineBinary);
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "data" && value.type === "image") continue;
    if (key === "resource" && value.type === "resource" && isRecord(entry)) {
      const resource: Record<string, unknown> = {};
      for (const [resourceKey, resourceValue] of Object.entries(entry)) {
        if (resourceKey !== "blob") resource[resourceKey] = withoutInlineBinary(resourceValue);
      }
      next.resource = resource;
      continue;
    }
    next[key] = withoutInlineBinary(entry);
  }
  return next;
}

function safeJson(value: unknown, pretty = false): string {
  try {
    return JSON.stringify(withoutInlineBinary(value), null, pretty ? 2 : undefined) ?? String(value);
  } catch {
    return String(value);
  }
}

function appendImageCandidate(
  blocks: ToolResultMessage["content"],
  candidate: unknown,
  supportsVision: boolean,
  imageInput: ImageInputDiagnostic,
): void {
  const index = imageInput.imageCount++;
  if (isRecord(candidate) && blocks.some((block) => block.type === "image" &&
    block.data === candidate.data && block.mimeType === candidate.mimeType)) return;
  const admitted = admitImageInput(candidate, supportsVision);
  if ("image" in admitted) {
    imageInput.includedCount += 1;
    blocks.push(admitted.image);
    return;
  }
  imageInput.issues.push({ index, ...admitted.issue });
  blocks.push({ type: "text", text: admitted.issue.message });
}

function appendContentBlocks(
  blocks: ToolResultMessage["content"],
  entries: readonly unknown[],
  supportsVision: boolean,
  imageInput: ImageInputDiagnostic,
): void {
  for (const block of entries) {
    const blockText = hostContentBlockText(block);
    if (blockText !== undefined) {
      blocks.push({ type: "text", text: blockText });
    } else if (isRecord(block) && block.type === "image") {
      appendImageCandidate(blocks, block, supportsVision, imageInput);
    }
  }
}

/**
 * Normalize a Host, MCP, or plugin tool result without changing the source
 * payload retained in `details`. `includedCount` means admitted for the model,
 * not that any image has been analysed.
 */
export function normalizeToolResultContent(
  raw: unknown,
  supportsVision: boolean,
  includeFallback = false,
): NormalizedToolResultContent {
  const content: ToolResultMessage["content"] = [];
  const imageInput: ImageInputDiagnostic = {
    imageCount: 0,
    includedCount: 0,
    issues: [],
  };
  const rawObject = isRecord(raw) ? raw : undefined;
  const rawBlocks = rawObject && Array.isArray(rawObject.content)
    ? rawObject.content
    : undefined;

  if (rawBlocks) {
    appendContentBlocks(content, rawBlocks, supportsVision, imageInput);
    if (Array.isArray(rawObject?.images)) for (const image of rawObject.images) {
      appendImageCandidate(content, isRecord(image) ? { type: "image", ...image } : image, supportsVision, imageInput);
    }
    if (includeFallback && content.length === 0) content.push({ type: "text", text: safeJson(raw, true) });
  } else if (Array.isArray(raw)) {
    appendContentBlocks(content, raw, supportsVision, imageInput);
    if (includeFallback && content.length === 0) content.push({ type: "text", text: safeJson(raw, true) });
  } else if (typeof raw === "string" && (includeFallback || raw.trim())) {
    content.push({ type: "text", text: raw });
  } else if (rawObject && Array.isArray(rawObject.images)) {
    if (typeof rawObject.text === "string") {
      content.push({ type: "text", text: rawObject.text });
    } else {
      const rest = { ...rawObject };
      delete rest.images;
      content.push({ type: "text", text: safeJson(rest, includeFallback) });
    }
    for (const image of rawObject.images) {
      appendImageCandidate(
        content,
        isRecord(image) ? { type: "image", ...image } : image,
        supportsVision,
        imageInput,
      );
    }
  } else if (raw !== undefined && raw !== null) {
    content.push({ type: "text", text: safeJson(raw, includeFallback) });
  }

  return {
    content,
    ...(imageInput.imageCount > 0 ? { imageInput } : {}),
  };
}

function persistedSourceContent(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.details)) return raw;
  const details = raw.details;
  if (Array.isArray(details.blocks)) return details.blocks;
  if (Array.isArray(details.content) || Array.isArray(details.images)) return details;
  return raw;
}

/**
 * Content blocks for a persisted tool result. Restore keeps vision-capable
 * image blocks in state; the final provider boundary applies the active model's
 * capability again before serialization.
 */
export function restoredToolResultContent(
  raw: unknown,
): ToolResultMessage["content"] {
  return normalizeToolResultContent(persistedSourceContent(raw), true).content;
}
