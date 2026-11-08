import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { IconChevronRight, IconImage } from "../../../components/icons";
import { Button } from "../../../components/ui";
import { toolResultImageSet, type ToolImageSet } from "../../../lib/tool-result-images";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../../stores/app-store";
import { GeneratedImages } from "./GeneratedImages";
import { GeneratedImageThumbnail } from "./GeneratedImageThumbnail";
import { GeneratedImageViewer } from "./GeneratedImageViewer";
import "../../../styles/generated-images.css";
import "../../../styles/tool-result-images.css";

export function ToolResultImages({ message }: { message: UiMessage }) {
  const paneSessionId = useSlotSessionId();
  const sessionId = useAppStore((state) => paneSessionId || state.activeSessionId);
  const result = toolResultImageSet(message);
  const key = `${sessionId}:${message.id}`;
  if (result.generated) return <GeneratedImages key={key} message={message} />;
  if (!result.images.length && !result.issueCodes.length) return null;
  return <ToolImageGallery key={key} result={result} message={message} />;
}

function ToolImageGallery({ result, message }: { result: ToolImageSet; message: UiMessage }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const images = useMemo(() => result.images.map((image) => ({
    ...image,
    label: image.path.split(/[\\/]/).at(-1) || t("toolImages.image", { index: image.index + 1 }),
  })), [result, t]);
  return <section className="tool-result-images" data-tool-image-message-id={message.id} aria-label={t("toolImages.title")}>
    {images.length ? <>
      <Button variant="ghost" className="tool-result-images-heading" aria-expanded={open}
        title={t("toolImages.readHint")} onClick={() => setOpen(!open)}>
        <IconImage size={15} />
        <span className="tool-result-images-count">{t("toolImages.returned", { count: images.length })}</span>
        <span className="tool-result-images-source">{message.toolName}</span>
        <IconChevronRight size={12} className={open ? "is-open" : undefined} />
      </Button>
      {open ? <div className="tool-result-image-thumbnails">
        {images.map((image, index) => <GeneratedImageThumbnail key={image.index} image={image}
          selected={viewerIndex === index} className="tool-result-image-thumb"
          onSelect={(trigger) => { focusReturnRef.current = trigger; setViewerIndex(index); }} />)}
      </div> : null}
    </> : null}
    {result.issueCodes.map((code) => <p className="tool-result-images-notice" role="status" key={code}>
      {t(`toolImages.${code}`)}
    </p>)}
    {viewerIndex !== null && images[viewerIndex] ? <GeneratedImageViewer
      images={images} selectedIndex={viewerIndex} onSelect={setViewerIndex}
      onClose={() => setViewerIndex(null)} focusReturnRef={focusReturnRef} /> : null}
  </section>;
}
