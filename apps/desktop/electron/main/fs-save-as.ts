/**
 * "Save a copy" for a file the app can already read (chat file chips, the
 * files panel): Electron Main resolves the source, the *user* picks the
 * destination in the native save dialog, and the exact bytes are copied.
 *
 * Invariants this module owns:
 *
 * - The source is resolved through the caller's containment
 *   (`resolveRealOpenablePath`, same roots as `fs/open`) and must be a regular
 *   file. A rejection happens before the dialog, so an unreadable reference
 *   never prompts.
 * - The destination is never named by the renderer. It exists only as the
 *   native dialog's answer, and it must be an absolute path.
 * - The source is revalidated after the dialog returns. The dialog is a human
 *   pause of unbounded length; a file that disappeared or was retargeted while
 *   it was open is a failure, not a copy of whatever now sits at that name.
 * - The bytes are copied by the filesystem (`copyFile`), never through the
 *   bounded text/image preview path, so a binary or a multi-megabyte file
 *   arrives byte-identical. The source is never written to.
 * - Saving onto the source itself — the same name, the same real path, or the
 *   same inode behind a link — is refused instead of silently destroying the
 *   original.
 */
import { copyFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { ErrorCodes } from "@pi-desktop/shared";

/** The native save dialog's answer. An empty `filePath` means dismissal. */
export type SaveAsDialogResult = { canceled: boolean; filePath?: string };

export type SaveAsDependencies = {
  /** Containment for the renderer's reference; `null` means "not readable". */
  resolveSource: (ref: string) => Promise<string | null>;
  /** Native save dialog. The destination is the user's choice, not ours. */
  showSaveDialog: (options: { defaultPath: string }) => Promise<SaveAsDialogResult>;
  /** Byte copy; replaceable so tests can observe a real failure path. */
  copyFile?: (source: string, destination: string) => Promise<void>;
};

export type SaveAsResult = { canceled: boolean };

function failure(message: string, errorCode: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

/** Keep the original filesystem message, but report a classifiable code. */
function asAppError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const errorCode =
    code === "ENOENT" || code === "ENOTDIR"
      ? ErrorCodes.NOT_FOUND
      : code === "EACCES" || code === "EPERM"
        ? ErrorCodes.UNAUTHORIZED
        : code === "EISDIR" || code === "EINVAL"
          ? ErrorCodes.INVALID_ARGUMENT
          : ErrorCodes.INTERNAL;
  return Object.assign(
    error instanceof Error ? error : new Error(String(error)),
    { errorCode },
  );
}

function comparablePath(path: string): string {
  // Windows paths are case-insensitive, so `C:\A.txt` and `c:\a.txt` are one
  // file; every other platform keeps the exact spelling.
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/**
 * Resolve the reference and require a regular file, returning its real path.
 * Used both before the dialog and again after it.
 */
async function resolveRegularFile(
  ref: string,
  resolveSource: SaveAsDependencies["resolveSource"],
): Promise<{ path: string; dev: number; ino: number }> {
  const resolved = await resolveSource(ref);
  if (!resolved) {
    throw failure("path is not readable", ErrorCodes.INVALID_ARGUMENT);
  }
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    throw asAppError(error);
  }
  if (!info.isFile()) {
    throw failure("not a regular file", ErrorCodes.INVALID_ARGUMENT);
  }
  const real = await realpath(resolved).catch((error: unknown) => { throw asAppError(error); });
  return { path: real, dev: info.dev, ino: info.ino };
}

/** Refuse a destination that would overwrite the file being copied. */
async function assertDestinationIsDistinct(
  source: { path: string; dev: number; ino: number },
  destination: string,
): Promise<void> {
  const sourceKey = comparablePath(source.path);
  if (comparablePath(resolve(destination)) === sourceKey) {
    throw failure("destination is the source file", ErrorCodes.INVALID_ARGUMENT);
  }
  let destinationInfo: Awaited<ReturnType<typeof stat>>;
  try {
    destinationInfo = await stat(destination);
  } catch (error) {
    // Only a missing destination is expected; permission and I/O failures remain visible.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw asAppError(error);
  }
  if (!destinationInfo.isFile()) {
    throw failure("destination is not a file", ErrorCodes.INVALID_ARGUMENT);
  }
  // The same inode behind another name (hard link), or a link whose target is
  // the source: `copyFile` would truncate the source through it.
  if (
    destinationInfo &&
    source.ino !== 0 &&
    destinationInfo.dev === source.dev &&
    destinationInfo.ino === source.ino
  ) {
    throw failure("destination is the source file", ErrorCodes.INVALID_ARGUMENT);
  }
  const destinationReal = await realpath(destination).catch((error: unknown) => { throw asAppError(error); });
  if (destinationReal && comparablePath(destinationReal) === sourceKey) {
    throw failure("destination is the source file", ErrorCodes.INVALID_ARGUMENT);
  }
}

/**
 * Resolve `ref`, let the user choose a destination, then copy the exact bytes.
 *
 * `canceled: true` guarantees nothing was written. Any other return means the
 * copy completed; a failed copy throws instead of reporting success.
 */
export async function saveFileAs(
  ref: string,
  deps: SaveAsDependencies,
): Promise<SaveAsResult> {
  const requested = String(ref ?? "").trim();
  if (!requested) {
    throw failure("path required", ErrorCodes.INVALID_ARGUMENT);
  }

  // Validate before prompting; an unreadable reference reports an error without a dialog.
  const source = await resolveRegularFile(requested, deps.resolveSource);

  // 2. The destination is the user's, so only the source's own name travels
  //    into the dialog as an initial value.
  const choice = await deps.showSaveDialog({ defaultPath: basename(source.path) });
  const chosen = choice.canceled ? "" : choice.filePath ?? "";
  if (!chosen) return { canceled: true };
  if (!isAbsolute(chosen)) {
    throw failure("destination must be an absolute path", ErrorCodes.INVALID_ARGUMENT);
  }

  // 3. Revalidate after the await: the dialog is an unbounded human pause, and
  //    a source that vanished or changed identity in the meantime must not be
  //    copied under a stale assumption.
  const revalidated = await resolveRegularFile(requested, deps.resolveSource);
  if (revalidated.path !== source.path ||
    (source.ino !== 0 && revalidated.ino !== 0 &&
      (revalidated.dev !== source.dev || revalidated.ino !== source.ino))) {
    throw failure(
      "source changed while the save dialog was open",
      ErrorCodes.CONFLICT,
    );
  }

  const destination = resolve(chosen);
  await assertDestinationIsDistinct(revalidated, destination);

  try {
    await (deps.copyFile ?? copyFile)(source.path, destination);
  } catch (error) {
    throw asAppError(error);
  }
  return { canceled: false };
}
