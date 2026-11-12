import { memo, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { IconChevronRight, IconImage } from "../../../components/icons";
import { Button } from "../../../components/ui";
import type { AssistantTurnPart } from "../../../lib/assistant-turns";
import { groupTurnToolImages } from "../../../lib/tool-image-groups";
import { toolResultImageSet } from "../../../lib/tool-result-images";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../../stores/app-store";
import { GeneratedImages } from "./GeneratedImages";
import { GeneratedImageThumbnail } from "./GeneratedImageThumbnail";
import { GeneratedImageViewer } from "./GeneratedImageViewer";
import "../../../styles/generated-images.css";
import "../../../styles/tool-result-images.css";

export function TurnToolImages({ parts }: { parts: readonly AssistantTurnPart[] }) {
  const groups = useMemo(() => groupTurnToolImages(parts), [parts]);
  return <>{groups.map((messages) => <ToolImageResults key={messages[0].id} messages={messages} />)}</>;
}

export function ToolResultImages({ message }: { message: UiMessage }) {
  return <ToolImageResults messages={[message]} />;
}

const ToolImageResults = memo(function ToolImageResults({ messages }: { messages: readonly UiMessage[] }) {
  const paneSessionId = useSlotSessionId();
  const sessionId = useAppStore((state) => paneSessionId || state.activeSessionId);
  const first = messages[0];
  const result = toolResultImageSet(first);
  const key = `${sessionId}:${first.id}`;
  if (result.generated) return <GeneratedImages key={key} message={first} />;
  if (!result.images.length && !result.issueCodes.length && !result.displayOmitted) return null;
  return <ToolImageGallery key={key} messages={messages} />;
}, (previous, next) => previous.messages.length === next.messages.length &&
  previous.messages.every((message, index) => message === next.messages[index]));

function ToolImageGallery({ messages }: { messages: readonly UiMessage[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [viewerKey, setViewerKey] = useState<string | null>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const results = useMemo(() => messages.map((message) => ({ message, result: toolResultImageSet(message) })), [messages]);
  const images = useMemo(() => results.flatMap(({ message, result }) => result.images.map((image) => ({
    ...image,
    key: JSON.stringify([message.id, image.index]),
    messageId: message.id,
    callId: message.toolCallId,
    label: image.path.split(/[\\/]/).at(-1) || t("toolImages.image", { index: image.index + 1 }),
    source: messages.length > 1 ? `${message.toolName} · ${message.toolCallId || message.id}` : undefined,
  }))).map((image, index) => ({ ...image, index })), [results, messages.length, t]);
  const issueCodes = [...new Set(results.flatMap(({ result }) => result.issueCodes))];
  const viewerIndex = images.findIndex((image) => image.key === viewerKey);
  return <section className="tool-result-images" data-tool-image-message-id={messages[0].id} aria-label={t("toolImages.title")}>
    {images.length ? <>
      <Button variant="ghost" className="tool-result-images-heading" aria-expanded={open}
        title={t("toolImages.readHint")} onClick={() => setOpen(!open)}>
        <IconImage size={15} />
        <span className="tool-result-images-count">{t("toolImages.returned", { count: images.length })}</span>
        <span className="tool-result-images-source">{messages[0].toolName}</span>
        <IconChevronRight size={12} className={open ? "is-open" : undefined} />
      </Button>
      {open ? <div className="tool-result-image-thumbnails">
        {images.map((image, index) => <div key={image.key} className="tool-result-image-item"
          data-tool-image-message-id={image.messageId} data-tool-call-id={image.callId}>
          <GeneratedImageThumbnail image={image} source={image.source}
            selected={viewerIndex === index} className="tool-result-image-thumb"
            onSelect={(trigger) => { focusReturnRef.current = trigger; setViewerKey(image.key); }} />
        </div>)}
      </div> : null}
    </> : null}
    {issueCodes.map((code) => <p className="tool-result-images-notice" role="status" key={code}>
      {t(`toolImages.${code}`)}
    </p>)}
    {results.some(({ result }) => result.displayOmitted) ? <p className="tool-result-images-notice" role="status">
      {t("settings.imagePreviewUnavailable")}
    </p> : null}
    {viewerIndex >= 0 ? <GeneratedImageViewer
      images={images} selectedIndex={viewerIndex} onSelect={(index) => setViewerKey(images[index].key)}
      onClose={() => setViewerKey(null)} focusReturnRef={focusReturnRef} /> : null}
  </section>;
}
