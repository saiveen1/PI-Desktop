import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { finished } from "node:stream/promises";
import test from "node:test";
import { buildEnvironment, buildPersonal, prepareBuild, runCommand } from "../../../scripts/build-personal-release.mjs";
import { cleanPersonalRelease as cleanStandalone } from "../../../scripts/clean-personal-release.mjs";
import { fixture, buildInputs, packageOutput, version, repo, write } from "./helpers/personal-release-fixture.mjs";

test("preflight selects the current checkout, exact argv, one NSIS target, and creates no output", (t) => {
  const { context, root } = fixture(t);
  assert.equal(context.root, root);
  assert.equal(context.version, version);
  assert.equal(context.stages.length, 6);
  assert.deepEqual(context.stages[0].args, ["--filter", "@pi-desktop/desktop^...", "--fail-if-no-match", "run", "build"]);
  assert.ok(context.stages[1].args.includes("--locked"));
  const packaging = context.stages.at(-1);
  assert.deepEqual(packaging.args.slice(1, 6), ["--win", "nsis", "--x64", "--publish", "never"]);
  assert.ok(!context.stages.some((s) => s.args.includes("zip") || s.args.includes("portable") || s.args.includes("install")));
  assert.ok(!existsSync(context.output));
  assert.ok(!existsSync(context.logs));
});

test("build environment drops inherited profiles/hooks without changing the parent", () => {
  const parent = Object.freeze({ Path: "original", PI_DESKTOP_DATA_DIR: "private", pi_desktop_dev: "1", NODE_OPTIONS: "--require=hook", ELECTRON_RUN_AS_NODE: "1", CARGO_TARGET_DIR: "other", KEEP: "yes" });
  const entry = resolve("pnpm-native/pnpm.exe");
  const env = buildEnvironment(parent, entry);
  assert.equal(env.PATH, `${dirname(entry)};original`);
  assert.equal(env.KEEP, "yes");
  assert.equal(env.PI_DESKTOP_DATA_DIR, undefined);
  assert.equal(env.pi_desktop_dev, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.CARGO_TARGET_DIR, undefined);
  assert.equal(parent.PI_DESKTOP_DATA_DIR, "private");
});

test("preflight refuses unsupported platforms, missing pnpm, mixed versions and missing updater guards", (t) => {
  const { root, desktop, env } = fixture(t);
  assert.throws(() => prepareBuild({ root, platform: "linux", env }), /Windows x64/);
  assert.throws(() => prepareBuild({ root, platform: "win32", arch: "x64", env: {} }), /Run pnpm/);
  write(join(root, "package.json"), '{"version":"99.0.0"}');
  assert.throws(() => prepareBuild({ root, platform: "win32", arch: "x64", env }), /versions differ/);
  write(join(root, "package.json"), JSON.stringify({ version }));
  write(join(desktop, "electron/main/updater.ts"), "// missing guard");
  assert.throws(() => prepareBuild({ root, platform: "win32", arch: "x64", env }), /updater guard/);
});

test("representative build journey publishes only verified installer and checksums, never runs it", async (t) => {
  const { context } = fixture(t);
  const invoked = [];
  const result = await buildPersonal(context, { run: async (stage, options) => {
    invoked.push(stage);
    assert.equal(options.env.PI_DESKTOP_DATA_DIR, undefined);
    if (stage.name === "Desktop production build") buildInputs(context);
    if (stage.name === "NSIS installer only") await packageOutput(context);
  } });
  assert.deepEqual(invoked, context.stages);
  assert.equal(result.installed, false);
  assert.equal(result.launched, false);
  assert.equal(typeof result.buildId, "string", "every build needs a distinct identity without changing its release version");
  assert.equal(result.version, version);
  assert.equal(result.sha256, createHash("sha256").update(readFileSync(result.artifact)).digest("hex"));
  const name = result.artifact.split(/[\\/]/).at(-1);
  assert.equal(readFileSync(`${result.artifact}.sha256`, "utf8"), `${result.sha256}  ${name}\n`);
  assert.deepEqual(readdirSync(context.output).sort(), [".build", name, `${name}.sha256`, `${name}.changes.md`, `${name}.build-info.json`, "build-info.json"].sort());
  assert.ok(!existsSync(join(context.logs, "build.lock")));
});

