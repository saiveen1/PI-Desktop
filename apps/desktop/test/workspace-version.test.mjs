import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { applyFileEdits, assertRepositoryFile, planWorkspaceVersion, restoreFileEdits } from "../../../scripts/workspace-version.mjs";
import { loadReleaseHistory, renderChangelog } from "../../../scripts/personal-release-notes.mjs";
import { fixture, fixtureGit, read, repo, version, write } from "./helpers/personal-release-fixture.mjs";

const nextMinor = version.replace(/^(\d+)\.(\d+)\..*$/, (_all, major, minor) => `${major}.${Number(minor) + 1}.0-beta.1`);

test("shared version planning updates packages, Cargo, APP_VERSION and README lines, then restores exact bytes", (t) => {
  const { root } = fixture(t);
  const plan = planWorkspaceVersion(root, nextMinor);
  assert.ok(plan.some((entry) => entry.path.endsWith("README.md")));
  for (const edit of plan) assert.equal(readFileSync(edit.path, "utf8"), edit.before, "planning never writes");
  applyFileEdits(plan);
  assert.equal(JSON.parse(readFileSync(join(root, "docs/package.json"), "utf8")).version, nextMinor);
  assert.equal(JSON.parse(readFileSync(join(root, "packages/shared/package.json"), "utf8")).version, nextMinor);
  const releaseLine = nextMinor.split(".").slice(0, 2).join(".") + ".x";
  assert.ok(readFileSync(join(root, "README.md"), "utf8").includes(releaseLine));
  assert.ok(readFileSync(join(root, "README.zh-CN.md"), "utf8").includes(releaseLine));
  restoreFileEdits(plan);
  for (const edit of plan) assert.equal(readFileSync(edit.path, "utf8"), edit.before);
});

test("stale metadata is refused before any version write and rollback preserves concurrent edits", (t) => {
  const { root } = fixture(t);
  const plan = planWorkspaceVersion(root, nextMinor);
  const changed = plan.at(-1);
  write(changed.path, "concurrent document edit");
  assert.throws(() => applyFileEdits(plan), /changed concurrently/);
  assert.equal(readFileSync(plan[0].path, "utf8"), plan[0].before);
  write(changed.path, changed.before);
  applyFileEdits(plan);
  write(changed.path, "another concurrent edit");
  assert.throws(() => restoreFileEdits(plan), /rollback incomplete/);
  assert.equal(readFileSync(changed.path, "utf8"), "another concurrent edit");
  assert.equal(readFileSync(plan[0].path, "utf8"), plan[0].before);
});

test("version drift and outside metadata targets fail without writes", (t) => {
  const { root } = fixture(t);
  const packageBefore = readFileSync(join(root, "package.json"), "utf8");
  write(join(root, "docs/package.json"), '{"version":"99.0.0"}');
  assert.throws(() => planWorkspaceVersion(root, nextMinor), /versions differ/);
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), packageBefore);
  assert.throws(() => assertRepositoryFile(root, join(root, "..", "outside-release.json")), /contained file/);
  assert.ok(!existsSync(join(root, "..", "outside-release.json")));
});

test("the existing release CLI uses the shared plan without creating commits or tags by default", (t) => {
  const { root } = fixture(t);
  write(join(root, "scripts/release.mjs"), read("scripts/release.mjs"));
  write(join(root, "scripts/workspace-version.mjs"), read("scripts/workspace-version.mjs"));
  const before = fixtureGit(root, "rev-parse", "HEAD");
  const result = spawnSync(process.execPath, [join(root, "scripts/release.mjs"), nextMinor], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, nextMinor);
  assert.equal(fixtureGit(root, "rev-parse", "HEAD"), before);
  assert.equal(fixtureGit(root, "tag", "--list"), "");
});

test("tracked personal history matches its generated view and real Git commit subjects", () => {
  const history = loadReleaseHistory(repo);
  assert.equal(read("CHANGELOG.md"), renderChangelog(history));
  const entries = [...(history.baseline?.changes ?? []), ...history.releases.flatMap((entry) => entry.changes)];
  const commits = [...new Set(entries.map((entry) => entry.commit))];
  const lines = fixtureGit(repo, "show", "--no-patch", "--format=%H%x09%s", ...commits).split("\n");
  const subjects = new Map(lines.filter(Boolean).map((line) => [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)]));
  for (const entry of entries) assert.equal(subjects.get(entry.commit), entry.subject);
  if (!history.releases.length) assert.match(read("CHANGELOG.md"), /Unreleased personal development baseline/);
});

test("partial first or subsequent temporary writes preserve every original metadata file", (t) => {
  const { root } = fixture(t);
  const plan = planWorkspaceVersion(root, nextMinor);
  for (const failAt of [1, 2]) {
    let calls = 0;
    assert.throws(() => applyFileEdits(plan, (file, content) => {
      if (++calls === failAt) {
        writeFileSync(file, content.slice(0, 3));
        throw new Error("simulated partial write");
      }
      writeFileSync(file, content);
    }), /simulated partial write/);
    for (const edit of plan) assert.equal(readFileSync(edit.path, "utf8"), edit.before);
    assert.equal(fixtureGit(root, "status", "--porcelain"), "", "no metadata or temporary files are left behind");
  }
});
