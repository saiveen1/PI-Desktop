import type { ComposerPasteFile, ComposerPastedFile } from "@pi-desktop/shared";

type FileImportBridge = {
  getDroppedFilePath: (file: File) => string | null;
  selectComposerFiles: (files: File[]) => Promise<string>;
  importFiles: (sessionId: string, token: string) => Promise<{ files: ComposerPastedFile[] }>;
  pasteFiles: (sessionId: string, files: ComposerPasteFile[]) => Promise<{ files: ComposerPastedFile[] }>;
};

/** Disk-backed Files cross preload as selections, never as whole-file byte buffers. */
export async function importComposerBrowserFiles(
  sessionId: string,
  files: File[],
  bridge: FileImportBridge,
): Promise<{ files: ComposerPastedFile[] }> {
  if (files.length > 20) throw new Error("too many pasted files (maximum 20)");
  const native = files.map(file => Boolean(bridge.getDroppedFilePath(file)));
  const nativeFiles = files.filter((_, index) => native[index]);
  const generatedFiles = files.filter((_, index) => !native[index]);
  const imported = nativeFiles.length
    ? await bridge.importFiles(sessionId, await bridge.selectComposerFiles(nativeFiles))
    : { files: [] };
  const pasted = generatedFiles.length
    ? await bridge.pasteFiles(sessionId, await Promise.all(generatedFiles.map(async file => ({
        name: file.name || undefined,
        mimeType: file.type || undefined,
        data: await file.arrayBuffer(),
      }))))
    : { files: [] };
  let nativeIndex = 0, generatedIndex = 0;
  return { files: native.map(isNative => isNative ? imported.files[nativeIndex++]! : pasted.files[generatedIndex++]!) };
}
