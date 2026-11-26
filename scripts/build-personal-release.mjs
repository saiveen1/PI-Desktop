#!/usr/bin/env node
// Build artifacts only. Never install, launch Desktop, or manage user processes.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cleanPersonalRelease } from "./clean-personal-release.mjs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFileEdits, assertRepositoryFile, planWorkspaceVersion, restoreFileEdits } from "./workspace-version.mjs";
import { assertNewBeta, captureGitSource } from "./personal-build-source.mjs";
import { collectReleaseChanges, loadReleaseHistory, planReleaseRecord, renderBuildNotes } from "./personal-release-notes.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

function verifyInstalledElectron(root, dist, version) {
  for (const file of ["electron.exe", "version", "resources.pak", "icudtl.dat"]) {
    const info = statSync(join(dist, file), { throwIfNoEntry: false });
    if (!info?.isFile() || !info.size) {
      throw new Error(`Installed Electron distribution is missing ${file}; run pnpm --filter @pi-desktop/desktop exec install-electron.`);
    }
  }
  const location = relative(root, realpathSync(dist));
  if (location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)) {
    throw new Error("Installed Electron distribution must belong to the current checkout.");
  }
  if (readFileSync(join(dist, "version"), "utf8").trim().replace(/^v/, "") !== version) {
    throw new Error(`Installed Electron distribution version does not match the Electron package (${version}).`);
  }
  const dos = Buffer.alloc(64);
  const pe = Buffer.alloc(6);
  const fd = openSync(join(dist, "electron.exe"), "r");
  try {
    if (readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos.readUInt16LE(0) !== 0x5a4d ||
        readSync(fd, pe, 0, pe.length, dos.readUInt32LE(60)) !== pe.length ||
        pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664) {
      throw new Error("Installed Electron distribution must be Windows x64.");
    }
  } finally {
    closeSync(fd);
  }
}

export function buildEnvironment(parent, pnpmEntry) {
  const env = Object.fromEntries(Object.entries(parent).filter(([key]) =>
    !/^PI_DESKTOP_|^PI_PERSONAL_(?:BUILD_|SOURCE_)|^PI_V022_BUILD_ROOT$|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^CARGO_TARGET_DIR$|^CARGO_BUILD_TARGET$/i.test(key),
  ));
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const original = pathKey ? env[pathKey] : "";
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  // Prefer pnpm's real executable over cmd shims in the builder's collector too.
  env.PATH = `${dirname(pnpmEntry)};${original}`;
  return env;
}

