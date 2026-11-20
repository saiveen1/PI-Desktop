import { useTranslation } from "react-i18next";
import { IconDownload } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { useChatNativeFilesAllowed } from "../../../hooks/use-chat-session-capability";
import { api } from "../../../lib/api";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../../stores/app-store";
import { generatedImageDownloadName } from "./generated-image-download";

export function ImageDownload({ src, index, originalPath }: { src?: string | null; index: number; originalPath?: string }) {
  const { t } = useTranslation();
  const paneSessionId = useSlotSessionId();
  const sessionId = useAppStore((state) => paneSessionId || state.activeSessionId);
  const nativeFilesAllowed = useChatNativeFilesAllowed();
  const label = t("settings.downloadGeneratedImage");
  if (originalPath) {
    return nativeFilesAllowed ? <TooltipButton type="button" tooltip={label} onClick={() => {
      void api.fsSaveAs(originalPath, sessionId).catch(() => {
        useAppStore.getState().showToast(t("chat.fileActionFailed"), { variant: "error" });
      });
    }}><IconDownload size={18} /></TooltipButton> : null;
  }
  const name = generatedImageDownloadName(src ?? null, index);
  return src && name ? <a href={src} download={name} aria-label={label} title={label}><IconDownload size={18} /></a> : null;
}
