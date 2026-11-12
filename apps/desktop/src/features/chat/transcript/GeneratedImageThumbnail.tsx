import { useState } from "react";
import type { ToolResultImage } from "../../../lib/tool-result-images";
import { useTranslation } from "react-i18next";
import { TooltipButton } from "../../../components/ui";
import { useReferencedImageDataUrl } from "../../../lib/use-referenced-image-data-url";

export type GeneratedImageRef = ToolResultImage;

export function GeneratedImageThumbnail({ image, selected, onSelect, className, source }: {
  image: GeneratedImageRef;
  selected: boolean;
  onSelect: (trigger: HTMLButtonElement) => void;
  className: string;
  source?: string;
}) {
  const { t } = useTranslation();
  const referencedSrc = useReferencedImageDataUrl(image.dataUrl ? null : image.path, image.mimeType);
  const src = image.dataUrl ?? referencedSrc;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const label = image.label ?? t("settings.generatedImage", { index: image.index + 1 });
  return (
    <TooltipButton
      type="button"
      className={className}
      tooltip={source ? `${label}\n${source}` : label}
      aria-current={selected ? "true" : undefined}
      onClick={(event) => onSelect(event.currentTarget)}
    >
      {src && src !== failedSrc ? <img src={src} alt="" onError={() => setFailedSrc(src)} />
        : <span role="status">{t("settings.imagePreviewUnavailable")}</span>}
    </TooltipButton>
  );
}
