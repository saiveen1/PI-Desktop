import { realpath } from "node:fs/promises";
import type { ComposerPastedFile } from "@pi-desktop/shared";
import { referenceComposerFiles } from "./composer-file-references.ts";
import { importComposerFiles, isImageFile, mimeTypeForPath } from "./composer-paste.ts";

/** Native selections share one policy regardless of picker, drop, or paste. */
export async function importComposerSelection(
  dataDir: string,
  sessionId: string,
  projectPath: string | undefined,
  paths: string[],
): Promise<ComposerPastedFile[]> {
  if (paths.length > 20) throw new Error("too many imported files (maximum 20)");
  // A local path is not a remotely readable reference. Keep the existing copy flow.
  if (!projectPath) return importComposerFiles(dataDir, sessionId, paths);
  const canonical = await Promise.all(paths.map(path => realpath(path)));
  const image = canonical.map(path => isImageFile(path, mimeTypeForPath(path)));
  const copied = await importComposerFiles(dataDir, sessionId, canonical.filter((_, index) => image[index]));
  const referenced = await referenceComposerFiles(dataDir, sessionId, projectPath, canonical.filter((_, index) => !image[index]));
  let imageIndex = 0, fileIndex = 0;
  return image.map(isImage => isImage ? copied[imageIndex++]! : referenced[fileIndex++]!);
}
