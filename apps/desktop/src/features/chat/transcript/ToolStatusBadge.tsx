import { useTranslation } from "react-i18next";
import { Tooltip } from "../../../components/ui";
import { IconCircleAlert, IconStop } from "../../../components/icons";
import type { ToolStatusPresentation } from "../../../lib/tool-status";

/** Shared status treatment for command and ordinary tool rows. */
export function ToolStatusBadge({ status, label, runHead }: {
  status: ToolStatusPresentation;
  label: string;
  runHead: boolean;
}) {
  const { t } = useTranslation();
  if (!runHead && (status.kind === "running" || status.kind === "success" || status.kind === "unknown")) {
    return <>
      {status.kind === "running" ? <span className="tool-spinner" aria-label={label} /> : null}
      <span className="sr-only" role="status" aria-live="polite">{label}</span>
    </>;
  }
  if (!label) return null;
  const reason = status.reasonKey ? t(status.reasonKey, { code: status.exitCode }) : undefined;
  const description = [reason, status.detail].filter(Boolean).join("\n") || label;
  const statusTone = status.kind === "running" ? "is-running"
    : status.kind === "failed" ? "is-error"
    : status.kind === "success" ? "is-done" : "is-neutral";
  return (
    <Tooltip
      label={description}
      className={runHead ? `tool-row-state ${statusTone}` : `tool-row-status${status.kind === "failed" ? " error" : ""}`}
    >
      <span className="tool-status-content" role="status" aria-live="polite" aria-label={description === label ? label : `${label}: ${description}`}>
        {runHead ? <span className="tool-row-state-dot" aria-hidden />
          : status.kind === "failed" ? <IconCircleAlert size={13} />
          : status.kind === "skipped" || status.kind === "interrupted" ? <IconStop size={12} /> : null}
        {label}
      </span>
    </Tooltip>
  );
}
