import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider, useTranslation } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { useAppStore } from "../../src/stores/app-store";
import { SidebarSessionGroups } from "../../src/features/sessions/SidebarSessionGroups";
import { SessionOrganizationDialog, type SessionOrganizationTarget } from "../../src/features/sessions/SessionOrganizationDialog";
import { ProjectFolderReferences } from "../../src/features/sessions/ProjectFolderReferences";
import { SessionLabelChips, sessionGroupMenu, sessionMarkMenu } from "../../src/features/sessions/SessionLabelControls";
import { SidebarMenuPanel } from "../../src/components/SidebarMenuPanel";
import { Button } from "../../src/components/ui";
import { groupSessionsByGroup, sessionOrganizationCatalog } from "../../src/lib/session-organization";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/ui-kit.css";
import "../../src/styles/overlays.css";
import "../../src/styles/settings.css";
import "../../src/styles/sessions.css";
import "../../src/styles/sidebar-threads.css";

const scope = "group:fixture";
const roots = [{ name: "PI-Desktop", path: "/synthetic/app", position: 0 }, { name: "Pi_Plugin", path: "/synthetic/plugins", position: 1 }];
const synthetic = ["one", "two"].map((id, index) => ({ id, title: index ? "Custom color and group test" : "Shared project conversation",
  projectPath: roots[index].path, mode: "agent" as const, createdAt: "2026-11-08T10:00:00Z", updatedAt: "2026-11-08T10:00:00Z" }));
useAppStore.setState({ sessions: synthetic, sessionMeta: { one: { labelIds: ["investigation", "feature"] } },
  sessionOrganization: { version: 1, scopes: {} }, sidebarProjectGroups: [{ id: "fixture", name: "pi desktop", primaryPath: roots[0].path,
    roots, createdAt: 0, updatedAt: 0, pinned: false, lastOpenedAt: 0 }],
});
const i18n = createInstance();
void i18n.init({ lng: "zh-CN", resources: { "zh-CN": { translation: catalogs["zh-CN"] } } }).then(() => {
  createRoot(document.getElementById("root")!).render(<I18nextProvider i18n={i18n}><Fixture /></I18nextProvider>);
});

function Fixture() {
  const { t } = useTranslation();
  const organization = useAppStore(state => state.sessionOrganization);
  const labels = useAppStore(state => state.sessionLabels);
  const meta = useAppStore(state => state.sessionMeta);
  const sessions = useAppStore(state => state.sessions);
  const catalog = sessionOrganizationCatalog(organization, scope, labels);
  const [target, setTarget] = useState<SessionOrganizationTarget | null>(null);
  const [toggledGroups, setToggledGroups] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const row = sessions.find(session => session.id === selected);
  return <main style={{ padding: 24, display: "grid", gridTemplateColumns: "300px 1fr", gap: 24, minHeight: "100vh" }}>
    <section className="sidebar-session-group" style={{ width: 300 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}><strong>pi desktop</strong><ProjectFolderReferences roots={roots} primaryPath={roots[0].path} /></div>
      <SidebarSessionGroups groups={groupSessionsByGroup(sessions, catalog.groups, meta)} scope={scope} toggledGroups={toggledGroups}
        onToggle={key => setToggledGroups(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
        onManage={() => setTarget({ scope, name: "pi desktop" })}
        renderSessions={rows => rows.map(session => <div key={session.id} className="thread-item" data-session-id={session.id}>
          <Button variant="ghost" className="thread-item-main" onClick={() => setSelected(session.id)}><SessionLabelChips labels={catalog.labels} meta={meta[session.id] ?? {}} /><span className="thread-item-title">{session.title}</span></Button>
        </div>)} />
    </section>
    <section><h1>Isolated production-component fixture</h1><p>No Host, provider or daily profile is connected.</p>
      <pre id="fixture-state" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{JSON.stringify({ organization, meta, sessions: sessions.map(session => session.id) }, null, 2)}</pre>
    </section>
    {row ? <SidebarMenuPanel position={{ top: 200, left: 330 }} onKeyDown={event => { if (event.key === "Escape") setSelected(null); }} content={{ label: t("nav.sessionActions"), items: [
      sessionGroupMenu(row.id, catalog.groups, meta[row.id] ?? {}, t, () => { setSelected(null); setTarget({ scope, name: "pi desktop" }); }),
      ...sessionMarkMenu(row.id, catalog.labels, meta[row.id] ?? {}, t, () => { setSelected(null); setTarget({ scope, name: "pi desktop", tab: "labels" }); }),
    ] }} /> : null}
    {target ? <SessionOrganizationDialog target={target} onClose={() => setTarget(null)} /> : null}
  </main>;
}
