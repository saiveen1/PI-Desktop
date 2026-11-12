import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";
import { IconBot } from "../../components/icons";
import { approvalIsLive, useDelegationApprovals } from "../../components/delegation-approval/useDelegationApprovals";
import { useChatSessionCapability } from "../../hooks/use-chat-session-capability";
import { subagentsWorkPanelTab } from "../../lib/work-panel-tabs";
import { useAppStore } from "../../stores/app-store";
import { useSessionDelegations } from "./useSessionDelegations";
import "./session-delegations.css";

export function SessionDelegationsButton() {
  const sessionId = useAppStore(state => state.activeSessionId);
  const local = useChatSessionCapability("canUseLocalTools");
  return sessionId && local ? <SessionButton key={sessionId} sessionId={sessionId} /> : null;
}

function SessionButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const state = useSessionDelegations(sessionId);
  const approvals = useDelegationApprovals();
  const pending = approvals.requests.filter(request => request.sessionId === sessionId && approvalIsLive(request, approvals.now)).length;
  const open = useAppStore(store => store.openWorkPanelTabForSession);
  const selected = useAppStore(store => store.workPanelOpen && store.activeWorkPanelTabId === "subagents");
  const parts: string[] = [];
  if (state.active) parts.push(t("subagentControls.runningCount", { count: state.active }));
  if (pending) parts.push(t("subagentControls.pendingCount", { count: pending }));
  else if (state.starting) parts.push(t("subagentControls.startingCount", { count: state.starting }));
  if (state.attention) parts.push(`${t("chat.taskGroups.attention")} ${state.attention}`);
  if (state.error || approvals.loadError) parts.push(t("subagentControls.statusUnavailable"));
  else if (!parts.length && (state.loading || approvals.loading)) parts.push(t("subagentControls.loading"));
  else if (!parts.length && state.total) parts.push(t("subagentControls.historyCount", { count: state.total }));
  const summary = parts.join(" · ");
  const label = [t("subagentControls.indexLabel"), summary].filter(Boolean).join(" · ");
  return <Button variant="ghost" size="sm" className="session-subagents-button no-drag"
    data-active={state.active > 0 || state.starting > 0} data-attention={pending > 0 || state.attention > 0 || state.error || approvals.loadError}
    aria-label={label} title={label} aria-pressed={selected}
    onClick={() => open(sessionId, subagentsWorkPanelTab())}>
    <IconBot size={15} />
    <span className="session-subagents-label">{t("subagentControls.indexLabel")}</span>
    {summary ? <span className="session-subagents-summary" role="status">{summary}</span> : null}
  </Button>;
}
