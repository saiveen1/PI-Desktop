import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildPersonal, parsePersonalBuildArgs, runCommand } from "../../../scripts/build-personal-release.mjs";
import { assertNewBeta, captureGitSource, gitChanges } from "../../../scripts/personal-build-source.mjs";
import { loadReleaseHistory, renderChangelog } from "../../../scripts/personal-release-notes.mjs";
import { candidate, fixture, fixtureGit, syntheticBuild, version, write } from "./helpers/personal-release-fixture.mjs";

const releaseContext = (f) => f.preflight({ releaseVersion: candidate });
const versionPaths = ["package.json", "apps/desktop/package.json", "docs/package.json", "packages/shared/package.json", "packages/shared/src/protocol.ts", "Cargo.toml", "Cargo.lock", "README.md", "README.zh-CN.md", "docs/releases/history.json", "CHANGELOG.md"];
const snapshot = (root) => versionPaths.map((path) => readFileSync(join(root, path), "utf8"));

test("normal and explicit-beta preflight are read-only and never allocate build state", (t) => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const candidateContext = releaseContext(f);
  assert.equal(candidateContext.version, candidate);
  assert.equal(candidateContext.release, true);
  assert.equal(f.context.version, version);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(candidateContext.buildId, undefined);
  assert.ok(!existsSync(candidateContext.logs));
  assert.ok(!existsSync(candidateContext.output));
  assert.deepEqual(parsePersonalBuildArgs(["--check", "--release", candidate]), { check: true, releaseVersion: candidate });
  for (const args of [["--release"], ["--check", "--check"], ["--release", candidate, "--release", candidate], ["--install"]]) assert.throws(() => parsePersonalBuildArgs(args), /Usage:/);
});

