import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
register(pathToFileURL(join(here, "helpers/updater-module-stubs.mjs")));

const { AppUpdaterController } = await import("../electron/main/updater.ts");
const { app } = await import("./helpers/updater-electron-stub.mjs");

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  logger = null;
  nextVersion = "0.16.1";
  downloadStarts = [];
  checks = 0;
  cancellations = [];

  async checkForUpdates() {
    this.checks += 1;
    this.emit("checking-for-update");
    const info = {
      version: this.nextVersion,
      files: [],
      path: "",
      sha512: "",
      releaseDate: "2026-10-03T00:00:00.000Z",
    };
    this.emit("update-available", info);
    const cancellationToken = {
      cancel: () => {
        this.cancellations.push(info.version);
        this.emit("update-cancelled", info);
      },
    };
    const downloadPromise = this.autoDownload
      ? (this.downloadStarts.push(info.version), Promise.resolve([]))
      : null;
    return { updateInfo: info, cancellationToken, downloadPromise };
  }

  async downloadUpdate() {
    return [];
  }

  quitAndInstall() {}
}

function createController({ updater, settings = {}, persist = async () => {} }) {
  const logger = { app: () => {} };
  const sent = [];
  const controller = new AppUpdaterController({
    logger,
    send: (channel, payload) => sent.push({ channel, payload }),
    currentVersion: "0.16.0",
    platform: "darwin",
    isPackaged: true,
    autoUpdater: updater,
    readUpdateSettings: async () => settings,
    persistDismissedVersion: persist,
  });
  return { controller, sent };
}

test("dismissing an in-app update cancels its download and disables install on quit", async () => {
  const updater = new FakeUpdater();
  const persisted = [];
  const { controller } = createController({
    updater,
    persist: async (version) => persisted.push(version),
  });

  await controller.check();
  assert.deepEqual(updater.downloadStarts, ["0.16.1"]);
  assert.equal(controller.getState().status, "downloading");

  await controller.dismiss();

  assert.deepEqual(updater.cancellations, ["0.16.1"]);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.getState().status, "available");
  assert.equal(controller.getState().dismissed, true);
  assert.deepEqual(persisted, ["0.16.1"]);
  controller.dispose();
});

test("a restored dismissal blocks that release and a newer release resumes automatic delivery", async () => {
  const updater = new FakeUpdater();
  const persisted = [];
  let clearDismissal;
  const cleared = new Promise((resolve) => {
    clearDismissal = resolve;
  });
  const { controller } = createController({
    updater,
    settings: { updatePreference: "automatic", updateDismissedVersion: "0.16.1" },
    persist: async (version) => {
      persisted.push(version);
      if (version === null) clearDismissal();
    },
  });

  await controller.check();
  assert.deepEqual(updater.downloadStarts, []);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.getState().dismissed, true);

  updater.nextVersion = "0.16.2";
  await controller.check();
  await cleared;
  assert.deepEqual(updater.downloadStarts, ["0.16.2"]);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(controller.getState().dismissed, false);
  assert.deepEqual(persisted, [null]);
  controller.dispose();
});

function withPackagedMetadata(metadata, create) {
  const directory = mkdtempSync(join(tmpdir(), "pi-personal-release-"));
  const original = app.getAppPath;
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify(metadata));
    app.getAppPath = () => directory;
    return create();
  } finally {
    app.getAppPath = original;
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const platform of ["win32", "darwin", "linux"]) {
  test("self-managed " + platform + " release cannot check, download, install, or re-enable upstream updates", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const updater = new FakeUpdater();
    // Model electron-updater's eager defaults, not only this fake's defaults.
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    const download = t.mock.method(updater, "downloadUpdate");
    const install = t.mock.method(updater, "quitAndInstall");
    const controller = withPackagedMetadata(
      { piSelfManaged: true, piDistribution: "installed" },
      () => new AppUpdaterController({
        logger: { app: () => {} },
        send: () => {},
        currentVersion: "0.21.0",
        platform,
        isPackaged: true,
        autoUpdater: updater,
        readUpdateSettings: async () => ({ updatePreference: "automatic" }),
      }),
    );
    t.after(() => controller.dispose());
    assert.equal(controller.getState().mode, "disabled");
    assert.equal(controller.getState().automaticSupported, false);
    assert.equal(controller.getState().defaultPreference, "manual");
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.deepEqual(updater.eventNames(), []);
    controller.startAutoCheck();
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(7 * 60 * 60 * 1000);
    await controller.reclaimRelocatedUpdateCache();
    await assert.rejects(controller.check({ manual: true }), /updates are disabled/);
    controller.setPreference("automatic");
    assert.equal(controller.getState().mode, "disabled");
    assert.equal(controller.getState().preference, "manual");
    await assert.rejects(controller.download(), /not supported/);
    await assert.rejects(controller.openReleases(), /self-managed builds/);
    assert.throws(() => controller.install(), /no downloaded update/);
    assert.equal(updater.checks, 0);
    assert.equal(download.mock.callCount(), 0);
    assert.equal(install.mock.callCount(), 0);
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(controller.isInstallingUpdate(), false);
  });
}

test("only a boolean self-managed package marker opts out; ordinary packages retain updates", async () => {
  for (const marker of [undefined, false, "true", "false", 1, null]) {
    const { controller } = withPackagedMetadata(
      { piSelfManaged: marker, piDistribution: "installed" },
      () => createController({ updater: new FakeUpdater() }),
    );
    try {
      assert.equal(controller.getState().mode, "in-app");
      assert.equal(controller.getState().automaticSupported, true);
      await controller.check();
      assert.equal(controller.getState().status, "downloading");
    } finally {
      controller.dispose();
    }
  }
});


test("ordinary Windows distribution metadata retains NSIS, ZIP, and portable defaults", () => {
  for (const [distribution, mode] of [["installed", "in-app"], ["zip", "manual"], ["portable", "manual"]]) {
    const controller = withPackagedMetadata(
      { piDistribution: distribution },
      () => new AppUpdaterController({
        logger: { app: () => {} },
        send: () => {},
        currentVersion: "0.21.0",
        platform: "win32",
        isPackaged: true,
        autoUpdater: new FakeUpdater(),
      }),
    );
    try {
      assert.equal(controller.getState().mode, mode);
      assert.equal(controller.getState().automaticSupported, true);
    } finally {
      controller.dispose();
    }
  }
});
