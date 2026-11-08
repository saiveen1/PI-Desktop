import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, TooltipButton } from "../../components/ui";
import { IconClose } from "../../components/icons";
import { SESSION_COLORS, EXTRA_SESSION_COLORS, sessionColor, sessionColorCss, colorToHex, hexToHsv, hsvToHex, type HsvColor, type SessionColor } from "../../lib/session-colors";
import "../../styles/session-color-picker.css";

export function SessionColorPicker({ value, onChange, allowClear = false, clearLabel }: {
  value?: SessionColor; onChange: (value: SessionColor | undefined) => void; allowClear?: boolean; clearLabel?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [hsv, setHsv] = useState(() => hexToHsv(value ?? "blue"));
  const [draft, setDraft] = useState<string>(() => colorToHex(value ?? "blue"));
  const hsvRef = useRef(hsv);
  const emitted = useRef(value);
  const pointer = useRef<number | null>(null);
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    const next = hexToHsv(value ?? "blue");
    hsvRef.current = next; setHsv(next); setDraft(colorToHex(value ?? "blue"));
  }, [value]);
  const choose = (color: SessionColor | undefined) => {
    emitted.current = color;
    if (color) { const next = hexToHsv(color); hsvRef.current = next; setHsv(next); setDraft(colorToHex(color)); }
    onChange(color);
  };
  const commit = (next: HsvColor) => {
    next = { h: Math.max(0, Math.min(360, next.h)), s: Math.max(0, Math.min(100, next.s)), v: Math.max(0, Math.min(100, next.v)) };
    hsvRef.current = next; setHsv(next);
    const color = hsvToHex(next); emitted.current = color; setDraft(color); onChange(color);
  };
  const updateBoard = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width && rect.height) commit({ ...hsvRef.current, s: (event.clientX - rect.left) / rect.width * 100, v: (1 - (event.clientY - rect.top) / rect.height) * 100 });
  };
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const valid = sessionColor(draft);
  const invalid = !valid;
  return <div className="session-color-picker" role="group" aria-label={t("sessionLabels.color")}>
    <div className="session-color-presets">
      {allowClear ? <TooltipButton type="button" tooltip={clearLabel ?? t("sessionLabels.clearColor")} ariaLabel={clearLabel ?? t("sessionLabels.clearColor")}
        aria-pressed={!value} onClick={() => choose(undefined)}><IconClose size={13} /></TooltipButton> : null}
      {[...SESSION_COLORS, ...EXTRA_SESSION_COLORS].map(color => <TooltipButton type="button" key={color} className="session-color-preset"
        tooltip={color.startsWith("#") ? color : t(`sessionLabels.colors.${color}`)} ariaLabel={color.startsWith("#") ? color : t(`sessionLabels.colors.${color}`)}
        aria-pressed={value === color} onClick={() => choose(color)}>
        <span className="session-picker-swatch" style={{ backgroundColor: sessionColorCss(color) }} aria-hidden />
      </TooltipButton>)}
      <Button type="button" variant="ghost" className="session-custom-color-toggle" aria-expanded={expanded} aria-controls={`${id}-custom`}
        onClick={() => setExpanded(open => !open)}>{t("sessionLabels.customColor")}</Button>
    </div>
    {expanded ? <div id={`${id}-custom`} className="session-custom-color">
      <div className="session-color-board" role="slider" tabIndex={0} aria-label={`${t("sessionLabels.saturation")} / ${t("sessionLabels.brightness")}`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv.s)}
        aria-valuetext={`${t("sessionLabels.saturation")} ${Math.round(hsv.s)}%, ${t("sessionLabels.brightness")} ${Math.round(hsv.v)}%`}
        style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 100, v: 100 }) }}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); updateBoard(event); }}
        onPointerMove={event => { if (pointer.current === event.pointerId) updateBoard(event); }}
        onPointerUp={release} onPointerCancel={release} onLostPointerCapture={() => { pointer.current = null; }}
        onKeyDown={event => {
          const next = { ...hsvRef.current }; const step = event.shiftKey ? 10 : 1;
          if (event.key === "ArrowLeft") next.s -= step; else if (event.key === "ArrowRight") next.s += step;
          else if (event.key === "ArrowUp") next.v += step; else if (event.key === "ArrowDown") next.v -= step;
          else if (event.key === "Home") next.s = 0; else if (event.key === "End") next.s = 100; else return;
          event.preventDefault(); commit(next);
        }}>
        <span className="session-color-board-cursor" style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%` }} />
      </div>
      <div className="session-color-sliders">{(["h", "s", "v"] as const).map(channel => <label key={channel}>
        <span>{t(channel === "h" ? "sessionLabels.hue" : channel === "s" ? "sessionLabels.saturation" : "sessionLabels.brightness")}</span>
        <Input type="range" min={0} max={channel === "h" ? 360 : 100} step={1} value={Math.round(hsv[channel])}
          onChange={event => commit({ ...hsvRef.current, [channel]: Number(event.target.value) })} />
      </label>)}</div>
      <div className="session-color-hex">
        <span className="session-color-preview" role="img" aria-label={t("sessionLabels.colorPreview")} style={{ backgroundColor: sessionColorCss(value ?? hsvToHex(hsv)) }} />
        <label htmlFor={`${id}-hex`}>{t("sessionLabels.hexColor")}</label>
        <Input id={`${id}-hex`} value={draft} maxLength={7} spellCheck={false} aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined}
          onChange={event => { const text = event.target.value; setDraft(text); const color = sessionColor(text); if (color) { emitted.current = color;
            const next = hexToHsv(color); hsvRef.current = next; setHsv(next); onChange(color); } }}
          onBlur={() => { if (valid) setDraft(colorToHex(valid)); }} />
      </div>
      {invalid ? <p id={`${id}-error`} className="session-color-error" role="status">{t("sessionLabels.invalidColor")}</p> : null}
    </div> : null}
  </div>;
}
