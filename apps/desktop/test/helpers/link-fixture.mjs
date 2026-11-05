/**
 * Symlink fixtures that respect Windows link privileges.
 *
 * Creating a file symbolic link on Windows requires SeCreateSymbolicLink
 * privilege (Developer Mode or an elevated token); a directory link does not
 * when it is a junction. Tests that exercise symlink semantics must not turn
 * that OS limitation into a red failure: the helper downgrades a directory
 * link to a junction (same realpath behaviour the implementations guard
 * against) and reports an explicit skip when the OS still refuses, so the
 * assertions themselves keep running unchanged on Linux, macOS, and
 * privileged Windows.
 */
import { symlinkSync } from "node:fs";
import { symlink } from "node:fs/promises";

function linkType(type) {
  return process.platform === "win32" && type === "dir" ? "junction" : type;
}

function isPrivilegeError(error) {
  return process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES");
}

/**
 * Create `link` pointing at `target`. Directory links become junctions on
 * Windows; a refused file link skips the current test with the reason instead
 * of failing it. Returns true when the link exists.
 *
 * Pass `{ relative: true }` for a deliberately relative target: a junction
 * stores an absolute path, so a relative-target fixture cannot be expressed on
 * Windows and the test is skipped there instead of silently testing something
 * else.
 */
export async function createLinkOrSkip(t, target, link, type = "file", { relative = false } = {}) {
  if (relative && process.platform === "win32") {
    t.skip("junctions cannot carry a relative target");
    return false;
  }
  try {
    await symlink(target, link, linkType(type));
    return true;
  } catch (error) {
    if (isPrivilegeError(error)) {
      t.skip(`Windows denies ${type} symlinks without privilege (EPERM)`);
      return false;
    }
    throw error;
  }
}

/** Synchronous variant for tests that build fixtures synchronously. */
export function createLinkOrSkipSync(t, target, link, type = "file") {
  try {
    symlinkSync(target, link, linkType(type));
    return true;
  } catch (error) {
    if (isPrivilegeError(error)) {
      t.skip(`Windows denies ${type} symlinks without privilege (EPERM)`);
      return false;
    }
    throw error;
  }
}
