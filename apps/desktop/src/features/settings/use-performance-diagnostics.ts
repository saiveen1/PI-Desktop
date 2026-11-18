import { useCallback, useEffect, useRef, useState } from "react";
import type { PerformanceAction, PerformanceDiagnosticsState } from "@pi-desktop/shared";
import { api } from "../../lib/api";

type Request = PerformanceAction | "preview" | "save";
type Preview = { id: number; json: string };
type View = {
  data: PerformanceDiagnosticsState | null;
  busy: Request | null;
  error: Request | null;
  preview: Preview | null;
  saveResult: "saved" | "cancelled" | null;
};

const initialView: View = { data: null, busy: null, error: null, preview: null, saveResult: null };
const POLL_MS = 2000;

// Keep a request already in flight ahead of a newly mounted panel, without keeping a poller alive.
let lastRequest: Promise<void> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = lastRequest.then(work, work);
  lastRequest = result.then(() => undefined, () => undefined);
  return result;
}

export function usePerformanceDiagnostics() {
  const [view, setView] = useState<View>(initialView);
  const requestRef = useRef<(request: Request) => void>(() => undefined);

  useEffect(() => {
    let active = true;
    let busy = false;
    let queued: { kind: Exclude<Request, "snapshot">; id: number | null; phase: PerformanceDiagnosticsState["phase"] | null } | null = null;
    let visibilityGeneration = 0;
    let refreshOnVisible = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: View = initialView;
    const publish = (patch: Partial<View>) => {
      if (!active) return;
      current = { ...current, ...patch };
      setView(current);
    };
    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      if (!active || document.hidden || busy || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void run("snapshot");
      }, POLL_MS);
    };
    const applyData = (data: PerformanceDiagnosticsState) => {
      const preview = current.preview && data.phase === "complete" && data.id === current.preview.id
        ? current.preview : null;
      publish({ data, preview, saveResult: preview ? current.saveResult : null });
    };
    async function run(kind: Request) {
      if (!active || (kind === "snapshot" && document.hidden)) return;
      if (busy) {
        if (kind !== "snapshot" && current.busy === "snapshot" && !queued) {
          queued = { kind, id: current.data?.id ?? null, phase: current.data?.phase ?? null };
          publish({ busy: kind, error: null });
        }
        return;
      }
      const data = current.data;
      const id = data?.id;
      if (kind === "start" && (!data || data.phase === "recording")) return;
      if ((kind === "stop" || kind === "mark") && (data?.phase !== "recording" || id == null)) return;
      if (kind === "preview" && (data?.phase !== "complete" || id == null)) return;
      if (kind === "save" && (data?.phase !== "complete" || id == null || current.preview?.id !== id)) return;
      clearTimer();
      busy = true;
      const generation = visibilityGeneration;
      if (kind === "snapshot") refreshOnVisible = false;
      publish({
        busy: kind,
        error: kind === "snapshot" ? current.error : null,
        ...(kind === "start" ? { preview: null, saveResult: null } : {}),
        ...(kind === "save" ? { saveResult: null } : {}),
      });
      try {
        const result = await serialize(async () => {
          if (!active || (kind === "snapshot" && (document.hidden || generation !== visibilityGeneration))) return null;
          if (kind === "snapshot" || kind === "start") return api.performanceDiagnostics(kind);
          if (kind === "stop" || kind === "mark") return api.performanceDiagnostics(kind, id!);
          if (kind === "preview") return api.previewPerformanceReport(id!);
          return api.exportPerformanceReport(id!);
        });
        if (!active || result === null || (kind === "snapshot" && (document.hidden || generation !== visibilityGeneration))) return;
        if (kind === "preview") {
          if (typeof result === "string" && current.data?.phase === "complete" && current.data.id === id) {
            publish({ preview: { id: id!, json: result }, saveResult: null });
          }
        } else if (kind === "save") {
          if (typeof result === "object" && "saved" in result && current.preview?.id === id) {
            publish({ saveResult: result.saved ? "saved" : "cancelled" });
          }
        } else if (typeof result === "object" && "phase" in result) {
          applyData(result);
          if (kind === "snapshot" && current.error === "snapshot") publish({ error: null });
        }
      } catch {
        if (active && (kind !== "snapshot" || (!document.hidden && generation === visibilityGeneration))) {
          publish({ error: kind });
        }
      } finally {
        busy = false;
        if (active) {
          const next = queued;
          queued = null;
          publish({ busy: null });
          if (next) {
            if (generation !== visibilityGeneration || current.data?.id !== next.id || current.data?.phase !== next.phase) {
              publish({ error: next.kind });
              if (!document.hidden && refreshOnVisible) void run("snapshot");
              else schedule();
            } else void run(next.kind);
          } else if (!document.hidden && refreshOnVisible) void run("snapshot");
          else schedule();
        }
      }
    }
    const onVisibility = () => {
      visibilityGeneration++;
      clearTimer();
      refreshOnVisible = true;
      if (!document.hidden) {
        if (!busy) void run("snapshot");
      }
    };
    requestRef.current = (kind) => { void run(kind); };
    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) void run("snapshot");
    return () => {
      active = false;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      requestRef.current = () => undefined;
    };
  }, []);

  const request = useCallback((kind: Request) => requestRef.current(kind), []);
  return { ...view, request };
}
