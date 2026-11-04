import { useTranslation } from "react-i18next";
import { Button, Checkbox } from "../../components/ui";
import { IconArchive, IconArchiveRestore, IconTrash } from "../../components/icons";
import "./session-organization.css";

export function SessionSelectionToolbar({
  count, total, busy, onSelectAll, onExit, onArchive, onUnarchive, onTrash,
}: {
  count: number;
  total: number;
  busy: boolean;
  onSelectAll: () => void;
  onExit: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onTrash?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="session-selection-toolbar" role="group" aria-label={t("sessionOrganization.select")} aria-busy={busy}>
      <div className="session-selection-heading">
        <Checkbox label={t("sessionOrganization.selectVisible")} checked={total > 0 && count === total}
          indeterminate={count > 0 && count < total} disabled={busy || total === 0} onChange={onSelectAll} />
        <Button size="sm" variant="ghost" disabled={busy} onClick={onExit}>{t("sessionOrganization.done")}</Button>
      </div>
      <span className="session-selection-count" role="status">{t("sessionOrganization.selected", { count })}</span>
      <div className="session-selection-actions">
        {onArchive && <Button size="sm" disabled={busy || !count} onClick={onArchive}>
          <IconArchive size={14} aria-hidden />{t("nav.archiveTask")}
        </Button>}
        {onUnarchive && <Button size="sm" disabled={busy || !count} onClick={onUnarchive}>
          <IconArchiveRestore size={14} aria-hidden />{t("sessionOrganization.unarchive")}
        </Button>}
        {onTrash && <Button size="sm" disabled={busy || !count} onClick={onTrash}>
          <IconTrash size={14} aria-hidden />{t("sessionOrganization.moveToTrash")}
        </Button>}
      </div>
    </div>
  );
}
