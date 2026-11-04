import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { sessionAllows } from "../lib/remote-session-safety";
import { useSlotSessionId } from "../plugins/renderer-slots/use-slots";
import { useAppStore } from "../stores/app-store";
import { useChatNativeFilesAllowed } from "./use-chat-session-capability";
import { useResolveChatFileRef } from "./use-preview-target";

export type ChatFileAction = "open-default" | "save-as" | "copy-content" | "reveal";

/** Native actions share reference completion and never follow a changed session. */
export function useChatFileAction() {
  const { t } = useTranslation();
  const paneSessionId = useSlotSessionId();
  const sessionId = useAppStore((state) => paneSessionId || state.activeSessionId);
  const workspacePath = useAppStore((state) => state.workspace?.path ?? null);
  const nativeFilesAllowed = useChatNativeFilesAllowed();
  const resolveRef = useResolveChatFileRef();
  const showToast = useAppStore((state) => state.showToast);

  return useCallback(async (action: ChatFileAction, path: string, baseDir?: string) => {
    const isCurrent = () => {
      const state = useAppStore.getState();
      const session = state.sessions.find((item) => item.id === sessionId);
      return nativeFilesAllowed && state.activeSessionId === sessionId
        && (state.workspace?.path ?? null) === workspacePath
        && !session?.remoteWorkspace && !state.workspace?.remote
        && sessionAllows(session ?? (sessionId?.startsWith("remote:") ? { id: sessionId } : undefined), "canUseLocalTools");
    };
    if (!isCurrent()) return;
    try {
      const resolved = await resolveRef(path, baseDir);
      if (!resolved || !isCurrent()) return;
      switch (action) {
        case "open-default":
          await api.fsOpen(resolved.absolutePath, undefined, sessionId);
          break;
        case "reveal":
          await api.fsReveal(resolved.absolutePath, sessionId);
          break;
        case "save-as": {
          const result = await api.fsSaveAs(resolved.absolutePath, sessionId);
          if (!result.canceled && isCurrent()) {
            showToast(t("chat.fileSaved"), { variant: "success" });
          }
          break;
        }
        case "copy-content": {
          const result = await api.fsRead(resolved.absolutePath, undefined, sessionId);
          if (!isCurrent()) return;
          if (result.kind !== "text" || typeof result.content !== "string") {
            showToast(t("chat.fileContentsUnavailable"), { variant: "error" });
            return;
          }
          await navigator.clipboard.writeText(result.content);
          if (isCurrent()) showToast(t("chat.copied"), { variant: "success" });
          break;
        }
      }
    } catch {
      if (isCurrent()) showToast(t("chat.fileActionFailed"), { variant: "error" });
    }
  }, [nativeFilesAllowed, resolveRef, sessionId, showToast, t, workspacePath]);
}
