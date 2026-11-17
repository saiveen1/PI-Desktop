import { createContext, useContext, type ReactNode } from "react";
import { ScopeContext, type DisclosureScopeValue } from "./disclosure-scope";

export const TurnActivityScope = createContext<DisclosureScopeValue | null>(null);

/** Fold activity in place so the intervening message bubbles never move or remount. */
export function TurnProcessActivity({ children }: { children: ReactNode }) {
  const scope = useContext(TurnActivityScope);
  if (!scope) return <>{children}</>;
  return <div className="turn-process-activity" hidden={!scope.visible} inert={!scope.visible}>
    <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
  </div>;
}
