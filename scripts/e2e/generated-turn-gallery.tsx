import type { i18n as I18n } from "i18next";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { TurnToolImages } from "../../apps/desktop/src/features/chat/transcript/ToolResultImages";
import { api } from "../../apps/desktop/src/lib/api";

function check(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(test: () => boolean, message: string) {
  const deadline = performance.now() + 4000;
  while (!test() && performance.now() < deadline) await frame();
  check(test(), message);
}
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=";
const tool = (id: string, toolName: string, details: Record<string, unknown>): UiMessage => ({
  id, role: "tool", content: "", createdAt: "", toolName, toolCallId: `call-${id}`, toolResult: { details },
});
const batch = (id: string, results: unknown[]) => tool(id, "image-fixture", { kind: "generated-images", results });
const success = (path: string, index = 0) => ({ index, status: "succeeded", path, mimeType: "image/png" });
const timeout = { status: "failed", errorCode: "IMAGE_TIMEOUT" };

export async function verifyGeneratedTurnGallery(root: Root, container: HTMLElement, i18n: I18n) {
  const render = (messages: UiMessage[]) => flushSync(() => root.render(<I18nextProvider i18n={i18n}>
    <TurnToolImages parts={messages.map(message => ({ kind: "activity", items: [{ kind: "tool", message }] }))} />
  </I18nextProvider>));
  const query = <T extends HTMLElement = HTMLElement>(selector: string) => container.querySelector<T>(selector);
  const click = (node: HTMLElement | undefined | null) => { check(node, "missing click target"); flushSync(() => node.click()); };
  const modal = () => document.querySelector<HTMLDialogElement>("dialog.generated-image-viewer[open]");
  const thumbs = () => [...container.querySelectorAll<HTMLButtonElement>(".generated-overview-thumb")];
  const originalRead = api.fsReadImageDataUrl;
  const reads: string[] = [];
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  api.fsReadImageDataUrl = async (ref, _mime, _session, allowThumbnail) => {
    reads.push(ref);
    check(allowThumbnail === true, "generated preview did not request a contained thumbnail");
    if (ref === "cold.png") await ready;
    if (ref === "missing.png") return { kind: "missing" };
    if (ref === "large.png") return { kind: "tooLarge" };
    if (ref === "unavailable.png") throw Error("fixture read failed");
    return { kind: "image", dataUrl: ref === "broken.png" ? "data:image/png;base64,AAAA" : png };
  };
  try {
    container.style.marginTop = "20000px";
    render([batch("cold", [success("cold.png")])]);
    await frame(); await frame();
    check(!reads.length, "offscreen generation card read the file before it approached the viewport");
    const loadingHeight = query(".generated-image-preview")!.getBoundingClientRect().height;
    check(loadingHeight > 80, "loading preview has no reserved frame");
    container.scrollIntoView();
    await until(() => reads.includes("cold.png"), "nearby card never requested its file");
    check(query(".generated-image-preview")?.innerText === i18n.t("imagePreviewState.loading"), "read in progress shown as unavailable");
    release();
    await until(() => !!query<HTMLImageElement>(".generated-image-preview img")?.naturalWidth, "cold card failed to decode");
    check(query(".generated-image-preview")!.getBoundingClientRect().height === loadingHeight, "card jumps on successful decode");
    render([batch("cold", [success("broken.png")])]);
    await until(() => query(".generated-image-preview")?.innerText === i18n.t("imagePreviewState.invalid"), "decode failure did not explain the unavailable card");
    check(!query(".generated-image-actions :is(a,button)") && query(".generated-image-preview")!.getBoundingClientRect().height === loadingHeight,
      "failed preview still offers download or changes the frame");
    for (const [ref, reason] of [["missing.png", "missing"], ["large.png", "tooLarge"],
      ["unavailable.png", "unavailable"], ["https://invalid.example/never-read.png", "restricted"]] as const) {
      render([batch("cold", [success(ref)])]);
      await until(() => query(".generated-image-preview")?.innerText === i18n.t(`imagePreviewState.${reason}`), `wrong card state: ${reason}`);
      check(query(".generated-image-preview")!.getBoundingClientRect().height === loadingHeight && !query(".generated-image-actions :is(button,a)"), `unstable failed card: ${reason}`);
      if (reason === "restricted") check(!reads.includes(ref), "restricted file reached the reader");
    }
    console.info("TURN_GALLERY_STAGE deferred reads, decoded error and contained read states passed");
    container.style.marginTop = ""; window.scrollTo(0, 0);

    // Repeated tool-local indices, filenames, and mixed result types must not collapse distinct items.
    const batches = Array.from({ length: 14 }, (_, b) => batch(`b${b}`, [success("shared.png"), success(`image-${b}.png`, 1), ...(b < 9 ? [timeout] : [])]));
    const capture = { images: [{ mimeType: "image/png", data: png.split(",")[1] }] };
    const before = tool("before", "mcp_capture", capture);
    const after = tool("after", "plugin_capture", capture);
    const setup = tool("setup", "GenerateImages", { kind: "image-generation-error", errorCode: "IMAGE_NOT_CONFIGURED" });
    const mixed = [before, batches[0], tool("read", "Read", capture), after, setup];
    render(mixed);
    click(container.querySelectorAll<HTMLButtonElement>(".generated-image-thumb")[1]);
    click(query(".generated-image-preview"));
    const viewer = modal();
    check(viewer, "single-batch preview did not open");
    const next = () => viewer.querySelectorAll<HTMLButtonElement>(".generated-image-viewer-navigation button")[1];
    const position = (current: number, total: number) => viewer.innerText.includes(i18n.t("chat.imagePreview.position", { current, total }));
    render([...mixed, ...batches.slice(1, -1)]);
    check(modal() === viewer && position(2, 26), "first append reset the open viewer or lost the selected item");
    click(next());
    await until(() => position(3, 26), "next did not cross the first batch boundary");
    render([...mixed, ...batches.slice(1)]);
    check(modal() === viewer && position(3, 28) && viewer.getAttribute("aria-label") === i18n.t("generatedGallery.item", { batch: 2, index: 1 }), "appending another batch reset navigation or original item identity");
    click(viewer.querySelector("header button"));
    const sheet = query(".generated-overview");
    check(sheet && !query(".generated-image-card") && thumbs().length === 28, "14 batches did not become one 28-image contact sheet");
    check(container.querySelectorAll(".generated-overview").length === 1, "duplicate turn overview");
    const trace = sheet.querySelector("details");
    check(trace && !trace.open && !trace.querySelector("li")?.checkVisibility(), "technical trace expanded on initial render");
    check(sheet.innerText.includes(i18n.t("generatedGallery.succeeded", { count: 28 })) && sheet.innerText.includes(i18n.t("generatedGallery.timedOut", { count: 9 })), "missing immediate partial-result counts");
    const current = thumbs()[2];
    check(current.getAttribute("aria-current") === "true" && current.parentElement?.dataset.toolImageMessageId === "b1" && current.parentElement.dataset.toolCallId === "call-b1", "selected thumbnail lost originating batch/call identity");
    const ordinary = [...container.querySelectorAll<HTMLElement>(".tool-result-images")];
    check(ordinary.map(el => el.dataset.toolImageMessageId).join() === "before,after" && ordinary[0].nextElementSibling === sheet && sheet.nextElementSibling === ordinary[1], "non-generated galleries disappeared, moved, or swallowed an inspection Read");
    check(container.innerText.includes(i18n.t("settings.configureImageModel")), "setup action merged into generated trace");
    click(trace.querySelector("summary"));
    check(trace.open && trace.querySelectorAll("li").length === 37 && trace.querySelectorAll("code").length === 9 && trace.innerText.includes("IMAGE_TIMEOUT") && trace.innerText.includes(i18n.t("generatedGallery.item", { batch: 14, index: 2 })), "trace lacks batch/item provenance or raw timeout codes");
    click(thumbs().at(-1));
    check(modal()?.innerText.includes(i18n.t("chat.imagePreview.position", { current: 28, total: 28 })), "contact-sheet tile did not open the last image");
    click(modal()?.querySelector("header button"));
    check(document.activeElement === thumbs().at(-1), "closing viewer did not restore focus to originating tile");

    console.info("TURN_GALLERY_STAGE 14 batches, 37 items, cross-batch append and focus passed");
    const failOnly = batch("fail", [timeout]);
    render([failOnly]);
    check(!query(".generated-image-card") && !query("details")?.hasAttribute("open") && container.innerText.includes(i18n.t("generatedGallery.timedOut", { count: 1 })) && !container.innerText.includes("IMAGE_TIMEOUT"), "single timeout shows raw code instead of a count");
    render([failOnly, batch("cancel", [{ status: "cancelled", errorCode: "IMAGE_CANCELLED" }, { status: "failed", errorCode: "raw: private content" }])]);
    check(!!query(".generated-overview") && !thumbs().length && !modal() && container.innerText.includes(i18n.t("generatedGallery.cancelled", { count: 1 })) && container.innerText.includes(i18n.t("generatedGallery.failed", { count: 1 })), "failure-only gallery obscured cancelled or other failures");
    click(query("details summary"));
    check(container.innerText.includes("IMAGE_CANCELLED") && !container.textContent?.includes("private content"), "unsafe error text disclosed or safe code omitted");
  } finally {
    release(); render([]); container.style.marginTop = ""; api.fsReadImageDataUrl = originalRead;
  }
}