export function prepareBuild({ root = ROOT, platform = process.platform, arch = process.arch, env = process.env, releaseVersion } = {}) {
  if (platform !== "win32" || arch !== "x64") throw new Error("Personal release requires Windows x64; no alternate targets are built.");
  root = realpathSync(root);
  const desktop = join(root, "apps/desktop");
  const pkg = json(join(desktop, "package.json"));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error("Invalid desktop version.");
  if (json(join(root, "package.json")).version !== pkg.version) throw new Error("Root and Desktop versions differ; fix version metadata explicitly, not during packaging.");
  const pnpmEntry = env.npm_execpath;
  if (!pnpmEntry || !isAbsolute(pnpmEntry) || !existsSync(pnpmEntry) || !/^pnpm\.(?:exe|cjs|mjs|js)$/i.test(basename(pnpmEntry))) {
    throw new Error("Run pnpm dist:personal with the existing pnpm toolchain (npm_execpath must identify pnpm.exe or its JS entry).");
  }
  const req = createRequire(join(desktop, "package.json"));
  const bin = (name) => {
    const manifest = req.resolve(`${name}/package.json`);
    return join(dirname(manifest), json(manifest).bin[name]);
  };
  const builder = bin("electron-builder");
  const vite = bin("electron-vite");
  const asar = req("@electron/asar");
  const builderReq = createRequire(builder);
  const library = dirname(builderReq.resolve("app-builder-lib/package.json"));
  const template = join(library, "templates/nsis/include/allowOnlyOneInstallerInstance.nsh");
  if (!existsSync(template) || template.length >= 260) {
    throw new Error("NSIS template is missing or its path exceeds 259 characters. Stop; do not create another checkout or drive mapping.");
  }
  const configPath = join(desktop, "electron-builder.personal.cjs");
  const config = req(configPath);
  if (config.appId !== pkg.build.appId || config.productName !== pkg.build.productName ||
      config.extraMetadata.piSelfManaged !== true || config.extraMetadata.piDistribution !== "installed" ||
      JSON.stringify(config.win.target) !== JSON.stringify([{ target: "nsis", arch: ["x64"] }]) ||
      config.directories.output !== "release/personal/.build" || config.nsis.runAfterFinish !== false ||
      config.nsis.artifactName !== "PI-Desktop-Personal-Setup-${version}.${ext}") {
    throw new Error("Personal build configuration violates the installer-only contract.");
  }
  const { electronDist, electronVersion } = config;
  verifyInstalledElectron(root, electronDist, electronVersion);
  const updater = readFileSync(join(desktop, "electron/main/updater.ts"), "utf8");
  if (!updater.includes("metadata.piSelfManaged === true")) throw new Error("Current source lacks the self-managed updater guard; metadata alone does not disable updates.");
  const output = join(desktop, "release/personal");
  const staging = join(output, ".build");
  const logs = join(root, ".artifacts/personal-release");
  // Reject redirected output ancestors rather than writing into an installation/profile.
  for (const target of [staging, logs]) {
    let existing = target;
    while (!existsSync(existing)) existing = dirname(existing);
    if (realpathSync(existing).toLowerCase() !== resolve(existing).toLowerCase()) throw new Error("Build output must not be redirected by a symlink/junction.");
  }
  const pnpm = (args) => extname(pnpmEntry).toLowerCase() === ".exe"
    ? { command: pnpmEntry, args }
    : { command: process.execPath, args: [pnpmEntry, ...args] };
  const node = (entry, args = []) => ({ command: process.execPath, args: [entry, ...args] });
  const stages = [
    { name: "Desktop dependencies", cwd: root, ...pnpm(["--filter", "@pi-desktop/desktop^...", "--fail-if-no-match", "run", "build"]) },
    { name: "Locked release Host", cwd: root, command: "cargo", args: ["build", "--release", "--locked", "--manifest-path", "Cargo.toml", "--target-dir", "target", "-p", "host-core"] },
    { name: "Agent runtime bundle", cwd: join(root, "packages/agent-runtime"), ...node(join(root, "packages/agent-runtime/scripts/bundle.mjs")) },
    { name: "Desktop production build", cwd: desktop, ...node(vite, ["build"]) },
    { name: "Personal updater regression", cwd: root, ...node("--test", ["apps/desktop/test/updater-controller.test.mjs"]) },
    { name: "NSIS installer only", cwd: desktop, ...node(builder, ["--win", "nsis", "--x64", "--publish", "never", "--config", configPath]) },
  ];
  const source = captureGitSource(root);
  const history = loadReleaseHistory(root);
  if (releaseVersion !== undefined) {
    assertNewBeta(root, pkg.version, releaseVersion, history);
    if (source.dirty) throw new Error("An explicit beta release requires a clean source checkout; ordinary builds may include recorded dirty changes.");
  }
  const version = releaseVersion ?? pkg.version;
  const plannedVersions = planWorkspaceVersion(root, version);
  const versionEdits = releaseVersion !== undefined ? plannedVersions : [];
  assertRepositoryFile(root, join(output, "build-info.json"));
  const changes = collectReleaseChanges(root, history);
  return { root, desktop, output, staging, logs, currentVersion: pkg.version, version, release: releaseVersion !== undefined,
    installerName: `PI-Desktop-Personal-Setup-${version}.exe`, source, history, versionEdits, ...changes,
    env: buildEnvironment(env, pnpmEntry), stages, asar, electronDist, electronVersion };
}

