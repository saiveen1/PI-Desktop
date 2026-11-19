import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export function localGit(root, args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding, windowsHide: true, timeout: 10000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** Never prints file contents, calls a remote, or reads ignored/unrelated profiles. */
export function captureGitSource(root) {
  const commit = localGit(root, ["rev-parse", "--verify", "HEAD"]).trim();
  const tree = localGit(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const status = localGit(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  const hash = createHash("sha256").update(commit).update("\0").update(status);
  for (const args of [["diff", "--binary", "HEAD", "--"], ["diff", "--cached", "--binary", "--"]]) {
    hash.update("\0").update(localGit(root, args, undefined));
  }
  const untracked = localGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  for (const path of untracked.sort()) {
    const full = join(root, path);
    const stat = lstatSync(full);
    hash.update("\0" + path + "\0");
    if (stat.isSymbolicLink()) hash.update(readlinkSync(full));
    else if (stat.isFile()) {
      if (stat.size > 32 * 1024 * 1024) throw new Error(`Untracked source exceeds provenance limit; commit or ignore it explicitly: ${path}`);
      hash.update(readFileSync(full));
    } else throw new Error(`Unsupported untracked source: ${path}`);
  }
  const tracked = localGit(root, ["diff", "--name-only", "-z", "HEAD", "--"]).split("\0").filter(Boolean);
  return { commit, tree, dirty: status.length > 0, fingerprint: hash.digest("hex"), changedFiles: [...new Set([...tracked, ...untracked])].sort() };
}

export function gitChanges(root, baseCommit) {
  if (baseCommit) {
    if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new Error("Invalid release baseline commit.");
    try { localGit(root, ["merge-base", "--is-ancestor", baseCommit, "HEAD"]); }
    catch { throw new Error("Release baseline is not an ancestor of HEAD; choose the correct release lineage instead of guessing changes."); }
  }
  const text = localGit(root, ["log", "--no-merges", "--format=%H%x09%s", baseCommit ? `${baseCommit}..HEAD` : "HEAD", "--"]);
  return text.trim().split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("\t");
    const commit = line.slice(0, separator);
    const subject = line.slice(separator + 1).replace(/[\u0000-\u001f\u007f]/g, " ");
    const kind = subject.match(/^(\w+)(?:\([^)]*\))?!?:/)?.[1];
    const category = ({ feat: "Added", fix: "Fixed", perf: "Improved" })[kind] ?? "Maintenance";
    return { commit, subject, category };
  });
}

export const PERSONAL_BETA_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;

export function assertBetaVersionAdvance(requested, previousVersions) {
  const parts = (value) => value.match(PERSONAL_BETA_VERSION)?.slice(1).map(BigInt);
  const next = parts(requested);
  if (!next) throw new Error("Explicit personal releases require X.Y.Z-beta.N with no leading zeroes.");
  for (const value of previousVersions) {
    const stable = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)?.slice(1).map(BigInt);
    const previous = parts(value) ?? stable;
    if (!previous) throw new Error(`Unsupported current version: ${value}`);
    const position = next.slice(0, 3).findIndex((number, i) => number !== previous[i]);
    if (position >= 0 ? next[position] < previous[position] : stable || next[3] <= previous[3]) {
      throw new Error(`Release version must be newer than ${value}.`);
    }
  }
}

export function assertNewBeta(root, current, requested, history) {
  assertBetaVersionAdvance(requested, [current, ...history.releases.map((entry) => entry.version)]);
  if (localGit(root, ["tag", "--list", `v${requested}`]).trim()) throw new Error(`Release version v${requested} is already tagged locally; select a new candidate explicitly.`);
}
