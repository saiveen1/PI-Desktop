import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const policyFiles = {
  "AGENTS.md": read("AGENTS.md"),
  "CLAUDE.md": read("CLAUDE.md"),
};
const gateSource = read("scripts/check-agent-policy-sync.mjs");

/**
 * `AGENTS.md` and `CLAUDE.md` route agents to real documents. The gate resolves
 * those `.md` paths against the repository root, so a temporary fixture must
 * materialize them instead of pointing at nonexistent files.
 */
function referencedDocs() {
  const refs = new Set();
  for (const source of Object.values(policyFiles)) {
    for (const match of source.matchAll(/`([^`\n]+?\.md)(?:#[^`\n]*)?`/g)) refs.add(match[1]);
    for (const match of source.matchAll(/\]\(\s*(<[^>\n]+>|[^)\s]+?)\s*\)/g)) {
      const target = match[1].replace(/^<|>$/g, "").split("#")[0];
      if (target.endsWith(".md") && !/^[a-z][a-z0-9+.-]*:/i.test(target)) refs.add(target);
    }
  }
  return [...refs];
}
const docs = referencedDocs();

function runGate(t, { overrides = {}, omitDocs = [] } = {}) {
  const directory = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-agent-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "scripts"));
  writeFileSync(join(directory, "scripts/check-agent-policy-sync.mjs"), gateSource);
  for (const doc of docs) {
    if (omitDocs.includes(doc)) continue;
    mkdirSync(dirname(join(directory, doc)), { recursive: true });
    writeFileSync(join(directory, doc), "# fixture\n");
  }
  for (const [path, content] of Object.entries({ ...policyFiles, ...overrides })) {
    writeFileSync(join(directory, path), content);
  }
  const result = spawnSync(process.execPath, [join(directory, "scripts/check-agent-policy-sync.mjs")], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  return result;
}

const replaceOnce = (source, from, to = "Removed by negative fixture.") => {
  assert.ok(source.includes(from), `fixture phrase is missing: ${from}`);
  return source.replace(from, to);
};

test("AGENTS.md is authoritative and CLAUDE.md only delegates to it", (t) => {
  assert.ok(docs.length > 0, "expected the policy files to reference real documents");
  assert.ok(docs.includes("docs/spec/00-baseline.md"));

  assert.ok(docs.every((doc) => existsSync(new URL(doc, root))), "every referenced document must exist");
  // The entry point stays a pointer: it names the policy, requires reading it,
  // and does not carry a second copy of the rules.
  assert.match(policyFiles["CLAUDE.md"], /`AGENTS\.md`/);
  assert.match(policyFiles["CLAUDE.md"], /authoritative/i);
  assert.match(policyFiles["CLAUDE.md"], /[Rr]ead\s+`AGENTS\.md`/);
  assert.ok(
    policyFiles["CLAUDE.md"].split("\n").length < policyFiles["AGENTS.md"].split("\n").length / 4,
    "CLAUDE.md should stay a short entry point, not a second policy document",
  );
  assert.match(policyFiles["AGENTS.md"], /`CLAUDE\.md`/);

  const result = runGate(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Agent policy check passed/);
});

