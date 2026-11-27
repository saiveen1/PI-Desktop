import type { TurnContextMessage, TurnContextSnapshot } from "@pi-desktop/shared";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, Field, Textarea } from "../../../components/ui";
import { IconChevronDown, IconChevronRight } from "../../../components/icons";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { canEditTurnContext, getTurnContextAnchor } from "../../../stores/runtime/transcript-action";
import { createContextRows, hasOpaqueThinking, isIncludedContextBlock, parseContextArgs, proposeContextEdits, type ContextBlock } from "./turn-context-draft";

function contextError(error: unknown, fallback: "loadFailed" | "saveFailed") {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === "LIMIT_EXCEEDED" ? "turnContext.limit" : `turnContext.${fallback}` as const;
}

export function useTurnContextEditor(sessionId: string, anchorMessageId?: string) {
  const { t } = useTranslation();
  const editable = useAppStore((state) => anchorMessageId !== undefined && canEditTurnContext(state, sessionId, anchorMessageId));
  const [loading, setLoading] = useState(false);
  const [snapshot, setSnapshot] = useState<TurnContextSnapshot | null>(null);
  const owner = useRef<AbortController | null>(null);
  useEffect(() => () => owner.current?.abort(), [sessionId, anchorMessageId]);

  const begin = async () => {
    if (!anchorMessageId || owner.current || !canEditTurnContext(useAppStore.getState(), sessionId, anchorMessageId)) return;
    const request = new AbortController();
    owner.current = request;
    setLoading(true);
    // Catch even a batched A → B → A navigation while awaiting the Host.
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.activeSessionId !== previous.activeSessionId ||
        state.selectingSessionId !== previous.selectingSessionId || state.page !== previous.page ||
        state.transcriptViews[sessionId]?.focus !== previous.transcriptViews[sessionId]?.focus ||
        !getTurnContextAnchor(state, sessionId, anchorMessageId) ||
        (state.messages !== previous.messages && state.messages.findLast((message) => message.role !== "system")?.id !==
          previous.messages.findLast((message) => message.role !== "system")?.id)) {
        request.abort();
      }
    });
    request.signal.addEventListener("abort", () => {
      unsubscribe();
      owner.current = null;
      setLoading(false);
      setSnapshot(null);
    }, { once: true });
    try {
      const result = await api.getTurnContext({ sessionId, anchorMessageId });
      if (request.signal.aborted) return;
      if (!canEditTurnContext(useAppStore.getState(), sessionId, anchorMessageId)) {
        request.abort();
        return;
      }
      if (result.snapshot.sessionId !== sessionId || result.snapshot.anchorMessageId !== anchorMessageId) throw new Error("Mismatched turn context");
      setSnapshot(result.snapshot);
      setLoading(false);
    } catch (error) {
      if (request.signal.aborted) return;
      useAppStore.getState().showToast(t(contextError(error, "loadFailed")), { variant: "error" });
      request.abort();
    }
  };
  const active = snapshot?.sessionId === sessionId && snapshot.anchorMessageId === anchorMessageId ? snapshot : null;
  return { editable, loading, snapshot: active, signal: active ? owner.current?.signal : undefined, begin, cancel: () => owner.current?.abort() };
}

function ContextValues({ source, block }: { source: TurnContextMessage; block: ContextBlock }) {
  const { t } = useTranslation();
  return block.kind === "tool" ? <>
    <span>{t("turnContext.args")}</span><pre>{block.args}</pre>
    <span>{t("turnContext.result")}</span><pre>{block.value || t("turnContext.emptyText")}</pre>
  </> : <pre>{block.value || t(hasOpaqueThinking(source, block) ? "turnContext.opaque" : "turnContext.emptyText")}</pre>;
}

