import { useEffect, useState } from "react";
import { sessionAllows } from "./remote-session-safety";
import { useSlotSessionId } from "../plugins/renderer-slots/use-slots";
import { api } from "./api";
import { useAppStore } from "../stores/app-store";

/**
 * Module-level cache so revisiting the same message does not re-read the
 * file. The key includes workspace and MIME context so a reference cannot
 * show stale bytes after a project or selected image changes.
 */
type Preview = { dataUrl: string; isThumbnail?: true };
const dataUrlCache = new Map<string, Preview>();
const pendingReads = new Map<string, Promise<Preview | null>>();
const DATA_URL_CACHE_ENTRIES = 50;
const DATA_URL_CACHE_MAX_BYTES = 40 * 1024 * 1024;
let dataUrlCacheBytes = 0;

function cacheKey(workspaceRoot: string | null, ref: string, mimeType?: string): string {
  return `${workspaceRoot ?? ""}\u0000${ref}\u0000${mimeType ?? ""}`;
}

function rememberDataUrl(key: string, preview: Preview) {
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

/**
 * Load a contained image ref into a bounded data URL. Host containment
 * (workspace, scratch, attachments) is the gate; failures resolve to null.
 */
export function useReferencedImageDataUrl(
  ref: string | null | undefined,
  mimeType?: string,
): string | null {
  return useReferencedImagePreview(ref, mimeType)?.dataUrl ?? null;
}

export function useReferencedImagePreview(
  ref: string | null | undefined,
  mimeType?: string,
  allowThumbnail?: true,
): Preview | null {
  const paneSessionId = useSlotSessionId();
  const sessionId = useAppStore((s) => paneSessionId || s.activeSessionId);
  const localToolsAllowed = useAppStore((s) => {
    const id = paneSessionId || s.activeSessionId;
    return sessionAllows(s.sessions.find((item) => item.id === id) ?? (id?.startsWith("remote:") ? { id } : undefined), "canUseLocalTools");
  });
  const workspaceRoot = useAppStore((s) => localToolsAllowed ? s.workspace?.path ?? null : null);
  const normalizedRef = typeof ref === "string" ? ref.trim() : "";
  const requestedKey = localToolsAllowed && normalizedRef && !/^(?:https?|data|blob):/i.test(normalizedRef)
    ? cacheKey(sessionId ? `${workspaceRoot ?? ""}:${sessionId}` : workspaceRoot, normalizedRef, mimeType) + (allowThumbnail ? "\u0000thumbnail" : "")
    : null;
  const [resolved, setResolved] = useState<{ key: string; preview: Preview | null }>({
    key: "", preview: null,
  });
  useEffect(() => {
    if (!requestedKey) {
      setResolved({ key: "", preview: null });
      return;
    }
    const cached = dataUrlCache.get(requestedKey);
    if (cached !== undefined) {
      setResolved({ key: requestedKey, preview: cached });
      return;
    }
    let current = true;
    setResolved({ key: requestedKey, preview: null });
    let pending = pendingReads.get(requestedKey);
    if (!pending) {
      pending = api.fsReadImageDataUrl(normalizedRef, mimeType, sessionId, allowThumbnail)
        .then((result) => {
          if (result.kind !== "image" || !result.dataUrl) return null;
          const preview = { dataUrl: result.dataUrl, isThumbnail: result.isThumbnail };
          rememberDataUrl(requestedKey, preview);
          return preview;
        })
        .catch(() => null)
        .finally(() => pendingReads.delete(requestedKey));
      pendingReads.set(requestedKey, pending);
    }
    void pending.then((preview) => {
      if (current) setResolved({ key: requestedKey, preview });
    });
    return () => {
      current = false;
    };
  }, [requestedKey, normalizedRef, mimeType, sessionId, allowThumbnail]);
  if (!requestedKey) return null;
  const cached = dataUrlCache.get(requestedKey);
  return cached ?? (resolved.key === requestedKey ? resolved.preview : null);
}