export function runCommand(stage, { env, log }) {
  return new Promise((accept, reject) => {
    const child = spawn(stage.command, stage.args, { cwd: stage.cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let outputError;
    const output = (chunk) => {
      // Keep draining owned pipes after an I/O failure; settle on close so
      // version rollback cannot detach a still-running build command.
      if (outputError) return;
      try { appendFileSync(log, chunk); process.stdout.write(chunk); }
      catch (error) { outputError = error; }
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (outputError) reject(new Error(`${stage.name} output logging failed after child exit (${signal || code}); no retry was attempted.`, { cause: outputError }));
      else if (code === 0) accept();
      else reject(new Error(`${stage.name} failed (${signal || code}); see ${log}. No retry or installation was attempted.`));
    });
  });
}

function nonempty(path) {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) throw new Error(`Required build output missing: ${path}`);
}

export function verifyPackage(context) {
  const unpacked = join(context.staging, "win-unpacked");
  for (const path of ["PI-Desktop.exe", "resources/app.asar", "resources/bin/pi-desktop-host-core.exe", "resources/agent-runtime/sidecar.js", "resources/agent-runtime/package.json"]) nonempty(join(unpacked, path));
  if (existsSync(join(unpacked, "resources/default_app.asar")) || existsSync(join(unpacked, "version"))) {
    throw new Error("Packaged Electron still contains stock application files.");
  }
  const pkg = JSON.parse(context.asar.extractFile(join(unpacked, "resources/app.asar"), "package.json").toString("utf8"));
  if (pkg.version !== context.version || pkg.piSelfManaged !== true || pkg.piDistribution !== "installed") throw new Error("Packaged version or self-managed installed metadata is incorrect.");
  if (pkg.piBuildId !== context.buildId || pkg.piSourceCommit !== context.source.commit) throw new Error("Packaged source/build identity is incorrect.");
  const runtime = json(join(unpacked, "resources/agent-runtime/package.json"));
  if (runtime.type !== "module") throw new Error("Packaged runtime must retain its ESM package manifest.");
  const wasm = context.asar.extractFile(join(unpacked, "resources/app.asar"), join("out", "main", "photon_rs_bg.wasm"));
  if (!WebAssembly.validate(wasm)) throw new Error("Packaged Main photon_rs_bg.wasm is invalid.");
  const installer = join(context.staging, context.installerName);
  nonempty(installer);
  if (statSync(installer).size < 1024 * 1024) throw new Error("Installer is too small; refusing to deliver a stub.");
  return installer;
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function buildPersonal(context, { run = runCommand, now = () => new Date(), writeMetadataFile = writeFileSync } = {}) {
  mkdirSync(context.logs, { recursive: true });
  const lock = join(context.logs, "build.lock");
  const handle = openSync(lock, "wx");
  closeSync(handle);
  const log = join(context.logs, "build.log");
  const published = [];
  let versionApplied = false;
  let metadataEdits;
  let metadataApplied = false;
  const started = now().toISOString();
  context.buildId = started.replace(/[-:.]/g, "") + "-g" + context.source.commit.slice(0, 12) + "-" + randomUUID().slice(0, 8);
  const lockContents = JSON.stringify({ pid: process.pid, startedAt: started, buildId: context.buildId });
  try {
    writeFileSync(lock, lockContents);
    if (captureGitSource(context.root).fingerprint !== context.source.fingerprint) throw new Error("Source changed since preflight; rerun the read-only check before building.");
    applyFileEdits(context.versionEdits, writeMetadataFile);
    versionApplied = true;
    const buildSource = captureGitSource(context.root);
    const env = { ...context.env, PI_PERSONAL_BUILD_ID: context.buildId, PI_PERSONAL_SOURCE_COMMIT: context.source.commit };
    const cleaned = cleanPersonalRelease({ root: context.root }).cleaned;
    writeFileSync(log, `Building version ${context.version}; build ${context.buildId}; source ${context.source.commit}; dirty=${buildSource.dirty}. Build only, never install.\n`);
    appendFileSync(log, `Electron ${context.electronVersion} from ${context.electronDist}.\n`);
    for (const entry of cleaned) appendFileSync(log, `clean ${entry.removed ? "removed" : "absent"} ${entry.label}\n`);
    mkdirSync(context.staging, { recursive: true });
    for (const [index, stage] of context.stages.entries()) {
      if (stage.name === "NSIS installer only") {
        for (const required of ["target/release/pi-desktop-host-core.exe", "packages/agent-runtime/dist-bundle/sidecar.js", "packages/agent-runtime/dist-bundle/package.json", "apps/desktop/out/main/index.js", "apps/desktop/out/main/photon_rs_bg.wasm", "apps/desktop/out/renderer/index.html"]) nonempty(join(context.root, required));
      }
      const heading = `[${index + 1}/${context.stages.length}] ${stage.name}\n`;
      console.log(heading.trim());
      appendFileSync(log, heading);
      await run(stage, { env, log });
    }
    const built = verifyPackage(context);
    const digest = await sha256(built);
    if (captureGitSource(context.root).fingerprint !== buildSource.fingerprint) throw new Error("Source changed during packaging; refusing to publish misleading provenance.");
    const artifact = join(context.output, `PI-Desktop-Personal-Setup-${context.version}-${context.buildId}.exe`);
    const notes = `${artifact}.changes.md`;
    const result = { version: context.version, buildId: context.buildId, release: context.release,
      source: buildSource, versionOverride: context.release ? { from: context.currentVersion, to: context.version } : null,
      baseCommit: context.baseCommit, baselineKind: context.baselineKind, changes: context.changes,
      artifact, notes, sha256: digest, bytes: statSync(built).size, builtAt: now().toISOString(),
      installed: false, launched: false, validation: "Offline package checks only; no profile compatibility or Authenticode claim." };
    metadataEdits = context.release ? planReleaseRecord(context.root, context.history, result, context.changes) : [];
    const latest = join(context.output, "build-info.json");
    assertRepositoryFile(context.root, latest);
    metadataEdits.push({ path: latest, before: existsSync(latest) ? readFileSync(latest, "utf8") : null, after: JSON.stringify(result, null, 2) + "\n" });
    copyFileSync(built, artifact, constants.COPYFILE_EXCL);
    published.push(artifact);
    for (const [path, content] of [
      [`${artifact}.sha256`, `${digest}  ${basename(artifact)}\n`],
      [notes, renderBuildNotes(result)],
      [`${artifact}.build-info.json`, JSON.stringify(result, null, 2) + "\n"],
    ]) {
      writeFileSync(path, content, { flag: "wx" });
      published.push(path);
    }
    applyFileEdits(metadataEdits, writeMetadataFile);
    metadataApplied = true;
    appendFileSync(log, `SUCCESS ${artifact}\nSHA256 ${digest}\n`);
    return result;
  } catch (error) {
    const failures = [error];
    if (metadataApplied) { try { restoreFileEdits(metadataEdits); } catch (rollback) { failures.push(rollback); } }
    if (versionApplied) { try { restoreFileEdits(context.versionEdits); } catch (rollback) { failures.push(rollback); } }
    for (const path of published.reverse()) { try { unlinkSync(path); } catch (cleanup) { failures.push(cleanup); } }
    if (failures.length > 1) throw new AggregateError(failures, "Build failed; rollback needs inspection (concurrent edits were preserved)");
    throw error;
  } finally {
    if (readFileSync(lock, "utf8") === lockContents) unlinkSync(lock);
    else console.error("Build lock changed ownership; preserved it for inspection.");
  }
}

export function parsePersonalBuildArgs(args) {
  const options = { check: false };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--check" && !options.check) options.check = true;
    else if (args[index] === "--release" && options.releaseVersion === undefined && args[index + 1] && !args[index + 1].startsWith("--")) options.releaseVersion = args[++index];
    else throw new Error("Usage: pnpm dist:personal [--check] [--release X.Y.Z-beta.N]. No install, launch, target, or checkout overrides.");
  }
  return options;
}

async function main() {
  const { check, ...options } = parsePersonalBuildArgs(process.argv.slice(2));
  const context = prepareBuild(options);
  if (check) {
    console.log(JSON.stringify({ root: context.root, currentVersion: context.currentVersion, version: context.version, release: context.release,
      source: context.source, baseCommit: context.baseCommit, baselineKind: context.baselineKind, changes: context.changes,
      versionFiles: context.versionEdits.map((entry) => entry.path), output: context.output,
      electronDist: context.electronDist, electronVersion: context.electronVersion, stages: context.stages }, null, 2));
    return;
  }
  console.log(JSON.stringify(await buildPersonal(context), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
