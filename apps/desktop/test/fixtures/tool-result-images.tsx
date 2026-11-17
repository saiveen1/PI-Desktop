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
api.fsReadImageDataUrl = async (ref, _mimeType, sessionId) => {
  reads.push({ ref, sessionId });
  return ref === "missing.png" ? { kind: "missing" } : { kind: "image", dataUrl: ref === "blue.png" ? blueUrl : redUrl };
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
const waitForSelectedImage = async (src: string) => {
  await new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(checkSelection);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error("Viewer did not select the expected image")); }, 2000);
    function checkSelection() {
      if (selectedImage()?.src !== src) return;
      clearTimeout(timer); observer.disconnect(); resolve();
    }
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
    checkSelection();
  });
  await selectedImage()?.decode();
};
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
    await waitForSelectedImage(stage === "next" ? blueUrl : redUrl);
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
    render([gallery, ...groupedReads], "child-output", "subagent"); await decodeThumbnails();
    check(document.querySelectorAll(".tool-result-images").length === 1 && document.querySelectorAll(".tool-result-image-thumb").length === 6, "Subagent loses output or promotes Reads");
    flushSync(() => thumb().click()); await frame();
    render([{ ...gallery, toolResult: { images: [blue] } }], "session-b", "subagent"); await decodeThumbnails();
    check(!dialog(), "Viewer leaked across owning sessions");
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
