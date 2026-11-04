import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

/** Selection is scoped to rendered rows, never folded or filtered-out sessions. */
export function useSessionSelection(visibleIds: readonly string[]) {
  const [active, setActive] = useState(false);
  const [ids, setIds] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const visible = useMemo(() => new Set(visibleIds), [visibleIds]);
  const selectedIds = useMemo(() => new Set([...ids].filter((id) => visible.has(id))), [ids, visible]);

  useEffect(() => {
    setIds((previous) => {
      const next = new Set([...previous].filter((id) => visible.has(id)));
      return next.size === previous.size ? previous : next;
    });
    if (anchor.current && !visible.has(anchor.current)) anchor.current = null;
  }, [visible]);

  const enter = useCallback((id?: string) => {
    setActive(true);
    if (id) {
      setIds((previous) => new Set([...previous, id]));
      anchor.current = id;
    }
  }, []);
  const exit = useCallback(() => {
    setActive(false);
    setIds(new Set());
    anchor.current = null;
  }, []);
  const toggle = useCallback((id: string) => {
    setActive(true);
    setIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchor.current = id;
  }, []);
  const click = (event: MouseEvent, id: string) => {
    if (!active && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      anchor.current = id;
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    setActive(true);
    const start = anchor.current ? visibleIds.indexOf(anchor.current) : -1;
    const end = visibleIds.indexOf(id);
    if (event.shiftKey && start >= 0 && end >= 0) {
      const range = visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1);
      setIds((previous) => new Set([...previous, ...range]));
    } else {
      toggle(id);
    }
    return true;
  };
  const selectAll = () => {
    setActive(true);
    setIds(selectedIds.size === visible.size ? new Set() : new Set(visible));
  };
  const remove = (completed: readonly string[]) => {
    const removed = new Set(completed);
    setIds((previous) => new Set([...previous].filter((id) => !removed.has(id))));
  };

  return { active, selectedIds, enter, exit, toggle, click, selectAll, remove };
}
