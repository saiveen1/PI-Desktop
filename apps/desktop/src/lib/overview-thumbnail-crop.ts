const SAMPLE_EDGE = 128;

/** Crop the sampled thumbnail itself, not an estimated rectangle in the original. */
export function drawOverviewThumbnail(image: HTMLImageElement, canvas: HTMLCanvasElement): boolean {
  const { naturalWidth, naturalHeight } = image;
  if (!/^data:image\/(?:png|webp);base64,/i.test(image.src) ||
      !Number.isSafeInteger(naturalWidth) || !Number.isSafeInteger(naturalHeight) ||
      naturalWidth <= 0 || naturalHeight <= 0 || naturalWidth * naturalHeight > 16_000_000) return false;
  const scale = Math.min(1, SAMPLE_EDGE / Math.max(naturalWidth, naturalHeight));
  const width = Math.round(naturalWidth * scale), height = Math.round(naturalHeight * scale);
  if (!width || !height) return false;
  let cropped = false;
  try {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(image, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height);
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (pixels.data[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    if (right < left || (left === 0 && top === 0 && right === width - 1 && bottom === height - 1)) return false;
    canvas.width = right - left + 1;
    canvas.height = bottom - top + 1;
    ctx.putImageData(pixels, -left, -top);
    cropped = true;
    return true;
  } catch {
    // Canvas readback is optional. Keep the decoded image on any platform failure.
    return false;
  } finally {
    if (!cropped) { canvas.width = 0; canvas.height = 0; }
  }
}
