import { app, dialog, webContents, type BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IpcRegistrar } from "../ipc/types";
import { registerPerformanceIpc } from "../ipc/performance-ipc";
import { createPerformanceProcessSampler } from "./process-sampler";
import { savePerformanceFile } from "./save-report";

/** Fixed metadata from the shipped manifest, not a renderer-selected file or environment. */
function buildMetadata() {
  let buildId: string | null = null;
  if (app.isPackaged) {
    const metadata: unknown = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"));
    if (metadata && typeof metadata === "object" && "piBuildId" in metadata && typeof metadata.piBuildId === "string" &&
      /^\d{8}T\d{9}Z-g[0-9a-f]{12}-[0-9a-f]{8}$/.test(metadata.piBuildId)) buildId = metadata.piBuildId;
  }
  return { appVersion: app.getVersion(), buildId, platform: process.platform, arch: process.arch, electron: process.versions.electron };
}

export function registerDesktopPerformance(deps: {
  registrar: IpcRegistrar;
  isDeveloperMode(): boolean;
  getMainWindow(): BrowserWindow | null;
  getHostPid(): number | null;
  getAgentPid(): number | null;
  getBrowserPids(): readonly number[];
  pluginForContents(contentsId: number): string | null;
  getPluginProcessOwners(): ReadonlyMap<number, string>;
}) {
  const getContents = () => {
    const win = deps.getMainWindow();
    return win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win.webContents : null;
  };
  const sampler = createPerformanceProcessSampler({ ...deps, getRendererPid: () => getContents()?.getOSProcessId() ?? null,
    getPluginPageOwners() {
      const owners = new Map<number, string | null>();
      const nonPlugin = new Set<number>();
      for (const page of webContents.getAllWebContents()) {
        if (page.isDestroyed()) continue;
        const pid = page.getOSProcessId();
        if (pid <= 0) continue;
        const plugin = deps.pluginForContents(page.id);
        if (!plugin) nonPlugin.add(pid);
        else owners.set(pid, owners.has(pid) && owners.get(pid) !== plugin ? null : plugin);
      }
      // Mixed owners may share an OS process; never guess a single plugin identity.
      for (const pid of nonPlugin) owners.delete(pid);
      return owners;
    },
  });
  return registerPerformanceIpc({ ...deps, getContents, sampler, now: Date.now, monotonic: () => performance.now(),
    every(ms, callback) { const timer = setInterval(callback, ms); timer.unref(); return () => clearInterval(timer); },
    build: buildMetadata,
    async chooseFile(id) {
      const win = deps.getMainWindow();
      if (!win || win.isDestroyed()) throw new Error("Window unavailable");
      const chosen = await dialog.showSaveDialog(win, { defaultPath: `pi-desktop-performance-${id}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }], properties: ["showOverwriteConfirmation"] });
      return chosen.canceled || !chosen.filePath ? null : chosen.filePath;
    },
    saveFile: savePerformanceFile,
  });
}