export function TurnContextEditor({ snapshot, editable, signal, cancel }: {
  snapshot: TurnContextSnapshot;
  editable: boolean;
  signal: AbortSignal;
  cancel: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const scroll = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState(() => createContextRows(snapshot.messages));
  const [preview, setPreview] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const [restoreAll, setRestoreAll] = useState(false);
  const [excludeHistoryThinking, setExcludeHistoryThinking] = useState(false);
  const [excludePreviousTurns, setExcludePreviousTurns] = useState(snapshot.excludePreviousTurns === true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ReturnType<typeof contextError> | null>(null);
  const inFlight = useRef(false);
  useLayoutEffect(() => { scroll.current?.querySelector<HTMLTextAreaElement>('[data-context-kind="final"] textarea')?.focus(); }, []);

  const blockList = rows.flatMap(({ source, blocks, originals }, rowIndex) => blocks.map((block, index) => ({
    source, block, original: originals[index], rowIndex, index, key: `${source.messageId}:${block.kind}`,
  })));
  const bulkExclude = snapshot.isLatestTurn && excludeHistoryThinking;
  const included = blockList.filter(({ source, block }) => !(bulkExclude && block.kind === "thinking") && isIncludedContextBlock(source, block));
  const final = blockList.find(({ block }) => block.kind === "final");
  const process = blockList.filter(({ block }) => block.kind !== "final");
  const { edits, restore, invalid } = proposeContextEdits(rows, restoreAll, !bulkExclude);
  const boundaryChanged = excludePreviousTurns !== (snapshot.excludePreviousTurns === true);
  const canSave = editable && !saving && !invalid && (edits.length > 0 || restore || bulkExclude || boundaryChanged);
  const save = async () => {
    if (!canSave || inFlight.current || signal.aborted) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    const { sessionId, anchorMessageId, revision } = snapshot;
    try {
      const saved = await useAppStore.getState().editTurnContext({
        sessionId, anchorMessageId, expectedRevision: revision, edits, ...(restore ? { restore } : {}),
        ...(bulkExclude ? { excludeHistoryThinking: true } : {}),
        ...(boundaryChanged ? { excludePreviousTurns } : {}),
      }, signal);
      if (signal.aborted) return;
      if (saved) cancel();
      else setError("turnContext.saveFailed");
    } catch (failure) {
      if (!signal.aborted) setError(contextError(failure, "saveFailed"));
    } finally {
      if (!signal.aborted) {
        inFlight.current = false;
        setSaving(false);
      }
    }
  };
  const change = (rowIndex: number, index: number, block: ContextBlock) => setRows((previous) => previous.map((row, i) =>
    i === rowIndex ? { ...row, blocks: row.blocks.map((item, j) => j === index ? block : item) } : row));
  const shortcut = (mode: "thinking" | "final" | "restore") => {
    if (mode === "restore") {
      setRestoreAll(true);
      setExcludeHistoryThinking(false);
    }
    setRows((previous) => previous.map((row) => ({
      ...row, blocks: mode === "restore" ? row.originals : row.blocks.map((block) => ({
        ...block, excluded: mode === "final" ? block.kind !== "final" : block.kind === "thinking" || block.excluded,
      })),
    })));
  };

  const renderBlock = ({ source, block, original, rowIndex, index, key }: (typeof blockList)[number]) => {
    const label = block.kind === "tool" ? source.toolName || t("turnContext.tool") : t(`turnContext.${block.kind}`);
    const argsInvalid = block.kind === "tool" && !parseContextArgs(block.args);
    const excludedByHistory = bulkExclude && block.kind === "thinking";
    const argsErrorId = `${titleId}-${rowIndex}-args-error`;
    return <li key={key} className="turn-context-block" data-context-kind={block.kind}>
      <div className="turn-context-row">
        <h4>{label}</h4>
        {!preview && <Checkbox label={t("turnContext.include")} aria-label={t("turnContext.includeBlock", { label })}
          checked={!excludedByHistory && !block.excluded} disabled={saving || excludedByHistory}
          onChange={(event) => change(rowIndex, index, { ...block, excluded: !event.currentTarget.checked })} />}
      </div>
      {preview ? <ContextValues source={source} block={block} /> : <>
        {block.kind === "tool" && <Field label={t("turnContext.args")}>
          <Textarea className="turn-context-json" rows={3} value={block.args} readOnly={saving}
            aria-invalid={argsInvalid || undefined} aria-describedby={argsInvalid ? argsErrorId : undefined}
            onChange={(event) => change(rowIndex, index, { ...block, args: event.currentTarget.value })} />
        </Field>}
        {argsInvalid && <p className="turn-context-error" id={argsErrorId} role="alert">{t("turnContext.invalidArgs")}</p>}
        {block.kind === "final" && !block.excluded && !block.value.trim() && <p className="turn-context-error" id={`${titleId}-final-error`} role="alert">{t("turnContext.emptyText")}</p>}
        <Textarea rows={block.kind === "final" ? 5 : 3} className="selectable" aria-label={block.kind === "tool" ? t("turnContext.result") : label}
          aria-invalid={block.kind === "final" && !block.excluded && !block.value.trim() || undefined}
          aria-describedby={block.kind === "final" && !block.excluded && !block.value.trim() ? `${titleId}-final-error` : undefined}
          placeholder={hasOpaqueThinking(source, block) ? t("turnContext.opaque") : undefined}
          value={block.value} readOnly={saving} onChange={(event) => change(rowIndex, index, { ...block, value: event.currentTarget.value })} />
        <div className="turn-context-original">
          <details>
            <summary>{t("turnContext.original")}</summary>
            <ContextValues source={source} block={original} />
          </details>
          <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => change(rowIndex, index, original)}>{t("turnContext.restoreBlock")}</Button>
        </div>
      </>}
    </li>;
  };

  return <form className="turn-context-editor" aria-labelledby={titleId} aria-busy={saving || undefined}
    onSubmit={(event) => { event.preventDefault(); void save(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !saving && !inFlight.current && !event.nativeEvent.isComposing) {
        event.preventDefault();
        cancel();
      }
    }}>
    <header className="turn-context-header">
      <h3 id={titleId}>{t("turnContext.edit")}</h3>
      <p>{t("turnContext.description")}</p>
      <p>{t("turnContext.warning")}</p>
      <Checkbox label={t("turnContext.excludePreviousTurns")} aria-describedby={`${titleId}-previous-turns`}
        checked={excludePreviousTurns} disabled={saving} onChange={(event) => setExcludePreviousTurns(event.currentTarget.checked)} />
      <p id={`${titleId}-previous-turns`}>{t("turnContext.previousTurnsScope")}</p>
      {snapshot.isLatestTurn && <>
        <Checkbox label={t("turnContext.excludeHistoryThinking")} aria-describedby={`${titleId}-history-thinking`}
          checked={bulkExclude} disabled={saving} onChange={(event) => setExcludeHistoryThinking(event.currentTarget.checked)} />
        <p id={`${titleId}-history-thinking`}>{t("turnContext.historyThinkingScope")}</p>
      </>}
      <div className="turn-context-toolbar">
        <Button type="button" size="sm" variant="ghost" aria-pressed={preview} disabled={saving || (!preview && invalid)} onClick={() => {
          setPreview(!preview);
          if (scroll.current) scroll.current.scrollTop = 0;
        }}>{t("turnContext.preview")}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => shortcut("restore")}>{t("turnContext.restoreAll")}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => shortcut("thinking")}>{t("turnContext.excludeThinking")}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => shortcut("final")}>{t("turnContext.finalOnly")}</Button>
      </div>
      <p className="turn-context-count" role="status">{t("turnContext.count", {
        included: included.length, omitted: blockList.length - included.length,
      })}</p>
    </header>
    <div className="turn-context-scroll" ref={scroll}>
      {preview && !included.length && <p>{t("turnContext.emptyPreview")}</p>}
      <ol className="turn-context-list">{preview ? included.map(renderBlock) : final && renderBlock(final)}</ol>
      {!preview && process.length > 0 && <>
        <Button type="button" size="sm" variant="ghost" className="turn-context-process" aria-expanded={processOpen}
          aria-controls={`${titleId}-process`} onClick={() => setProcessOpen(!processOpen)}>
          {processOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          {t("turnContext.process", { count: process.length })}
        </Button>
        <ol id={`${titleId}-process`} hidden={!processOpen} className="turn-context-list">{processOpen && process.map(renderBlock)}</ol>
      </>}
    </div>
    <footer className="turn-context-footer">
      {error && <p className="turn-context-error" role="alert">{t(error)}</p>}
      {!editable && <p role="status">{t("turnContext.busy")}</p>}
      <div className="turn-context-toolbar">
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={cancel}>{t("common.cancel")}</Button>
        <Button type="submit" size="sm" variant="primary" disabled={!canSave}>{t(saving ? "common.saving" : "common.save")}</Button>
      </div>
    </footer>
  </form>;
}
