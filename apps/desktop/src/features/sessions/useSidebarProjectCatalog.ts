import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";

/** Host project records are read-only; only presentation metadata is edited here. */
export function useSidebarProjectCatalog() {
  const projects = useAppStore(state => state.sidebarProjectGroups);
  const openProjects = useAppStore(state => state.openProjects);
  const workspace = useAppStore(state => state.workspace);
  const page = useAppStore(state => state.page);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const catalogKey = JSON.stringify([page, workspace?.path, workspace?.name, openProjects.map(project => [project.path, project.name])]);
  useEffect(() => {
    let cancelled = false;
    void api.listProjectGroups().then(({ groups }) => {
      if (!cancelled) useAppStore.getState().setSidebarProjectGroups(groups);
    }).catch(error => {
      if (!cancelled) useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    });
    return () => { cancelled = true; };
  }, [catalogKey, revision]);
  return { projects, refresh };
}
