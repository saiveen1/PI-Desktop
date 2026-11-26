import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { ToolResultImages } from "../../src/features/chat/transcript/ToolResultImages";
import { ToolRow } from "../../src/features/chat/transcript/ToolRow";
import { AssistantTurn } from "../../src/features/chat/transcript/AssistantTurn";
import { SubagentTurnContent } from "../../src/features/chat/transcript/SubagentTurnContent";
import { TranscriptDisclosureProvider } from "../../src/features/chat/transcript/disclosure";
import { SlotSessionProvider } from "../../src/plugins/renderer-slots/use-slots";
import { buildTranscriptEntries } from "../../src/lib/assistant-turns";
import { buildToolPresentation } from "../../src/lib/tool-presentation";
import { api } from "../../src/lib/api";
import { useAppStore } from "../../src/stores/app-store";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/ui-kit.css";

const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] } } });
document.documentElement.style.setProperty("--font-scale", "1");
const view = createRoot(document.getElementById("root")!);
const image = (color: string, width = 120, height = 80, transparent = false) => {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color; context.fillRect(0, 0, width, height);
  if (transparent) context.clearRect(0, 0, width / 2, height);
  return { type: "image", mimeType: "image/png", data: canvas.toDataURL().split(",")[1] };
};
const red = image("red"), blue = image("blue");
const redUrl = `data:image/png;base64,${red.data}`, blueUrl = `data:image/png;base64,${blue.data}`;
const reducedUrl = `data:image/png;base64,${image("blue", 560, 140, true).data}`;
const originalUrl = `data:image/png;base64,${image("blue", 1440, 360, true).data}`;
const message = (id: string, toolResult: unknown, toolName = "Read"): UiMessage => ({
  id, role: "tool", content: "", toolName, toolCallId: `call-${id}`, toolArgs: { path: "sample.png" }, toolResult,
  toolStatus: "success", status: "complete", createdAt: "2026-11-08T00:00:00Z",
});
const original = message("mcp", { content: [red, blue], details: { content: [red, blue, red] } }, "mcp_screenshot");
const groupedReads = Array.from({ length: 6 }, (_, index) => message(`read-${index}`, {
  path: `capture-${index}.png`, images: [index % 2 ? blue : red],
}));
const galleryImages = ["red", "blue", "green", "orange", "purple", "cyan"].map((color, index) => ({
  ...image(color), path: `capture-${index}.png`,
}));
const gallery = message("gallery", { images: galleryImages }, "mcp_screenshot");
const reads: Array<{ ref: string; sessionId?: string }> = [];
const savedOriginals: Array<{ path: string; sessionId?: string }> = [];
const revealedOriginals: Array<{ path: string; sessionId?: string }> = [];
const systemOpens: string[] = [];
api.fsOpen = async (path) => { systemOpens.push(path); return { ok: true }; };
api.fsReveal = async (path, sessionId) => { revealedOriginals.push({ path, sessionId }); return { ok: true }; };
type ImageRead = Awaited<ReturnType<typeof api.fsReadImageDataUrl>>;
const originalReads: Array<{ ref: string; mimeType?: string; sessionId: string; resolve: (result: ImageRead) => void }> = [];
api.fsReadGeneratedOriginal = (ref, mimeType, sessionId) => new Promise<ImageRead>((resolve) => {
  originalReads.push({ ref, mimeType, sessionId, resolve });
});
const deferredReads = new Map<string, (result: ImageRead) => void>();
const deferredResults = new Map<string, Promise<ImageRead>>();
api.fsSaveAs = async (path, sessionId) => {
  savedOriginals.push({ path, sessionId });
  return { canceled: false };
};
api.fsReadImageDataUrl = async (ref, _mimeType, sessionId, allowThumbnail) => {
  reads.push({ ref, sessionId });
  if (ref.startsWith("deferred-")) {
    if (!deferredResults.has(ref)) deferredResults.set(ref, new Promise<ImageRead>((resolve) => { deferredReads.set(ref, resolve); }));
    return deferredResults.get(ref)!;
  }
  if (ref === "outside.png") return { kind: "missing", errorCode: "PATH_OUTSIDE_ALLOWED_ROOT" };
  if (ref === "missing.png") return { kind: "missing", errorCode: "FILE_NOT_FOUND" };
  if (ref === "large.png") {
    check(allowThumbnail === true, "Generated card did not request a thumbnail fallback");
    return { kind: "image", dataUrl: reducedUrl, isThumbnail: true };
  }
  return { kind: "image", dataUrl: ref === "blue.png" ? blueUrl : redUrl };
};
useAppStore.setState({ activeSessionId: "unrelated-active-session" });
const render = (messages: UiMessage[], sessionId = "session-a", turn: boolean | "subagent" | "row" = false, active = false) => {
  const entries = buildTranscriptEntries([
    { id: "user", role: "user", content: "Inspect pictures", createdAt: "2026-11-08T00:00:00Z" },
    ...messages,
    ...(active ? [] : [{ id: "answer", role: "assistant", content: "Result", status: "complete", createdAt: "2026-11-08T00:00:00Z" } as UiMessage]),
  ]).entries;
  const entry = entries.find((item) => item.kind === "assistant-turn");
  flushSync(() => view.render(<I18nextProvider i18n={i18n}><SlotSessionProvider sessionId={sessionId}>
    <TranscriptDisclosureProvider key={turn ? sessionId : "gallery"} sessionId={sessionId}>
      {turn === "subagent" ? <SubagentTurnContent id="child" rows={messages.map((message) => ({ kind: "tool" as const, message }))} active={active} />
        : turn === "row" ? messages.map((item) => <ToolRow key={item.id} message={item} />)
        : turn && entry?.kind === "assistant-turn" ? <AssistantTurn entry={entry} isActive={active} />
        : messages.map((item) => <ToolResultImages key={item.id} message={item} />)}
    </TranscriptDisclosureProvider>
  </SlotSessionProvider></I18nextProvider>));
};
const thumb = () => document.querySelector<HTMLButtonElement>(".tool-result-image-thumb")!;
const dialog = () => document.querySelector<HTMLDialogElement>("dialog.generated-image-viewer");
const selectedImage = () => document.querySelector<HTMLImageElement>(".generated-image-viewer-viewport img");
const viewerStatus = () => dialog()?.querySelector(".generated-image-viewer-viewport [role=status]")?.textContent;
const originalStatus = () => dialog()?.querySelector(".generated-image-viewer-original-status")?.textContent;
const viewerButton = (label: string | string[]) => [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
  .find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === i18n.t(label));
