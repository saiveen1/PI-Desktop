import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { IconNewSession } from "../../components/icons";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { Button, TooltipButton } from "../../components/ui";
import type { SessionGroup } from "../../lib/session-organization";
import { ColorSwatch } from "./SessionLabelControls";
import "../../styles/session-organization.css";

export function ProjectGroupCreateButton({ groups, onCreate, label, disabled = false }: {
  groups: readonly SessionGroup[];
  onCreate: (groupId: string | null) => void;
  label: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const visible = open && !disabled && groups.length > 0;
  useEffect(() => { if (disabled || groups.length === 0) setOpen(false); }, [disabled, groups.length]);
  const choose = (id: string | null) => { setOpen(false); onCreate(id); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
      event.key === "ArrowDown" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  return <AnchoredMenu className="project-group-create-anchor" open={visible} onClose={() => setOpen(false)} menuClassName="project-group-create-menu"
    label={label} role="menu" align="end" onMenuKeyDown={onKeyDown}
    trigger={ref => <TooltipButton ref={ref} type="button" className="sidebar-session-group-add"
      tooltip={label} ariaLabel={label} disabled={disabled} aria-haspopup={groups.length ? "menu" : undefined}
      aria-expanded={groups.length ? visible : undefined} onClick={() => groups.length ? setOpen(value => !value) : onCreate(null)}>
      <IconNewSession size={13} aria-hidden />
    </TooltipButton>}>
    {groups.map(group => <Button variant="ghost" role="menuitem" className="project-group-create-item" key={group.id} onClick={() => choose(group.id)}>
      <ColorSwatch color={group.color} /><span className="sidebar-conversation-group-name" title={group.name}>{group.name}</span>
    </Button>)}
    <Button variant="ghost" role="menuitem" className="project-group-create-item" onClick={() => choose(null)}>{t("sessionGroups.ungrouped")}</Button>
  </AnchoredMenu>;
}
