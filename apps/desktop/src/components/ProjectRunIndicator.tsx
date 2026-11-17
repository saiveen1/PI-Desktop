import { useTranslation } from "react-i18next";
import type { ProjectRunSummary } from "../lib/sidebar-project-runs";
import { projectRunSummaryIsLive } from "../lib/sidebar-project-runs";
import { IconActivity, IconCheck, IconClock, IconClose } from "./icons";
import "../styles/session-organization.css";

/**
 * The two project-level "work is running under here" affordances (D-sidebar).
 *
 * Both live on the project group *header*, not on the session rows: a
 * collapsed group folds its body to `0fr` and marks it `inert`, so a
 * row-level status dot disappears exactly when the answer is most useful.
 * The header stays visible in both states.
 *
 * Theme tokens distinguish running, needs-action, completed, and failed.
 * Motion is decorative and is dropped under `prefers-reduced-motion`.
 */

function runLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  summary: ProjectRunSummary,
): string {
  const parts: string[] = [];
  if (summary.running > 0) parts.push(t("nav.projectRunningCount", { count: summary.running }));
  if (summary.waiting > 0) parts.push(t("nav.projectNeedsActionCount", { count: summary.waiting, defaultValue: "{{count}} need action" }));
  if (summary.completed > 0) parts.push(t("nav.projectCompletedCount", { count: summary.completed, defaultValue: "{{count}} completed" }));
  if (summary.failed > 0) parts.push(t("nav.projectFailedCount", { count: summary.failed, defaultValue: "{{count}} failed" }));
  return parts.join(" · ");
}

/** Badge (A): a separate count capsule for each state. */
export function ProjectRunBadge({ summary }: { summary: ProjectRunSummary }) {
  const { t } = useTranslation();
  if (!projectRunSummaryIsLive(summary)) return null;
  const label = runLabel(t, summary);
  return (
    <span className="project-run-badges">
      {summary.running > 0 ? (
        <span className="project-run-badge running" aria-label={label} title={label}>
          <span className="project-run-badge-dot" aria-hidden />
          {summary.running}
        </span>
      ) : null}
      {summary.waiting > 0 ? (
        <span className="project-run-badge waiting" aria-label={label} title={label}>
          <span className="project-run-badge-dot" aria-hidden />
          {summary.waiting}
        </span>
      ) : null}
      {summary.completed > 0 ? <span className="project-run-badge completed" aria-label={label} title={label}><span className="project-run-badge-dot" aria-hidden />{summary.completed}</span> : null}
      {summary.failed > 0 ? <span className="project-run-badge failed" aria-label={label} title={label}><span className="project-run-badge-dot" aria-hidden />{summary.failed}</span> : null}
    </span>
  );
}

/**
 * Activity rail (B): a 2px track down the group's left edge with a comet
 * pulse travelling along it. Rendered as a sibling of the header inside the
 * group so it spans the opened body too, and pinned to the header height
 * while the group is collapsed.
 */
export function ProjectRunRail({ summary }: { summary: ProjectRunSummary }) {
  const { t } = useTranslation();
  if (summary.running === 0 && summary.waiting === 0) return null;
  const label = runLabel(t, summary);
  return (
    <span className="project-run-rail" aria-label={label} role="img">
      <span className="project-run-rail-pulse" aria-hidden />
    </span>
  );
}

/**
 * The "n" figure that accompanies the rail: a coloured pip per kind, so the
 * colour ties the number to its meaning instead of leaving a bare count.
 *
 * It is the badge's stand-in, not an addition to it: callers gate it on
 * `railCount`, so it appears only while the badge is switched off and the same
 * figure never renders twice on one header.
 */
export function ProjectRunCount({ summary }: { summary: ProjectRunSummary }) {
  const { t } = useTranslation();
  if (!projectRunSummaryIsLive(summary)) return null;
  const label = runLabel(t, summary);
  return (
    <span className="project-run-count" aria-label={label} title={label}>
      {summary.running > 0 ? (
        <span className="project-run-pip running">{summary.running}</span>
      ) : null}
      {summary.waiting > 0 ? (
        <span className="project-run-pip waiting">{summary.waiting}</span>
      ) : null}
      {summary.completed > 0 ? <span className="project-run-pip completed">{summary.completed}</span> : null}
      {summary.failed > 0 ? <span className="project-run-pip failed">{summary.failed}</span> : null}
    </span>
  );
}

/** Compact status and total for session-group and pinned headers. */
export function GroupRunStatus({ summary }: { summary: ProjectRunSummary }) {
  const { t } = useTranslation();
  const label = [runLabel(t, summary), t("nav.groupTotalCount", { count: summary.total, defaultValue: "{{count}} total" })].filter(Boolean).join(" · ");
  const items = [
    { key: "running", count: summary.running, Icon: IconActivity },
    { key: "waiting", count: summary.waiting, Icon: IconClock },
    { key: "completed", count: summary.completed, Icon: IconCheck },
    { key: "failed", count: summary.failed, Icon: IconClose },
  ];
  return <span className="group-run-status" role="img" aria-label={label} title={label}>
    {items.map(({ key, count, Icon }) => count > 0 ? <span key={key} className={`group-run-status-item ${key}`} aria-hidden="true"><Icon size={11} />{count}</span> : null)}
    <span className="sidebar-conversation-group-count" aria-hidden="true">{summary.total}</span>
  </span>;
}
