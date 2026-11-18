import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

/** The destination is from a native save dialog, never renderer input. */
export async function savePerformanceFile(path: string, text: string, stillAuthorized: () => void): Promise<void> {
  if (extname(path).toLowerCase() !== ".json") throw new Error("Choose a JSON report file");
  const temp = join(dirname(path), `.pi-performance-${randomUUID()}.tmp`);
  const file = await open(temp, "wx", 0o600);
  let published = false;
  try {
    try {
      stillAuthorized();
      await file.writeFile(text, "utf8");
    } finally { await file.close(); }
    stillAuthorized();
    await rename(temp, path);
    published = true;
  } finally { if (!published) await rm(temp, { force: true }); }
}
