import { memo, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { IconChevronRight, IconImage } from "../../../components/icons";
import { Button } from "../../../components/ui";
import type { AssistantTurnPart } from "../../../lib/assistant-turns";
import { turnToolImageMessages } from "../../../lib/tool-image-groups";
import { toolResultImageSet } from "../../../lib/tool-result-images";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../../stores/app-store";
import { GeneratedImages } from "./GeneratedImages";
import { GeneratedImageThumbnail } from "./GeneratedImageThumbnail";
import { GeneratedImageViewer } from "./GeneratedImageViewer";
import { useRestoredToolImages } from "./use-restored-tool-images";
import "../../../styles/generated-images.css";
import "../../../styles/tool-result-images.css";

export function TurnToolImages({ parts }: { parts: readonly AssistantTurnPart[] }) {
  const messages = useMemo(() => turnToolImageMessages(parts), [parts]);
  return <>{messages.map((message) => <ToolResultImages key={message.id} message={message} />)}</>;
}

export const ToolResultImages = memo(function ToolResultImages({ message }: { message: UiMessage }) {
  const paneSessionId = useSlotSessionId();
  const sessionId = useAppStore((state) => paneSessionId || state.activeSessionId);
  const result = toolResultImageSet(message);
  const key = `${sessionId}:${message.id}`;
  if (result.generated) return <GeneratedImages key={key} message={message} />;
  if (!result.images.length && !result.issueCodes.length && !result.displayOmitted) return null;
  return <ToolImageGallery key={key} message={message} sessionId={sessionId} />;
});

function ToolImageGallery({ message, sessionId }: { message: UiMessage; sessionId?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [viewerKey, setViewerKey] = useState<string | null>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const { result, restoring } = useRestoredToolImages(message, sessionId, open);
  const images = useMemo(() => result.images.map((image) => ({
    ...image,
    path: restoring && !image.dataUrl ? "" : image.path,
    key: JSON.stringify([message.id, image.index]),
    label: image.path.split(/[\\/]/).at(-1) || t("toolImages.image", { index: image.index + 1 }),
  })), [result, message.id, restoring, t]);
  const viewerIndex = images.findIndex((image) => image.key === viewerKey);
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
        {images.map((image, index) => <div key={image.key} className="tool-result-image-item"
          data-tool-image-message-id={message.id} data-tool-call-id={message.toolCallId}>
          <GeneratedImageThumbnail image={image}
            selected={viewerIndex === index} className="tool-result-image-thumb"
            onSelect={(trigger) => { focusReturnRef.current = trigger; setViewerKey(image.key); }} />
        </div>)}
      </div> : null}
    </> : null}
    {result.issueCodes.map((code) => <p className="tool-result-images-notice" role="status" key={code}>
      {t(`toolImages.${code}`)}
    </p>)}
    {result.displayOmitted ? <p className="tool-result-images-notice" role="status">
      {t("settings.imagePreviewUnavailable")}
    </p> : null}
    {viewerIndex >= 0 ? <GeneratedImageViewer
      images={images} selectedIndex={viewerIndex} onSelect={(index) => setViewerKey(images[index].key)}
      onClose={() => setViewerKey(null)} focusReturnRef={focusReturnRef} /> : null}
  </section>;
}
