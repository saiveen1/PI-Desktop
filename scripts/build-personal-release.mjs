#!/usr/bin/env node
// Build artifacts only. Never install, launch Desktop, or manage user processes.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

export function buildEnvironment(parent, pnpmEntry) {
  const env = Object.fromEntries(Object.entries(parent).filter(([key]) =>
    !/^PI_DESKTOP_|^PI_V022_BUILD_ROOT$|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^CARGO_TARGET_DIR$|^CARGO_BUILD_TARGET$/i.test(key),
  ));
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const original = pathKey ? env[pathKey] : "";
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  // Prefer pnpm's real executable over cmd shims in the builder's collector too.
  env.PATH = `${dirname(pnpmEntry)};${original}`;
  return env;
}

export function prepareBuild({ root = ROOT, platform = process.platform, arch = process.arch, env = process.env } = {}) {
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
  return { root, desktop, output, staging, logs, version: pkg.version, installerName: `PI-Desktop-Personal-Setup-${pkg.version}.exe`, env: buildEnvironment(env, pnpmEntry), stages, asar };
}

export function runCommand(stage, { env, log }) {
  return new Promise((accept, reject) => {
    const child = spawn(stage.command, stage.args, { cwd: stage.cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = (chunk) => { appendFileSync(log, chunk); process.stdout.write(chunk); };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) accept();
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
  const pkg = JSON.parse(context.asar.extractFile(join(unpacked, "resources/app.asar"), "package.json").toString("utf8"));
  if (pkg.version !== context.version || pkg.piSelfManaged !== true || pkg.piDistribution !== "installed") throw new Error("Packaged version or self-managed installed metadata is incorrect.");
  const runtime = json(join(unpacked, "resources/agent-runtime/package.json"));
  if (runtime.type !== "module") throw new Error("Packaged runtime must retain its ESM package manifest.");
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

export async function buildPersonal(context, { run = runCommand } = {}) {
  mkdirSync(context.logs, { recursive: true });
  const lock = join(context.logs, "build.lock");
  const handle = openSync(lock, "wx"); // Existing/stale lock needs operator inspection, never process killing.
  closeSync(handle);
  const log = join(context.logs, "build.log");
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), root: context.root }));
    writeFileSync(log, `Building current checkout ${context.root}; version ${context.version}. Build only, never install.\n`);
    mkdirSync(context.staging, { recursive: true });
    const staleInstaller = join(context.staging, context.installerName);
    if (existsSync(staleInstaller)) unlinkSync(staleInstaller);
    for (const [index, stage] of context.stages.entries()) {
      if (stage.name === "NSIS installer only") {
        for (const required of ["target/release/pi-desktop-host-core.exe", "packages/agent-runtime/dist-bundle/sidecar.js", "packages/agent-runtime/dist-bundle/package.json", "apps/desktop/out/main/index.js", "apps/desktop/out/renderer/index.html"]) nonempty(join(context.root, required));
      }
      const heading = `[${index + 1}/${context.stages.length}] ${stage.name}\n`;
      console.log(heading.trim());
      appendFileSync(log, heading);
      await run(stage, { env: context.env, log });
    }
    const built = verifyPackage(context);
    const digest = await sha256(built);
    const artifact = join(context.output, context.installerName);
    const temporary = `${artifact}.tmp`;
    copyFileSync(built, temporary);
    renameSync(temporary, artifact);
    writeFileSync(`${artifact}.sha256`, `${digest}  ${basename(artifact)}\n`);
    const result = { version: context.version, artifact, sha256: digest, bytes: statSync(artifact).size, builtAt: new Date().toISOString(), sourceRoot: context.root, installed: false, launched: false, validation: "Offline package checks only; no profile compatibility or Authenticode claim." };
    writeFileSync(join(context.output, "build-info.json"), `${JSON.stringify(result, null, 2)}\n`);
    appendFileSync(log, `SUCCESS ${artifact}\nSHA256 ${digest}\n`);
    return result;
  } finally {
    unlinkSync(lock);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new Error("Usage: pnpm dist:personal [--check]. No install, launch, target, or checkout overrides.");
  const context = prepareBuild();
  if (args[0] === "--check") {
    console.log(JSON.stringify({ root: context.root, version: context.version, output: context.output, stages: context.stages }, null, 2));
    return;
  }
  console.log(JSON.stringify(await buildPersonal(context), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
