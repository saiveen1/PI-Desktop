import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { ToolResultImages } from "../../src/features/chat/transcript/ToolResultImages";
import { AssistantTurn } from "../../src/features/chat/transcript/AssistantTurn";
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
const image = (color: string) => {
  const canvas = document.createElement("canvas");
  canvas.width = 120; canvas.height = 80;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color; context.fillRect(0, 0, 120, 80);
  return { type: "image", mimeType: "image/png", data: canvas.toDataURL().split(",")[1] };
};
const red = image("red"), blue = image("blue");
const redUrl = `data:image/png;base64,${red.data}`, blueUrl = `data:image/png;base64,${blue.data}`;
const message = (id: string, toolResult: unknown, toolName = "Read"): UiMessage => ({
  id, role: "tool", content: "", toolName, toolArgs: { path: "sample.png" }, toolResult,
  toolStatus: "success", status: "complete", createdAt: "2026-11-08T00:00:00Z",
});
const original = message("mcp", { content: [red, blue], details: { content: [red, blue, red] } }, "mcp_screenshot");
const reads: Array<{ ref: string; sessionId?: string }> = [];
api.fsReadImageDataUrl = async (ref, _mimeType, sessionId) => {
  reads.push({ ref, sessionId });
  return ref === "missing.png" ? { kind: "missing" } : { kind: "image", dataUrl: ref === "blue.png" ? blueUrl : redUrl };
};
useAppStore.setState({ activeSessionId: "unrelated-active-session" });
const render = (messages: UiMessage[], sessionId = "session-a", turn = false) => {
  const entries = buildTranscriptEntries([
    { id: "user", role: "user", content: "Inspect pictures", createdAt: "2026-11-08T00:00:00Z" },
    ...messages,
    { id: "answer", role: "assistant", content: "Result", status: "complete", createdAt: "2026-11-08T00:00:00Z" },
  ]).entries;
  const entry = entries.find((item) => item.kind === "assistant-turn");
  flushSync(() => view.render(<I18nextProvider i18n={i18n}><SlotSessionProvider sessionId={sessionId}>
    <TranscriptDisclosureProvider sessionId={sessionId}>
      {turn && entry?.kind === "assistant-turn" ? <AssistantTurn entry={entry} isActive={false} />
        : messages.map((item) => <ToolResultImages key={item.id} message={item} />)}
    </TranscriptDisclosureProvider>
  </SlotSessionProvider></I18nextProvider>));
};
const thumb = () => document.querySelector<HTMLButtonElement>(".tool-result-image-thumb")!;
const dialog = () => document.querySelector<HTMLDialogElement>("dialog.generated-image-viewer");
const selectedImage = () => document.querySelector<HTMLImageElement>(".generated-image-viewer-viewport img");
const decodeThumbnails = async () => {
  await Promise.all([...document.querySelectorAll<HTMLImageElement>(".tool-result-image-thumb img, .generated-image-thumb img")].map((img) => img.decode()));
};
let trigger: HTMLButtonElement;

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
    await frame(); await selectedImage()?.decode();
    check(selectedImage()?.src === (stage === "next" ? blueUrl : redUrl), "Keyboard selection used wrong image");
  } else if (stage === "keyboard-open") {
    await frame();
    check(dialog()?.open && selectedImage()?.src === redUrl, "Enter did not open the focused thumbnail");
  } else if (stage === "close" || stage === "close-again") {
    await frame(); check(!dialog(), "Escape did not close the viewer");
    check(document.activeElement === trigger, "Focus did not return to the thumbnail");
  } else if (stage === "restore") {
    flushSync(() => view.render(null));
    render([JSON.parse(JSON.stringify(original))]); await decodeThumbnails();
    check(document.querySelectorAll(".tool-result-image-thumb").length === 2, "Restored history lost images");
    flushSync(() => thumb().click());
    render([message("mcp", { images: [blue] })], "session-b"); await decodeThumbnails();
    check(!dialog(), "Viewer leaked across sessions with identical message IDs");
    check(document.querySelector<HTMLImageElement>(".tool-result-image-thumb img")?.src === blueUrl, "Previous session image leaked");
  } else if (stage === "states") {
    const warning = message("unsupported", { content: [], details: { images: [red], imageInput: {
      imageCount: 1, includedCount: 0, issues: [{ index: 0, code: "MODEL_NO_VISION", message: "omitted" }],
    } } });
    render([warning]); await decodeThumbnails();
    check(document.body.textContent?.includes("Images were not sent to the model"), "Non-vision omission is hidden");
    render([message("missing", { images: [{ path: "missing.png", mimeType: "image/png" }] })]); await frame();
    check(document.body.textContent?.includes(i18n.t("settings.imagePreviewUnavailable")), "Missing resource has no state");
    check(reads.at(-1)?.sessionId === "session-a", "Reference read used the active rather than owning session");
    flushSync(() => thumb().click()); await frame();
    check(!document.querySelector("dialog a[download]"), "Missing image has a download link");
    render([message("mixed", { images: [red, { path: "missing.png", mimeType: "image/png" }, blue] })]);
    await decodeThumbnails(); flushSync(() => thumb().click()); await frame();
    const viewerThumbs = document.querySelectorAll<HTMLButtonElement>(".generated-image-viewer-thumb");
    flushSync(() => viewerThumbs[1].click()); await frame();
    check(!selectedImage() && !document.querySelector("dialog a[download]"), "Missing middle image displays old bytes");
    flushSync(() => viewerThumbs[2].click()); await frame();
    check(selectedImage()?.src === blueUrl, "Missing middle image shifted the navigation index");
    render([message("failed", { error: "File not found", code: "FILE_NOT_FOUND" })]);
    check(!document.querySelector(".tool-result-images"), "Failed read claimed images were returned");
    await i18n.changeLanguage("zh-CN"); render([warning]);
    check(document.body.textContent?.includes("图片未送入模型"), "Image feedback is not localized");
    await i18n.changeLanguage("en");
  } else if (stage === "turn") {
    render([original, message("read", { path: "sample.png", images: [red] })], "session-a", true);
    await decodeThumbnails();
    check(document.querySelectorAll(".tool-result-images").length === 2, "Parent turn lost or duplicated image results");
    check(document.querySelectorAll(".tool-result-image-thumb").length === 3, "Images are associated with the wrong tool call");
    const details = document.querySelector<HTMLButtonElement>(".turn-process button");
    if (details) flushSync(() => details.click());
    check(document.querySelectorAll(".tool-result-images").length === 2, "Opening process details duplicates images");
  } else if (stage === "generated") {
    const generated = message("generated", { details: { kind: "generated-images", results: [
      { status: "succeeded", path: "red.png", mimeType: "image/png" },
      { status: "succeeded", path: "blue.png", mimeType: "image/png" },
      { status: "failed", errorCode: "IMAGE_DOWNLOAD_FAILED" },
    ] } }, "renamed-image-tool");
    render([generated]); await frame(); await decodeThumbnails();
    check(document.querySelectorAll(".generated-image-card").length === 1, "Generation card was removed");
    check(document.body.textContent?.includes("IMAGE_DOWNLOAD_FAILED"), "Generation failure feedback was removed");
    const thumbs = document.querySelectorAll<HTMLButtonElement>(".generated-image-thumb");
    check(thumbs.length === 2, "Generated batch lost thumbnails");
    flushSync(() => thumbs[1].click()); await frame();
    check(document.querySelector<HTMLAnchorElement>(".generated-image-actions a")?.href === blueUrl, "Generated download did not follow selection");
    render([message("setup", { details: { kind: "image-generation-error", errorCode: "IMAGE_NOT_CONFIGURED" } })]);
    const configure = document.querySelector<HTMLButtonElement>(".generated-images button");
    check(configure, "Generation setup action was removed");
    flushSync(() => configure!.click());
    check(useAppStore.getState().settingsAnchor === "settings.imageModel", "Setup action opened the wrong destination");
  } else if (stage === "snapshot-light" || stage === "snapshot-dark") {
    document.documentElement.dataset.theme = stage.endsWith("light") ? "light" : "dark";
    document.getElementById("root")!.style.cssText = "width:280px;margin:24px";
    await i18n.changeLanguage("zh-CN");
    render([original]); await decodeThumbnails(); await frame();
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
