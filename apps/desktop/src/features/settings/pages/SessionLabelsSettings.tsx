import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, TooltipButton } from "../../../components/ui";
import { IconArrowDown, IconArrowUp, IconCheck, IconPlus, IconTrash } from "../../../components/icons";
import { SettingsCard } from "../primitives";
import { useAppStore } from "../../../stores/app-store";
import type { SessionLabel, SessionColor } from "../../../lib/session-labels";
import { SessionColorPicker, sessionLabelName } from "../../sessions/SessionLabelControls";

function LabelEditor({ label, index, total, onMove, onSave, onDelete }: {
  label: SessionLabel; index: number; total: number;
  onMove: (offset: number) => void; onSave: (label: SessionLabel) => void; onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(sessionLabelName(label, t));
  const [color, setColor] = useState(label.color);
  const save = () => {
    if (!name.trim()) return;
    onSave({ id: label.id, name: name.trim(), color,
      ...(name === sessionLabelName(label, t) && label.defaultName ? { defaultName: label.defaultName } : {}) });
  };
  return <form className="session-label-editor" onSubmit={event => { event.preventDefault(); save(); }}>
    <Input value={name} maxLength={80} aria-label={t("sessionLabels.name")} onChange={event => setName(event.target.value)} />
    <SessionColorPicker value={color} onChange={value => { if (value) setColor(value); }} />
    <div className="session-label-actions">
      <TooltipButton type="submit" className="icon-btn icon-btn-square" disabled={!name.trim()}
        tooltip={t("sessionLabels.save")} ariaLabel={t("sessionLabels.save")}><IconCheck size={14} /></TooltipButton>
      <TooltipButton type="button" className="icon-btn icon-btn-square" disabled={index === 0} onClick={() => onMove(-1)}
        tooltip={t("sessionLabels.moveUp")} ariaLabel={t("sessionLabels.moveUp")}><IconArrowUp size={14} /></TooltipButton>
      <TooltipButton type="button" className="icon-btn icon-btn-square" disabled={index === total - 1} onClick={() => onMove(1)}
        tooltip={t("sessionLabels.moveDown")} ariaLabel={t("sessionLabels.moveDown")}><IconArrowDown size={14} /></TooltipButton>
      <TooltipButton type="button" className="icon-btn icon-btn-square" onClick={onDelete}
        tooltip={t("sessionLabels.delete")} ariaLabel={t("sessionLabels.delete")}><IconTrash size={14} /></TooltipButton>
    </div>
  </form>;
}
export function SessionLabelsSettings() {
  const { t } = useTranslation();
  const labels = useAppStore(state => state.sessionLabels);
  const meta = useAppStore(state => state.sessionMeta);
  const setLabels = useAppStore(state => state.setSessionLabels);
  const [name, setName] = useState("");
  const [color, setColor] = useState<SessionColor>("blue");
  const [deleting, setDeleting] = useState<string | null>(null);
  const labelToDelete = labels.find(row => row.id === deleting);
  return <SettingsCard title={t("sessionLabels.title")}>
    <div className="session-label-settings">
      {labels.map((label, index) => <LabelEditor key={label.id} label={label} index={index} total={labels.length}
        onSave={next => setLabels(labels.map(row => row.id === next.id ? next : row))}
        onMove={offset => { const next = [...labels]; next.splice(index, 1); next.splice(index + offset, 0, label); setLabels(next); }}
        onDelete={() => setDeleting(label.id)} />)}
      {labelToDelete ? <div className="session-label-delete" role="alert">
        <p>{t("sessionLabels.deleteConfirm", { name: sessionLabelName(labelToDelete, t),
          count: Object.values(meta).filter(row => row.labelIds?.includes(labelToDelete.id)).length })}</p>
        <Button variant="ghost" onClick={() => setDeleting(null)}>{t("sessionLabels.cancel")}</Button>
        <Button onClick={() => { setLabels(labels.filter(row => row.id !== labelToDelete.id)); setDeleting(null); }}>{t("sessionLabels.delete")}</Button>
      </div> : null}
      <form className="session-label-editor" onSubmit={event => {
        event.preventDefault();
        if (!name.trim() || labels.length >= 128) return;
        setLabels([...labels, { id: crypto.randomUUID(), name: name.trim(), color }]);
        setName("");
      }}>
        <Input value={name} maxLength={80} placeholder={t("sessionLabels.name")} aria-label={t("sessionLabels.add")}
          onChange={event => setName(event.target.value)} />
        <SessionColorPicker value={color} onChange={value => { if (value) setColor(value); }} />
        <TooltipButton type="submit" className="icon-btn icon-btn-square" disabled={!name.trim() || labels.length >= 128}
          tooltip={t("sessionLabels.add")} ariaLabel={t("sessionLabels.add")}><IconPlus size={14} /></TooltipButton>
      </form>
    </div>
  </SettingsCard>;
}
