import type { IpcMainInvokeEvent, WebContents } from "electron";
import { IPC } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";
import { isCaptureId, parsePerformancePulse } from "../performance/measurement-input";
import { createPerformanceRecorder, type RecorderDependencies } from "../performance/recorder";

type Dependencies = Omit<RecorderDependencies, "allowed" | "signal"> & {
  registrar: Pick<IpcRegistrar, "handleWithEvent" | "assertMainWindowSender">;
  isDeveloperMode(): boolean;
  getContents(): WebContents | null;
  chooseFile(id: number): Promise<string | null>;
  saveFile(path: string, report: string, stillAuthorized: () => void): Promise<void>;
};

/** Event-only handlers: not registered on the external-agent/internal invoke map. */
export function registerPerformanceIpc(deps: Dependencies) {
  let owner: WebContents | null = null;
  let generation = 0;
  let preview: { id: number; text: string } | null = null;
  let saving = false;
  const allowed = () => deps.isDeveloperMode() && owner !== null && !owner.isDestroyed() && owner === deps.getContents();
  const recorder = createPerformanceRecorder({ ...deps, allowed, signal(value) {
    if (owner && !owner.isDestroyed() && !owner.isCrashed()) owner.send(IPC.event.performanceCapture, value);
  } });
  function onNavigation(details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) {
    if (details.isMainFrame && !details.isSameDocument) clear();
  }
  function clear() {
    generation++;
    preview = null;
    recorder.clear();
    if (!owner) return;
    owner.removeListener("did-start-navigation", onNavigation);
    owner.removeListener("render-process-gone", clear);
    owner.removeListener("destroyed", clear);
    owner = null;
  }
  function authorize(event: IpcMainInvokeEvent) {
    deps.registrar.assertMainWindowSender(event);
    if (!deps.isDeveloperMode() || event.sender.isDestroyed() || event.sender !== deps.getContents() ||
      !event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== event.sender.getURL()) {
      throw Object.assign(new Error("Performance diagnostics require developer mode in the main window"), { errorCode: "PERMISSION_DENIED" });
    }
    if (owner !== event.sender) {
      clear();
      owner = event.sender;
      owner.on("did-start-navigation", onNavigation);
      owner.once("render-process-gone", clear);
      owner.once("destroyed", clear);
    }
    const at = generation;
    return () => {
      if (at !== generation || !allowed()) throw new Error("Performance diagnostics session ended");
    };
  }
  const invalid = () => new Error("Invalid performance diagnostics request");
  const handle = deps.registrar.handleWithEvent.bind(deps.registrar);
  handle(IPC.invoke.performanceDiagnostics, async (event, ...args: unknown[]) => {
    const check = authorize(event);
    const [action, id] = args;
    if (action === "snapshot" && args.length === 1) {
      const state = await recorder.snapshot();
      check();
      return state;
    }
    if (action === "start" && args.length === 1) {
      const result = recorder.start();
      preview = null;
      return result;
    }
    if (args.length === 2 && isCaptureId(id)) {
      if (action === "stop") return recorder.stop(id);
      if (action === "mark") return recorder.mark(id);
    }
    throw invalid();
  });
  handle(IPC.invoke.performancePulse, async (event, ...args: unknown[]) => {
    authorize(event);
    if (args.length !== 1) throw invalid();
    recorder.pulse(parsePerformancePulse(args[0]));
  });
  handle(IPC.invoke.performanceReportPreview, async (event, ...args: unknown[]) => {
    authorize(event);
    const [id] = args;
    if (args.length !== 1 || !isCaptureId(id)) throw invalid();
    if (!preview || preview.id !== id) preview = { id, text: recorder.report(id) };
    return preview.text;
  });
  handle(IPC.invoke.performanceReportExport, async (event, ...args: unknown[]) => {
    const check = authorize(event);
    const selected = preview;
    if (args.length !== 1 || !selected || args[0] !== selected.id) throw new Error("Preview this recording before saving");
    if (saving) throw new Error("A save dialog is already open");
    saving = true;
    try {
      const path = await deps.chooseFile(selected.id);
      const stillAuthorized = () => {
        check();
        if (preview !== selected) throw new Error("The previewed recording has changed");
      };
      stillAuthorized();
      if (path === null) return { saved: false };
      await deps.saveFile(path, selected.text, stillAuthorized);
      return { saved: true };
    } finally { saving = false; }
  });
  return clear;
}
