import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { SidebarSessionGroups } from "../../src/features/sessions/SidebarSessionGroups";
import { ProjectGroupCreateButton } from "../../src/features/sessions/ProjectGroupCreateButton";
import "../../src/styles/sidebar-threads.css";

await i18n.init({ lng: "en", resources: { en: { translation: { sessionGroups: { manage: "Manage", ungrouped: "Ungrouped" }, project: { newTask: "New task" }, nav: { projectRunningCount: "{{count}} running", projectNeedsActionCount: "{{count}} waiting", projectCompletedCount: "{{count}} completed", projectFailedCount: "{{count}} failed", groupTotalCount: "{{count}} total" } } } } });
const groups = [{ id: "a", name: "Alpha", color: "red" }, { id: "b", name: "Beta", color: "blue" }];
window.created = [];
function Fixture() {
  const [folded, setFolded] = useState(new Set());
  return <I18nextProvider i18n={i18n}><div className="sidebar-session-group-header">
    <ProjectGroupCreateButton groups={groups} label="Create project task" onCreate={id => window.created.push(id)} />
    <ProjectGroupCreateButton groups={[]} label="Create directly" onCreate={id => window.created.push(id)} />
    <ProjectGroupCreateButton groups={groups} label="Disabled create" disabled onCreate={id => window.created.push(id)} />
  </div><SidebarSessionGroups groups={[{ group: groups[0], sessions: [{ id: "1" }, { id: "2" }], visibleSessions: [{ id: "1" }] }, { group: null, sessions: [] }]}
    scope="test" toggledGroups={folded} onToggle={key => setFolded(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; })}
    onManage={() => {}} onCreate={id => window.created.push(id)} renderSessions={sessions => <span data-sessions>{sessions.map(row => row.id).join(",")}</span>}
    summarize={sessions => ({ total: sessions.length, running: sessions.length, waiting: 0, completed: 0, failed: 0 })} />
  </I18nextProvider>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
window.fixtureReady = true;
