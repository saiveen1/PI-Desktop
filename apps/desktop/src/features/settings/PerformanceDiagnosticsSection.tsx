import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PerformanceSnapshot } from "@pi-desktop/shared";
import { Badge, Button } from "../../components/ui";
import { SettingsCard } from "./primitives";
import { usePerformanceDiagnostics } from "./use-performance-diagnostics";
import "./performance-diagnostics.css";

function ProcessTable({ snapshot }: { snapshot: PerformanceSnapshot | null }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const date = (time: number) => new Date(time).toLocaleString(locale);
  const metric = (value: number | null, divisor = 1) => value == null || !Number.isFinite(value)
    ? t("performanceDiagnostics.unavailable")
    : (value / divisor).toLocaleString(locale, { maximumFractionDigits: 1 });
  if (!snapshot || snapshot.processes.length === 0) {
    return <>
      {snapshot?.truncated ? <p role="status" className="performance-note">{t("performanceDiagnostics.truncated")}</p> : null}
      <p role="status" className="performance-note">{t("performanceDiagnostics.empty")}</p>
    </>;
  }
  return (
    <>
      <p className="performance-note">{t("performanceDiagnostics.snapshotTime", { time: date(snapshot.at) })}</p>
      {snapshot.truncated ? <p role="status" className="performance-note">{t("performanceDiagnostics.truncated")}</p> : null}
      <table className="performance-table">
        <caption className="performance-sr-only">{t("performanceDiagnostics.processTable")}</caption>
        <colgroup><col className="performance-process-column" /><col /><col /><col /></colgroup>
        <thead><tr>
          <th scope="col">{t("performanceDiagnostics.process")}</th>
          <th scope="col">{t("performanceDiagnostics.cpu")}</th>
          <th scope="col">{t("performanceDiagnostics.workingSet")}</th>
          <th scope="col">{t("performanceDiagnostics.privateMemory")}</th>
        </tr></thead>
        <tbody>{snapshot.processes.map((row) => (
          <tr key={`${row.pid}:${row.startedAt ?? "unknown"}`}>
            <th scope="row">
              <span className="performance-process-name">{t(`performanceDiagnostics.roles.${row.role}`)}</span>
              <span className="performance-process-detail">{t("performanceDiagnostics.pid", { pid: row.pid })}</span>
              {row.owner ? <span className="performance-process-detail">{t("performanceDiagnostics.owner", { owner: row.owner })}</span> : null}
              {row.startedAt != null ? <span className="performance-process-detail">{t("performanceDiagnostics.processStarted", { time: date(row.startedAt) })}</span> : null}
            </th>
            <td>{metric(row.cpuPercent)}</td>
            <td>{metric(row.workingSetKiB, 1024)}</td>
            <td>{metric(row.privateKiB, 1024)}</td>
          </tr>
        ))}</tbody>
      </table>
    </>
  );
}

