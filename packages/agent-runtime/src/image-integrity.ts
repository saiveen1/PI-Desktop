import { createHash } from "node:crypto";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import type { ImageDimensions } from "@pi-desktop/shared";

// Keep digests only, never source images or decoded pixels, across request projections.
const decodedImages = new Map<string, boolean>();
const MAX_CACHED_IMAGES = 128;

function completeContainer(bytes: Buffer, mimeType: string): boolean {
  switch (mimeType) {
    case "image/png": {
      let offset = 8;
      while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const end = offset + 12 + length;
        if (end > bytes.length) return false;
        if (bytes.toString("ascii", offset + 4, offset + 8) === "IEND") return length === 0;
        offset = end;
      }
      return false;
    }
    case "image/jpeg":
      return bytes.length >= 2 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9;
    case "image/gif":
      return bytes.at(-1) === 0x3b;
    case "image/webp":
      return bytes.length >= 12 && bytes.readUInt32LE(4) + 8 === bytes.length;
    default:
      return false;
  }
}

/** Call only after the shared encoded-byte and dimension limits have passed. */
export function imageDecodesCompletely(data: string, mimeType: string, dimensions: ImageDimensions): boolean {
  const bytes = Buffer.from(data, "base64");
  const key = createHash("sha256").update(mimeType).update(bytes).digest("hex");
  const cached = decodedImages.get(key);
  if (cached !== undefined) return cached;
  let valid = false;
  // Decoders can accept a partial final chunk; require the complete container too.
  if (completeContainer(bytes, mimeType)) {
    let image: PhotonImage | undefined;
    try {
      image = PhotonImage.new_from_byteslice(bytes);
      valid = image.get_width() === dimensions.width && image.get_height() === dimensions.height;
    } catch {
      // A recognized header is not proof that the compressed pixels can be decoded.
      valid = false;
    } finally {
      image?.free();
    }
  }
  if (decodedImages.size >= MAX_CACHED_IMAGES) decodedImages.delete(decodedImages.keys().next().value!);
  decodedImages.set(key, valid);
  return valid;
}