test("the same Policy-Sync token is required in both files", (t) => {
  const mismatched = runGate(t, {
    overrides: {
      "CLAUDE.md": policyFiles["CLAUDE.md"].replace(/Policy-Sync: \S+/, "Policy-Sync: mismatched-fixture"),
    },
  });
  assert.equal(mismatched.status, 1);
  assert.match(mismatched.stderr, /Policy-Sync token mismatch/);

  const missing = runGate(t, {
    overrides: { "AGENTS.md": policyFiles["AGENTS.md"].replace(/Policy-Sync: \S+\n/, "") },
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /AGENTS\.md: missing `Policy-Sync: <token>`/);
});

test("the gate rejects a broken delegation from the Claude entry point", (t) => {
  const noAuthority = runGate(t, {
    overrides: {
      "CLAUDE.md": policyFiles["CLAUDE.md"].replace(/authoritative/gi, "referenced"),
    },
  });
  assert.equal(noAuthority.status, 1);
  assert.match(noAuthority.stderr, /must state that AGENTS\.md is authoritative/);

  const noRead = runGate(t, {
    overrides: {
      "CLAUDE.md": replaceOnce(
        policyFiles["CLAUDE.md"],
        "Read\n`AGENTS.md` before any non-trivial work, then follow it.",
        "This file is self-contained.",
      ),
    },
  });
  assert.equal(noRead.status, 1);
  assert.match(noRead.stderr, /must explicitly require reading AGENTS\.md/);
});

test("the gate rejects a Claude entry point that restates the policy", (t) => {
  const duplicated = runGate(t, {
    overrides: {
      "CLAUDE.md": `${policyFiles["CLAUDE.md"]}\n${[
        "SQLite is owned exclusively by Rust `host-core`.",
        "Electron Main must remain a thin orchestrator.",
        "Dev launches must isolate inherited data by default.",
        "Observable behavior changes must update the relevant spec.",
      ].join("\n")}\n`,
    },
  });
  assert.equal(duplicated.status, 1);
  assert.match(duplicated.stderr, /CLAUDE\.md: restates \d+ safety anchors/);
});

test("safety anchors are enforced in the authoritative policy, not the entry point", (t) => {
  for (const [phrase, anchor] of [
    ["SQLite is owned exclusively by Rust `host-core`.", "sqlite-host-core-only"],
    ["Electron Main must remain a thin orchestrator.", "main-thin-orchestrator"],
    ["Branches and worktrees are optional, not prerequisites for development.", "optional-worktree-isolation"],
    ["Do not create cross-checkout junctions or directory symlinks for mutable workspace trees.", "worktree-mutable-isolation"],
    ["Never recursively delete a worktree while it contains directory links.", "worktree-link-safe-teardown"],
    ["Worktree removal never authorizes branch deletion.", "worktree-branch-authorization"],
    ["Dev launches must isolate inherited data by default.", "development-data-safety"],
    ["Personal packaging must use `pnpm dist:personal` in the current checkout.", "fixed-personal-packaging-entry"],
    [
      "A packaging request never authorizes installation or application startup.",
      "packaging-is-not-installation",
    ],
    [
      "An ordinary `pnpm dist:personal` build never changes the app version",
      "packaging-does-not-bump-version",
    ],
    ["revert, move, or delete anything that is not from this task.", "uncommitted-work-preserved"],
    ["All user-visible strings in `apps/desktop` go through i18n", "i18n-user-visible-strings"],
    ["Every long-lived resource needs an owner and a cleanup path", "lifecycle-cleanup"],
  ]) {
    const result = runGate(t, {
      overrides: { "AGENTS.md": replaceOnce(policyFiles["AGENTS.md"], phrase) },
    });
    assert.equal(result.status, 1, `dropping ${anchor} should fail the gate`);
    assert.ok(result.stderr.includes(anchor), `expected ${anchor} in: ${result.stderr}`);
  }
});

test("an anchor kept only in the Claude entry point is reported as misplaced", (t) => {
  const phrase = "SQLite is owned exclusively by Rust `host-core`.";
  const result = runGate(t, {
    overrides: {
      "AGENTS.md": replaceOnce(policyFiles["AGENTS.md"], phrase),
      "CLAUDE.md": `${policyFiles["CLAUDE.md"]}\n${phrase}\n`,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /present in CLAUDE\.md but missing from AGENTS\.md/);
});

test("the gate rejects inline-code and Markdown-link references to missing documents", (t) => {
  const missingInline = runGate(t, {
    overrides: {
      "AGENTS.md": `${policyFiles["AGENTS.md"]}\nScoped rules: \`docs/spec/99-fixture/missing-rules.md\`\n`,
    },
  });
  assert.equal(missingInline.status, 1);
  assert.match(missingInline.stderr, /referenced document\(s\) do not exist: docs\/spec\/99-fixture\/missing-rules\.md/);

  const missingLink = runGate(t, {
    overrides: {
      "CLAUDE.md": `${policyFiles["CLAUDE.md"]}\nSee [fixture rules](docs/spec/99-fixture/missing-link.md#section).\n`,
    },
  });
  assert.equal(missingLink.status, 1);
  assert.match(missingLink.stderr, /referenced document\(s\) do not exist: docs\/spec\/99-fixture\/missing-link\.md/);

  // Omitting a real referenced document from the fixture is also a failure, so
  // the check cannot pass by comparing against an empty reference set.
  const omitted = runGate(t, { omitDocs: ["docs/spec/00-baseline.md"] });
  assert.equal(omitted.status, 1);
  assert.match(omitted.stderr, /docs\/spec\/00-baseline\.md/);
});

test("local development, packaging, and data-safety wording cannot regress", (t) => {
  for (const source of Object.values(policyFiles)) {
    assert.doesNotMatch(
      source,
      /1 request = 1 branch \+ 1 dedicated worktree|Never develop on `main`|Confirm you are \(or will create\) a dedicated worktree/,
    );
  }
  const worktree = runGate(t, {
    overrides: {
      "AGENTS.md": replaceOnce(
        policyFiles["AGENTS.md"],
        "Branches and worktrees are optional, not prerequisites for development.",
        "Every request must create a dedicated worktree.",
      ),
    },
  });
  assert.equal(worktree.status, 1);
  assert.match(worktree.stderr, /optional-worktree-isolation/);

  const dataSafety = runGate(t, {
    overrides: {
      "AGENTS.md": replaceOnce(
        policyFiles["AGENTS.md"],
        "Dev launches must isolate inherited data by default.",
        "Development data safety removed in this negative test fixture.",
      ),
    },
  });
  assert.equal(dataSafety.status, 1);
  assert.match(dataSafety.stderr, /development-data-safety/);
});
