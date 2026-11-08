#!/usr/bin/env node
/**
 * Agent policy gate: `AGENTS.md` is authoritative, `CLAUDE.md` only delegates.
 *
 * Usage:
 *   node scripts/check-agent-policy-sync.mjs
 *   pnpm check:agent-policy
 *
 * `AGENTS.md` carries the repository policy for AI agents. `CLAUDE.md` is the
 * Claude Code / Claude Cowork entry point: it must point to `AGENTS.md`, require
 * reading it before non-trivial work, and must not become a second copy of the
 * rules. Changing one without the other is documentation drift and fails here.
 *
 * Enforced:
 *   1. Both files exist at the repository root.
 *   2. Both declare the same `Policy-Sync: <token>` revision near the top.
 *   3. `CLAUDE.md` explicitly delegates to `AGENTS.md` and states that
 *      `AGENTS.md` is authoritative; `AGENTS.md` names `CLAUDE.md` and requires
 *      the token to stay in sync.
 *   4. Every safety anchor below is present in `AGENTS.md`. An anchor found only
 *      in `CLAUDE.md` means the policy moved back into the entry point.
 *   5. `CLAUDE.md` stays a pointer: it must not restate most of the anchors.
 *   6. Every `.md` document referenced from either file — inline code or a
 *      Markdown link — exists on disk.
 *
 * When policy text changes: update `AGENTS.md`, keep `CLAUDE.md` delegating,
 * bump `Policy-Sync:` in BOTH to the same new value, and run
 * `pnpm check:agent-policy`.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

const read = (relPath) => {
  try {
    return readFileSync(path.join(root, relPath), "utf8");
  } catch {
    failures.push(`${relPath}: file is missing`);
    return null;
  }
};

const normalize = (text) =>
  text
    .replace(/[→↓]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const agentsRaw = read("AGENTS.md");
const claudeRaw = read("CLAUDE.md");
const agents = agentsRaw ? normalize(agentsRaw) : "";
const claude = claudeRaw ? normalize(claudeRaw) : "";

// Safety anchors live in AGENTS.md only. Each is a distinctive phrase (or
// alternate phrasings) that the authoritative policy must keep stating, so
// rewriting the entry point can never drop a real safeguard.
/** @type {{ id: string, anyOf: string[], why: string }[]} */
const REQUIRED_ANCHORS = [
  {
    id: "fixed-personal-packaging-entry",
    anyOf: ["Personal packaging must use `pnpm dist:personal` in the current checkout."],
    why: "one fixed packaging entry keeps builds reproducible",
  },
  {
    id: "packaging-is-not-installation",
    anyOf: ["A packaging request never authorizes installation or application startup."],
    why: "building an installer must not install or launch it",
  },
  {
    id: "packaging-does-not-bump-version",
    anyOf: [
      "An ordinary `pnpm dist:personal` build never changes the app version",
      "an ordinary `pnpm dist:personal` build never changes the app version",
    ],
    why: "only an explicit candidate release selects a version",
  },
  {
    id: "development-data-safety",
    anyOf: ["Dev launches must isolate inherited data by default."],
    why: "development must not write a live release profile",
  },
  {
    id: "local-checkout-development",
    anyOf: ["Develop in the current checkout by default, including on local `main`."],
    why: "local development is the default workflow",
  },
  {
    id: "optional-worktree-isolation",
    anyOf: ["Branches and worktrees are optional, not prerequisites for development."],
    why: "worktrees remain optional, never a gate",
  },
  {
    id: "process-model",
    anyOf: ["Renderer → Preload IPC → Electron Main → Rust Host Core / Node Agent Runtime"],
    why: "the frozen process model must stay stated",
  },
  {
    id: "sqlite-host-core-only",
    anyOf: [
      "SQLite is owned exclusively by Rust `host-core`.",
      "sqlite remains owned exclusively by rust host-core",
    ],
    why: "storage ownership stays with the Rust host",
  },
  {
    id: "main-thin-orchestrator",
    anyOf: [
      "Electron Main must remain a thin orchestrator.",
      "electron main stays a thin orchestrator",
    ],
    why: "Electron Main must not absorb business logic",
  },
  {
    id: "no-implicit-delivery-actions",
    anyOf: [
      "Do not commit, stage, push, tag, open a PR, install a build, or launch Desktop",
    ],
    why: "git, packaging, and launch actions require an explicit request",
  },
  {
    id: "dependency-reinstall-not-for-e2e",
    anyOf: [
      "Do not run `pnpm install`, `npm install`, or create a second dependency or",
    ],
    why: "E2E reuses the checkout environment",
  },
  {
    id: "architecture-ratchet-hotspots",
    anyOf: ["apps/desktop/src/stores/app-store.ts"],
    why: "hotspot files stay shrink-or-stay-stable",
  },
  {
    id: "preserve-behavior-default",
    anyOf: ["Unless the task explicitly requires behavior to change"],
    why: "behavior changes are opt-in per task",
  },
  {
    id: "never-weaken-security",
    anyOf: ["Never fix functionality by weakening"],
    why: "security is never traded for convenience",
  },
  {
    id: "adr-for-frozen-boundaries",
    anyOf: [
      "Changing a frozen architecture, public interface, data ownership model, or",
    ],
    why: "frozen boundaries require an ADR",
  },
  {
    id: "specs-stay-synchronized",
    anyOf: ["Observable behavior changes must update the relevant spec."],
    why: "specs track observable behavior",
  },
  {
    id: "user-path-test-coverage",
    anyOf: ["including the representative user path through the affected feature"],
    why: "features need the real user path under test",
  },
  {
    id: "uncommitted-work-preserved",
    anyOf: [
      "Do not overwrite, revert, move, or delete anything that is not from this task.",
    ],
    why: "concurrent work must survive",
  },
  {
    id: "i18n-user-visible-strings",
    anyOf: ["All user-visible strings in `apps/desktop` go through i18n"],
    why: "the renderer ships translated strings",
  },
  {
    id: "lifecycle-cleanup",
    anyOf: ["Every long-lived resource needs an owner and a cleanup path"],
    why: "long-lived resources must be disposed",
  },
  {
    id: "product-specs-authoritative",
    anyOf: ["authoritative for behavior"],
    why: "product specs stay authoritative for behavior",
  },
  {
    id: "no-outside-pr-type-restriction",
    anyOf: ["do not apply here", "does not apply here"],
    why: "the inherited upstream PR-type restriction is not local policy",
  },
];

