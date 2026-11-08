import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertRepositoryFile } from "./workspace-version.mjs";
import { gitChanges } from "./personal-build-source.mjs";

const CATEGORIES = ["Added", "Fixed", "Improved", "Maintenance"];
export const HISTORY_PATH = "docs/releases/history.json";

export function loadReleaseHistory(root) {
  const path = join(root, HISTORY_PATH);
  if (!existsSync(path)) return { schemaVersion: 1, baseline: null, releases: [] };
  assertRepositoryFile(root, path);
  const history = JSON.parse(readFileSync(path, "utf8"));
  const validCommit = (value) => typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
  const validChanges = (value) => Array.isArray(value) && value.every((entry) =>
    entry && validCommit(entry.commit) && typeof entry.subject === "string" && !/[\r\n\0]/.test(entry.subject) && CATEGORIES.includes(entry.category));
  if (history?.schemaVersion !== 1 || !Array.isArray(history.releases) ||
      (history.baseline !== null && (!history.baseline || !validCommit(history.baseline.sourceCommit) || !validChanges(history.baseline.changes))) ||
      history.releases.some((entry) => !entry || !/^\d+\.\d+\.\d+-beta\.\d+$/.test(entry.version) ||
        !validCommit(entry.sourceCommit) || !validChanges(entry.changes) || !/^[0-9a-f]{64}$/.test(entry.sha256) ||
        typeof entry.buildId !== "string" || typeof entry.builtAt !== "string") ||
      new Set(history.releases.map((entry) => entry.version)).size !== history.releases.length) {
    throw new Error("Invalid personal release history; refusing to guess a release baseline.");
  }
  return history;
}

export function collectReleaseChanges(root, history) {
  const previous = history.releases[0];
  const baseline = previous?.sourceCommit ?? history.baseline?.sourceCommit;
  const initial = previous ? [] : history.baseline?.changes ?? [];
  const changes = [...gitChanges(root, baseline), ...initial];
  return {
    baseCommit: baseline ?? null,
    baselineKind: previous ? "previous personal release" : history.baseline ? "unreleased personal baseline plus subsequent commits" : "complete local history (no prior personal release)",
    changes: [...new Map(changes.map((entry) => [entry.commit, entry])).values()],
  };
}

function safeText(value) {
  return value.replace(/[\\`*_{}[\]<>#|]/g, "\\$&");
}

function changeSections(changes) {
  return CATEGORIES.map((category) => {
    const rows = changes.filter((entry) => entry.category === category);
    return `### ${category}\n\n` + (rows.length
      ? rows.map((entry) => `- ${safeText(entry.subject)} (\`${entry.commit.slice(0, 12)}\`)`).join("\n")
      : "- No changes recorded in this category.");
  }).join("\n\n");
}

export function renderBuildNotes({ version, buildId, source, changes, baseCommit, baselineKind, release }) {
  return `# ${release ? "Personal beta candidate" : "Development build"}: ${version}\n\n` +
    `- Build: \`${buildId}\`\n- Source commit: \`${source.commit}\`\n- Source fingerprint: \`${source.fingerprint}\`\n` +
    `- Working tree includes uncommitted changes: **${source.dirty ? "yes" : "no"}**\n` +
    `- Comparison: ${baselineKind}; base ${baseCommit ? `\`${baseCommit}\`` : "none"}.\n\n` +
    "These categories are derived from Git commit subjects, not evidence of tests or stability. " +
    "Uncommitted changes are fingerprinted but never invented as feature descriptions. " +
    "Verification is limited to the packaging runner's offline checks; installation, live-profile upgrades and signing trust are not established.\n\n" +
    changeSections(changes) + "\n";
}

export function renderChangelog(history) {
  const intro = "# Personal changelog\n\n" +
    "This is the personal edition's release record, generated from `docs/releases/history.json`. " +
    "Ordinary builds do not create releases or change the beta version. " +
    "Commit-subject categories are traceability aids, not stability or test claims.\n\n";
  if (!history.releases.length) {
    return intro + "## Unreleased personal development baseline\n\n" +
      "No personal beta candidate has been recorded by the new release workflow. " +
      "The following is historical development, not a fabricated release.\n\n" +
      (history.baseline ? `Snapshot: \`${history.baseline.sourceCommit}\`.\n\n${changeSections(history.baseline.changes)}\n` : "No baseline commits recorded.\n");
  }
  return intro + history.releases.map((entry) =>
    `## ${entry.version} — ${entry.builtAt.slice(0, 10)}\n\n` +
    `Source: \`${entry.sourceCommit}\`; build: \`${entry.buildId}\`; SHA-256: \`${entry.sha256}\`.\n\n` +
    "Verified by offline package checks only; no installation or profile-upgrade claim.\n\n" + changeSections(entry.changes),
  ).join("\n\n") + "\n";
}

export function planReleaseRecord(root, history, result, changes) {
  const record = {
    version: result.version, sourceCommit: result.source.commit, sourceFingerprint: result.source.fingerprint,
    versionOverride: result.versionOverride, buildId: result.buildId, builtAt: result.builtAt,
    sha256: result.sha256, artifact: result.artifact.split(/[\\/]/).at(-1), changes,
    validation: result.validation,
  };
  const next = { ...history, releases: [record, ...history.releases] };
  return [
    [HISTORY_PATH, JSON.stringify(next, null, 2) + "\n"],
    ["CHANGELOG.md", renderChangelog(next)],
  ].map(([name, after]) => {
    const path = join(root, name);
    assertRepositoryFile(root, path);
    return { path, before: existsSync(path) ? readFileSync(path, "utf8") : null, after };
  });
}
