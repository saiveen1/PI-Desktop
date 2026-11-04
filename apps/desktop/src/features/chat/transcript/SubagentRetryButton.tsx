import { useChatSessionCapability } from "../../../hooks/use-chat-session-capability";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { Button, TooltipButton } from "../../../components/ui";
import { IconReview } from "../../../components/icons";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";

const useRetries = create<{
  busy: Record<string, string | undefined>;
}>(() => ({ busy: {} }));

export function SubagentRetryButton({
  delegationId,
  failed,
  compact = false,
}: {
  delegationId: string;
  failed: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const paneSessionId = useSlotSessionId();
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const sessionId = useAppStore(state => paneSessionId || state.activeSessionId);
  const source = useAppStore(state => state.sessions.find(session => session.id === state.activeSessionId)?.source);
  const busy = useRetries(state => sessionId ? state.busy[sessionId] : undefined);
  const retrying = busy === delegationId;

  if (!failed || !localToolsAllowed || !sessionId || source === "remote" || source === "pi-native") {
    return null;
  }

  const retry = async () => {
    if (useRetries.getState().busy[sessionId]) return;
    useRetries.setState(state => ({ busy: { ...state.busy, [sessionId]: delegationId } }));
    try {
      const result = await api.retrySubagent({ sessionId, delegationId });
      if (!result.accepted) {
        useAppStore.getState().showToast(result.error ?? t("chat.toolFailed"), { variant: "error" });
      }
    } catch (error) {
      useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      useRetries.setState(state => {
        const busy = { ...state.busy };
        delete busy[sessionId];
        return { busy };
      });
    }
  };

  const label = retrying ? t("chat.running") : t("chat.retry");
  if (compact) {
    return (
      <TooltipButton
        type="button"
        className="copy-btn icon"
        tooltip={label}
        ariaLabel={label}
        disabled={!!busy}
        onClick={() => void retry()}
      >
        {retrying ? <span className="tool-spinner" aria-hidden /> : <IconReview size={13} />}
      </TooltipButton>
    );
  }
  return (
    <Button
      className="subagent-retry-button"
      variant="secondary"
      size="sm"
      title={label}
      aria-label={label}
      disabled={!!busy}
      onClick={() => void retry()}
    >
      {retrying ? <span className="tool-spinner" aria-hidden /> : <IconReview size={10} />}
      <span>{label}</span>
    </Button>
  );
}