function DiagnosticsContent() {
  const { t, i18n } = useTranslation();
  const { data, busy, error, preview, saveResult, request } = usePerformanceDiagnostics();
  const stopRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLButtonElement>(null);
  const nextFocus = useRef<"stop" | "preview" | null>(null);
  const recordingFocus = useRef(false);
  useEffect(() => {
    if (busy) return;
    const target = nextFocus.current === "stop" ? stopRef.current
      : nextFocus.current === "preview" || (data?.phase === "complete" && recordingFocus.current) ? previewRef.current : null;
    nextFocus.current = null;
    if (data?.phase !== "recording") recordingFocus.current = false;
    if (target && (document.activeElement === document.body || document.activeElement === document.documentElement)) target.focus();
  }, [busy, data?.phase]);
  const locale = i18n.resolvedLanguage || i18n.language;
  const date = (time: number | null) => time == null
    ? t("performanceDiagnostics.unavailable") : new Date(time).toLocaleString(locale);
  const delay = (value: number | null) => value == null || !Number.isFinite(value)
    ? t("performanceDiagnostics.unavailable")
    : t("performanceDiagnostics.delayValue", { value: value.toLocaleString(locale, { maximumFractionDigits: 1 }) });
  const disabled = busy !== null && busy !== "snapshot";
  const recording = data?.phase === "recording";
  const complete = data?.phase === "complete" && data.id != null;

  return (
    <div className="performance-content">
      <p className="performance-note">{t("performanceDiagnostics.privacy")}</p>
      <p className="performance-note">{t("performanceDiagnostics.recordingHint")}</p>
      {!data && !error ? <p role="status">{t("performanceDiagnostics.loading")}</p> : null}
      {busy && busy !== "snapshot" && busy !== "save" ? <p role="status">{t("performanceDiagnostics.working")}</p> : null}
      {error ? <div className="performance-error" role="alert">
        <span>{t(`performanceDiagnostics.errors.${error}`)}</span>
        {error === "snapshot" ? <Button variant="secondary" disabled={busy !== null} onClick={() => request("snapshot")}>{t("performanceDiagnostics.retry")}</Button> : null}
      </div> : null}
      {data ? <>
        <div className="performance-status" role="status"><Badge>{t(`performanceDiagnostics.status.${data.phase}`)}</Badge>
          {data.startedAt != null ? <span>{t("performanceDiagnostics.began")}: {date(data.startedAt)}</span> : null}
          {recording && data.deadline != null ? <span>{t("performanceDiagnostics.deadline")}: {date(data.deadline)}</span> : null}
          {data.phase === "complete" && data.endedAt != null ? <span>{t("performanceDiagnostics.completed")}: {date(data.endedAt)}</span> : null}
        </div>
        <dl className="performance-summary">
          <div><dt>{t("performanceDiagnostics.samples")}</dt><dd>{data.sampleCount}</dd></div>
          <div><dt>{t("performanceDiagnostics.markers")}</dt><dd>{data.markerCount}</dd></div>
          <div><dt>{t("performanceDiagnostics.mainDelay")}</dt><dd>{delay(data.maxMainDelayMs)}</dd></div>
          <div><dt>{t("performanceDiagnostics.uiDelay")}</dt><dd>{delay(data.maxUiDelayMs)}</dd></div>
        </dl>
        <div className="performance-actions">
          {recording ? <>
            <Button ref={stopRef} variant="secondary" disabled={disabled || data.id == null}
              onFocus={() => { recordingFocus.current = true; }} onBlur={() => { recordingFocus.current = false; }} onClick={(event) => {
              if (document.activeElement === event.currentTarget) nextFocus.current = "preview";
              request("stop");
            }}>{t("performanceDiagnostics.stop")}</Button>
            <Button variant="secondary" disabled={disabled || data.id == null}
              onFocus={() => { recordingFocus.current = true; }} onBlur={() => { recordingFocus.current = false; }}
              onClick={() => request("mark")}>{t("performanceDiagnostics.mark")}</Button>
          </> : <Button variant="secondary" disabled={disabled} onClick={(event) => {
            if (document.activeElement === event.currentTarget) nextFocus.current = "stop";
            request("start");
          }}>{t(data.phase === "complete" ? "performanceDiagnostics.startNew" : "performanceDiagnostics.start")}</Button>}
          {complete ? <Button ref={previewRef} variant="secondary" disabled={disabled} onClick={() => request("preview")}>{t("performanceDiagnostics.preview")}</Button> : null}
        </div>
        <ProcessTable snapshot={data.latest} />
        {preview && complete && preview.id === data.id ? <section className="performance-preview" aria-label={t("performanceDiagnostics.previewLabel")}>
          <h4>{t("performanceDiagnostics.previewLabel")}</h4>
          <p className="performance-note">{t("performanceDiagnostics.previewHint")}</p>
          <pre tabIndex={0} className="selectable">{preview.json}</pre>
          <Button variant="secondary" disabled={disabled} onClick={() => request("save")}>{t(busy === "save" ? "performanceDiagnostics.saving" : "performanceDiagnostics.save")}</Button>
          {saveResult ? <p role="status">{t(`performanceDiagnostics.${saveResult}`)}</p> : null}
        </section> : null}
      </> : null}
    </div>
  );
}

export function PerformanceDiagnosticsSection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return <SettingsCard title={t("performanceDiagnostics.title")} caption={t("performanceDiagnostics.description")}
    action={<Button variant="secondary" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
      {t(open ? "performanceDiagnostics.close" : "performanceDiagnostics.open")}
    </Button>}>
    <div id={panelId}>{open ? <DiagnosticsContent /> : <p className="performance-collapsed">{t("performanceDiagnostics.privacy")}</p>}</div>
  </SettingsCard>;
}
