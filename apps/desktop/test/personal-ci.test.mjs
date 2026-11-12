import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { buildPersonal, prepareBuild } from "../../../scripts/build-personal-release.mjs";
import { personalCiIdentity, prepareCiRelease, stageCiArtifacts, verifyCiDelivery } from "../../../scripts/personal-ci.mjs";
import { renderBuildNotes, loadReleaseHistory } from "../../../scripts/personal-release-notes.mjs";
import { fixture, fixtureGit, read, syntheticBuild, version, write } from "./helpers/personal-release-fixture.mjs";

const candidate = version.replace(/-beta\.(\d+)$/, (_all, n) => `-beta.${Number(n) + 1}`);
const envFor = (sha, release = false) => ({
  GITHUB_REPOSITORY: "saiveen1/PI-Desktop", GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha,
  GITHUB_EVENT_NAME: release ? "workflow_dispatch" : "push", PERSONAL_RELEASE_VERSION: release ? candidate : "",
});

async function built(t, release = false) {
  const f = fixture(t);
  const context = release ? prepareBuild({ root: f.root, env: f.env, platform: "win32", arch: "x64", releaseVersion: candidate }) : f.context;
  const result = await buildPersonal(context, { run: syntheticBuild(context) });
  const identity = personalCiIdentity(envFor(result.source.commit, release));
  const delivery = await stageCiArtifacts(f.root, identity);
  return { ...f, result, identity, delivery };
}

