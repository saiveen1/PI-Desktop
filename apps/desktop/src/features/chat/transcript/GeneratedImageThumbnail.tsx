import { Fragment, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconCircleAlert, IconClock } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { drawOverviewThumbnail } from "../../../lib/overview-thumbnail-crop";
import type { ToolResultImage } from "../../../lib/tool-result-images";
import { useImageNearViewport } from "../../../lib/use-image-near-viewport";
import { useReferencedImagePreviewState } from "../../../lib/use-referenced-image-data-url";
import "../../../styles/image-thumbnail-state.css";

export type GeneratedImageRef = ToolResultImage;

export function GeneratedImageThumbnail({ image, selected, onSelect, className, source }: {
  image: GeneratedImageRef;
  selected: boolean;
  onSelect: (trigger: HTMLButtonElement) => void;
  className: string;
  source?: string;
}) {
  const { t } = useTranslation();
  const [observe, near] = useImageNearViewport<HTMLButtonElement>();
  const [focused, setFocused] = useState(false);
  const eligible = !image.allowThumbnail || near || focused;
  const overview = image.allowThumbnail && className.split(/\s+/).includes("generated-overview-thumb");
  const preview = useReferencedImagePreviewState(eligible && !image.dataUrl ? image.path : null, image.mimeType, image.allowThumbnail);
  const src = eligible ? image.dataUrl ?? preview.dataUrl : undefined;
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const reason = !eligible ? "loading" : src ? (src === failedSrc ? "invalid" : undefined) : preview.reason ?? "loading";
  const statusText = reason && t(`imagePreviewState.${reason}`);
  const defaultLabel = t("settings.generatedImage", { index: image.index + 1 });
  const label = reason === "restricted" ? defaultLabel : image.label ?? defaultLabel;
  const tooltip = [label, !reason && source, statusText].filter(Boolean).join("\n");
  return (
    <TooltipButton
      ref={image.allowThumbnail ? observe : undefined}
      type="button"
      className={className}
      tooltip={tooltip}
      aria-current={selected ? "true" : undefined}
      aria-busy={reason === "loading" || undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={(event) => onSelect(event.currentTarget)}
    >
      {src && !reason ? <Fragment key={src}>
        <img ref={imgRef} src={src} alt=""
          onLoad={overview ? (event) => {
            if (event.currentTarget === imgRef.current && canvasRef.current) {
              canvasRef.current.hidden = !drawOverviewThumbnail(event.currentTarget, canvasRef.current);
            }
          } : undefined}
          onError={(event) => { if (event.currentTarget === imgRef.current) setFailedSrc(src); }} />
        {overview && <canvas ref={canvasRef} width={0} height={0} hidden aria-hidden="true" />}
      </Fragment> : <span className="image-thumbnail-status" role="status">
        {reason === "loading" ? <IconClock size={16} /> : <IconCircleAlert size={16} />}
        <span className="image-thumbnail-status-text">{statusText}</span>
      </span>}
    </TooltipButton>
  );
}
