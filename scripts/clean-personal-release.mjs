#!/usr/bin/env node
// Remove personal-release build intermediates. Build artifacts only: never
// install, launch Desktop, touch profiles, or remove the verified deliverable.
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Intermediates under apps/desktop/release/personal that a rebuild regenerates. */
const STAGING = join("apps", "desktop", "release", "personal", ".build");
/** Combined stage log/lock for the personal lane. */
const LOGS = join(".artifacts", "personal-release");

/**
 * Reject a path that escapes `root` or sits behind a redirected ancestor.
 * A junction/symlink to an installation or profile must never be deleted.
 */
function assertContained(root, target, label) {
  if (!existsSync(target)) return false;
  const real = realpathSync(target);
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedRoot, real);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep) || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`${label} resolves outside the checkout; refusing to clean it.`);
  }
  for (let current = target; current !== root; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} sits behind a link or junction; refusing to clean it.`);
    }
  }
  return true;
}

function removeTree(root, target, label) {
  if (!assertContained(root, target, label)) return { label, removed: false, entries: 0 };
  const entries = (() => {
    try {
      return statSync(target).isDirectory() ? readdirSync(target).length : 1;
    } catch {
      return 0;
    }
  })();
  rmSync(target, { recursive: true, force: true });
  return { label, removed: true, entries };
}

/**
 * Delete only regenerable intermediates for the personal lane.
 *
 * The published installer, its `.sha256`, and `build-info.json` stay: the
 * runbook requires a failed build to leave the previous verified deliverable
 * intact. A stale `build.lock` is left for operator inspection, never removed
 * here, because it may still guard a live build.
 */
export function cleanPersonalRelease({ root = resolve(".") } = {}) {
  const staging = join(root, STAGING);
  const logs = join(root, LOGS);
  const results = [removeTree(root, staging, "release/personal/.build")];
  // Clean the lane's leftovers individually so a live build lock survives.
  if (assertContained(root, logs, ".artifacts/personal-release")) {
    for (const name of ["build.log"]) {
      results.push(removeTree(root, join(logs, name), `.artifacts/personal-release/${name}`));
    }
    // Keep `build.lock`: an absent lock is created by the next build, and a
    // present one needs inspection rather than silent deletion.
  }
  return { root, cleaned: results };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 0) throw new Error("Usage: pnpm clean:personal-release. No arguments, targets, or checkout overrides.");
  const result = cleanPersonalRelease();
  for (const entry of result.cleaned) {
    console.log(`${entry.removed ? "removed" : "absent"} ${entry.label}${entry.removed ? ` (${entry.entries} entries)` : ""}`);
  }
  console.log("Kept: published installer, checksum, build-info.json, build.lock.");
}

if (process.argv[1] && process.argv[1].endsWith(`clean-personal-release.mjs`)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
