import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useChatNativeFilesAllowed } from "../../../hooks/use-chat-session-capability";
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronLeft, IconChevronRight, IconClose, IconExternal, IconFolder, IconMinus, IconPlus } from "../../../components/icons";
import { Button, OverlayBackdrop, TooltipButton } from "../../../components/ui";
import { useOpenChatFileRef } from "../../../hooks/use-preview-target";
import { api } from "../../../lib/api";
import { useBlockingOverlay } from "../../../lib/blocking-overlay";
import { portalToBody } from "../../../lib/portal-visibility";
import { useReferencedImagePreviewState } from "../../../lib/use-referenced-image-data-url";
import { useAppStore } from "../../../stores/app-store";
import { ImageDownload } from "./ImageDownload";
import { GeneratedImageThumbnail, type GeneratedImageRef } from "./GeneratedImageThumbnail";
import "../../../styles/generated-image-viewer.css";

type ViewerImage = GeneratedImageRef & { key?: string };
type ImageKey = string | number;
type ImageSource = { key: ImageKey; src: string };
const imageKey = (image: ViewerImage): ImageKey => image.key ?? image.index;
type OriginalOwner = { path: string; mimeType?: string; sessionId: string };
type OriginalState = { owner: OriginalOwner } & (
  { status: "loading" | "failed" } | { status: "ready"; src: string; width: number; height: number }
);
const rasterMime = /^image\/(?:png|jpeg|webp)$/;
const rasterDataUrl = /^data:(image\/(?:png|jpeg|webp));base64,/;

