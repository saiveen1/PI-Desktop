import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";
import { IconBot } from "../../components/icons";
import { approvalIsLive, useDelegationApprovals } from "../../components/delegation-approval/useDelegationApprovals";
import { SubagentTaskList } from "../chat/transcript/SubagentTaskList";
import { SlotSessionProvider } from "../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../stores/app-store";
import { useSessionDelegations } from "./useSessionDelegations";
import "./session-delegations.css";

export function SessionDelegationsPanel() {
  const sessionId = useAppStore(state => state.activeSessionId);
  return sessionId ? <SlotSessionProvider sessionId={sessionId}>
    <SessionIndex key={sessionId} sessionId={sessionId} />
  </SlotSessionProvider> : null;
}

function SessionIndex({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const state = useSessionDelegations(sessionId);
  const approvals = useDelegationApprovals();
  const pending = approvals.requests.filter(request => request.sessionId === sessionId && approvalIsLive(request, approvals.now));
  const error = state.error || approvals.loadError;
  return <section className="session-subagents-panel" aria-label={t("subagentControls.indexTitle")}>
    <header className="session-subagents-heading">
      <IconBot size={17} /><h2>{t("subagentControls.indexTitle")}</h2>
      <Button variant="ghost" size="sm" onClick={() => { void state.reload(); void approvals.reload(); }}>
        {t("delegationHistory.refresh")}
      </Button>
    </header>
    <div className="session-subagents-scroll">
      {error ? <p role="alert">{t("delegationHistory.loadFailed")}</p> : null}
      {state.loading || approvals.loading ? <p role="status">{t("delegationHistory.loading")}</p> : null}
      {pending.length ? <section className="subagent-task-group" aria-label={t("delegationHistory.pending")}>
        <h3 className="subagent-task-group-label">{t("delegationHistory.pending")} · {pending.length}</h3>
        {pending.map(request => <div className="session-subagents-approval" key={request.requestId}>
          <span>{request.description || request.agentName || t("chat.subagentUnnamed")}</span>
          <Button variant="ghost" size="sm" onClick={() => {
            if (!approvalIsLive(request, Date.now())) return;
            window.dispatchEvent(new CustomEvent("pi-desktop:notification-target", { detail: {
              kind: "delegation-approval", sessionId, requestId: request.requestId, revision: request.revision,
            } }));
          }}>{t("delegationHistory.viewApproval")}</Button>
        </div>)}
      </section> : null}
      <SubagentTaskList grouped items={state.tasks} delegationStatuses={state.statuses} />
      {!state.loading && !approvals.loading && !error && !state.total && !pending.length
        ? <p className="session-subagents-empty">{t("subagentControls.emptySession")}</p> : null}
    </div>
  </section>;
}
