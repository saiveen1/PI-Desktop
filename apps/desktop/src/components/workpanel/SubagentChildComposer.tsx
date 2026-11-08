import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { sessionAllows } from "../../lib/remote-session-safety";
import type { SubagentOutcome } from "../../lib/subagent-topology";
import { useAppStore } from "../../stores/app-store";
import { Button, Textarea } from "../ui";
import { CHILD_MESSAGE_LIMIT, childMessageOwner, childMessages } from "./child-message-controller";

export function SubagentChildComposer({ sessionId, chainId, delegationId, outcome, children }: {
  sessionId: string;
  chainId: string;
  delegationId?: string;
  outcome?: SubagentOutcome;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const session = useAppStore(state => state.sessions.find(item => item.id === sessionId));
  const allowed = !!sessionId && !sessionId.startsWith("remote:") && session?.source !== "remote"
    && session?.source !== "pi-native" && sessionAllows(session, "canUseLocalTools");
  const owner = childMessageOwner(sessionId, chainId);
  const currentOwner = useRef<string | null>(owner);
  currentOwner.current = owner;
  useEffect(() => {
    currentOwner.current = owner;
    return () => { currentOwner.current = null; };
  }, [owner]);
  const draft = useSyncExternalStore(childMessages.subscribe, () => childMessages.get(owner), () => childMessages.get(owner));
  const tooLong = draft.content.length > CHILD_MESSAGE_LIMIT;
  const send = () => {
    if (!allowed || !delegationId) return;
    void childMessages.send(owner, { sessionId, delegationId }, request => api.sendSubagentMessage(request),
      () => currentOwner.current === owner && useAppStore.getState().activeSessionId === sessionId);
  };
  return (
    <footer className="subagent-transcript-composer" aria-busy={draft.pending}>
      <Textarea rows={2} maxLength={CHILD_MESSAGE_LIMIT} disabled={!allowed || !delegationId}
        aria-label={t("subagentControls.composer")} placeholder={t(allowed ? "subagentControls.composer" : "subagentControls.unsupported")}
        aria-invalid={tooLong} value={draft.content}
        onChange={event => childMessages.edit(owner, event.target.value)} />
      {!allowed ? <p className="text-xs text-text-secondary">{t("subagentControls.unsupported")}</p> : null}
      {tooLong ? <p role="alert" className="text-xs text-text-secondary">{t("subagentControls.tooLong")}</p> : null}
      {draft.error ? <p role="alert" className="text-xs text-text-secondary">{t("subagentControls.sendFailed", { error: draft.error })}</p> : null}
      <div className="subagent-transcript-composer-controls">
        {children}
        <Button variant="primary" size="sm" disabled={!allowed || !delegationId || draft.pending || tooLong || !draft.content.trim()}
          onClick={send}>
          {t(draft.pending ? "subagentControls.sending" : outcome === "running" ? "subagentControls.send"
            : outcome === "completed" ? "subagentControls.continue" : "subagentControls.resume")}
        </Button>
      </div>
    </footer>
  );
}
