import type { Result } from "@pi-desktop/shared";

// Preload-only: deliberately absent from IPC_WHITELIST and the MCP invoke surface.
export const COMPOSER_FILE_SELECTION_CHANNEL = "pi-desktop/composer/nativeFileSelection";

/** Resolve native File objects in preload; page-supplied path strings are never accepted. */
export function createComposerFileSelector(
  resolvePath: (file: File) => string,
  registerPaths: (paths: string[]) => Promise<Result<{ token: string }>>,
): (files: File[]) => Promise<string> {
  return async files => {
    if (!Array.isArray(files) || !files.length || files.length > 20) {
      throw new Error("invalid native file selection");
    }
    const paths = files.map(file => {
      // Electron rejects non-File values and returns an empty path for generated Files.
      const path = resolvePath(file);
      if (!path) throw new Error("native file path is unavailable");
      return path;
    });
    const result = await registerPaths(paths);
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.data.token;
  };
}
