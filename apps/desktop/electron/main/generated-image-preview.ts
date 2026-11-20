import { open } from "node:fs/promises";
import { MAX_IMAGE_BYTES as MAX_GENERATED_IMAGE_BYTES, generatedImageType } from "@pi-desktop/agent-runtime";
import { imageMimeFor, MAX_IMAGE_BYTES, readOpenableImage, resolveRealOpenablePath } from "@pi-desktop/host-runtime";
import { probeImageDimensions, type FsImageDataUrlResult } from "@pi-desktop/shared";

// Even a noisy 1024px square PNG with alpha fits within the 5 MiB result budget.
const MAX_PREVIEW_EDGE = 1024;
const MAX_SOURCE_PIXELS = 16_000_000;
type ResizeRaster = (bytes: Buffer, width: number, height: number) => Buffer;
let pendingResize: Promise<unknown> = Promise.resolve();

/** A contained file can exceed the data-URL budget but still have a safe thumbnail. */
export async function readGeneratedImagePreview(
  ref: string,
  workspaceRoot: string | null,
  extraRoots: readonly string[],
  mimeType: string | undefined,
  resize: ResizeRaster,
): Promise<FsImageDataUrlResult> {
  const original = await readOpenableImage(ref, workspaceRoot, extraRoots, mimeType);
  if (original.kind !== "tooLarge" || (original.size ?? Infinity) > MAX_GENERATED_IMAGE_BYTES) return original;
  const result = pendingResize.then(async (): Promise<FsImageDataUrlResult> => {
    const path = await resolveRealOpenablePath(ref, workspaceRoot, extraRoots);
    if (!path) return { kind: "missing", errorCode: "PATH_OUTSIDE_ALLOWED_ROOT" };
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_GENERATED_IMAGE_BYTES) return original;
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== info.size) return original;
      const bytes = buffer.subarray(0, length);
      const mime = imageMimeFor(ref, mimeType);
      if (generatedImageType(bytes).mimeType !== mime) return { kind: "notImage", errorCode: "NOT_AN_IMAGE" };
      const dimensions = probeImageDimensions(bytes);
      if (!dimensions || dimensions.width * dimensions.height > MAX_SOURCE_PIXELS) return original;
      const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(dimensions.width, dimensions.height));
      const thumbnail = resize(bytes, Math.max(1, Math.round(dimensions.width * scale)),
        Math.max(1, Math.round(dimensions.height * scale)));
      if (!thumbnail.length) return { kind: "notImage", errorCode: "NOT_AN_IMAGE" };
      if (thumbnail.length > MAX_IMAGE_BYTES) return original;
      return { kind: "image", dataUrl: `data:image/png;base64,${thumbnail.toString("base64")}`, size: thumbnail.length, isThumbnail: true };
    } finally {
      await file.close();
    }
  }).catch((error: unknown) => {
    if (error instanceof Error && "errorCode" in error && error.errorCode === "IMAGE_INVALID_CONTENT") {
      return { kind: "notImage", errorCode: "NOT_AN_IMAGE" } as const;
    }
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return { kind: "missing", errorCode: "FILE_NOT_FOUND" } as const;
    }
    throw error;
  });
  // Serialize bounded source reads and decoding so galleries cannot multiply peak memory.
  pendingResize = result.catch(() => undefined);
  return result;
}