test("explicit beta delivery updates all versions and release records only after verified packaging", async (t) => {
  const f = fixture(t);
  const context = releaseContext(f);
  const originalCommit = fixtureGit(f.root, "rev-parse", "HEAD");
  const result = await buildPersonal(context, { run: syntheticBuild(context) });
  assert.equal(JSON.parse(readFileSync(join(f.root, "package.json"), "utf8")).version, candidate);
  assert.match(readFileSync(join(f.root, "packages/shared/src/protocol.ts"), "utf8"), new RegExp(candidate.replaceAll(".", "\\.")));
  assert.match(readFileSync(join(f.root, "Cargo.lock"), "utf8"), new RegExp(candidate.replaceAll(".", "\\.")));
  const history = loadReleaseHistory(f.root);
  assert.equal(history.releases.length, 1);
  assert.equal(history.releases[0].version, candidate);
  assert.equal(history.releases[0].sha256, result.sha256);
  assert.equal(history.releases[0].sourceCommit, originalCommit);
  assert.equal(history.releases[0].buildId, result.buildId);
  assert.deepEqual(result.versionOverride, { from: version, to: candidate });
  assert.equal(readFileSync(join(f.root, "CHANGELOG.md"), "utf8"), renderChangelog(history));
  assert.equal(fixtureGit(f.root, "rev-parse", "HEAD"), originalCommit, "release never commits for the user");
  assert.equal(fixtureGit(f.root, "tag", "--list"), "", "release never tags or publishes");
  assert.match(readFileSync(result.notes, "utf8"), /Personal beta candidate|### Added|### Fixed|### Improved|### Maintenance/);
});

test("failed candidate restores exact version bytes, keeps previous metadata, and records no release", async (t) => {
  const f = fixture(t);
  const context = releaseContext(f);
  const before = snapshot(f.root);
  write(join(context.output, "build-info.json"), "previous successful build metadata");
  await assert.rejects(buildPersonal(context, { run: async () => { throw new Error("synthetic compile failure"); } }), /synthetic compile failure/);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(readFileSync(join(context.output, "build-info.json"), "utf8"), "previous successful build metadata");
  assert.equal(loadReleaseHistory(f.root).releases.length, 0);
  assert.equal(fixtureGit(f.root, "status", "--porcelain"), "");
  assert.ok(!existsSync(join(context.logs, "build.lock")));
});

test("candidate selection refuses dirty sources, non-beta labels, downgrades and existing local tags", (t) => {
  const f = fixture(t);
  const history = loadReleaseHistory(f.root);
  for (const value of [version, "0.0.0-beta.1", "0.23.0", "0.23.0-beta.01", "0.23.0-rc.1"]) assert.throws(() => assertNewBeta(f.root, version, value, history), /beta|newer/);
  fixtureGit(f.root, "tag", `v${candidate}`);
  assert.throws(() => releaseContext(f), /already tagged locally/);
  write(join(f.root, "README.md"), "uncommitted source change");
  const later = candidate.replace(/(\d+)$/, (number) => String(Number(number) + 1));
  assert.throws(() => f.preflight({ releaseVersion: later }), /clean source checkout/);
});

test("beta candidates compare correctly against a stable current version", (t) => {
  const f = fixture(t);
  const history = loadReleaseHistory(f.root);
  assert.doesNotThrow(() => assertNewBeta(f.root, "0.23.0", "0.23.1-beta.1", history));
  for (const candidate of ["0.23.0-beta.1", "0.22.9-beta.99", "0.23.0", "0.23.1-beta.01"]) {
    assert.throws(() => assertNewBeta(f.root, "0.23.0", candidate, history), /beta|newer/);
  }
  assert.doesNotThrow(() => assertNewBeta(f.root, "0.23.1-beta.1", "0.23.1-beta.2", history));
  assert.throws(() => assertNewBeta(f.root, "0.23.1-beta.2", "0.23.1-beta.1", history), /newer/);
});

test("Git-derived categories preserve commit evidence and never invent dirty-file feature text", async (t) => {
  const f = fixture(t);
  const base = fixtureGit(f.root, "rev-parse", "HEAD");
  for (const [index, subject] of ["feat(files): add fixture preview", "fix(files): retain fixture paths", "perf(files): avoid fixture rescans"].entries()) {
    write(join(f.root, "fixture.txt"), String(index));
    fixtureGit(f.root, "add", "--", "fixture.txt");
    fixtureGit(f.root, "-c", "commit.gpgsign=false", "commit", "-m", subject, "-m", "Synthetic history only.");
  }
  assert.deepEqual(gitChanges(f.root, base).map((entry) => entry.category), ["Improved", "Fixed", "Added"]);
  write(join(f.root, "uncommitted.txt"), "fixture bytes must never become a feature description");
  const source = captureGitSource(f.root);
  assert.equal(source.dirty, true);
  write(join(f.root, "uncommitted.txt"), "changed fixture bytes");
  assert.notEqual(captureGitSource(f.root).fingerprint, source.fingerprint);
  const context = f.preflight();
  const result = await buildPersonal(context, { run: syntheticBuild(context) });
  const notes = readFileSync(result.notes, "utf8");
  assert.ok(result.source.dirty);
  assert.match(notes, /feat\(files\): add fixture preview/);
  assert.doesNotMatch(notes, /changed fixture bytes/);
  assert.equal(loadReleaseHistory(f.root).releases.length, 0, "a development build is not a release");
});

test("a changed preflight source starts no commands and a mid-build edit publishes nothing", async (t) => {
  const f = fixture(t);
  write(join(f.root, "README.md"), "change after preflight");
  await assert.rejects(buildPersonal(f.context, { run: async () => assert.fail("stale preflight must not execute") }), /Source changed since preflight/);
  const context = f.preflight();
  const run = syntheticBuild(context);
  await assert.rejects(buildPersonal(context, { run: async (stage) => {
    await run(stage);
    if (stage.name === "NSIS installer only") write(join(f.root, "README.md"), "concurrent work must survive");
  } }), /Source changed during packaging/);
  assert.equal(readFileSync(join(f.root, "README.md"), "utf8"), "concurrent work must survive");
  assert.ok(!existsSync(join(context.output, "build-info.json")));
  assert.equal(loadReleaseHistory(f.root).releases.length, 0);
});

test("candidate rollback preserves concurrent metadata edits and reports incomplete rollback", async (t) => {
  const f = fixture(t);
  const context = releaseContext(f);
  const originalCargo = readFileSync(join(f.root, "Cargo.toml"), "utf8");
  await assert.rejects(buildPersonal(context, { run: async () => {
    write(join(f.root, "package.json"), JSON.stringify({ version: candidate, userChange: true }));
    throw new Error("synthetic failure after concurrent edit");
  } }), /rollback needs inspection/);
  assert.equal(JSON.parse(readFileSync(join(f.root, "package.json"), "utf8")).userChange, true);
  assert.equal(readFileSync(join(f.root, "Cargo.toml"), "utf8"), originalCargo);
  assert.equal(loadReleaseHistory(f.root).releases.length, 0);
});

test("forged package source identity cannot be delivered", async (t) => {
  const f = fixture(t);
  const { buildInputs, packageOutput } = await import("./helpers/personal-release-fixture.mjs");
  await assert.rejects(buildPersonal(f.context, { run: async (stage) => {
    if (stage.name === "Desktop production build") buildInputs(f.context);
    if (stage.name === "NSIS installer only") await packageOutput(f.context, { piSourceCommit: "forged" });
  } }), /source\/build identity is incorrect/);
  assert.ok(!existsSync(join(f.context.output, "build-info.json")));
});

test("ordinary packaging preserves an intentionally different dirty README release line", async (t) => {
  const f = fixture(t);
  const before = "Current release line: 0.99.x\nUser draft must survive unchanged.\n";
  write(join(f.root, "README.md"), before);
  const context = f.preflight();
  const result = await buildPersonal(context, { run: syntheticBuild(context) });
  assert.equal(result.version, version);
  assert.equal(readFileSync(join(f.root, "README.md"), "utf8"), before);
  assert.equal(context.versionEdits.length, 0);
});

test("child logging errors settle after the owned child exits and still roll candidate versions back", async (t) => {
  const f = fixture(t);
  const context = releaseContext(f);
  const before = snapshot(f.root);
  const marker = join(context.logs, "child-finished");
  await assert.rejects(buildPersonal(context, { run: async (_stage, { env, log }) => {
    rmSync(log);
    mkdirSync(log);
    await runCommand({ name: "logging failure probe", command: process.execPath, cwd: f.root,
      args: ["-e", "process.stdout.write('fixture output',()=>require('node:fs').writeFileSync(process.argv[1],'done'))", marker] }, { env, log });
  } }), /output logging failed/);
  assert.equal(readFileSync(marker, "utf8"), "done", "the command boundary waits for its owned child, not an arbitrary delay");
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(loadReleaseHistory(f.root).releases.length, 0);
  assert.ok(!existsSync(join(context.logs, "build.lock")));
});

test("a partial release-record write cannot truncate history or retain a failed delivery", async (t) => {
  const f = fixture(t);
  const context = releaseContext(f);
  const before = snapshot(f.root);
  write(join(context.output, "previous.exe"), "previous verified artifact");
  write(join(context.output, "build-info.json"), "previous verified metadata");
  await assert.rejects(buildPersonal(context, { run: syntheticBuild(context), writeMetadataFile: (file, content) => {
    if (content.startsWith('{\n  "schemaVersion"')) {
      writeFileSync(file, content.slice(0, 7));
      throw new Error("simulated release history disk full");
    }
    writeFileSync(file, content);
  } }), /simulated release history disk full/);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(readFileSync(join(context.output, "build-info.json"), "utf8"), "previous verified metadata");
  assert.deepEqual(readdirSync(context.output).filter((name) => name.endsWith(".exe")), ["previous.exe"]);
  assert.ok(!existsSync(join(context.logs, "build.lock")));
});

test("malformed or duplicate release history is rejected without touching delivery metadata", (t) => {
  const f = fixture(t);
  const originalVersion = readFileSync(join(f.root, "package.json"), "utf8");
  write(join(f.context.output, "build-info.json"), "previous successful metadata");
  const record = { version: candidate, sourceCommit: f.context.source.commit, changes: [], sha256: "0".repeat(64), buildId: "fixture", builtAt: "2026-11-08T00:00:00.000Z" };
  for (const bad of [
    { schemaVersion: 99, baseline: null, releases: [] },
    { schemaVersion: 1, baseline: { sourceCommit: "invalid", changes: [] }, releases: [] },
    { schemaVersion: 1, baseline: null, releases: [record, record] },
    { schemaVersion: 1, baseline: null, releases: [{}] },
  ]) {
    write(join(f.root, "docs/releases/history.json"), JSON.stringify(bad));
    assert.throws(() => loadReleaseHistory(f.root), /Invalid personal release history/);
    assert.equal(readFileSync(join(f.root, "package.json"), "utf8"), originalVersion);
    assert.equal(readFileSync(join(f.context.output, "build-info.json"), "utf8"), "previous successful metadata");
  }
});
