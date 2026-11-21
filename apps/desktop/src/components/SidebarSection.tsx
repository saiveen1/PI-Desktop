import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { clampSidebarSectionHeight, SIDEBAR_SECTION_HEIGHT_MAX, SIDEBAR_SECTION_HEIGHT_MIN, type SidebarSectionId, type SidebarSectionPreference } from "../lib/sidebar-preferences";
import { IconChevronDown } from "./icons";
import { Button, cx } from "./ui";

export function SidebarSection({ id, label, count, preference, fill, onChange, onInteract, toolbar, actions, body, children }: {
  id: SidebarSectionId;
  label: string;
  count: number;
  preference?: SidebarSectionPreference;
  fill?: boolean;
  onChange: (id: SidebarSectionId, preference: SidebarSectionPreference) => void;
  onInteract: () => void;
  toolbar?: HTMLAttributes<HTMLDivElement> & { "data-sidebar-section"?: string };
  actions?: ReactNode;
  body: HTMLAttributes<HTMLDivElement>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const bodyId = `sidebar-section-${id}-body`;
  const labelId = `sidebar-section-${id}-label`;
  const collapsed = preference?.collapsed === true;
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; y: number; height: number; max: number } | null>(null);
  const [preview, setPreview] = useState<number>();
  const [renderedHeight, setRenderedHeight] = useState(SIDEBAR_SECTION_HEIGHT_MIN);
  const height = preview ?? preference?.height;
  const readHeight = () => scroller.current?.offsetHeight ?? SIDEBAR_SECTION_HEIGHT_MIN;
  const resizeStart = () => {
    const current = readHeight();
    const scroll = scroller.current;
    // The visible viewport may be compressed. Adjust the unconstrained size
    // so growing it never makes it shrink further against the same budget.
    const cap = scroll && !fill ? Number.parseFloat(getComputedStyle(scroll).maxHeight) : NaN;
    const automatic = Number.isFinite(cap) && scroll ? Math.max(current, Math.min(cap, scroll.scrollHeight)) : current;
    const start = preference?.height ?? automatic;
    const available = scroll?.closest(".sidebar-sections")?.clientHeight ?? SIDEBAR_SECTION_HEIGHT_MAX;
    return { height: start, max: Math.max(start, available + Math.max(0, start - current)) };
  };
  const setHeight = (height: number | undefined) => onChange(id, { ...preference, height });

  useEffect(() => {
    if (collapsed || !scroller.current) return;
    const observer = new ResizeObserver(() => setRenderedHeight(clampSidebarSectionHeight(readHeight())));
    observer.observe(scroller.current);
    return () => observer.disconnect();
  }, [collapsed]);

  const cancelDrag = () => {
    drag.current = null;
    setPreview(undefined);
  };
  return (
    <section
      aria-labelledby={labelId}
      className={cx("sidebar-section", id === "pinned" && "sidebar-pinned-sessions")}
      data-sidebar-session-section={id === "recent" ? "temporary" : id}
      data-collapsed={collapsed || undefined}
      data-fill={(fill && height === undefined) || undefined}
      style={height === undefined ? undefined : { "--sidebar-section-height": `${height}px` } as CSSProperties}
    >
      <div {...toolbar} className={cx("sidebar-list-toolbar", id !== "projects" && "sidebar-list-toolbar-secondary")}>
        <Button type="button" variant="ghost" id={labelId} className="sidebar-section-toggle sidebar-list-label"
          aria-controls={bodyId} aria-expanded={!collapsed} onClick={() => {
            cancelDrag();
            onInteract();
            onChange(id, { ...preference, collapsed: !collapsed });
          }}>
          <IconChevronDown size={12} aria-hidden="true" className={cx("sidebar-disclosure-icon", collapsed && "collapsed")} />
          <span className="sidebar-section-name">{label}</span>
          <span className="sidebar-section-count">{count}</span>
        </Button>
        {actions}
      </div>
      <div {...body} ref={scroller} id={bodyId} hidden={collapsed} className={cx("sidebar-section-scroll", body.className)}>
        {!collapsed && children}
      </div>
      {!collapsed && (
        <div className="sidebar-section-handle" role="separator" tabIndex={0} aria-orientation="horizontal"
          aria-controls={bodyId} aria-label={t("nav.resizeSidebarSection", { section: label })}
          aria-valuemin={SIDEBAR_SECTION_HEIGHT_MIN} aria-valuemax={SIDEBAR_SECTION_HEIGHT_MAX} aria-valuenow={renderedHeight}
          data-resizing={preview !== undefined || undefined}
          onPointerDown={event => {
            if (event.button !== 0 || drag.current) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { ...resizeStart(), pointerId: event.pointerId, y: event.clientY };
            onInteract();
          }}
          onPointerMove={event => {
            const start = drag.current;
            if (start?.pointerId !== event.pointerId) return;
            const delta = event.clientY - start.y;
            setPreview(delta === 0 ? undefined : clampSidebarSectionHeight(Math.min(start.max, start.height + delta)));
          }}
          onPointerUp={event => {
            const start = drag.current;
            if (start?.pointerId !== event.pointerId) return;
            cancelDrag();
            const next = clampSidebarSectionHeight(Math.min(start.max, start.height + event.clientY - start.y));
            if (next !== start.height) setHeight(next);
          }}
          onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) cancelDrag(); }}
          onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) cancelDrag(); }}
          onDoubleClick={() => setHeight(undefined)}
          onKeyDown={event => {
            const start = drag.current;
            if (start && event.key === "Escape") {
              event.preventDefault();
              cancelDrag();
              if (event.currentTarget.hasPointerCapture(start.pointerId)) event.currentTarget.releasePointerCapture(start.pointerId);
            } else if (!start && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
              event.preventDefault();
              const { height: current, max } = resizeStart();
              const next = clampSidebarSectionHeight(Math.min(max, current + (event.key === "ArrowDown" ? 16 : -16)));
              if (next !== current) {
                onInteract();
                setHeight(next);
              }
            }
          }}
        />
      )}
    </section>
  );
}