const waitFor = (matches: () => boolean, failure: string) => new Promise<void>((resolve, reject) => {
  const observer = new MutationObserver(checkState);
  const timer = setTimeout(() => { observer.disconnect(); reject(new Error(failure)); }, 2000);
  function checkState() {
    if (!matches()) return;
    clearTimeout(timer); observer.disconnect(); resolve();
  }
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  checkState();
});
const waitForViewerStatus = (key: string) => waitFor(() => viewerStatus() === i18n.t(key), `Viewer did not report ${key}`);
const waitForImage = async (selector: string, src: string) => {
  const current = () => document.querySelector<HTMLImageElement>(selector);
  await waitFor(() => current()?.src === src, `Image did not load: ${selector}`);
  await current()?.decode();
};
const waitForSelectedImage = (src: string) => waitForImage(".generated-image-viewer-viewport img", src);
const decodeThumbnails = async () => {
  await Promise.all([...document.querySelectorAll<HTMLImageElement>(".tool-result-image-thumb img, .generated-image-thumb img")].map((img) => img.decode()));
};
let trigger: HTMLButtonElement;
let backgroundClicks = 0;
const underlay = document.createElement("button");
underlay.style.cssText = "position:fixed;inset:0;opacity:0";
underlay.setAttribute("aria-label", "Underlying conversation action");
underlay.onclick = () => { backgroundClicks += 1; };

Object.assign(window, { toolImagesPointer: (stage: string) => {
  const center = (element: Element) => {
    const box = element.getBoundingClientRect();
    return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];
  };
  const imagePoint = center(selectedImage()!);
  const left = [8, imagePoint[1]];
  const right = [innerWidth - 96, imagePoint[1]];
  if (stage === "lightbox-drag") return [imagePoint, right];
  if (stage === "lightbox-image") return [imagePoint];
  if (stage === "lightbox-zoom") return [center(dialog()!.querySelector(`[aria-label="${i18n.t("menu.zoomIn")}"]`)!)];
  return [stage === "lightbox-left" ? left : right];
} });

