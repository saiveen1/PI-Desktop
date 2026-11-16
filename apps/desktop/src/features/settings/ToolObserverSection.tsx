import { useEffect, useReducer, useState, type Dispatch } from "react";
import { useTranslation } from "react-i18next";
import type { ToolObservationGroup, ToolObservationQuery } from "@pi-desktop/shared";
import { Button, Badge, SegmentedControl } from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "./primitives";
import {
  TOOL_OBSERVER_OUTCOMES, initialToolObserverState, readToolObserverReport,
  toolObserverReducer, type ToolObserverAction, type ToolObserverState,
} from "./tool-observer-report";
import {
  TOOL_OBSERVER_EXAMPLE_LIMIT, canReferenceToolObservations, referenceToolObservationGroup,
  toolObserverExample, toolObserverLabel, toolObserverTarget,
} from "./tool-observer-reference";

function ObservationDetails({ values }: { values: Record<string, string | number | boolean | undefined> }) {
  const { t } = useTranslation();
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs-plus">
      {Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-text-muted">{t(`toolObserver.fields.${key}`)}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-all select-text">
            {key === "outcome" ? t(`toolObserver.outcomes.${value}`)
              : typeof value === "boolean" ? t(value ? "toolObserver.yes" : "toolObserver.no") : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Presentational boundary also exercised by the offline React interaction fixture. */
export function ToolObserverResults({ state, dispatch, canReference, onReference }: {
  state: ToolObserverState;
  dispatch: Dispatch<ToolObserverAction>;
  canReference: boolean;
  onReference: (group: ToolObservationGroup) => void;
}) {
  const { t } = useTranslation();
  if (state.status === "loading") return <p role="status" className="p-4 text-sm text-text-muted">{t("toolObserver.loading")}</p>;
  if (state.status === "error") return <p role="alert" className="p-4 text-sm">{t("toolObserver.error")}</p>;
  const report = state.report;
  if (!report) return null;
  const groups = report.groups.filter((group) => group.outcome !== "success").slice(0, 100);
  const selected = groups.find((group) => group.id === state.selectedId);
  return (
    <>
      <div className="space-y-3 p-4" aria-live="polite">
        <p className="text-sm">{t("toolObserver.total", { total: report.total })}</p>
        <div className="flex flex-wrap gap-2">
          {TOOL_OBSERVER_OUTCOMES.map((outcome) => (
            <Badge key={outcome}>{t(`toolObserver.outcomes.${outcome}`)}: {report.counts[outcome]}</Badge>
          ))}
        </div>
        <p className="text-xs-plus text-text-muted select-text">{t("toolObserver.window", { since: report.since, generatedAt: report.generatedAt })}</p>
        <p className="text-xs-plus text-text-muted">{t("toolObserver.coverage", {
          files: report.coverage.filesRead, malformed: report.coverage.malformedLines,
          legacy: report.coverage.ignoredLegacyRecords, errors: report.coverage.readErrors,
        })}</p>
        {report.coverage.limited ? <p role="status" className="text-xs-plus">{t("toolObserver.limited")}</p> : null}
        <p className="text-xs-plus text-text-muted">{t("toolObserver.uncertainty")}</p>
        {report.total === 0 ? <p role="status" className="text-sm">{t("toolObserver.empty")}</p>
          : groups.length === 0 ? <p role="status" className="text-sm">{t("toolObserver.noGroups")}</p> : null}
      </div>
      {groups.length > 0 ? (
        <SettingsRow title={t("toolObserver.groups")} description={t("toolObserver.groupsHint")}>
          <SettingsMenuSelect
            label={t("toolObserver.groups")}
            value={selected?.id ?? ""}
            options={[
              { id: "", label: t("toolObserver.selectGroup"), disabled: true },
              ...groups.map((group) => ({ id: group.id, label: t("toolObserver.groupLabel", {
                tool: toolObserverLabel(group.toolName), outcome: t(`toolObserver.outcomes.${group.outcome}`), count: group.count,
              }) })),
            ]}
            onChange={(id) => dispatch({ type: "select", scope: state.scope, id })}
          />
        </SettingsRow>
      ) : null}
      {selected ? (
        <div className="space-y-4 p-4">
          <ObservationDetails values={{
            id: toolObserverLabel(selected.id), toolName: toolObserverLabel(selected.toolName), outcome: selected.outcome,
            desktopPlatform: toolObserverLabel(selected.desktopPlatform), appVersion: toolObserverLabel(selected.appVersion),
            shellId: toolObserverLabel(selected.shellId), errorCode: toolObserverLabel(selected.errorCode), exitCode: selected.exitCode,
            count: selected.count, sessionCount: selected.sessionCount, firstSeen: selected.firstSeen, lastSeen: selected.lastSeen,
          }} />
          <p className="text-xs-plus text-text-muted">{t("toolObserver.platformHint")}</p>
          <h4 className="text-sm font-medium">{t("toolObserver.examples")}</h4>
          {selected.examples.slice(0, TOOL_OBSERVER_EXAMPLE_LIMIT).map((example, index) => (
            <ObservationDetails key={`${example.id}:${index}`} values={toolObserverExample(example)} />
          ))}
          <p className="text-xs-plus text-text-muted">{t("toolObserver.examplesHint")}</p>
          <Button variant="secondary" disabled={!canReference} onClick={() => onReference(selected)}>
            {t("toolObserver.reference")}
          </Button>
          <p className="text-xs-plus text-text-muted">{t(canReference ? "toolObserver.referenceHint" : "toolObserver.referenceDisabled")}</p>
        </div>
      ) : null}
    </>
  );
}

export function ToolObserverSection() {
  const { t } = useTranslation();
  const enabled = useAppStore((state) => state.settings?.developerMode === true);
  const target = useAppStore(toolObserverTarget);
  const canReference = useAppStore((state) => canReferenceToolObservations(state, target));
  const [period, setPeriod] = useState<"1" | "7" | "30">("7");
  const days: ToolObservationQuery["days"] = period === "1" ? 1 : period === "7" ? 7 : 30;
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  const scope = JSON.stringify([target, days, revision, enabled]);
  const [state, dispatch] = useReducer(toolObserverReducer, scope, initialToolObserverState);
  // Hide the old report in the render that changes ownership, before effects clean up.
  const visible = state.scope === scope ? state : initialToolObserverState(scope);

  useEffect(() => {
    if (!enabled) return;
    return readToolObserverReport((query) => api.getToolObservations(query), { days }, scope, dispatch);
  }, [enabled, days, scope]);

  if (!enabled) return null;
  return (
    <SettingsCard title={t("toolObserver.title")} caption={t("toolObserver.description")}
      action={<Button variant="secondary" disabled={visible.status === "loading"} onClick={refresh}>{t("toolObserver.refresh")}</Button>}>
      <SettingsRow title={t("toolObserver.period")}>
        <SegmentedControl value={period} onChange={setPeriod} label={t("toolObserver.period")}
          options={(["1", "7", "30"] as const).map((value) => ({ value,
            label: t(value === "1" ? "toolObserver.day" : "toolObserver.days", { days: value }),
          }))} />
      </SettingsRow>
      <ToolObserverResults state={visible} dispatch={dispatch} canReference={canReference}
        onReference={(group) => {
          if (!visible.report || !referenceToolObservationGroup(target, visible.report, group, {
            title: t("toolObserver.referenceTitle"), request: t("toolObserver.referenceRequest"),
          })) {
            useAppStore.getState().showToast(t("toolObserver.referenceNotAdded"), { variant: "info" });
          }
        }} />
    </SettingsCard>
  );
}
