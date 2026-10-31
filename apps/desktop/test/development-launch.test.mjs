import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import * as launcher from "../../../scripts/dev-electron.mjs";

const launcherSource = readFileSync(new URL("../../../scripts/dev-electron.mjs", import.meta.url), "utf8");
const flag = "--inherit-data-dir";

test("development launch preparation is available without starting Electron", () => {
  assert.equal(typeof launcher.prepareDevelopmentLaunch, "function");
});

test("plain dev strips inherited data roots including Windows case variants without mutating its parent", () => {
  const inherited = {
    PI_DESKTOP_DATA_DIR: "/daily-profile",
    pi_desktop_data_dir: "/another-case-profile",
    PI_DESKTOP_DEV: "0",
    PATH: "/existing-toolchain",
    OTHER_SETTING: "unchanged",
  };
  const before = { ...inherited };
  const args = ["--port", "5184", "--", "--user-data-dir=/temporary-browser"];
  const beforeArgs = [...args];
  const result = launcher.prepareDevelopmentLaunch(args, Object.freeze(inherited));
  assert.equal(result.env.PI_DESKTOP_DATA_DIR, undefined);
  assert.equal(result.env.pi_desktop_data_dir, undefined);
  assert.equal(result.env.PI_DESKTOP_DEV, "1");
  assert.equal(result.env.PATH, inherited.PATH);
  assert.equal(result.env.OTHER_SETTING, "unchanged");
  assert.equal(result.inheritsDataDir, false);
  assert.equal(result.clearedDataDir, true);
  assert.deepEqual(result.args, beforeArgs);
  assert.deepEqual(inherited, before);
  assert.deepEqual(args, beforeArgs);
});

test("explicit inheritance retains only the chosen root and consumes the launcher flag", () => {
  const cwd = join(tmpdir(), "pi-launch-cwd");
  for (const key of ["PI_DESKTOP_DATA_DIR", "pi_desktop_data_dir"]) {
    const inherited = { [key]: "./offline-repro-copy", OTHER_SETTING: "unchanged" };
    const result = launcher.prepareDevelopmentLaunch(
      ["--port", "5184", flag],
      inherited,
      cwd,
    );
    assert.equal(result.env.PI_DESKTOP_DATA_DIR, resolve(cwd, "offline-repro-copy"));
    assert.equal(result.env.pi_desktop_data_dir, undefined);
    assert.equal(result.env.PI_DESKTOP_DEV, "1");
    assert.deepEqual(result.args, ["--port", "5184"]);
    assert.equal(result.inheritsDataDir, true);
    assert.equal(result.clearedDataDir, false);
    assert.equal(inherited[key], "./offline-repro-copy");
  }
});

test("inheritance requires a nonempty unambiguous environment root and a bare opt-in flag", () => {
  for (const env of [{}, { PI_DESKTOP_DATA_DIR: "" }, { PI_DESKTOP_DATA_DIR: "   " }]) {
    assert.throws(() => launcher.prepareDevelopmentLaunch([flag], env), /requires a nonempty PI_DESKTOP_DATA_DIR/);
  }
  assert.throws(
    () => launcher.prepareDevelopmentLaunch([flag], { PI_DESKTOP_DATA_DIR: "/one", pi_desktop_data_dir: "/two" }),
    /conflicting.*PI_DESKTOP_DATA_DIR/,
  );
  for (const argument of [`${flag}=true`, `${flag}=false`, `${flag}=/some-path`]) {
    assert.throws(
      () => launcher.prepareDevelopmentLaunch([argument], { PI_DESKTOP_DATA_DIR: "/profile" }),
      /does not accept a value/,
    );
  }
});

test("clean development launches need no opt-in and opt-in is never sticky in the child environment", () => {
  const clean = launcher.prepareDevelopmentLaunch([], {});
  assert.equal(clean.clearedDataDir, false);
  assert.equal(clean.env.PI_DESKTOP_DATA_DIR, undefined);
  const first = launcher.prepareDevelopmentLaunch([flag], { PI_DESKTOP_DATA_DIR: join(tmpdir(), "repro") });
  const nested = launcher.prepareDevelopmentLaunch([], first.env);
  assert.equal(nested.env.PI_DESKTOP_DATA_DIR, undefined);
  assert.equal(nested.inheritsDataDir, false);
});