export function GeneratedImageViewer({ images, selectedIndex, onSelect, onClose, focusReturnRef }: {
  images: ViewerImage[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
  focusReturnRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const paneSessionId = useSlotSessionId();
  const sessionId = useAppStore((state) => paneSessionId || state.activeSessionId);
  const nativeFilesAllowed = useChatNativeFilesAllowed();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const latestGallery = useRef({ images, onSelect });
  const navigationRequestRef = useRef(0);
  const pendingKeyRef = useRef<ImageKey | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState<(ImageSource & { width: number; height: number }) | null>(null);
  const [manualZoom, setManualZoom] = useState<(ImageSource & { original: boolean; value: number }) | null>(null);
  const [failedSource, setFailedSource] = useState<ImageSource | null>(null);
  const [originalState, setOriginalState] = useState<OriginalState | null>(null);
  const originalRequest = useRef<{ candidate?: HTMLImageElement } | null>(null);
  const selected = images[selectedIndex];
  const selectedKey = selected && imageKey(selected);
  const referenced = useReferencedImagePreviewState(selected?.dataUrl ? null : selected?.path, selected?.mimeType, selected?.allowThumbnail);
  const previewSrc = selected?.dataUrl ?? (referenced.status === "ready" ? referenced.dataUrl : undefined);
  const failed = failedSource?.key === selectedKey && failedSource?.src === previewSrc;
  const reduced = !selected?.dataUrl && referenced.isThumbnail === true;
  const originalPath = nativeFilesAllowed && reduced ? selected?.path : undefined;
  const previewSize = previewSrc && !failed && natural?.key === selectedKey && natural?.src === previewSrc ? natural : null;
  const mimeType = selected?.mimeType;
  const canReadOriginal = !!(selected?.allowThumbnail && previewSize && rasterDataUrl.test(previewSrc ?? "") && (!mimeType || rasterMime.test(mimeType)));
  const originalOwner = useMemo(() => originalPath && sessionId && canReadOriginal
    ? { path: originalPath, mimeType, sessionId } : null,
  [originalPath, sessionId, mimeType, canReadOriginal, selectedKey, previewSrc]);
  const original = originalState?.owner === originalOwner ? originalState : null;
  const originalImage = original?.status === "ready" ? original : null;
  const src = originalImage?.src ?? previewSrc;
  const status = failed ? "invalid" : referenced.status === "loading" ? "loading" : referenced.reason ?? "unavailable";
  const label = selected?.label ?? t("settings.generatedImage", { index: (selected?.index ?? 0) + 1 });
  const size = originalImage ?? previewSize;
  const fit = size && viewport.width > 0 && viewport.height > 0
    ? Math.min(1, viewport.width / size.width, viewport.height / size.height)
    : 1;
  const zoom = manualZoom && manualZoom.key === selectedKey && manualZoom.src === previewSrc && manualZoom.original === !!originalImage
    ? manualZoom.value : fit;
  const openFile = useOpenChatFileRef();
  useBlockingOverlay();

  useLayoutEffect(() => {
    setOriginalState(null);
    return () => {
      originalRequest.current?.candidate?.removeAttribute("src");
      originalRequest.current = null;
    };
  }, [originalOwner]);

  const showingOriginal = !!originalImage;
  useLayoutEffect(() => {
    viewportRef.current?.scrollTo(0, 0);
  }, [showingOriginal]);

  useLayoutEffect(() => {
    latestGallery.current = { images, onSelect };
  }, [images, onSelect]);

  useLayoutEffect(() => () => {
    navigationRequestRef.current += 1;
    pendingKeyRef.current = null;
  }, [selectedKey, sessionId]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      dialog.close();
      focusReturnRef.current?.focus({ preventScroll: true });
    };
  }, [focusReturnRef]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const resize = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const selectImage = async (nextIndex: number) => {
    const target = images[nextIndex];
    if (!target) return;
    const key = imageKey(target);
    const request = ++navigationRequestRef.current;
    if (key === selectedKey) {
      pendingKeyRef.current = null;
      return;
    }
    pendingKeyRef.current = key;
    const thumbnail = dialogRef.current?.querySelectorAll(".generated-image-viewer-thumb")[nextIndex]?.querySelector("img");
    const thumbnailSrc = thumbnail?.src;
    if (thumbnail && thumbnailSrc) {
      try {
        await thumbnail.decode();
      } catch {
        // The selected image reports its own decode error.
      }
    }
    if (request !== navigationRequestRef.current) return;
    pendingKeyRef.current = null;
    const gallery = latestGallery.current;
    const index = gallery.images.findIndex((image) => imageKey(image) === key);
    if (index < 0) return;
    if (thumbnail && thumbnailSrc && thumbnail.src === thumbnailSrc && thumbnail.naturalWidth > 0 && thumbnail.naturalHeight > 0) {
      setNatural({ key, src: thumbnailSrc, width: thumbnail.naturalWidth, height: thumbnail.naturalHeight });
    }
    gallery.onSelect(index);
  };
  const move = (direction: number) => {
    const pendingIndex = images.findIndex((image) => imageKey(image) === pendingKeyRef.current);
    void selectImage((pendingIndex >= 0 ? pendingIndex : selectedIndex) + direction);
  };
  const closeViewer = () => {
    navigationRequestRef.current += 1;
    pendingKeyRef.current = null;
    onClose();
  };
  const changeZoom = (value: number) => {
    if (previewSrc && selectedKey !== undefined) {
      setManualZoom({ key: selectedKey, src: previewSrc, original: !!originalImage, value: Math.min(4, Math.max(Math.min(0.1, fit), value)) });
    }
  };
  const reveal = async () => {
    if (!nativeFilesAllowed || !selected?.path) return;
    try {
      await api.fsReveal(selected.path, sessionId);
    } catch {
      useAppStore.getState().showToast(t("settings.imageRevealFailed"), { variant: "error" });
    }
  };
  const toggleOriginal = async () => {
    if (!originalOwner || originalRequest.current || original?.status === "loading") return;
    if (originalImage) {
      setManualZoom(null);
      setOriginalState(null);
      return;
    }
    const request: { candidate?: HTMLImageElement } = {};
    originalRequest.current = request;
    setOriginalState({ owner: originalOwner, status: "loading" });
    const fail = () => setOriginalState({ owner: originalOwner, status: "failed" });
    try {
      const result = await api.fsReadGeneratedOriginal(originalOwner.path, originalOwner.mimeType, originalOwner.sessionId);
      if (originalRequest.current !== request) return;
      if (result.kind !== "image" || result.isThumbnail || !result.dataUrl) return fail();
      const mime = rasterDataUrl.exec(result.dataUrl)?.[1];
      if (!mime || (originalOwner.mimeType && mime !== originalOwner.mimeType)) return fail();
      const candidate = request.candidate = new Image();
      candidate.src = result.dataUrl;
      await candidate.decode();
      if (originalRequest.current !== request) return;
      const { naturalWidth: width, naturalHeight: height } = candidate;
      if (!width || !height) return fail();
      setOriginalState({ owner: originalOwner, status: "ready", src: result.dataUrl, width, height });
    } catch {
      if (originalRequest.current === request) fail();
    } finally {
      request.candidate?.removeAttribute("src");
      if (originalRequest.current === request) originalRequest.current = null;
    }
  };
  const saveOriginal = async () => {
    if (!originalPath) return;
    try {
      // Save As validates containment and copies bytes without executing a file association.
      await api.fsSaveAs(originalPath, sessionId);
    } catch {
      useAppStore.getState().showToast(t("chat.fileActionFailed"), { variant: "error" });
    }
  };
  if (!selected) return null;

  return portalToBody(
    <dialog
      ref={dialogRef}
      className="generated-image-viewer"
      aria-label={label}
      onCancel={(event) => { event.preventDefault(); closeViewer(); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          move(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <OverlayBackdrop className="generated-image-viewer-scrim" onClick={closeViewer}>
        <header className="generated-image-viewer-header">
          <TooltipButton type="button" autoFocus onClick={closeViewer} tooltip={t("common.close")}><IconClose size={18} /></TooltipButton>
          <strong>{label}</strong>
          <div className="generated-image-viewer-header-actions">
            {selected.path ? <TooltipButton type="button" onClick={() => { closeViewer(); void openFile(selected.path); }} tooltip={t("chat.previewFile")}><IconExternal size={18} /></TooltipButton> : null}
            {nativeFilesAllowed && selected.path ? <TooltipButton type="button" onClick={() => void reveal()} tooltip={t("settings.revealGeneratedImage")}><IconFolder size={18} /></TooltipButton> : null}
            {src && !failed && !reduced ? <ImageDownload src={src} index={selected.index} /> : null}
          </div>
        </header>
        <div className="generated-image-viewer-body">
          {images.length > 1 ? <nav className="generated-image-viewer-thumbs" aria-label={t("chat.imagePreview.title")}>
            {images.map((image, index) => <GeneratedImageThumbnail key={imageKey(image)} image={image} selected={index === selectedIndex} onSelect={() => void selectImage(index)} className="generated-image-viewer-thumb" />)}
          </nav> : null}
          <OverlayBackdrop className="generated-image-viewer-viewport" ref={viewportRef} onClick={closeViewer}>
            {src && !failed ? <img
              key={originalImage ? "original" : selectedKey}
              src={src}
              alt={label}
              draggable={false}
              data-sized={size ? "true" : undefined}
              style={size ? { width: size.width * zoom, height: size.height * zoom } : undefined}
              onLoad={originalImage ? undefined : (event) => {
                const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
                if (width > 0 && height > 0) setNatural({ key: imageKey(selected), src, width, height });
              }}
              onError={() => {
                if (originalImage) setOriginalState({ owner: originalImage.owner, status: "failed" });
                else setFailedSource({ key: imageKey(selected), src });
              }}
            /> : <p role="status">{t(`imagePreviewState.${status}`)}</p>}
          </OverlayBackdrop>
        </div>
        <footer className="generated-image-viewer-footer">
          {((reduced && src && !failed) || originalPath) ? <div className="generated-image-viewer-preview-info">
            {reduced && src && !failed ? <span role="status">{t(originalImage ? "imagePreviewState.original" : "imagePreviewState.reduced")}</span> : null}
            {originalOwner ? <Button type="button" variant="ghost" aria-disabled={original?.status === "loading" || undefined}
              onClick={() => void toggleOriginal()}>{t(originalImage ? "imagePreviewState.showPreview" : "imagePreviewState.openOriginal")}</Button> : null}
            {originalPath ? <Button type="button" variant="ghost" onClick={() => void saveOriginal()}>{t("chat.fileSaveAs")}</Button> : null}
            {original?.status === "loading" || original?.status === "failed" ? <span className="generated-image-viewer-original-status" role="status">
              {t(original.status === "loading" ? "imagePreviewState.loading" : "imagePreviewState.openOriginalFailed")}
            </span> : null}
          </div> : null}
          {images.length > 1 ? <div className="generated-image-viewer-navigation">
            <TooltipButton type="button" disabled={selectedIndex === 0} onClick={() => move(-1)} tooltip={t("chat.imagePreview.previous")}><IconChevronLeft size={18} /></TooltipButton>
            <span role="status">{t("chat.imagePreview.position", { current: selectedIndex + 1, total: images.length })}</span>
            <TooltipButton type="button" disabled={selectedIndex === images.length - 1} onClick={() => move(1)} tooltip={t("chat.imagePreview.next")}><IconChevronRight size={18} /></TooltipButton>
          </div> : null}
          <div className="generated-image-viewer-zoom">
            <TooltipButton type="button" disabled={!size || zoom <= Math.min(0.1, fit)} onClick={() => changeZoom(zoom / 1.25)} tooltip={t("menu.zoomOut")}><IconMinus size={18} /></TooltipButton>
            <output>{Math.round(zoom * 100)}%</output>
            {originalImage ? <TooltipButton type="button" tooltip={t("menu.actualSize")} onClick={() => changeZoom(1)}>100%</TooltipButton> : null}
            <TooltipButton type="button" disabled={!size || zoom >= 4} onClick={() => changeZoom(zoom * 1.25)} tooltip={t("menu.zoomIn")}><IconPlus size={18} /></TooltipButton>
            <Button type="button" variant="ghost" disabled={!size} onClick={() => setManualZoom(null)}>{t("chat.imagePreview.fit")}</Button>
          </div>
        </footer>
      </OverlayBackdrop>
    </dialog>,
  );
}