function clone(t, source, bare = false) {
  const parent = mkdtempSync(join(tmpdir(), "pi-personal-ci-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const destination = join(parent, bare ? "remote.git" : "checkout");
  fixtureGit(source, "clone", ...(bare ? ["--bare"] : []), "--no-local", source, destination);
  return destination;
}

function changeManifest(f, edit) {
  const file = join(f.delivery.directory, `${f.delivery.installer}.build-info.json`);
  const result = JSON.parse(readFileSync(file, "utf8"));
  edit(result);
  writeFileSync(file, JSON.stringify(result));
  writeFileSync(join(f.delivery.directory, `${f.delivery.installer}.changes.md`), renderBuildNotes(result));
}

test("only the personal fork main push or explicit manual beta is accepted", () => {
  const valid = envFor("a".repeat(40));
  assert.equal(personalCiIdentity(valid).release, false);
  assert.equal(personalCiIdentity(envFor(valid.GITHUB_SHA, true)).version, candidate);
  for (const patch of [
    { GITHUB_REPOSITORY: "vastsa/PI-Desktop" }, { GITHUB_REF: "refs/heads/other" },
    { GITHUB_SHA: "not-a-commit" }, { GITHUB_EVENT_NAME: "pull_request" },
    { PERSONAL_RELEASE_VERSION: candidate },
    { GITHUB_EVENT_NAME: "workflow_dispatch", PERSONAL_RELEASE_VERSION: "$(echo injected)" },
    { GITHUB_EVENT_NAME: "workflow_dispatch", PERSONAL_RELEASE_VERSION: "1.0.0-beta.01" },
  ]) assert.throws(() => personalCiIdentity({ ...valid, ...patch }));
});

test("push build stages exactly four checked files without changing version or history", async (t) => {
  const f = await built(t);
  assert.equal(f.result.version, version);
  assert.equal(loadReleaseHistory(f.root).releases.length, 0);
  assert.deepEqual(readdirSync(f.delivery.directory).sort(), [...f.delivery.files].sort());
  assert.equal(fixtureGit(f.root, "status", "--porcelain"), "");
  await assert.rejects(stageCiArtifacts(f.root, f.identity), /already exists/);
  await assert.rejects(prepareCiRelease(f.root, f.delivery.directory, f.identity), /explicit manual beta/);
});

test("manual beta reconstructs only metadata, then an isolated atomic push retains history and tag", async (t) => {
  const f = await built(t, true);
  const remote = clone(t, f.root, true);
  const publisher = clone(t, remote);
  const prepared = await prepareCiRelease(publisher, f.delivery.directory, f.identity);
  assert.equal(JSON.parse(readFileSync(join(publisher, "package.json"), "utf8")).version, candidate);
  assert.equal(loadReleaseHistory(publisher).releases[0].sha256, f.result.sha256);
  assert.equal(loadReleaseHistory(publisher).releases[0].sourceCommit, f.identity.sourceCommit);
  assert.deepEqual(fixtureGit(publisher, "diff", "--cached", "--name-only").split("\n").sort(), [...prepared.paths].sort());
  assert.equal(fixtureGit(publisher, "rev-parse", "HEAD"), f.identity.sourceCommit, "helper never commits");
  assert.equal(fixtureGit(publisher, "tag", "--list"), "", "helper never tags");
  fixtureGit(publisher, "-c", "commit.gpgsign=false", "commit", "-m", "chore(release): record synthetic beta", "-m", "Synthetic offline fixture only.");
  fixtureGit(publisher, "tag", "-a", prepared.tag, "-m", "Synthetic beta");
  fixtureGit(publisher, "push", "--atomic", "--no-follow-tags", "origin", "HEAD:refs/heads/main", `refs/tags/${prepared.tag}`);
  assert.equal(fixtureGit(remote, "rev-parse", "main"), fixtureGit(publisher, "rev-parse", "HEAD"));
  assert.equal(fixtureGit(remote, "rev-parse", `${prepared.tag}^{commit}`), fixtureGit(remote, "rev-parse", "main"));
});

test("an advanced remote rejects both the release commit and tag without force", async (t) => {
  const f = await built(t, true);
  const remote = clone(t, f.root, true);
  const publisher = clone(t, remote);
  const prepared = await prepareCiRelease(publisher, f.delivery.directory, f.identity);
  fixtureGit(publisher, "-c", "commit.gpgsign=false", "commit", "-m", "chore(release): synthetic stale release", "-m", "Offline fixture only.");
  fixtureGit(publisher, "tag", "-a", prepared.tag, "-m", "Synthetic beta");
  const newer = clone(t, remote);
  write(join(newer, "new-work.txt"), "concurrent work");
  fixtureGit(newer, "add", "--", "new-work.txt");
  fixtureGit(newer, "-c", "commit.gpgsign=false", "commit", "-m", "fix(test): concurrent source", "-m", "Offline fixture only.");
  fixtureGit(newer, "push", "origin", "HEAD:refs/heads/main");
  assert.throws(() => fixtureGit(publisher, "push", "--atomic", "--no-follow-tags", "origin", "HEAD:refs/heads/main", `refs/tags/${prepared.tag}`));
  assert.equal(fixtureGit(remote, "rev-parse", "main"), fixtureGit(newer, "rev-parse", "HEAD"));
  assert.equal(fixtureGit(remote, "tag", "--list", prepared.tag), "");
});

test("tampered bytes, source identity and extra download files cannot be published", async (t) => {
  const f = await built(t, true);
  const installer = join(f.delivery.directory, f.delivery.installer);
  writeFileSync(installer, Buffer.alloc(f.result.bytes, 7));
  await assert.rejects(verifyCiDelivery(f.delivery.directory, f.identity), /checksum mismatch/);
  writeFileSync(installer, Buffer.alloc(f.result.bytes, 42));
  await assert.rejects(verifyCiDelivery(f.delivery.directory, { ...f.identity, sourceCommit: "f".repeat(40) }), /source differs/);
  const publisher = clone(t, f.root);
  write(join(f.delivery.directory, "unexpected.txt"), "not a delivery file");
  await assert.rejects(prepareCiRelease(publisher, f.delivery.directory, f.identity), /Unexpected files/);
  assert.equal(fixtureGit(publisher, "status", "--porcelain"), "");
});

test("dirty publish checkout and forged change records fail before metadata edits", async (t) => {
  const f = await built(t, true);
  const dirty = clone(t, f.root);
  write(join(dirty, "other-work.txt"), "must survive");
  await assert.rejects(prepareCiRelease(dirty, f.delivery.directory, f.identity), /clean checkout/);
  assert.equal(readFileSync(join(dirty, "other-work.txt"), "utf8"), "must survive");
  const clean = clone(t, f.root);
  changeManifest(f, (result) => { result.changes[0].subject = "feat(test): forged release claim"; });
  await assert.rejects(prepareCiRelease(clean, f.delivery.directory, f.identity), /do not match source history/);
  assert.equal(fixtureGit(clean, "status", "--porcelain"), "");
});

test("unexpected build source edits cannot enter a release commit", async (t) => {
  const f = await built(t, true);
  const publisher = clone(t, f.root);
  changeManifest(f, (result) => { result.source.changedFiles.push("unrelated-source.ts"); });
  await assert.rejects(prepareCiRelease(publisher, f.delivery.directory, f.identity), /unexpected source files/);
  assert.equal(fixtureGit(publisher, "status", "--porcelain"), "");
});

test("workflow restricts publishing, reuses the personal builder and pins action code", () => {
  const { parse } = createRequire(import.meta.url)("yaml");
  const raw = read(".github/workflows/personal-windows.yml");
  const workflow = parse(raw);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.ok(!workflow.on.pull_request && !workflow.on.pull_request_target && !workflow.on.push.tags);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const { build, publish } = workflow.jobs;
  assert.match(build.if, /saiveen1\/PI-Desktop/);
  assert.equal(build.steps[0].with["persist-credentials"], false);
  assert.equal(build.steps[0].with["fetch-depth"], 0);
  assert.equal(publish.needs, "build");
  assert.match(publish.if, /workflow_dispatch/);
  assert.match(publish.if, /inputs\.release_version != ''/);
  assert.equal(publish.permissions.contents, "write");
  const upload = build.steps.find((step) => step.name === "Upload installer and provenance");
  assert.equal(upload.id, "installer");
  assert.equal(build.outputs.artifact_id, "${{ steps.installer.outputs.artifact-id }}");
  const download = publish.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.deepEqual(download.with, {
    "artifact-ids": "${{ needs.build.outputs.artifact_id }}",
    "merge-multiple": true,
    path: "${{ env.PERSONAL_ARTIFACT_DIR }}",
  }, "failed-job reruns must use the successful build output, not the new attempt number");
  for (const step of [...build.steps, ...publish.steps]) {
    if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
    if (step.run) assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./);
  }
  const buildRun = build.steps.find((step) => step.name === "Build the personal installer").run;
  assert.match(buildRun, /pnpm dist:personal --check/);
  assert.match(buildRun, /args\+=\(--release "\$PERSONAL_RELEASE_VERSION"\)/);
  assert.match(buildRun, /pnpm dist:personal "\$\{args\[@\]\}"/);
  assert.doesNotMatch(raw, /--force|--no-verify|dist:win|release\.mjs/);
  const commit = publish.steps.find((step) => step.name === "Commit metadata and atomically publish personal tag").run;
  assert.match(commit, /git ls-remote origin refs\/heads\/main/);
  assert.match(commit, /git push --atomic --no-follow-tags/);
  const release = publish.steps.find((step) => step.name === "Publish prerelease assets").run;
  assert.match(release, /--verify-tag --prerelease --latest=false/);
  assert.match(release, /--repo "\$GITHUB_REPOSITORY"/);
});