const requireContains = (label, haystack, needle, message) => {
  if (!haystack.includes(needle)) failures.push(`${label}: ${message}`);
};

/**
 * `.md` documents referenced inline (`docs/x.md`) or as a Markdown link
 * (`[text](docs/x.md#anchor)`). Fragments and trailing punctuation are stripped;
 * remote URLs are not local paths.
 */
function collectDocReferences(raw) {
  const inline = [...raw.matchAll(/`([^`\n]+?\.md)(?:#[^`\n]*)?`/gi)].map((match) => match[1]);
  const links = [...raw.matchAll(/\]\(\s*(<[^>\n]+>|[^)\s]+?)\s*\)/g)].map(
    (match) => match[1].replace(/^<|>$/g, ""),
  );
  return [...inline, ...links]
    .map((ref) => ref.split("#")[0].trim())
    .filter((ref) => /\.md$/i.test(ref))
    .map((ref) => ref.replace(/\.md$/i, ".md"))
    .filter((ref) => !/^[a-z][a-z0-9+.-]*:/i.test(ref))
    .map((ref) => ref.replace(/^\.\//, ""))
    .map((ref) => path.posix.normalize(ref.replace(/\\/g, "/")));
}

if (agentsRaw && claudeRaw) {
  const syncToken = /policy-sync:\s*`?([^\s`]+)`?/i;

  const agentsToken = agentsRaw.match(syncToken)?.[1];
  const claudeToken = claudeRaw.match(syncToken)?.[1];

  if (!agentsToken) {
    failures.push(
      "AGENTS.md: missing `Policy-Sync: <token>` (for example `Policy-Sync: 2026-02-14.1`)",
    );
  }
  if (!claudeToken) {
    failures.push(
      "CLAUDE.md: missing `Policy-Sync: <token>` (for example `Policy-Sync: 2026-02-14.1`)",
    );
  }
  if (agentsToken && claudeToken && agentsToken !== claudeToken) {
    failures.push(
      `Policy-Sync token mismatch: AGENTS.md has \`${agentsToken}\`, CLAUDE.md has \`${claudeToken}\`. Update both files and set the same new token.`,
    );
  }

  // Delegation, not duplication: CLAUDE.md must send the reader to AGENTS.md.
  requireContains(
    "CLAUDE.md",
    claude,
    "agents.md",
    "must name AGENTS.md as the authoritative policy it delegates to",
  );
  requireContains(
    "CLAUDE.md",
    claude,
    "authoritative",
    "must state that AGENTS.md is authoritative",
  );
  requireContains(
    "CLAUDE.md",
    claude,
    "read `agents.md`",
    "must explicitly require reading AGENTS.md before non-trivial work",
  );
  requireContains(
    "CLAUDE.md",
    claude,
    "delegat",
    "must describe itself as delegating to AGENTS.md instead of restating policy",
  );
  requireContains(
    "AGENTS.md",
    agents,
    "claude.md",
    "must name CLAUDE.md as the Claude Code entry point that delegates here",
  );

  for (const anchor of REQUIRED_ANCHORS) {
    const inAgents = anchor.anyOf.some((phrase) => agents.includes(normalize(phrase)));
    const inClaude = anchor.anyOf.some((phrase) => claude.includes(normalize(phrase)));
    if (!inAgents && !inClaude) {
      failures.push(
        `policy anchor \`${anchor.id}\`: missing from AGENTS.md (looked for: ${anchor.anyOf
          .map((phrase) => `"${phrase}"`)
          .join(" | ")}) — ${anchor.why}`,
      );
    } else if (!inAgents) {
      failures.push(
        `policy anchor \`${anchor.id}\`: present in CLAUDE.md but missing from AGENTS.md — move the rule into the authoritative policy`,
      );
    }
  }

  // A pointer file must not grow back into a second policy document.
  const restatedInClaude = REQUIRED_ANCHORS.filter((anchor) =>
    anchor.anyOf.some((phrase) => claude.includes(normalize(phrase))),
  );
  if (restatedInClaude.length > 2) {
    failures.push(
      `CLAUDE.md: restates ${restatedInClaude.length} safety anchors (${restatedInClaude
        .map((anchor) => anchor.id)
        .join(", ")}). Keep it a short delegation to AGENTS.md and let AGENTS.md own the rules.`,
    );
  }

  // Every referenced document must exist for both files.
  for (const [label, raw] of [
    ["AGENTS.md", agentsRaw],
    ["CLAUDE.md", claudeRaw],
  ]) {
    const missing = [...new Set(collectDocReferences(raw))].filter(
      (relPath) => !existsSync(path.join(root, relPath)),
    );
    if (missing.length > 0) {
      failures.push(
        `${label}: referenced document(s) do not exist: ${missing.join(", ")}. ` +
          "Update the path, or create the scoped rules file before referencing it.",
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Agent policy check failed:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nAGENTS.md is authoritative; CLAUDE.md must delegate to it. Keep the safety anchors in",
  );
  console.error(
    "AGENTS.md, keep referenced documents real, and set the same `Policy-Sync:` token in",
  );
  console.error("both files. Then re-run: pnpm check:agent-policy");
  process.exit(1);
}

console.log("Agent policy check passed (AGENTS.md authoritative, CLAUDE.md delegating).");