test("a failed build stops immediately, keeps the previous installer and releases its lock", async (t) => {
  const { context } = fixture(t);
  const previous = join(context.output, context.installerName);
  write(previous, "previous verified installer");
  let calls = 0;
  await assert.rejects(buildPersonal(context, { run: async () => { calls++; throw new Error("compiler failure"); } }), /compiler failure/);
  assert.equal(calls, 1);
  assert.equal(readFileSync(previous, "utf8"), "previous verified installer");
  assert.ok(!existsSync(join(context.logs, "build.lock")));
});

test("missing dist-bundle stops before electron-builder, not after shipping a broken EXE", async (t) => {
  const { context } = fixture(t);
  const invoked = [];
  await assert.rejects(buildPersonal(context, { run: async (stage) => {
    invoked.push(stage.name);
    if (stage.name === "Desktop production build") {
      buildInputs(context);
      rmSync(join(context.root, "packages/agent-runtime/dist-bundle/sidecar.js"));
    }
  } }), /Required build output missing/);
  assert.ok(!invoked.includes("NSIS installer only"));
  assert.ok(!existsSync(join(context.output, context.installerName)));
});

test("missing Main WASM stops before electron-builder", async (t) => {
  const { context } = fixture(t);
  const invoked = [];
  await assert.rejects(buildPersonal(context, { run: async (stage) => {
    invoked.push(stage.name);
    if (stage.name === "Desktop production build") {
      buildInputs(context);
      rmSync(join(context.root, "apps/desktop/out/main/photon_rs_bg.wasm"));
    }
  } }), /Required build output missing:.*photon_rs_bg\.wasm/);
  assert.ok(!invoked.includes("NSIS installer only"));
});

for (const missing of [true, false]) {
  test(`a package with ${missing ? "missing" : "invalid"} Main WASM cannot be delivered`, async (t) => {
    const { context } = fixture(t);
    await assert.rejects(buildPersonal(context, { run: async (stage) => {
      if (stage.name === "Desktop production build") buildInputs(context);
      if (stage.name === "NSIS installer only") {
        await packageOutput(context);
        const source = join(context.root, "synthetic-asar");
        const wasm = join(source, "out/main/photon_rs_bg.wasm");
        if (missing) rmSync(wasm);
        else write(wasm, "corrupt decoder");
        await finished(await context.asar.createPackage(source, join(context.staging, "win-unpacked/resources/app.asar")));
      }
    } }), /photon_rs_bg\.wasm/);
    assert.ok(!existsSync(join(context.output, context.installerName)));
  });
}

for (const metadata of [{ piSelfManaged: false }, { piDistribution: "portable" }, { version: "99.0.0" }]) {
  test(`invalid package metadata cannot be delivered: ${JSON.stringify(metadata)}`, async (t) => {
    const { context } = fixture(t);
    buildInputs(context);
    await assert.rejects(buildPersonal(context, { run: async (stage) => {
      if (stage.name === "NSIS installer only") await packageOutput(context, metadata);
    } }), /metadata is incorrect/);
    assert.ok(!existsSync(join(context.output, context.installerName)));
  });
}

test("an existing lock is preserved and no command is executed", async (t) => {
  const { context } = fixture(t);
  const lock = join(context.logs, "build.lock");
  write(lock, "another build");
  await assert.rejects(buildPersonal(context, { run: async () => assert.fail("must not run") }), /EEXIST/);
  assert.equal(readFileSync(lock, "utf8"), "another build");
});

test("real command boundary preserves failure status and argument tokens without cmd expansion", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "personal-command-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "command.log");
  await runCommand({ name: "argv probe", command: process.execPath, cwd: dir, args: ["-e", "console.log(process.argv[1])", "literal^caret & spaces"] }, { env: process.env, log });
  assert.match(readFileSync(log, "utf8"), /literal\^caret & spaces/);
  await assert.rejects(runCommand({ name: "failure", command: process.execPath, cwd: dir, args: ["-e", "process.exit(7)"] }, { env: process.env, log }), /failure failed \(7\)/);
});

