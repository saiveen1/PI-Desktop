# ADR 0089: Proactive Background Subagent Delegation

- Status: Accepted for implementation (resumable delegations amended by
  ADR 0279)
- Date: 2026-08-16
- Related: D201, D202, ADR 0062, ADR 0063, ADR 0048, ADR 0100, ADR 0279,
  E2E-142

## Context

ADR 0062 shipped delegation as context economy, and in practice the main agent
almost never delegates: the system prompt said nothing positive about it,
`Task` blocked the parent's tool loop, every builtin delegate was read-only,
and a per-batch concurrency cap of four left no room for orchestration patterns
such as reviewing a change before commit or exploring directions in parallel.

## Decision

Make delegation a first-class, proactive orchestration capability while keeping
every containment boundary ADR 0062 established.

### 1. The delegate lifecycle is non-blocking and tool-driven

`Task` starts a delegate in the background and returns a `delegationId`, and
three core tools drive the rest: `TaskWait` converges on running delegations and
returns their reports, `TaskList` reports the session's delegations with
status, and `TaskStop` stops them and reads as `stopped`. The runtime keeps a
delegation registry of id, agent, status, timings, result, completion promise,
and abort handle, retains settled records for the session so reports can be
re-read, and aborts anything still running when the run ends.

### 2. The system prompt names positive trigger patterns

The base prompt gains a `## Delegation` section, present only when the catalog
is non-empty, that lists the situations worth delegating and the convergence
rules for ending a turn.

### 3. New builtins: a faster `explorer` and a write-capable `fixer`

`explorer` was rewritten around tool selection and a structured report shape,
and a fourth builtin `fixer` implements multi-file changes from a complete spec
with a summary/changes/verification report; the other three stay read-only.

### 4. Definitions may declare a permission scope

Frontmatter accepts `permission: inherit | ask | accept-edits | auto`, default
`inherit`, and an explicit non-`inherit` scope is resolved by host-core for the
delegate's `tools.execute` calls instead of the session's effective mode. It is
a permission-mode override only: the hard deny rules and the external-path gate
stay in force, and `accept-edits` auto-allows `Write`/`Edit` inside the
workspace and scratch roots while Bash keeps the session's behavior.

### 5. Concurrency

The original per-session running cap was 10 (previously a per-batch cap of 4).
The 2026-11-12 capacity amendment makes it `delegation.limits.maxConcurrent`
(1–64, default 10), configured in Subagents → Scheduling. The live Host policy
snapshot carries it; Task checks it after model authorization and reports the
effective cap. Lowering it does not stop existing children, but later starts
and resumes wait for free capacity. Settled tasks release slots, so cumulative
task creation is not capped. The finite upper bound limits accidental API and
sidecar fan-out. Legacy default exports, approval gates, child work budgets and
history retention remain compatible. New optional fields use the existing
version-1 settings JSON with validation and no database-schema migration.

## Consequences

- Delegation becomes background orchestration: the parent implements while
  `explorer` searches and `code-reviewer` reviews, then converges with
  `TaskWait`.
- Positive prompt triggers plus a lifecycle vocabulary are what make delegation
  proactive rather than permitted-but-unused.
- A write-capable delegate is bounded by its definition's `permission` scope
  while host-core stays the authority, and old transcripts keep rendering
  through the existing delegate presentation.

## Alternatives

- Delegates running across turns: rejected, it would require reworking the turn
  lifecycle, completion semantics, and renderer idle handling for parallelism
  the within-turn model already delivers.
- Keeping `Task` blocking with a `wait` flag: rejected, a flag the model must
  remember to set is one it forgets.

## Amendment — session-owned job controls (2026-11-05)

`TaskWait`, `TaskList`, and `TaskStop` share explicit typed job references,
routing delegations in runtime and background Bash through session-owned Host
RPC. Controls exist without a subagent catalog. Host retains ownership checks,
operating-mode policy and process supervision; reports and resume chains stay
in runtime. Implicit wait/stop sets contain delegations, never Bash jobs.

Bash waits are bounded and completion-aware. Cancelling observation does not
signal the process; repeatable stdout/stderr tails are bounded independently.
No stdin, log-file dependency, restart durability or completion notification is
added. Remote/older Hosts explicitly report unsupported controls. Host output
and history retention remain finite.

### Coherent delegation selectors and explicit Bash targets (2026-11-07)

A delegation job accepts exactly one matching `delegationIds` entry and retains
delegation wait options; ambiguous sets fail. An explicit Bash job is the sole
target: pi `prepareArguments` removes delegation-only selectors from a copy
before schema validation, including irrelevant invalid values. Original arguments
remain diagnostic evidence. Identity, timeout, cancellation and ownership checks
are unchanged; failed lifecycle rows expose arguments without changing successful
roster presentation.
