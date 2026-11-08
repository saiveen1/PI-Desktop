import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

function metadata(path) {
  try { return lstatSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}

export function assertRepositoryFile(root, file) {
  const stat = metadata(file);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error(`Repository metadata must be a regular file: ${file}`);
  let target = file;
  while (!existsSync(target)) target = dirname(target);
  const rel = relative(realpathSync(root), realpathSync(target));
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new Error(`Repository metadata must be a regular contained file: ${file}`);
  }
}

/** Plan every existing workspace version surface without writing anything. */
export function planWorkspaceVersion(root, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) throw new Error("Invalid workspace version.");
  const files = ["package.json", "docs/package.json"];
  for (const group of ["apps", "packages"]) {
    if (!existsSync(join(root, group))) continue;
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(`${group}/${entry.name}/package.json`);
    }
  }
  const current = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const edits = [];
  for (const name of files) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    assertRepositoryFile(root, path);
    const before = readFileSync(path, "utf8");
    const pkg = JSON.parse(before);
    if (pkg.version !== current) throw new Error(`Workspace versions differ: ${name}`);
    if (pkg.version !== version) edits.push({ path, before, after: JSON.stringify({ ...pkg, version }, null, 2) + "\n" });
  }
  for (const [name, pattern] of [
    ["Cargo.toml", /(\[workspace\.package\][\s\S]*?\bversion = ")([^"]+)(")/],
    ["Cargo.lock", /(name = "host-core"\r?\nversion = ")([^"]+)(")/],
    ["packages/shared/src/protocol.ts", /(export const APP_VERSION = ")([^"]+)(")/],
  ]) {
    const path = join(root, name);
    assertRepositoryFile(root, path);
    const before = readFileSync(path, "utf8");
    const found = before.match(pattern);
    if (!found || found[2] !== current) throw new Error(`Workspace versions differ or are missing: ${name}`);
    const after = before.replace(pattern, (_match, prefix, _old, suffix) => prefix + version + suffix);
    if (after !== before) edits.push({ path, before, after });
  }
  const line = version.split(".").slice(0, 2).join(".") + ".x";
  for (const [name, pattern] of [
    ["README.md", /(Current release line:\s*)\d+\.\d+\.x/],
    ["README.zh-CN.md", /(当前发布线：\s*)\d+\.\d+\.x/],
  ]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    assertRepositoryFile(root, path);
    const before = readFileSync(path, "utf8");
    const after = before.replace(pattern, (_match, prefix) => prefix + line);
    if (after !== before) edits.push({ path, before, after });
  }
  return edits;
}

function contents(path) {
  const stat = metadata(path);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error(`Metadata is no longer a regular file: ${path}`);
  return stat ? readFileSync(path, "utf8") : null;
}

/** Stage complete bytes before replacing any tracked metadata. */
function stageReplacement(path, content, write = writeFileSync) {
  const temporary = `${path}.metadata-${randomUUID()}.tmp`;
  let handle;
  let owned = false;
  try {
    handle = openSync(temporary, "wx", (metadata(path)?.mode ?? 0o666) & 0o777);
    owned = true;
    write(handle, content);
    closeSync(handle);
    handle = undefined;
    return temporary;
  } catch (error) {
    const failures = [error];
    if (handle !== undefined) { try { closeSync(handle); } catch (cleanup) { failures.push(cleanup); } }
    if (owned) { try { unlinkSync(temporary); } catch (cleanup) { failures.push(cleanup); } }
    if (failures.length > 1) throw new AggregateError(failures, "Metadata staging failed; inspect its temporary file");
    throw error;
  }
}

/** Guarded atomic replacements; rollback never overwrites a concurrent edit. */
export function applyFileEdits(edits, write = writeFileSync) {
  for (const edit of edits) {
    if (contents(edit.path) !== edit.before) throw new Error(`Metadata changed concurrently: ${edit.path}`);
  }
  const staged = [];
  const applied = [];
  try {
    for (const edit of edits) staged.push({ edit, temporary: stageReplacement(edit.path, edit.after, write) });
    for (const { edit, temporary } of staged) {
      if (contents(edit.path) !== edit.before) throw new Error(`Metadata changed concurrently: ${edit.path}`);
      renameSync(temporary, edit.path);
      applied.push(edit);
    }
  } catch (error) {
    const failures = [error];
    try { restoreFileEdits(applied); } catch (rollback) { failures.push(rollback); }
    for (const { temporary } of staged) {
      if (metadata(temporary)) { try { unlinkSync(temporary); } catch (cleanup) { failures.push(cleanup); } }
    }
    if (failures.length > 1) throw new AggregateError(failures, "Metadata update and rollback need inspection");
    throw error;
  }
}

export function restoreFileEdits(edits) {
  const failures = [];
  for (const edit of [...edits].reverse()) {
    let temporary;
    try {
      if (contents(edit.path) !== edit.after) throw new Error(`Preserved concurrent metadata edit: ${edit.path}`);
      if (edit.before === null) unlinkSync(edit.path);
      else {
        temporary = stageReplacement(edit.path, edit.before);
        if (contents(edit.path) !== edit.after) throw new Error(`Preserved concurrent metadata edit: ${edit.path}`);
        renameSync(temporary, edit.path);
      }
    } catch (error) { failures.push(error); }
    if (temporary && metadata(temporary)) { try { unlinkSync(temporary); } catch (cleanup) { failures.push(cleanup); } }
  }
  if (failures.length) throw new AggregateError(failures, "Metadata rollback incomplete; inspect the preserved files");
}
