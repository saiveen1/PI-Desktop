import { useEffect, useMemo, useState } from "react";
import { sessionAllows } from "./remote-session-safety";
import { useSlotSessionId } from "../plugins/renderer-slots/use-slots";
import { api } from "./api";
import { useAppStore } from "../stores/app-store";

type Preview = { dataUrl: string; isThumbnail?: true };
type Ready = Preview & { status: "ready"; reason?: never };
type FailureReason = "missing" | "restricted" | "tooLarge" | "invalid" | "unavailable";
type Unavailable = { status: "unavailable"; reason: FailureReason; dataUrl?: never; isThumbnail?: never };
export type ReferencedImagePreviewState = Ready | Unavailable |
  { status: "loading"; dataUrl?: never; isThumbnail?: never; reason?: never };

const loading = { status: "loading" } as const;
const unavailable = (reason: FailureReason): Unavailable => ({ status: "unavailable", reason });
const dataUrlCache = new Map<string, Ready>();
const pendingReads = new Map<string, Promise<Ready | Unavailable>>();
const DATA_URL_CACHE_ENTRIES = 50;
const DATA_URL_CACHE_MAX_BYTES = 40 * 1024 * 1024;
let dataUrlCacheBytes = 0;

function rememberDataUrl(key: string, preview: Ready) {
  const existing = dataUrlCache.get(key);
  if (existing !== undefined) {
    dataUrlCacheBytes -= existing.dataUrl.length;
    dataUrlCache.delete(key);
  }
  dataUrlCacheBytes += preview.dataUrl.length;
  dataUrlCache.set(key, preview);
  while (
    dataUrlCache.size > DATA_URL_CACHE_ENTRIES ||
    dataUrlCacheBytes > DATA_URL_CACHE_MAX_BYTES
  ) {
    const oldest = dataUrlCache.keys().next().value;
    if (oldest === undefined) break;
    const value = dataUrlCache.get(oldest);
    if (value !== undefined) dataUrlCacheBytes -= value.dataUrl.length;
    dataUrlCache.delete(oldest);
  }
}

/** Legacy projections: pending and unavailable both resolve to null. */
export function useReferencedImageDataUrl(ref: string | null | undefined, mimeType?: string): string | null {
  return useReferencedImagePreviewState(ref, mimeType).dataUrl ?? null;
}

export function useReferencedImagePreview(
  ref: string | null | undefined,
  mimeType?: string,
  allowThumbnail?: true,
): Preview | null {
  const { dataUrl, isThumbnail } = useReferencedImagePreviewState(ref, mimeType, allowThumbnail);
  return useMemo(() => dataUrl ? { dataUrl, isThumbnail } : null, [dataUrl, isThumbnail]);
}

/** Only host-contained bytes can become ready; never return a path or raw host error. */
export function useReferencedImagePreviewState(
  ref: string | null | undefined,
  mimeType?: string,
  allowThumbnail?: true,
): ReferencedImagePreviewState {
  const paneSessionId = useSlotSessionId();
  const sessionId = useAppStore((s) => paneSessionId || s.activeSessionId);
  const localToolsAllowed = useAppStore((s) => {
    const id = paneSessionId || s.activeSessionId;
    return sessionAllows(s.sessions.find((item) => item.id === id) ?? (id?.startsWith("remote:") ? { id } : undefined), "canUseLocalTools");
  });
  const workspaceRoot = useAppStore((s) => localToolsAllowed ? s.workspace?.path ?? null : null);
  const normalizedRef = typeof ref === "string" ? ref.trim() : "";
  const restricted = !localToolsAllowed || /^(?:https?|data|blob):/i.test(normalizedRef);
  const requestedKey = normalizedRef && !restricted
    ? JSON.stringify([workspaceRoot, sessionId, normalizedRef, mimeType, allowThumbnail]) : null;
  const [resolved, setResolved] = useState<{ key: string; state: Ready | Unavailable } | null>(null);
  useEffect(() => {
    const cached = requestedKey ? dataUrlCache.get(requestedKey) : undefined;
    setResolved(requestedKey && cached ? { key: requestedKey, state: cached } : null);
    if (!requestedKey || cached) return;
    let current = true;
    let pending = pendingReads.get(requestedKey);
    if (!pending) {
      pending = api.fsReadImageDataUrl(normalizedRef, mimeType, sessionId, allowThumbnail)
        .then((result): Ready | Unavailable => {
          if (result.errorCode === "PATH_OUTSIDE_ALLOWED_ROOT") return unavailable("restricted");
          switch (result.kind) {
            case "missing": return unavailable("missing");
            case "notImage": return unavailable("invalid");
            case "tooLarge": return unavailable("tooLarge");
            case "image": {
              if (!result.dataUrl || !/^data:image\/[\w.+-]+;base64,/i.test(result.dataUrl)) return unavailable("invalid");
              const ready: Ready = { status: "ready", dataUrl: result.dataUrl, isThumbnail: result.isThumbnail };
              rememberDataUrl(requestedKey, ready);
              return ready;
            }
            default: return unavailable("unavailable");
          }
        })
        .catch(() => unavailable("unavailable"))
        .finally(() => pendingReads.delete(requestedKey));
      pendingReads.set(requestedKey, pending);
    }
    void pending.then((state) => {
      if (current) setResolved({ key: requestedKey, state });
    });
    return () => { current = false; };
  }, [requestedKey, normalizedRef, mimeType, sessionId, allowThumbnail]);
  if (!requestedKey) return unavailable(restricted ? "restricted" : "missing");
  return dataUrlCache.get(requestedKey) ?? (resolved?.key === requestedKey ? resolved.state : loading);
}
