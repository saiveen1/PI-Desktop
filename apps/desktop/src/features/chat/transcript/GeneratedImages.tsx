import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { generatedImageBatch, generatedImageDetails, summarizeGeneratedBatches, type GalleryImage, type GeneratedBatch } from "../../../lib/generated-image-groups";
import { useImageNearViewport } from "../../../lib/use-image-near-viewport";
import { useReferencedImagePreviewState } from "../../../lib/use-referenced-image-data-url";
import { useAppStore } from "../../../stores/app-store";
import { Button, TooltipButton } from "../../../components/ui";
import { GeneratedImageViewer } from "./GeneratedImageViewer";
import { GeneratedImageThumbnail } from "./GeneratedImageThumbnail";
import { ImageDownload } from "./ImageDownload";

function ImageResult({ image, onOpen }: { image: GalleryImage; onOpen: (trigger: HTMLButtonElement) => void }) {
  const { t } = useTranslation();
  const [frameRef, near] = useImageNearViewport<HTMLElement>();
  const preview = useReferencedImagePreviewState(near ? image.path : null, image.mimeType, true);
  const [failedSrc, setFailedSrc] = useState<string>();
  const decodeFailed = !!preview.dataUrl && preview.dataUrl === failedSrc;
  const src = !decodeFailed && preview.status === "ready" ? preview.dataUrl : undefined;
  const reason = !near || preview.status === "loading" ? "loading" : decodeFailed ? "invalid" : preview.reason ?? "unavailable";
  const label = t("settings.generatedImage", { index: image.index + 1 });
  return (
    <figure ref={frameRef} className="generated-image-card">
      <TooltipButton type="button" className="generated-image-preview" tooltip={label} aria-busy={reason === "loading" || undefined}
        onClick={event => onOpen(event.currentTarget)}>
        {src ? <img src={src} alt={label} onError={() => setFailedSrc(src)} />
          : <span role="status">{t(`imagePreviewState.${reason}`)}</span>}
      </TooltipButton>
      <figcaption className="generated-image-actions">
        {src ? <ImageDownload src={src} index={image.index} originalPath={preview.isThumbnail ? image.path : undefined} /> : null}
      </figcaption>
    </figure>
  );
}

export function GeneratedImages({ message }: { message: UiMessage }) {
  const { t } = useTranslation();
  const batch = useMemo(() => generatedImageBatch(message), [message]);
  if (batch) return <GeneratedBatchGallery key={message.id} batches={[batch]} />;
  const details = generatedImageDetails(message);
  const needsSetup = details?.kind === "image-generation-error" && [
    "IMAGE_NOT_CONFIGURED", "IMAGE_MODEL_UNAVAILABLE", "IMAGE_AUTH_FAILED", "IMAGE_AUTH_UNSUPPORTED",
  ].includes(String(details.errorCode));
  if (!needsSetup) return null;
  return <div className="generated-images" aria-label={t("settings.imageModel")}>
    <div>
      <p>{t("settings.imageModelSetupHint")}</p>
      <Button variant="ghost" onClick={() => {
        const state = useAppStore.getState();
        state.setSettingsTab("agent");
        state.setSettingsAnchor("settings.imageModel");
      }}>{t("settings.configureImageModel")}</Button>
    </div>
  </div>;
}

export function GeneratedBatchGallery({ batches }: { batches: readonly GeneratedBatch[] }) {
  const { t } = useTranslation();
  const { images, items, counts } = useMemo(() => summarizeGeneratedBatches(batches), [batches]);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [viewerOpen, setViewerOpen] = useState(false);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const gridRef = useRef<HTMLElement>(null);
  const compact = batches.length > 1;
  const viewerImages = useMemo(() => compact ? images.map(image => ({ ...image,
    label: t("generatedGallery.item", { batch: image.batch + 1, index: image.sourceIndex + 1 }),
  })) : images, [compact, images, t]);
  const selectedIndex = Math.max(0, images.findIndex(image => image.key === selectedKey));
  const selected = images[selectedIndex];
  const showOutcomes = compact || images.length < items.length;
  const openImage = (image: GalleryImage, trigger: HTMLButtonElement) => {
    focusReturnRef.current = trigger;
    setSelectedKey(image.key);
    setViewerOpen(true);
  };
  useLayoutEffect(() => {
    // A second batch replaces the open viewer's original card with a grid tile.
    if (viewerOpen && !focusReturnRef.current?.isConnected) {
      focusReturnRef.current = gridRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? null;
    }
  }, [compact, viewerOpen]);
  return <section className={compact ? "generated-overview" : "generated-images"} aria-label={t("generatedGallery.title")}>
    {showOutcomes ? <header className="generated-overview-summary">
      {compact && <strong>{t("generatedGallery.title")}</strong>}
      <span className="generated-overview-counts" role="status">
        {(["succeeded", "timedOut", "failed", "cancelled"] as const).map(outcome => counts[outcome] || outcome === "succeeded"
          ? <span key={outcome} data-outcome={outcome}>{t(`generatedGallery.${outcome}`, { count: counts[outcome] })}</span> : null)}
      </span>
    </header> : null}
    {selected && (compact ? (
      <nav ref={gridRef} className="generated-overview-grid" aria-label={t("chat.imagePreview.title")}>
        {images.map((image, index) => <div className="generated-overview-item" key={image.key}
          data-tool-image-message-id={image.messageId} data-tool-call-id={image.toolCallId} data-result-slot={image.slot}>
          <GeneratedImageThumbnail className="generated-overview-thumb" image={{ ...image, label: t("generatedGallery.openImage", { index: index + 1 }) }}
            selected={image.key === selected.key} onSelect={trigger => openImage(image, trigger)} />
        </div>)}
      </nav>
    ) : (
      <div className={`generated-image-set${images.length > 1 ? " is-multiple" : ""}`}>
        <ImageResult image={selected} onOpen={trigger => openImage(selected, trigger)} />
        {images.length > 1 && <nav className="generated-image-thumbnails" aria-label={t("chat.imagePreview.title")}>
          {images.map(image => <GeneratedImageThumbnail key={image.key} className="generated-image-thumb" image={image}
            selected={image.key === selected.key} onSelect={() => setSelectedKey(image.key)} />)}
        </nav>}
      </div>
    ))}
    {showOutcomes && <details className="generated-overview-trace">
      <summary>{t("generatedGallery.details")}</summary>
      <ol>{items.map(item => <li key={item.key} data-tool-image-message-id={item.messageId} data-tool-call-id={item.toolCallId} data-result-slot={item.slot}>
        <span>{t("generatedGallery.item", { batch: item.batch + 1, index: item.sourceIndex + 1 })}</span>
        <span>{t(`generatedGallery.${item.outcome}`, { count: 1 })}</span>
        {item.errorCode && <code>{item.errorCode}</code>}
      </li>)}</ol>
    </details>}
    {viewerOpen && selected && <GeneratedImageViewer images={viewerImages} selectedIndex={selectedIndex}
      onSelect={index => setSelectedKey(images[index].key)} onClose={() => setViewerOpen(false)} focusReturnRef={focusReturnRef} />}
  </section>;
}
