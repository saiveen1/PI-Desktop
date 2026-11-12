import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNewBeta, captureGitSource, localGit } from "./personal-build-source.mjs";
import { collectReleaseChanges, loadReleaseHistory, planReleaseRecord, renderBuildNotes } from "./personal-release-notes.mjs";
import { applyFileEdits, planWorkspaceVersion } from "./workspace-version.mjs";

export const PERSONAL_REPOSITORY = "saiveen1/PI-Desktop";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const beta = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;
const basename = (value) => typeof value === "string" ? value.split(/[\\/]/).at(-1) : "";
const json = (file) => JSON.parse(readFileSync(file, "utf8"));

/** Environment inputs are data, never interpolated into a command. */
export function personalCiIdentity(env) {
  assert.equal(env.GITHUB_REPOSITORY, PERSONAL_REPOSITORY, "Personal CI is restricted to the personal fork.");
  assert.equal(env.GITHUB_REF, "refs/heads/main", "Personal CI only builds main.");
  assert.ok(["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME), "Unsupported personal CI event.");
  assert.match(env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/, "Missing source commit.");
  const version = env.PERSONAL_RELEASE_VERSION ?? "";
  if (version) {
    assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "A push cannot select a release version.");
    assert.match(version, beta, "Select an explicit X.Y.Z-beta.N version without leading zeroes.");
  }
  return { sourceCommit: env.GITHUB_SHA, version, release: Boolean(version) };
}

function regularFile(file) {
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Artifacts must be regular files.");
  return stat;
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Validate only the four public delivery files, never trust recorded absolute paths. */
export async function verifyCiDelivery(directory, identity) {
  const manifests = readdirSync(directory).filter((name) => name.endsWith(".exe.build-info.json"));
  assert.equal(manifests.length, 1, "Expected exactly one installer metadata file.");
  const manifest = join(directory, manifests[0]);
  regularFile(manifest);
  const result = json(manifest);
  assert.match(result.version ?? "", beta, "Artifact version must be beta.");
  if (identity.version) assert.equal(result.version, identity.version, "Artifact version differs from the requested release.");
  assert.equal(result.release, identity.release, "Build/release mode mismatch.");
  assert.equal(result.source?.commit, identity.sourceCommit, "Artifact source differs from this workflow.");
  assert.equal(result.source?.dirty, identity.release, "Unexpected source dirty state.");
  assert.match(result.source?.fingerprint ?? "", /^[a-f0-9]{64}$/, "Missing source fingerprint.");
  assert.match(result.buildId ?? "", /^\d{8}T\d{9}Z-g[a-f0-9]{12}-[a-f0-9]{8}$/, "Invalid build identity.");
  assert.ok(result.buildId.includes(`-g${identity.sourceCommit.slice(0, 12)}-`), "Build identity has another source.");
  assert.equal(result.installed, false);
  assert.equal(result.launched, false);
  assert.match(result.sha256 ?? "", /^[a-f0-9]{64}$/);
  const installer = `PI-Desktop-Personal-Setup-${result.version}-${result.buildId}.exe`;
  assert.equal(basename(result.artifact), installer, "Artifact filename mismatch.");
  assert.equal(manifests[0], `${installer}.build-info.json`, "Metadata filename mismatch.");
  const files = [installer, `${installer}.sha256`, `${installer}.changes.md`, `${installer}.build-info.json`];
  for (const file of files) regularFile(join(directory, file));
  const size = regularFile(join(directory, installer)).size;
  assert.ok(size >= 1024 * 1024, "Refusing a stub installer.");
  assert.equal(size, result.bytes, "Installer length mismatch.");
  assert.equal(await digest(join(directory, installer)), result.sha256, "Installer checksum mismatch.");
  assert.equal(readFileSync(join(directory, `${installer}.sha256`), "utf8"), `${result.sha256}  ${installer}\n`);
  assert.equal(readFileSync(join(directory, `${installer}.changes.md`), "utf8"), renderBuildNotes(result), "Build notes differ from metadata.");
  return { result, files, installer, notes: join(directory, `${installer}.changes.md`) };
}

/** Package output remains ignored; only this known delivery set is uploaded. */
export async function stageCiArtifacts(root, identity) {
  assert.equal(captureGitSource(root).commit, identity.sourceCommit, "Checkout source changed.");
  const output = join(root, "apps/desktop/release/personal");
  const delivery = await verifyCiDelivery(output, identity);
  assert.equal(json(join(root, "package.json")).version, delivery.result.version);
  const destination = join(root, ".artifacts/personal-ci/deliverables");
  assert.ok(!existsSync(destination), "Delivery staging already exists; inspect it instead of overwriting.");
  mkdirSync(destination, { recursive: true });
  for (const file of delivery.files) copyFileSync(join(output, file), join(destination, file));
  return { directory: destination, ...delivery };
}

/**
 * Reconstruct version/history edits on a fresh source checkout. No source files
 * from the artifact are applied, and this helper never commits, tags or publishes.
 */
export async function prepareCiRelease(root, directory, identity) {
  assert.ok(identity.release, "Only an explicit manual beta may prepare release metadata.");
  const source = captureGitSource(root);
  assert.equal(source.commit, identity.sourceCommit, "Release checkout differs from the built source.");
  assert.equal(source.dirty, false, "Release metadata requires a clean checkout and index.");
  const delivery = await verifyCiDelivery(directory, identity);
  assert.deepEqual(readdirSync(directory).sort(), [...delivery.files].sort(), "Unexpected files in the downloaded delivery.");
  const { result } = delivery;
  const current = json(join(root, "package.json")).version;
  const history = loadReleaseHistory(root);
  assertNewBeta(root, current, identity.version, history);
  assert.deepEqual(result.versionOverride, { from: current, to: identity.version });
  assert.equal(result.source.tree, source.tree, "Source tree mismatch.");
  const changes = collectReleaseChanges(root, history);
  assert.deepEqual(result.changes, changes.changes, "Release notes do not match source history.");
  assert.equal(result.baseCommit, changes.baseCommit);
  assert.equal(result.baselineKind, changes.baselineKind);
  const versions = planWorkspaceVersion(root, identity.version);
  const relativePath = (file) => relative(root, file).replaceAll("\\", "/");
  assert.deepEqual([...result.source.changedFiles].sort(), versions.map((edit) => relativePath(edit.path)).sort(), "Build changed unexpected source files.");
  const edits = [...versions, ...planReleaseRecord(root, history, result, changes.changes)];
  const paths = edits.map((edit) => relativePath(edit.path));
  applyFileEdits(edits);
  localGit(root, ["diff", "--check"]);
  localGit(root, ["add", "--", ...paths]);
  const staged = localGit(root, ["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean).sort();
  assert.deepEqual(staged, [...paths].sort(), "Staged files differ from the release metadata plan.");
  return { ...delivery, paths, tag: `personal-v${identity.version}` };
}

async function main() {
  const identity = personalCiIdentity(process.env);
  const action = process.argv[2];
  assert.equal(process.argv.length, 3, "Usage: node scripts/personal-ci.mjs stage|prepare-release");
  if (action === "stage") {
    const delivery = await stageCiArtifacts(ROOT, identity);
    console.log(`Verified ${delivery.files.length} delivery files for ${delivery.result.buildId}.`);
  } else if (action === "prepare-release") {
    assert.ok(process.env.PERSONAL_ARTIFACT_DIR, "Missing downloaded artifact directory.");
    assert.ok(process.env.GITHUB_OUTPUT, "Missing workflow output channel.");
    const delivery = await prepareCiRelease(ROOT, resolve(process.env.PERSONAL_ARTIFACT_DIR), identity);
    appendFileSync(process.env.GITHUB_OUTPUT, `tag=${delivery.tag}\n`);
    console.log(`Prepared ${delivery.paths.length} version/history files for ${delivery.tag}.`);
  } else throw new Error("Usage: node scripts/personal-ci.mjs stage|prepare-release");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
