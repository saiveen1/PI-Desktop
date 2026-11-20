import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { isModeRunOpen, type PersonaDefinition } from "@pi-desktop/shared";
import { IconCheck, IconChevronDown } from "../../../components/icons";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { Button, HelpIcon, SettingsToggle, TooltipButton } from "../../../components/ui";
import { approvalIsLive, useDelegationApprovals } from "../../../components/delegation-approval/useDelegationApprovals";
import { useAppStore, type AppState } from "../../../stores/app-store";
import { hasRunningPersonaChild, isExtensionPersonaProvider, personaStoreBlock, sessionSupportsPersona } from "../../../stores/runtime/session-persona";
import { useSessionDelegations } from "../../delegations/useSessionDelegations";
import { useModesStore } from "../../modes/modes-store";
import "../../../styles/composer-persona.css";

const EMPTY_CATALOG: readonly PersonaDefinition[] = [];
type Block = NonNullable<ReturnType<typeof personaStoreBlock>> | "modeRun" | "checkingFailed";
type PickerProps = { sessionId?: string; providerId?: string; onOpen: () => void };

export function ComposerPersonaPicker({ sessionId, providerId, onOpen }: PickerProps) {
  const session = useAppStore((state) => state.sessions.find((row) => row.id === sessionId));
  const projectPath = useAppStore((state) => state.activeProjectPath);
  const defaultProviderId = useAppStore((state) => state.settings?.defaultProviderId);
  if (isExtensionPersonaProvider(providerId ?? defaultProviderId) ||
      (sessionId && (!session || !sessionSupportsPersona(session, defaultProviderId)))) return null;
  return sessionId && session
    ? <SessionPicker key={sessionId} sessionId={sessionId} definition={session.persona?.definition}
        inherit={session.persona?.inheritToSubagents === true} onOpen={onOpen} />
    : <DraftPicker key={projectPath ?? ""} projectPath={projectPath} onOpen={onOpen} />;
}

function SessionPicker({ sessionId, ...props }: Omit<PersonaMenuProps, "block"> & { sessionId: string }) {
  const stateBlock = useAppStore((state) => personaStoreBlock(state, sessionId));
  const modeRun = useModesStore((state) => state.runs[sessionId]);
  const children = useSessionDelegations(sessionId);
  const approvals = useDelegationApprovals();
  const awaitingDelegation = approvals.requests.some((row) => row.sessionId === sessionId && approvalIsLive(row, approvals.now));
  const block = stateBlock ?? (awaitingDelegation ? "approval" : hasRunningPersonaChild(children.entries) || children.starting ? "running"
    : modeRun && isModeRunOpen(modeRun.state) ? "modeRun"
    : children.error || approvals.loadError ? "checkingFailed"
    : !children.loaded || !approvals.loaded ? "loading" : undefined);
  return <PersonaMenu {...props} block={block} sessionId={sessionId} />;
}

function DraftPicker({ projectPath, onOpen }: { projectPath?: string; onOpen: () => void }) {
  const fields = useAppStore((state) => state.draftConfiguration);
  const settings = useAppStore((state) => state.settings);
  const block = useAppStore((state) => personaStoreBlock(state));
  const definition = settings?.personas?.find((row) => row.id === fields?.personaId);
  return <PersonaMenu definition={definition} inherit={!!definition && fields?.inheritToSubagents === true}
    projectPath={projectPath} block={block ?? (settings ? undefined : "loading")} onOpen={onOpen} />;
}

type PersonaMenuProps = {
  sessionId?: string;
  projectPath?: string;
  definition?: PersonaDefinition;
  inherit: boolean;
  block?: Block;
  onOpen: () => void;
};

function PersonaMenu({ sessionId, projectPath, definition, inherit, block, onOpen }: PersonaMenuProps) {
  const { t } = useTranslation();
  const templates = useAppStore((state) => state.settings?.personas ?? EMPTY_CATALOG);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const label = t("personas.chip", { name: definition?.name ?? t("personas.default") });
  const reason = block ? t(`personas.block.${block}`) : undefined;
  const inheritLabel = t("personas.inherit");
  const isAppliedTemplate = (item: PersonaDefinition) => item.id === definition?.id && item.name === definition.name && item.prompt === definition.prompt;
  const choose = async (change: Parameters<AppState["configureActivePersona"]>[0]) => {
    if (block) return;
    try {
      await useAppStore.getState().configureActivePersona(change, { sessionId, projectPath });
    } catch {
      const current = useAppStore.getState();
      if (current.page === "chat" && current.activeSessionId === sessionId && !current.selectingSessionId) {
        current.showToast(t("personas.sessionSaveFailed"), { variant: "error" });
      }
    }
  };
  return <AnchoredMenu className="composer-persona" open={open} onClose={close} side="top" role="dialog"
    menuClassName="composer-mode-menu composer-persona-menu" label={t("personas.title")}
    trigger={ref => <TooltipButton ref={ref} type="button" className={`icon-btn mode-chip composer-persona-chip${open ? " active" : ""}`}
      ariaLabel={reason ? `${label}. ${reason}` : label} tooltip={reason ? `${label}. ${reason}` : label}
      aria-haspopup="dialog" aria-expanded={open} aria-disabled={!!block || undefined}
      onClick={() => { if (open) close(); else if (!block) { onOpen(); setOpen(true); } }}>
      <span className="text-sm">{label}</span><IconChevronDown size={12} aria-hidden="true" />
    </TooltipButton>}>
    <div role="group" aria-label={t("personas.templates")}>
      <div className="composer-persona-default">
        <Button variant="ghost" className="composer-plus-item composer-persona-option" aria-pressed={!definition} disabled={!!block}
          onClick={() => void choose({ personaId: null })}>
          <span>{t("personas.default")}</span>{!definition ? <IconCheck size={13} aria-hidden="true" /> : null}
        </Button>
        <HelpIcon label={t("personas.defaultHelp")} />
      </div>
      {templates.map((item) => <Button key={item.id} variant="ghost" className="composer-plus-item composer-persona-option"
        aria-pressed={isAppliedTemplate(item)} disabled={!!block} onClick={() => void choose({ personaId: item.id })}>
        <span>{item.name}</span>{isAppliedTemplate(item) ? <IconCheck size={13} aria-hidden="true" /> : null}
      </Button>)}
    </div>
    {definition && !templates.some(isAppliedTemplate) ? <p className="composer-persona-note">
      {t("personas.retained", { name: definition.name })}
    </p> : null}
    <div className="composer-menu-separator" role="separator" />
    <div className="composer-persona-inherit">
      <span>{inheritLabel}</span>
      <SettingsToggle label={inheritLabel} checked={inherit} disabled={!!block || !definition}
        onChange={() => void choose({ inheritToSubagents: !inherit })} />
    </div>
    <p className="composer-persona-note" role={reason ? "status" : undefined}>{reason ?? t("personas.appliesNext")}</p>
    <Button variant="ghost" className="composer-plus-item composer-persona-option"
      onClick={() => {
        close();
        const state = useAppStore.getState();
        state.setSettingsTab("instructions");
        state.setSettingsAnchor("personas.title");
      }}>
      {t("personas.manage")}
    </Button>
  </AnchoredMenu>;
}