// Exercise the real entry point, argument consumption, cwd change, and spawn.
// Only external Electron/Vite packages are replaced, under a temporary root.
function createLaunchFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-dev-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const script = join(root, "scripts/dev-electron.mjs");
  const desktop = join(root, "apps/desktop");
  const electron = join(desktop, "node_modules/electron");
  const vite = join(desktop, "node_modules/electron-vite");
  const reportPath = join(root, "launch-result.json");
  const dataDir = join(root, "offline-repro-data");
  const sentinel = join(dataDir, "untouched.txt");
  write(script, launcherSource);
  write(join(desktop, "package.json"), JSON.stringify({ type: "module" }));
  write(join(electron, "package.json"), JSON.stringify({ name: "electron", version: "fixture", main: "index.cjs" }));
  write(join(electron, "index.cjs"), "module.exports = __filename;\n");
  write(join(vite, "package.json"), JSON.stringify({ name: "electron-vite", type: "module" }));
  write(join(vite, "bin/electron-vite.js"), `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.PI_DEV_LAUNCH_REPORT, JSON.stringify({
  dataDir: process.env.PI_DESKTOP_DATA_DIR ?? null,
  development: process.env.PI_DESKTOP_DEV,
  args: process.argv.slice(2),
}));
`);
  write(sentinel, "Never modify this profile during launcher tests.");
  return {
    root,
    dataDir,
    run(args, dataValue = dataDir) {
      rmSync(reportPath, { force: true });
      const env = Object.fromEntries(Object.entries(process.env).filter(
        ([key]) => key.toUpperCase() !== "PI_DESKTOP_DATA_DIR",
      ));
      if (dataValue !== undefined) env.PI_DESKTOP_DATA_DIR = dataValue;
      env.PI_DEV_LAUNCH_REPORT = reportPath;
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      assert.ifError(result.error);
      let report = null;
      try {
        report = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      assert.equal(readFileSync(sentinel, "utf8"), "Never modify this profile during launcher tests.");
      return { ...result, report };
    },
  };
}

test("the real launcher isolates plain dev then permits a fresh explicit opt-in", {
  skip: process.platform === "darwin" ? "macOS native bundle setup has its own platform-specific suite" : false,
}, (t) => {
  const fixture = createLaunchFixture(t);
  const isolated = fixture.run(["--port", "5184"]);
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.deepEqual(isolated.report, { dataDir: null, development: "1", args: ["dev", "--port", "5184"] });
  assert.match(isolated.stderr, /Ignoring inherited PI_DESKTOP_DATA_DIR/);
  assert.ok(!isolated.stderr.includes(fixture.dataDir), "profile paths must not leak in notices");

  const optedIn = fixture.run([flag, "--port", "5184"], "./offline-repro-data");
  assert.equal(optedIn.status, 0, optedIn.stderr);
  assert.deepEqual(optedIn.report, { dataDir: fixture.dataDir, development: "1", args: ["dev", "--port", "5184"] });
  assert.match(optedIn.stderr, /read\/write/);
  assert.match(optedIn.stderr, /Stop.*Release/);
  assert.ok(!optedIn.stderr.includes(fixture.dataDir));

  const again = fixture.run([]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.report.dataDir, null);
});

test("invalid inheritance fails before package discovery or child startup", (t) => {
  const fixture = createLaunchFixture(t);
  rmSync(join(fixture.root, "apps/desktop/node_modules"), { recursive: true });
  for (const args of [[flag], [`${flag}=true`]]) {
    const result = fixture.run(args, " ");
    assert.notEqual(result.status, 0);
    assert.equal(result.report, null);
    assert.match(result.stderr, /requires a nonempty PI_DESKTOP_DATA_DIR|does not accept a value/);
    assert.doesNotMatch(result.stderr, /Cannot find module/);
  }
});
