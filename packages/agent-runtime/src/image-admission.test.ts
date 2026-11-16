import type { Message } from "@earendil-works/pi-ai";
import type { UiMessage } from "@pi-desktop/shared";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { describe, expect, it, vi } from "vitest";
import { admitImageInput, omitInadmissibleImages, omitOversizedImages } from "./image-admission.js";
import { convertToLlm } from "./pi-runtime-messages.js";
import { toolResultFromUi } from "./runtime.js";

function pngBase64(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

const TALL = pngBase64(780, 14182);
const NORMAL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==";
const NOTICE =
  "[Image omitted: 780x14182 px exceeds the 8000 px longest-edge limit for model input.]";

describe("image integrity admission", () => {
  const invalid = { issue: { code: "IMAGE_INVALID", message: "[Image omitted: image input is invalid.]" } };
  const png = Buffer.from(NORMAL, "base64");

  it.each([33, 45, png.length - 12, png.length - 1])("rejects a PNG truncated at byte %s despite valid base64 and dimensions", (length) => {
    expect(admitImageInput({ type: "image", data: png.subarray(0, length).toString("base64"), mimeType: "image/png" }, true)).toEqual(invalid);
  });

  it("rejects corrupt compressed pixels in an otherwise complete PNG container", () => {
    const corrupt = Buffer.from(png);
    corrupt[45] = corrupt[45]! ^ 0xff;
    expect(admitImageInput({ type: "image", data: corrupt.toString("base64"), mimeType: "image/png" }, true)).toEqual(invalid);
    expect(admitImageInput({ type: "image", data: Buffer.from("not an image").toString("base64"), mimeType: "image/png" }, true)).toEqual(invalid);
  });

  it("preserves complete PNG/JPEG/GIF/WebP bytes", () => {
    const pixel = new PhotonImage(new Uint8Array([0, 255, 0, 255]), 1, 1);
    try {
      for (const [mimeType, bytes] of [
        ["image/png", pixel.get_bytes()], ["image/jpeg", pixel.get_bytes_jpeg(80)],
        ["image/webp", pixel.get_bytes_webp()],
        ["image/gif", Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64")],
      ] as const) {
        const candidate = { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType };
        expect(admitImageInput(candidate, true)).toEqual({ image: candidate });
        expect(admitImageInput({ ...candidate, data: Buffer.from(bytes).subarray(0, bytes.length - 1).toString("base64") }, true)).toEqual(invalid);
      }
    } finally { pixel.free(); }
  });

  it("decodes identical bytes once across repeated projections and base64 padding", () => {
    const pixel = new PhotonImage(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]), 2, 1);
    const data = Buffer.from(pixel.get_bytes()).toString("base64");
    pixel.free();
    const decode = vi.spyOn(PhotonImage, "new_from_byteslice");
    try {
      for (const encoded of [data, data, data.replace(/=+$/, "")]) {
        expect(admitImageInput({ type: "image", data: encoded, mimeType: "image/png" }, true)).toHaveProperty("image");
      }
      expect(decode).toHaveBeenCalledTimes(1);
    } finally { decode.mockRestore(); }
  });

  it("projects corrupt historical user/tool images as explicit errors without mutating the source", () => {
    const candidate = { type: "image" as const, data: png.subarray(0, 45).toString("base64"), mimeType: "image/png" };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "inspect" }, candidate], timestamp: 1 },
      { role: "toolResult", toolCallId: "read", toolName: "Read", content: [candidate], isError: false, timestamp: 2 },
    ];
    const original = structuredClone(messages);
    const projected = convertToLlm(messages);
    for (const message of projected) {
      expect(Array.isArray(message.content) && message.content.some((block) => block.type === "image")).toBe(false);
    }
    expect(JSON.stringify(projected)).toContain("image input is invalid");
    expect(messages).toEqual(original);
  });
});

describe("omitOversizedImages", () => {
  it("replaces an oversized image in a user prompt and keeps its position", () => {
    const messages: Message[] = [{
      role: "user",
      content: [
        { type: "text", text: "before" },
        { type: "image", data: TALL, mimeType: "image/png" },
        { type: "image", data: NORMAL, mimeType: "image/png" },
      ],
      timestamp: 1,
    }];
    const [user] = omitOversizedImages(messages);
    expect(user?.content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: NOTICE },
      { type: "image", data: NORMAL, mimeType: "image/png" },
    ]);
    expect(messages[0]?.content).toHaveLength(3);
    expect((messages[0]?.content as Array<{ type: string }>)[1]?.type).toBe("image");
  });

  it("returns the same array when every image is admissible", () => {
    const messages: Message[] = [
      { role: "user", content: "plain text", timestamp: 1 },
      {
        role: "user",
        content: [{ type: "image", data: NORMAL, mimeType: "image/png" }],
        timestamp: 2,
      },
    ];
    expect(omitOversizedImages(messages)).toBe(messages);
  });

  it("replaces malformed input with an explicit omission notice", () => {
    expect(admitImageInput({ type: "image", data: "not-an-image", mimeType: "image/png" }, true))
      .toEqual({ issue: { code: "IMAGE_INVALID", message: "[Image omitted: image input is invalid.]" } });
  });

  it("explains no-vision model omissions without retaining image blocks", () => {
    const [message] = omitInadmissibleImages([{
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "Read",
      isError: false,
      content: [{ type: "image", data: NORMAL, mimeType: "image/png" }],
      timestamp: 1,
    }], false);
    expect(message?.content).toEqual([
      { type: "text", text: "[Image omitted: the selected model does not support image input.]" },
    ]);
  });

  it("heals a restored session whose Read result holds an oversized image", () => {
    const row = {
      id: "tool-1",
      role: "tool",
      content: "",
      toolName: "read",
      toolCallId: "call-1",
      toolStatus: "done",
      toolResult: {
        path: "page.png",
        text: "Image file page.png (1890000 bytes, image/png); the image is attached to this result.",
        images: [{ data: TALL, mimeType: "image/png" }],
      },
    } as unknown as UiMessage;
    const restored = toolResultFromUi(row, 1);
    expect(restored.content).toEqual([
      { type: "text", text: expect.stringContaining("page.png") },
      { type: "text", text: NOTICE },
    ]);

    const [outgoing] = convertToLlm([restored]);
    expect(outgoing?.role).toBe("toolResult");
    expect(outgoing?.content).toEqual(restored.content);
  });
});
