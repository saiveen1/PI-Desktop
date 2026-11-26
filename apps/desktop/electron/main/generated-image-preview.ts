import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { MAX_IMAGE_BYTES as MAX_GENERATED_IMAGE_BYTES, generatedImageType } from "@pi-desktop/agent-runtime";
import { imageMimeFor, MAX_IMAGE_BYTES, readOpenableImage, resolveRealOpenablePath, resolveWithinRoot, unavailableImage } from "@pi-desktop/host-runtime";
import { probeImageDimensions, type FsImageDataUrlResult } from "@pi-desktop/shared";

const MAX_PREVIEW_EDGE = 1024;
const MAX_SOURCE_PIXELS = 16_000_000;
const denied = { kind: "missing", errorCode: "PATH_OUTSIDE_ALLOWED_ROOT" } as const;
const notImage = { kind: "notImage", errorCode: "NOT_AN_IMAGE" } as const;
type Dimensions = { width: number; height: number };
type Raster = { bytes: Buffer; mime: string; dimensions: Dimensions };
type ResizeRaster = (bytes: Buffer, width: number, height: number) => Buffer;
let pendingRaster: Promise<void> = Promise.resolve();

// Full-file reads and native raster decoding share one budget across both viewer modes.
function readRaster(ref: string, root: string | null, roots: readonly string[], mimeType: string | undefined,
  render: (raster: Raster) => FsImageDataUrlResult, pinnedRoot?: string): Promise<FsImageDataUrlResult> {
  const result = pendingRaster.then(async (): Promise<FsImageDataUrlResult> => {
    const path = await resolveRealOpenablePath(ref, root, roots);
    // A queued original request stays bound to the canonical root selected by the host.
    if (pinnedRoot && ((await realpath(pinnedRoot).catch(() => null)) !== pinnedRoot ||
      (path && (isAbsolute(relative(pinnedRoot, path)) || !resolveWithinRoot(pinnedRoot, relative(pinnedRoot, path)))))) return denied;
    if (!path) return unavailableImage(ref, root, roots);
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile()) return notImage;
      const tooLarge = { kind: "tooLarge", size: info.size, errorCode: "IMAGE_TOO_LARGE" } as const;
      if (info.size > MAX_GENERATED_IMAGE_BYTES) return tooLarge;
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== info.size) throw new Error("Generated image changed during read");
      const bytes = buffer.subarray(0, length);
      const mime = imageMimeFor(ref, mimeType);
      if (!mime || generatedImageType(bytes).mimeType !== mime) return notImage;
      const dimensions = probeImageDimensions(bytes);
      if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return notImage;
      if (dimensions.width * dimensions.height > MAX_SOURCE_PIXELS) return tooLarge;
      return render({ bytes, mime, dimensions });
    } finally {
      await file.close();
    }
  }).catch((error: unknown) => {
    if (error instanceof Error && "errorCode" in error && error.errorCode === "IMAGE_INVALID_CONTENT") return notImage;
    if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))) {
      return unavailableImage(ref, root, roots);
    }
    throw new Error("Could not read generated image");
  });
  pendingRaster = result.then(() => undefined, () => undefined);
  return result;
}

/** Ordinary small images keep their existing preview; only eligible large rasters are resized. */
export async function readGeneratedImagePreview(ref: string, workspaceRoot: string | null, extraRoots: readonly string[],
  mimeType: string | undefined, resize: ResizeRaster): Promise<FsImageDataUrlResult> {
  const original = await readOpenableImage(ref, workspaceRoot, extraRoots, mimeType);
  if (original.kind !== "tooLarge" || (original.size ?? Infinity) > MAX_GENERATED_IMAGE_BYTES) return original;
  return readRaster(ref, workspaceRoot, extraRoots, mimeType, ({ bytes, dimensions }) => {
    const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(dimensions.width, dimensions.height));
    const thumbnail = resize(bytes, Math.max(1, Math.round(dimensions.width * scale)), Math.max(1, Math.round(dimensions.height * scale)));
    if (!thumbnail.length) return notImage;
    if (thumbnail.length > MAX_IMAGE_BYTES) return original;
    return { kind: "image", dataUrl: `data:image/png;base64,${thumbnail.toString("base64")}`, size: thumbnail.length, isThumbnail: true };
  });
}

/** Only the owning local session's non-redirected scratch root may serve original bytes. */
export async function readGeneratedImageOriginal(ref: string, scratchRoot: string | null, mimeType: string | undefined,
  decode: (bytes: Buffer) => Dimensions | null): Promise<FsImageDataUrlResult> {
  if (!scratchRoot || !isAbsolute(scratchRoot) || !isAbsolute(ref)) return denied;
  const [parent, canonicalRoot] = await Promise.all([realpath(dirname(scratchRoot)), realpath(scratchRoot)]).catch(() => []);
  if (!parent || !canonicalRoot || relative(join(parent, basename(scratchRoot)), canonicalRoot) !== "") return denied;
  return readRaster(ref, null, [canonicalRoot], mimeType, ({ bytes, mime, dimensions }) => {
    if (mimeType && mimeType !== mime) return notImage;
    const decoded = decode(bytes);
    if (!decoded || decoded.width !== dimensions.width || decoded.height !== dimensions.height) return notImage;
    return { kind: "image", dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, size: bytes.length };
  }, canonicalRoot);
}