Object.assign(window, { toolImagesProbe: async (stage: string) => {
  if (stage === "open") {
    render([original]); await decodeThumbnails();
    check(document.querySelectorAll(".tool-result-image-thumb").length === 2, "Mirrors must not duplicate thumbnails");
    check(document.body.textContent?.includes("Returned 2 images"), "Missing compact summary");
    check(thumb().getBoundingClientRect().width === 80, "Thumbnail is not compact");
    check(reads.length === 0, "Inline results must not reread the original file");
    check(!JSON.stringify(buildToolPresentation(original)).includes(red.data), "Tool details expose binary data");
    trigger = thumb(); flushSync(() => trigger.click()); await frame();
    await selectedImage()?.decode();
    check(dialog()?.open && selectedImage()?.src === redUrl, "Click did not open original image");
    check(document.querySelector<HTMLAnchorElement>("dialog a[download]")?.href === redUrl, "Download does not match selected bytes");
  } else if (stage === "next" || stage === "previous") {
    await waitForSelectedImage(stage === "next" ? blueUrl : redUrl);
    check(selectedImage()?.src === (stage === "next" ? blueUrl : redUrl), "Keyboard selection used wrong image");
  } else if (stage === "keyboard-open") {
    await frame();
    check(dialog()?.open && selectedImage()?.src === redUrl, "Enter did not open the focused thumbnail");
  } else if (stage === "close" || stage === "close-again") {
    await frame(); check(!dialog(), "Escape did not close the viewer");
    check(document.activeElement === trigger, "Focus did not return to the thumbnail");
  } else if (stage === "lightbox-open" || stage === "lightbox-reopen") {
    if (stage === "lightbox-open") {
      const portrait = image("red", 160, 650);
      render([message("portrait", { images: [portrait] }, "mcp_screenshot")]);
      await decodeThumbnails();
      trigger = thumb();
      document.body.append(underlay);
    }
    flushSync(() => trigger.click()); await frame(); await selectedImage()?.decode(); await frame();
    check(dialog()?.open, "Portrait preview did not open");
  } else if (stage === "lightbox-drag" || stage === "lightbox-image" || stage === "lightbox-zoom") {
    await frame();
    check(dialog()?.open, `${stage} unexpectedly closed the preview`);
    if (stage === "lightbox-zoom") check(Number.parseInt(dialog()!.querySelector("output")!.textContent!) > 100, "Zoom click did not enlarge the image");
  } else if (stage === "lightbox-left" || stage === "lightbox-right") {
    await frame();
    check(!dialog(), `${stage}: clicking blank space did not close the preview`);
    check(document.activeElement === trigger, "Backdrop dismissal did not restore focus");
    check(backgroundClicks === 0, "Backdrop dismissal clicked the underlying action");
    if (stage === "lightbox-right") underlay.remove();
  } else if (stage === "restore") {
    flushSync(() => view.render(null));
    render([JSON.parse(JSON.stringify(original))]); await decodeThumbnails();
    check(document.querySelectorAll(".tool-result-image-thumb").length === 2, "Restored history lost images");
    flushSync(() => thumb().click());
    render([message("mcp", { images: [blue] })], "session-b"); await decodeThumbnails();
    check(!dialog(), "Viewer leaked across sessions with identical message IDs");
    check(document.querySelector<HTMLImageElement>(".tool-result-image-thumb img")?.src === blueUrl, "Previous session image leaked");
  } else if (stage === "retained-image") {
    const omitted = message("retained", { details: { path: "outside.png", images: [{ mimeType: "image/png", displayImageOmitted: true }] } });
    const requests: string[] = [];
    let resolveOld: (() => void) | undefined;
    api.getSession = async (id, options) => {
      requests.push(id);
      check(options?.messageAround === omitted.id && options.messageLimit === 1 && options.contentLimit === 256 * 1024, "Expected bounded single-message rehydration");
      if (id === "session-a") await new Promise<void>((resolve) => { resolveOld = resolve; });
      const restored = { ...omitted, toolResult: { images: [id === "session-a" ? red : blue] } };
      return { session: { id, messages: [restored] } as NonNullable<Awaited<ReturnType<typeof api.getSession>>["session"]> };
    };
    render([omitted], "session-a"); await frame();
    render([omitted], "session-b"); await frame();
    check(requests.join(",") === "session-a,session-b", "History read was not scoped to the owning session");
    check(!reads.some((item) => item.ref === "outside.png"), "Retained image reopened a source outside the project");
    resolveOld?.(); await frame();
    const thumbnail = thumb().querySelector("img");
    check(thumbnail?.src === blueUrl, "Historical image bytes were not restored or a stale session won");
    await thumbnail?.decode();
    flushSync(() => thumb().click()); await waitForSelectedImage(blueUrl);
    check(document.querySelector<HTMLAnchorElement>("dialog a[download]")?.href === blueUrl, "Retained original bytes are not downloadable");
    render([]);
  } else if (stage === "states") {
    const warning = message("unsupported", { content: [], details: { images: [red], imageInput: {
      imageCount: 1, includedCount: 0, issues: [{ index: 0, code: "MODEL_NO_VISION", message: "omitted" }],
    } } });
    render([warning]); await decodeThumbnails();
    check(document.body.textContent?.includes("Images were not sent to the model"), "Non-vision omission is hidden");
    render([message("missing", { images: [{ path: "deferred-missing.png", mimeType: "image/png" }] })]);
    check(thumb().getAttribute("aria-label")?.includes(i18n.t("imagePreviewState.loading")), "Cold thumbnail has no accessible loading state");
    flushSync(() => thumb().click());
    check(viewerStatus() === i18n.t("imagePreviewState.loading") && !selectedImage(), "Cold viewer rendered missing or stale content on its first frame");
    await frame();
    check(reads.at(-1)?.sessionId === "session-a", "Reference read used the active rather than owning session");
    deferredReads.get("deferred-missing.png")!({ kind: "missing", errorCode: "FILE_NOT_FOUND" });
    await waitForViewerStatus("imagePreviewState.missing");
    check([thumb().title, thumb().getAttribute("aria-label"), thumb().getAttribute("aria-description")]
      .some((description) => description?.includes(i18n.t("imagePreviewState.missing"))), "Missing thumbnail has no accessible reason");
    check(!selectedImage(), "Missing viewer kept invalid image bytes");
    check(!document.querySelector("dialog a[download]"), "Missing image has a download link");
    render([message("mixed", { images: [red, { path: "deferred-race.png", mimeType: "image/png" }, blue] })]);
    await decodeThumbnails(); flushSync(() => thumb().click()); await waitForSelectedImage(redUrl);
    const viewerThumbs = document.querySelectorAll<HTMLButtonElement>(".generated-image-viewer-thumb");
    flushSync(() => viewerThumbs[1].click());
    check(viewerStatus() === i18n.t("imagePreviewState.loading") && !selectedImage() && !document.querySelector("dialog a[download]"), "Loading middle image displays old bytes");
    flushSync(() => viewerThumbs[2].click()); await waitForSelectedImage(blueUrl);
    deferredReads.get("deferred-race.png")!({ kind: "missing", errorCode: "FILE_NOT_FOUND" });
    await waitFor(() => viewerThumbs[1].getAttribute("aria-label")?.includes(i18n.t("imagePreviewState.missing")) === true, "Missing result never settled in the thumbnail");
    check(selectedImage()?.src === blueUrl && !viewerStatus(), "Late missing result replaced the current image");
    flushSync(() => viewerThumbs[1].click()); await waitForViewerStatus("imagePreviewState.missing");
    check(!selectedImage(), "Missing middle image shifted the navigation index");
    render([message("invalid", { images: [{ ...red, data: "AAAA" }] })]);
    flushSync(() => thumb().click()); await waitForViewerStatus("imagePreviewState.invalid");
    check(!selectedImage() && !dialog()?.querySelector("a[download]"), "Invalid inline bytes remained viewable or downloadable");
    render([message("failed", { error: "File not found", code: "FILE_NOT_FOUND" })]);
    check(!document.querySelector(".tool-result-images"), "Failed read claimed images were returned");
    render([message("retained", { path: "missing.png", images: [red] })]); await decodeThumbnails();
    check(document.querySelector<HTMLImageElement>(".tool-result-image-thumb img")?.src === redUrl, "Retained bytes depended on the missing original file");
    render([message("display-omitted", { details: { images: [{ mimeType: "image/png", displayImageOmitted: true }],
      imageInput: { imageCount: 1, includedCount: 1, issues: [] } } })]);
    check(document.querySelector(".tool-result-images-notice")?.textContent === i18n.t("settings.imagePreviewUnavailable"), "Display omission was hidden or reported as invalid model input");
    check(!document.querySelector(".tool-result-images-count"), "Omitted display claims viewable images");
    await i18n.changeLanguage("zh-CN"); render([warning]);
    check(document.body.textContent?.includes("图片未送入模型"), "Image feedback is not localized");
    await i18n.changeLanguage("en");
  } else if (stage === "read-disclosure") {
    const settings = useAppStore.getState().settings;
    for (const mode of ["flat", "command-first", "fully-folded"] as const) {
      useAppStore.setState({ settings: { ...settings!, transcriptDisplayMode: mode } });
      for (const owner of [true, "subagent", "row"] as const) for (const active of [false, true]) {
        const input: UiMessage = JSON.parse(JSON.stringify(message("input-read", { path: "sample.png", images: [red] })));
        const before = JSON.stringify(input);
        const session = `read-${mode}-${owner}-${active}`;
        render([input], session, owner, active);
        const process = document.querySelector<HTMLButtonElement>(".turn-process > .tool-activity-header");
        if (process?.getAttribute("aria-expanded") === "false") flushSync(() => process.click());
        const row = document.querySelector<HTMLButtonElement>('[data-message-id="input-read"] .tool-row-header')!;
        check(row && row.getAttribute("aria-expanded") === "false", "Read must start collapsed");
        const preview = thumb();
        check(preview && preview.closest(".tool-row") === row.closest(".tool-row") && !preview.closest(".tool-row-body, [hidden]"), `${session}: visible Read has no inline thumbnail before opening details`);
        check(preview.closest(".tool-result-images")?.textContent?.includes(i18n.t("toolImages.returned", { count: 1 })), "Read feedback lacks the returned image count");
        await decodeThumbnails();
        flushSync(() => row.click());
        check(document.querySelectorAll(".tool-result-image-thumb").length === 1 && thumb() === preview, "Opening Read duplicated or replaced its preview");
        flushSync(() => row.click());
        flushSync(() => preview.click());
        await waitForSelectedImage(redUrl);
        check(dialog()?.open, "Collapsed Read cannot open its original image");
        if (process) {
          flushSync(() => process.click());
          check(!dialog() && !thumb(), "Folding the process left a Read preview or viewer behind");
          flushSync(() => process.click());
          flushSync(() => thumb().click());
        }
        check(JSON.stringify(input) === before, "Read disclosure mutated stored input");
        render([message(input.id, { images: [blue] })], `${session}-switched`, owner, true);
        await decodeThumbnails();
        check(!dialog() && thumb()?.querySelector("img")?.src === blueUrl, `${session}: Read preview leaked across sessions`);
        console.log(`READ_DISCLOSURE_CASE ${session} passed`);
      }
    }
    useAppStore.setState({ settings });
  } else if (stage === "turn") {
    render([original, message("read", { path: "sample.png", images: [red] })], "session-a", true);
    await decodeThumbnails();
    check(document.querySelectorAll(".tool-result-images").length === 1, "Turn promotes an inspection image or loses MCP output");
    check(document.querySelectorAll(".tool-result-image-thumb").length === 2, "Images are associated with the wrong tool call");
    const process = document.querySelector<HTMLButtonElement>(".turn-process > .tool-activity-header")!;
    flushSync(() => process.click());
    const group = document.querySelector<HTMLButtonElement>(".process-activity-group.grouped > .tool-activity-header");
    if (group?.getAttribute("aria-expanded") === "false") flushSync(() => group.click());
    check(document.querySelectorAll(".tool-result-image-thumb").length === 3 && document.querySelector('[data-message-id="read"] .tool-result-image-thumb'), "Opening the process lost the Read preview or duplicated the MCP output");
    if (group) {
      flushSync(() => group.click());
      check(document.querySelectorAll(".tool-result-image-thumb").length === 2, "Folding the activity group must hide only the inspected input");
    }
  } else if (stage === "group") {
    document.getElementById("root")!.style.cssText = "width:280px;margin:24px";
    render([gallery], "session-a", true); await decodeThumbnails(); await frame();
    check(document.querySelectorAll(".tool-result-images").length === 1, "Multi-image output must share one gallery");
    check(document.querySelectorAll(".tool-result-image-thumb").length === 6, "Gallery lost images");
    check(document.body.textContent?.includes("Returned 6 images"), "Gallery count does not include every image");
    const thumbs = [...document.querySelectorAll<HTMLButtonElement>(".tool-result-image-thumb")];
    const boxes = thumbs.map((item) => item.getBoundingClientRect());
    check(boxes[0].top === boxes[1].top && boxes[1].left > boxes[0].left, "Images are not horizontal");
    check(boxes[3].top > boxes[0].top && boxes.every((box) => box.width === 80), "Narrow gallery must wrap without shrinking thumbnails");
    check(thumbs.every((item) => item.parentElement?.dataset.toolCallId === "call-gallery"), "Thumbnail lost source call");
    check(thumbs[1].getAttribute("aria-label")?.includes("capture-1.png"), "Source filename is not accessible");
    const heading = document.querySelector<HTMLButtonElement>(".tool-result-images-heading")!;
    flushSync(() => heading.click());
    check(!document.querySelector(".tool-result-image-thumb") && heading.getAttribute("aria-expanded") === "false", "Gallery collapse failed");
    flushSync(() => heading.click()); await decodeThumbnails();
    trigger = document.querySelectorAll<HTMLButtonElement>(".tool-result-image-thumb")[1];
    flushSync(() => trigger.click()); await frame(); await selectedImage()?.decode();
    check(dialog()?.open && selectedImage()?.src === blueUrl, "Gallery click opened the wrong image");
  } else if (stage === "group-next") {
    const selectedUrl = `data:image/png;base64,${galleryImages[2].data}`;
    await waitForSelectedImage(selectedUrl);
    check(selectedImage()?.src === selectedUrl && document.querySelector("dialog strong")?.textContent === "capture-2.png", "Keyboard did not select the next image");
    const openDialog = dialog()!;
    const zoomIn = [...openDialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === i18n.t("menu.zoomIn"))!;
    flushSync(() => zoomIn.click());
    const zoom = openDialog.querySelector("output")?.textContent;
    check(zoom !== "100%", "Fixture did not change viewer zoom");
    const pendingImage = openDialog.querySelectorAll<HTMLImageElement>(".generated-image-viewer-thumb img")[3];
    let resolveDecode!: () => void;
    pendingImage.decode = () => new Promise<void>((resolve) => { resolveDecode = resolve; });
    flushSync(() => openDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    render([{ ...gallery, toolResult: { images: [...galleryImages, { ...image("magenta"), path: "later.png" }] } }], "session-a", true);
    await frame(); await selectedImage()?.decode();
    check(dialog() === openDialog && openDialog.querySelector("output")?.textContent === zoom, "Appending an image remounted the viewer or reset zoom");
    check(selectedImage()?.src === selectedUrl, "Appending an image changed the selection");
    resolveDecode(); await frame(); await selectedImage()?.decode();
    check(document.querySelector("dialog strong")?.textContent === "capture-3.png", "Appending discarded pending image navigation");
  } else if (stage === "group-close") {
    await frame();
    check(!dialog() && document.activeElement === trigger, "Closing viewer lost originating thumbnail focus");
  } else if (stage === "group-boundaries") {
    render(groupedReads, "read-batch", true);
    check(!document.querySelector(".tool-result-images"), "Consecutive Reads still echo input images");
    render([gallery, ...groupedReads], "child-output", "subagent");
    check(document.querySelectorAll(".tool-result-images").length === 1 && document.querySelectorAll(".tool-result-image-thumb").length === 6, "Subagent loses output or promotes Reads");
    flushSync(() => thumb().click());
    render([{ ...gallery, toolResult: { images: [blue] } }], "session-b", "subagent");
    check(!dialog(), "Viewer leaked across owning sessions");
  } else if (stage === "generated-large") {
    const generated = message("large", { kind: "generated-images", results: [
      { status: "succeeded", path: "large.png", mimeType: "image/png" },
      { status: "succeeded", path: "blue.png", mimeType: "image/png" },
    ] }, "GenerateImages");
    render([generated]);
    await waitForImage(".generated-image-preview img", reducedUrl);
    const save = document.querySelector<HTMLButtonElement>(".generated-image-actions button");
    check(save && !document.querySelector(".generated-image-actions a[download]"), "Thumbnail became a downloadable original");
    save?.click();
    flushSync(() => document.querySelector<HTMLButtonElement>(".generated-image-preview")?.click());
    await waitForSelectedImage(reducedUrl); await frame();
    check(dialog()?.textContent?.includes(i18n.t("imagePreviewState.reduced")), "Viewer did not disclose reduced preview");
    const preview = selectedImage()!;
    const bounds = preview.getBoundingClientRect();
    check(bounds.width === preview.naturalWidth && bounds.height === preview.naturalHeight && getComputedStyle(preview).objectFit === "contain", "Preview did not show the full wide canvas");
    check(getComputedStyle(preview).backgroundImage.includes("conic-gradient"), "Preview does not visibly mark transparency");
    const sample = document.createElement("canvas");
    sample.width = preview.naturalWidth; sample.height = preview.naturalHeight;
    const pixels = sample.getContext("2d")!;
    pixels.drawImage(preview, 0, 0);
    check(pixels.getImageData(0, 0, 1, 1).data[3] === 0 && pixels.getImageData(sample.width - 1, 0, 1, 1).data[3] === 255, "Preview lost transparent or opaque pixels");
    const saveLabel = "chat.fileSaveAs";
    const viewerSave = viewerButton(saveLabel);
    check(viewerSave && !dialog()?.querySelector("a[download]"), "Viewer linked reduced bytes instead of exposing Save Original");
    check(viewerButton("chat.previewFile"), "Viewer lost the work-panel action");
    viewerButton("settings.revealGeneratedImage")?.click();
    viewerSave?.click();
    check(savedOriginals.length === 2 && savedOriginals.every((item) => item.path === "large.png" && item.sessionId === "session-a"), "Save As did not target the original in the owning session");
    check(revealedOriginals.length === 1 && revealedOriginals[0].path === "large.png" && revealedOriginals[0].sessionId === "session-a", "Reveal did not target the original in the owning session");
    check(!systemOpens.length, "Viewer dispatched an unverified path to the system app");
    check(reads.filter((item) => item.ref === "large.png").length === 1, "Card and viewer loaded the same thumbnail twice");
    check(originalReads.length === 0, "Original was fetched without an explicit request");
    await waitFor(() => !!viewerButton("imagePreviewState.openOriginal"), "Viewer did not expose View original");
    const openOriginal = () => viewerButton("imagePreviewState.openOriginal")!;
    flushSync(() => { openOriginal().click(); openOriginal().click(); });
    check(originalReads.length === 1 && originalReads[0].ref === "large.png" && originalReads[0].mimeType === "image/png" && originalReads[0].sessionId === "session-a", "View original duplicated or misrouted the request");
    check(originalStatus() === i18n.t("imagePreviewState.loading") && selectedImage() === preview && !viewerButton("imagePreviewState.showPreview"), "Pending request replaced the preview or falsely labeled it original");
    originalReads[0].resolve({ kind: "image", dataUrl: originalUrl });
    await waitForSelectedImage(originalUrl);
    const full = selectedImage()!;
    check(full.naturalWidth === 1440 && full.naturalHeight === 360 && dialog()?.textContent?.includes(i18n.t("imagePreviewState.original")), "Viewer did not show the decoded original canvas");
    const viewport = full.parentElement!;
    const fitted = full.getBoundingClientRect();
    check(fitted.width <= viewport.clientWidth + 1 && fitted.height <= viewport.clientHeight + 1, "Original defaults to a cropped view instead of fitting");
    sample.width = full.naturalWidth; sample.height = full.naturalHeight;
    pixels.drawImage(full, 0, 0);
    check(pixels.getImageData(0, 0, 1, 1).data[3] === 0 && pixels.getImageData(sample.width - 1, 0, 1, 1).data[3] === 255, "Full resolution did not preserve alpha");
    flushSync(() => viewerButton("menu.actualSize")!.click());
    check(full.getBoundingClientRect().width === 1440 && full.getBoundingClientRect().height === 360 && viewport.scrollWidth === 1440, "Actual Size was not scrollable at true 1:1");
    viewerButton(saveLabel)?.click();
    check(savedOriginals.length === 3 && savedOriginals[2].path === "large.png" && savedOriginals[2].sessionId === "session-a" && !dialog()?.querySelector("a[download]"), "Original mode substituted the preview or full data URL for native Save As");
    flushSync(() => viewerButton("imagePreviewState.showPreview")!.click());
    await waitForSelectedImage(reducedUrl);

    flushSync(() => openOriginal().click());
    originalReads[1].resolve({ kind: "image", dataUrl: reducedUrl, isThumbnail: true });
    await waitFor(() => originalStatus() === i18n.t("imagePreviewState.openOriginalFailed"), "Thumbnail response was not rejected");
    check(selectedImage()?.src === reducedUrl && !viewerButton("imagePreviewState.showPreview"), "Failed request replaced the reduced preview");
    flushSync(() => openOriginal().click());
    originalReads[2].resolve({ kind: "image", dataUrl: "data:image/png;base64,AAAA" });
    await waitFor(() => originalStatus() === i18n.t("imagePreviewState.openOriginalFailed"), "Undecodable raster response was not rejected");
    check(selectedImage()?.src === reducedUrl, "Decode failure hid the preview");

    flushSync(() => openOriginal().click());
    flushSync(() => viewerButton("chat.imagePreview.next")!.click());
    await waitForSelectedImage(blueUrl);
    originalReads[3].resolve({ kind: "image", dataUrl: originalUrl });
    await frame();
    check(selectedImage()?.src === blueUrl && !originalStatus() && !viewerButton("imagePreviewState.openOriginal"), "Late original leaked into the next selection");
    flushSync(() => viewerButton("chat.imagePreview.previous")!.click());
    await waitForSelectedImage(reducedUrl);
    check(!viewerButton("imagePreviewState.showPreview"), "Returning to an image restored an old original");

    flushSync(() => openOriginal().click());
    originalReads[4].resolve({ kind: "image", dataUrl: originalUrl });
    await waitForSelectedImage(originalUrl);
    const { sessions } = useAppStore.getState();
    flushSync(() => useAppStore.setState({ sessions: [{
      id: "session-a", title: "Generated image owner", messageCount: 1, mode: "agent", thinkingLevel: "off", permissionMode: "inherit",
      createdAt: generated.createdAt, updatedAt: generated.createdAt,
      capabilities: { canPrompt: true, canStop: true, canRefresh: true, canUseLocalTools: false },
    }, ...sessions] }));
    check(!selectedImage() && !viewerButton("imagePreviewState.showPreview") && viewerStatus() === i18n.t("imagePreviewState.restricted"), "Revoking local file access left the original visible");
    flushSync(() => useAppStore.setState({ sessions }));
    await waitForSelectedImage(reducedUrl);
    check(originalReads.length === 5 && !viewerButton("imagePreviewState.showPreview"), "Restoring access resurrected or refetched the original");
    await waitFor(() => !!openOriginal(), "Original action did not reappear after restoring access");
    flushSync(() => openOriginal().click());
    render([generated], "remote:session-large");
    check(!dialog(), "Viewer stayed open across local-to-remote switch");
    flushSync(() => document.querySelector<HTMLButtonElement>(".generated-image-preview")?.click());
    originalReads[5].resolve({ kind: "image", dataUrl: originalUrl });
    await frame();
    check(dialog()?.open && viewerStatus() === i18n.t("imagePreviewState.restricted"), "Remote reference was not restricted in the viewer");
    check(!viewerButton(saveLabel) && !viewerButton("settings.revealGeneratedImage") && !viewerButton("imagePreviewState.openOriginal") && !dialog()?.querySelector("a[download]"), "Remote reference exposes native file actions");
    check(originalReads.length === 6 && !reads.some(({ sessionId }) => sessionId === "remote:session-large") && !systemOpens.length, "Remote reference attempted a local read or open");
    render([]);
  } else if (stage === "generated") {
    const generated = message("generated", { details: { kind: "generated-images", results: [
      { status: "succeeded", path: "red.png", mimeType: "image/png" },
      { status: "succeeded", path: "blue.png", mimeType: "image/png" },
      { status: "failed", errorCode: "IMAGE_DOWNLOAD_FAILED" },
    ] } }, "renamed-image-tool");
    render([generated]); await waitForImage(".generated-image-preview img", redUrl);
    check(document.querySelectorAll(".generated-image-card").length === 1, "Generation card was removed");
    check(document.body.textContent?.includes("IMAGE_DOWNLOAD_FAILED"), "Generation failure feedback was removed");
    const thumbs = document.querySelectorAll<HTMLButtonElement>(".generated-image-thumb");
    check(thumbs.length === 2, "Generated batch lost thumbnails");
    flushSync(() => thumbs[1].click()); await waitForImage(".generated-image-preview img", blueUrl);
    check(document.querySelector<HTMLAnchorElement>(".generated-image-actions a")?.href === blueUrl, "Generated download did not follow selection");
    trigger = document.querySelector<HTMLButtonElement>(".generated-image-preview")!;
    flushSync(() => trigger.click()); await waitForSelectedImage(blueUrl); await frame();
    const preview = dialog()!;
    check(innerWidth <= 400 && getComputedStyle(preview.querySelector("nav")!).flexDirection === "row", "Narrow preview did not move thumbnails below the image");
    for (const toolbar of preview.querySelectorAll("header, footer")) {
      const bounds = toolbar.getBoundingClientRect();
      check(bounds.left > 0 && bounds.right < innerWidth && bounds.bottom < innerHeight, "Floating controls overflow the narrow window");
    }
  } else if (stage === "generated-dismiss") {
    await frame();
    check(!dialog() && document.activeElement === trigger, "Narrow generated preview did not dismiss or restore focus");
    render([message("setup", { details: { kind: "image-generation-error", errorCode: "IMAGE_NOT_CONFIGURED" } })]);
    const configure = document.querySelector<HTMLButtonElement>(".generated-images button");
    check(configure, "Generation setup action was removed");
    flushSync(() => configure!.click());
    check(useAppStore.getState().settingsAnchor === "settings.imageModel", "Setup action opened the wrong destination");
  } else if (stage === "generated-aggregate") {
    const batch = (id: string, path: string) => message(id, { kind: "generated-images", results: [{ status: "succeeded", path, mimeType: "image/png" }] }, "GenerateImages");
    const first = batch("first-generated", "red.png"), second = batch("second-generated", "blue.png");
    render([first], "generated-turn", true, true);
    await waitForImage(".generated-image-preview img", redUrl);
    flushSync(() => document.querySelector<HTMLButtonElement>(".generated-image-preview")!.click());
    await waitForSelectedImage(redUrl);
    const openDialog = dialog();
    render([first, second], "generated-turn", true, true);
    const tiles = [...document.querySelectorAll<HTMLButtonElement>(".generated-overview-thumb")];
    check(tiles.length === 2 && dialog() === openDialog && selectedImage()?.src === redUrl, "Aggregating generated batches remounted or replaced the viewer selection");
    flushSync(() => viewerButton("chat.imagePreview.next")!.click());
    await waitForSelectedImage(blueUrl);
    check(tiles[1].getAttribute("aria-current") === "true" && [...openDialog!.querySelectorAll(".generated-image-viewer-thumb")][1]?.getAttribute("aria-current") === "true", "Repeated result indices selected the wrong batch");
    flushSync(() => viewerButton("common.close")!.click());
    check(!dialog() && document.activeElement === tiles[0], "Aggregate transition lost focus return to the equivalent originating tile");
  } else if (stage === "snapshot-light" || stage === "snapshot-dark") {
    document.documentElement.dataset.theme = stage.endsWith("light") ? "light" : "dark";
    document.getElementById("root")!.style.cssText = "width:280px;margin:24px";
    await i18n.changeLanguage("zh-CN");
    render([gallery], "session-a", true); await decodeThumbnails(); await frame();
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    await frame(); await frame();
    const rootBox = document.getElementById("root")!.getBoundingClientRect();
    check([...document.querySelectorAll(".tool-result-image-thumb")].every((item) => item.getBoundingClientRect().right <= rootBox.right), "Narrow gallery overflows");
    const count = document.querySelector<HTMLElement>(".tool-result-images-count")!;
    check(count.getBoundingClientRect().height < 25, "Compact summary wrapped to multiple lines");
    check(getComputedStyle(thumb()).borderRadius === "12px", "Fixture is missing the production radius token");
    console.log("TOOL_IMAGE_STYLE " + JSON.stringify({ stage, color: getComputedStyle(count).color, background: getComputedStyle(document.body).backgroundColor }));
  } else if (stage === "finish") {
    flushSync(() => view.unmount());
  }
  return { passed: true, stage };
} });
