import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { prepareBuild } from "../../../../scripts/build-personal-release.mjs";

export const repo = fileURLToPath(new URL("../../../../", import.meta.url));
export const read = (path) => readFileSync(join(repo, path), "utf8");
export const version = JSON.parse(read("apps/desktop/package.json")).version;
export const candidate = version.includes("-beta.")
  ? version.replace(/-beta\.(\d+)$/, (_all, number) => `-beta.${Number(number) + 1}`)
  : version.replace(/\.(\d+)$/, (_all, patch) => `.${Number(patch) + 1}-beta.1`);
export const write = (file, content) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); };
export function fixtureGit(root, ...args) {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.hooksPath=" + join(root, ".git/hooks"), ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, ".git-test-config"),
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function fixture(t, fixtureVersion = version) {
  const root = mkdtempSync(join(tmpdir(), "pi-personal-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const desktop = join(root, "apps/desktop");
  write(join(root, "package.json"), JSON.stringify({ version: fixtureVersion }));
  write(join(desktop, "package.json"), JSON.stringify({ ...JSON.parse(read("apps/desktop/package.json")), version: fixtureVersion }));
  write(join(desktop, "electron-builder.personal.cjs"), read("apps/desktop/electron-builder.personal.cjs"));
  write(join(desktop, "electron/main/updater.ts"), read("apps/desktop/electron/main/updater.ts"));
  write(join(root, "docs/package.json"), JSON.stringify({ version: fixtureVersion }));
  write(join(root, "packages/shared/package.json"), JSON.stringify({ version: fixtureVersion }));
  write(join(root, "packages/shared/src/protocol.ts"), `export const APP_VERSION = "${fixtureVersion}";\n`);
  write(join(root, "Cargo.toml"), `[workspace.package]\nversion = "${fixtureVersion}"\n`);
  write(join(root, "Cargo.lock"), `[[package]]\nname = "host-core"\nversion = "${fixtureVersion}"\n`);
  write(join(root, "README.md"), "Current release line: 0.22.x\n");
  write(join(root, "README.zh-CN.md"), "当前发布线：0.22.x\n");
  write(join(root, "docs/releases/history.json"), '{"schemaVersion":1,"baseline":null,"releases":[]}\n');
  write(join(root, "CHANGELOG.md"), "# Personal changelog\n\nNo releases recorded.\n");
  write(join(root, ".git-test-config"), "");
  write(join(root, ".gitignore"), "/node_modules/\n/apps/desktop/node_modules/\n/apps/desktop/release/\n/apps/desktop/out/\n/packages/agent-runtime/dist-bundle/\n/target/\n/.artifacts/\n/synthetic-asar/\n/tools/\n/.git-test-config\n");
  fixtureGit(root, "init", "--initial-branch=main");
  fixtureGit(root, "add", "--", ".gitignore", "package.json", "apps/desktop/package.json", "apps/desktop/electron-builder.personal.cjs", "apps/desktop/electron/main/updater.ts", "docs/package.json", "packages/shared/package.json", "packages/shared/src/protocol.ts", "Cargo.toml", "Cargo.lock", "README.md", "README.zh-CN.md", "docs/releases/history.json", "CHANGELOG.md");
  fixtureGit(root, "-c", "commit.gpgsign=false", "commit", "-m", "chore(test): seed isolated build fixture", "-m", "No real toolchain or installer is executed.");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "junction");
  symlinkSync(join(repo, "apps/desktop/node_modules"), join(desktop, "node_modules"), "junction");
  const pnpm = join(root, "tools/pnpm.exe");
  write(pnpm, "synthetic command boundary; never execute");
  const env = { PATH: process.env.PATH || "", npm_execpath: pnpm, PI_DESKTOP_DATA_DIR: "do-not-touch-live-data", NODE_OPTIONS: "--require=do-not-load-hook" };
  const context = prepareBuild({ root, platform: "win32", arch: "x64", env });
  return { root, desktop, pnpm, env, context };
}

export function buildInputs(context) {
  for (const file of ["target/release/pi-desktop-host-core.exe", "packages/agent-runtime/dist-bundle/sidecar.js", "apps/desktop/out/main/index.js", "apps/desktop/out/renderer/index.html"]) write(join(context.root, file), "synthetic build output");
  write(join(context.root, "apps/desktop/out/main/photon_rs_bg.wasm"), Buffer.from("0061736d01000000", "hex"));
  write(join(context.root, "packages/agent-runtime/dist-bundle/package.json"), '{"type":"module"}');
}

export async function packageOutput(context, metadata = {}) {
  const unpacked = join(context.staging, "win-unpacked");
  const source = join(context.root, "synthetic-asar");
  write(join(source, "package.json"), JSON.stringify({ version: context.version, piSelfManaged: true, piDistribution: "installed", piBuildId: context.buildId, piSourceCommit: context.source.commit, ...metadata }));
  write(join(source, "out/main/photon_rs_bg.wasm"), readFileSync(join(context.root, "apps/desktop/out/main/photon_rs_bg.wasm")));
  mkdirSync(join(unpacked, "resources"), { recursive: true });
  // asar 3 returns its output stream before the final bytes have flushed.
  await finished(await context.asar.createPackage(source, join(unpacked, "resources/app.asar")));
  write(join(unpacked, "PI-Desktop.exe"), "synthetic executable; never run");
  for (const [from, to] of [
    ["target/release/pi-desktop-host-core.exe", "bin/pi-desktop-host-core.exe"],
    ["packages/agent-runtime/dist-bundle/sidecar.js", "agent-runtime/sidecar.js"],
    ["packages/agent-runtime/dist-bundle/package.json", "agent-runtime/package.json"],
  ]) {
    const target = join(unpacked, "resources", to);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(context.root, from), target);
  }
  write(join(context.staging, context.installerName), Buffer.alloc(1024 * 1024, 42));
}

export function syntheticBuild(context) {
  return async (stage) => {
    if (stage.name === "Desktop production build") buildInputs(context);
    if (stage.name === "NSIS installer only") await packageOutput(context);
  };
}