test("CLI rejects install/launch/target overrides before creating any build state", () => {
  for (const arg of ["--install", "--launch", "--win", "--root=other"]) {
    const result = spawnSync(process.execPath, [join(repo, "scripts/build-personal-release.mjs"), arg], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No install, launch, target, or checkout overrides/);
  }
});

test("pre-build cleanup removes intermediates and stale log before the first stage", async (t) => {
  const { context } = fixture(t);
  write(join(context.staging, "win-unpacked", "PI-Desktop.exe"), "stale unpacked tree");
  write(join(context.staging, context.installerName), "stale partial installer");
  write(join(context.logs, "build.log"), "stale stage log");
  let sawCleanState = false;
  const result = await buildPersonal(context, { run: async (stage) => {
    if (stage.name === "Desktop dependencies") {
      sawCleanState = !existsSync(join(context.staging, "win-unpacked"));
      assert.equal(readFileSync(join(context.logs, "build.log"), "utf8").split("\n").some((line) => line.startsWith("clean removed")), true);
    }
    if (stage.name === "Desktop production build") buildInputs(context);
    if (stage.name === "NSIS installer only") await packageOutput(context);
  } });
  assert.ok(existsSync(result.artifact));
  assert.ok(sawCleanState, "staging must be cleaned before the first stage runs");
  assert.ok(existsSync(join(context.logs, "build.log")));
  assert.match(readFileSync(join(context.logs, "build.log"), "utf8"), /clean removed/);
  assert.equal(result.installed, false);
});

test("a live build lock still blocks a rebuild while cleanup is armed", async (t) => {
  const { context } = fixture(t);
  write(join(context.logs, "build.lock"), "another build");
  await assert.rejects(buildPersonal(context, { run: async () => assert.fail("must not run") }), /EEXIST/);
  assert.equal(readFileSync(join(context.logs, "build.lock"), "utf8"), "another build");
});

test("standalone cleanup removes intermediates and keeps lock, installer and info", (t) => {
  const { context } = fixture(t);
  const installer = join(context.output, context.installerName);
  write(installer, "previous verified installer");
  write(join(context.output, `${context.installerName}.sha256`), "digest");
  write(join(context.output, "build-info.json"), "{}");
  const lock = join(context.logs, "build.lock");
  write(lock, "another build");
  write(join(context.staging, "win-unpacked", "PI-Desktop.exe"), "stale");
  write(join(context.logs, "build.log"), "stale log");
  const result = cleanStandalone({ root: context.root });
  assert.ok(!existsSync(context.staging));
  assert.ok(!existsSync(join(context.logs, "build.log")));
  assert.equal(readFileSync(lock, "utf8"), "another build");
  assert.equal(readFileSync(installer, "utf8"), "previous verified installer");
  assert.ok(existsSync(join(context.output, `${context.installerName}.sha256`)));
  assert.ok(existsSync(join(context.output, "build-info.json")));
  assert.deepEqual(result.cleaned.map((entry) => entry.label).sort(), [".artifacts/personal-release/build.log", "release/personal/.build"]);
});

test("cleanup refuses a staging path redirected behind a junction", (t) => {
  const { context } = fixture(t);
  const victim = mkdtempSync(join(tmpdir(), "personal-clean-victim-"));
  t.after(() => rmSync(victim, { recursive: true, force: true }));
  mkdirSync(dirname(context.staging), { recursive: true });
  symlinkSync(victim, context.staging, "junction");
  assert.throws(() => cleanStandalone({ root: context.root }), /refusing to clean it/);
  assert.ok(readdirSync(victim).length === 0 && existsSync(victim), "junction target must survive");
});

test("ordinary rebuilds keep the release version and retain both installer artifacts", async (t) => {
  const { context } = fixture(t);
  const run = async (stage) => {
    if (stage.name === "Desktop production build") buildInputs(context);
    if (stage.name === "NSIS installer only") await packageOutput(context);
  };
  const first = await buildPersonal(context, { run });
  const original = readFileSync(first.artifact);
  const second = await buildPersonal(context, { run });
  assert.equal(first.version, version);
  assert.equal(second.version, version);
  assert.notEqual(first.artifact, second.artifact, "repacking must not overwrite the previous installer");
  assert.notEqual(first.buildId, second.buildId);
  assert.deepEqual(readFileSync(first.artifact), original);
  assert.ok(existsSync(second.artifact));
});
