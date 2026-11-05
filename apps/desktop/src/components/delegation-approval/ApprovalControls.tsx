import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DelegationApprovalPrompt } from "@pi-desktop/shared";
import { Button, Select } from "../ui";
import { approvalIsLive, approvalKey, type useDelegationApprovals } from "./useDelegationApprovals";

export type ApprovalState = ReturnType<typeof useDelegationApprovals>;
export const modelKey = (model: { providerId: string; modelId: string }) => JSON.stringify([model.providerId, model.modelId]);

export function ApprovalMetadata({ request, now, compact = false }: { request: DelegationApprovalPrompt; now: number; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const deadline = new Date(request.expiresAt);
  return <dl className="delegation-metadata">
    <div><dt>{t("delegationApproval.actualModel")}</dt><dd>{request.candidate.providerName} / {request.candidate.modelLabel ?? request.candidate.modelId}
      {request.candidate.providerName !== request.candidate.providerId || request.candidate.modelLabel !== request.candidate.modelId ? <small>{request.candidate.providerId} / {request.candidate.modelId}</small> : null}</dd></div>
    {!compact && request.requestedModel && request.requestedModel !== request.candidate.modelId && request.requestedModel !== `${request.candidate.providerId}/${request.candidate.modelId}` ?
      <div><dt>{t("delegationApproval.requestedModel")}</dt><dd>{request.requestedModel}</dd></div> : null}
    {!compact && request.modelReason ? <div><dt>{t("delegationApproval.reason")}</dt><dd>{request.modelReason}</dd></div> : null}
    {!compact && request.schedulingReason ? <div><dt>{t("delegationApproval.schedulingReason")}</dt><dd>{request.schedulingReason}</dd></div> : null}
    {!compact && request.candidate.thinkingLevel ? <div><dt>{t("delegationApproval.thinking")}</dt><dd>{request.candidate.thinkingLevel === "max" ? t("delegationApproval.maxThinking") : request.candidate.thinkingLevel === "omit" ? t("delegationApproval.defaultThinking") : t(`delegationApproval.thinkingLevels.${request.candidate.thinkingLevel}`)}</dd></div> : null}
    <div><dt>{t("delegationApproval.deadline")}</dt><dd><time dateTime={request.expiresAt}>{deadline.toLocaleTimeString(i18n.language)}</time>
      <span className={!approvalIsLive(request, now) ? "delegation-warning" : ""}> · {request.status !== "pending" ? t(`delegationApproval.feedback.${request.status}`) :
        Date.parse(request.expiresAt) <= now ? t("delegationApproval.feedback.expired") : t("delegationApproval.secondsLeft", { count: Math.ceil((Date.parse(request.expiresAt) - now) / 1000) })}</span></dd></div>
  </dl>;
}

/** Each exact target requires a separate explicit confirmation; there is no default model. */
export function ApprovalControls({ request, state }: { request: DelegationApprovalPrompt; state: ApprovalState }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState("");
  const key = approvalKey(request);
  const sending = state.feedback[key]?.state === "sending";
  const disabled = sending || !approvalIsLive(request, state.now);
  const identity = { requestId: request.requestId, sessionId: request.sessionId, revision: request.revision };
  const chosen = request.candidates.find((candidate) => modelKey(candidate) === target);
  return <div className="delegation-controls" aria-busy={sending}>
    <div className="delegation-row-actions">
      <Button size="sm" variant="primary" disabled={disabled} onClick={() => void state.send(request, { ...identity, action: "allow" })}>{t("delegationApproval.allowOnce")}</Button>
      <Button size="sm" disabled={disabled} onClick={() => void state.send(request, { ...identity, action: "skip" })}>{t("delegationApproval.skip")}</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void state.send(request, { ...identity, action: "cancel" })}>{t("delegationApproval.cancel")}</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void state.send(request, "extend")}>{t("delegationApproval.extend")}</Button>
    </div>
    <div className="delegation-model-picker">
      <Select aria-label={t("delegationApproval.chooseModel")} value={target} disabled={disabled} onChange={(event) => setTarget(event.target.value)}>
        <option value="">{t("delegationApproval.chooseModel")}</option>
        {request.candidates.map((candidate) => <option key={modelKey(candidate)} value={modelKey(candidate)}>{candidate.providerName} ({candidate.providerId}) / {candidate.modelId}</option>)}
      </Select>
      <Button size="sm" disabled={disabled || !chosen} onClick={() => {
        if (chosen) void state.send(request, { ...identity, action: "select", providerId: chosen.providerId, modelId: chosen.modelId });
      }}>{t("delegationApproval.confirmModel")}</Button>
    </div>
    {chosen ? <p className="delegation-confirm-target">{t("delegationApproval.confirmTarget", { provider: `${chosen.providerName} (${chosen.providerId})`, model: chosen.modelId })}</p> : null}
    {state.feedback[key] ? <p className={`delegation-feedback ${state.feedback[key].state}`} role={state.feedback[key].state === "error" ? "alert" : "status"}>
      {t(`delegationApproval.feedback.${state.feedback[key].message}`)}
    </p> : null}
  </div>;
}
