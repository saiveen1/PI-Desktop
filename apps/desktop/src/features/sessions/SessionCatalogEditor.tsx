import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, TooltipButton } from "../../components/ui";
import { IconArrowDown, IconArrowUp, IconCheck, IconPlus, IconTrash } from "../../components/icons";
import type { SessionLabel, SessionColor } from "../../lib/session-labels";
import { sessionOrganizationCatalog, sessionOrganizationScope } from "../../lib/session-organization";
import { useAppStore } from "../../stores/app-store";
import { ColorSwatch, SessionColorPicker, sessionLabelName } from "./SessionLabelControls";

export type SessionCatalogKind = "groups" | "labels";

function CatalogRow({ item, kind, index, total, count, onMove, onSave, onDelete }: {
  item: SessionLabel; kind: SessionCatalogKind; index: number; total: number; count: number;
  onMove: (offset: number) => void; onSave: (item: SessionLabel) => void; onDelete: () => void;
}) {
  const { t } = useTranslation();
  const displayName = sessionLabelName(item, t);
  const [name, setName] = useState(displayName);
  const [color, setColor] = useState(item.color);
  const prefix = kind === "groups" ? "sessionGroups" : "sessionLabels";
  return <form className="session-catalog-row" onSubmit={event => {
    event.preventDefault();
    if (name.trim()) onSave({ id: item.id, name: name.trim(), color,
      ...(name === displayName && item.defaultName ? { defaultName: item.defaultName } : {}) });
  }}>
    <div className="session-catalog-row-heading">
      <ColorSwatch color={color} />
      <Input value={name} maxLength={80} aria-label={t(`${prefix}.name`)} onChange={event => setName(event.target.value)} />
      <span className="session-catalog-usage">{t("sessionGroups.usage", { count })}</span>
      <TooltipButton type="submit" disabled={!name.trim()} tooltip={t("sessionLabels.save")} ariaLabel={t("sessionLabels.save")}><IconCheck size={14} /></TooltipButton>
      <TooltipButton type="button" disabled={index === 0} onClick={() => onMove(-1)} tooltip={t("sessionLabels.moveUp")} ariaLabel={t("sessionLabels.moveUp")}><IconArrowUp size={14} /></TooltipButton>
      <TooltipButton type="button" disabled={index === total - 1} onClick={() => onMove(1)} tooltip={t("sessionLabels.moveDown")} ariaLabel={t("sessionLabels.moveDown")}><IconArrowDown size={14} /></TooltipButton>
      <TooltipButton type="button" onClick={onDelete} tooltip={t(`${prefix}.delete`)} ariaLabel={t(`${prefix}.delete`)}><IconTrash size={14} /></TooltipButton>
    </div>
    <SessionColorPicker value={color} onChange={value => { if (value) setColor(value); }} />
  </form>;
}

export function SessionCatalogEditor({ scope, kind }: { scope: string; kind: SessionCatalogKind }) {
  const { t } = useTranslation();
  const organization = useAppStore(state => state.sessionOrganization);
  const legacyLabels = useAppStore(state => state.sessionLabels);
  const meta = useAppStore(state => state.sessionMeta);
  const sessions = useAppStore(state => state.sessions);
  const projects = useAppStore(state => state.sidebarProjectGroups);
  const setGroups = useAppStore(state => state.setSessionGroups);
  const setLabels = useAppStore(state => state.setProjectSessionLabels);
  const catalog = sessionOrganizationCatalog(organization, scope, legacyLabels);
  const items: SessionLabel[] = kind === "groups" ? catalog.groups : catalog.labels;
  const [name, setName] = useState("");
  const [color, setColor] = useState<SessionColor>("blue");
  const [deleting, setDeleting] = useState<string | null>(null);
  const prefix = kind === "groups" ? "sessionGroups" : "sessionLabels";
  const currentItems = () => {
    const state = useAppStore.getState();
    return sessionOrganizationCatalog(state.sessionOrganization, scope, state.sessionLabels)[kind];
  };
  const save = (next: SessionLabel[]) => kind === "groups" ? setGroups(scope, next) : setLabels(scope, next);
  const scopes = new Map(sessions.map(session => [session.id, sessionOrganizationScope(session, projects)]));
  const counts = new Map<string, number>();
  for (const [id, row] of Object.entries(meta)) {
    if ((scopes.get(id) ?? row.organizationScope) !== scope) continue;
    const keys = kind === "groups" ? row.groupId ? [row.groupId] : [] : row.labelIds ?? [];
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const countFor = (id: string) => counts.get(id) ?? 0;
  const itemToDelete = items.find(item => item.id === deleting);
  return <div className="session-catalog-editor">
    <p className="session-catalog-hint">{t(kind === "groups" ? "sessionGroups.description" : "sessionGroups.labelsDescription")}</p>
    {items.map((item, index) => <CatalogRow key={`${item.id}:${item.name}:${item.color}`} item={item} kind={kind}
      index={index} total={items.length} count={countFor(item.id)}
      onSave={next => save(currentItems().map(row => row.id === next.id ? next : row))}
      onMove={offset => { const next = [...currentItems()]; const position = next.findIndex(row => row.id === item.id);
        if (position < 0 || position + offset < 0 || position + offset >= next.length) return;
        next.splice(position, 1); next.splice(position + offset, 0, item); save(next); }}
      onDelete={() => setDeleting(item.id)} />)}
    {itemToDelete ? <div className="session-label-delete" role="alert">
      <p>{t(`${prefix}.deleteConfirm`, { name: sessionLabelName(itemToDelete, t), count: countFor(itemToDelete.id) })}</p>
      <Button variant="ghost" onClick={() => setDeleting(null)}>{t("sessionLabels.cancel")}</Button>
      <Button onClick={() => { save(currentItems().filter(row => row.id !== itemToDelete.id)); setDeleting(null); }}>{t(`${prefix}.delete`)}</Button>
    </div> : null}
    <form className="session-catalog-new" onSubmit={event => {
      event.preventDefault();
      const latest = currentItems();
      if (!name.trim() || latest.length >= 128) return;
      save([...latest, { id: crypto.randomUUID(), name: name.trim(), color }]); setName("");
    }}>
      <div className="session-catalog-row-heading">
        <Input value={name} maxLength={80} placeholder={t(`${prefix}.name`)} aria-label={t(`${prefix}.name`)} onChange={event => setName(event.target.value)} />
        <Button type="submit" disabled={!name.trim() || items.length >= 128}><IconPlus size={14} aria-hidden />{t(`${prefix}.add`)}</Button>
      </div>
      <SessionColorPicker value={color} onChange={value => { if (value) setColor(value); }} />
    </form>
  </div>;
}
