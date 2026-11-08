import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRoot } from "@pi-desktop/shared";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { Button } from "../../components/ui";
import { IconFolder } from "../../components/icons";

export function ProjectFolderReferences({ roots, primaryPath }: { roots: ProjectGroupRoot[]; primaryPath: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const id = useId();
  if (roots.length < 2) return null;
  const ordered = [...roots].sort((left, right) => Number(right.path === primaryPath) - Number(left.path === primaryPath) || left.position - right.position);
  return <AnchoredMenu open={open} onClose={() => setOpen(false)} role="dialog" label={t("sessionGroups.folders", { count: roots.length })}
    menuClassName="project-folder-references" align="end" trigger={ref => <Button ref={ref} variant="ghost" className="sidebar-project-folders"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={event => { event.stopPropagation(); setOpen(value => !value); }}>{t("sessionGroups.folders", { count: roots.length })}</Button>}>
    <div id={id}>{ordered.map(root => <div key={root.path} className="project-folder-reference" title={root.path}>
      <IconFolder size={14} aria-hidden /><span><strong>{root.name}</strong><span>{root.path}</span></span>
      {root.path === primaryPath ? <span className="project-folder-primary">{t("sessionGroups.primary")}</span> : null}
    </div>)}</div>
  </AnchoredMenu>;
}
