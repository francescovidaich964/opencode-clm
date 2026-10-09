# opencode-clm architecture

opencode-clm gives an OpenCode agent write access to its own context. The context the model
will see on its next request is mirrored to a file; the model edits that file with ordinary
tools; the plugin validates the result and uses it for the next request. OpenCode's stored
session history is never rewritten.

This document describes the system as implemented for OpenCode 1.18.34; §11 holds the
design notes and known limitations.

## 1. Three representations of one conversation

```text
OpenCode session history (raw, { info, parts } messages)
             │  experimental.chat.messages.transform
             ▼
Effective context — the messages actually sent to the provider
             │  rendered before every request
             ▼
Mirror file  — LIVE_CONTEXT.md, model-editable
             │  parsed and validated at the start of the next transform
             ▼
Revision checkpoint — persisted in the session's state.json
```

- **Raw history** is the source of truth and audit log. The plugin never deletes or
  rewrites it.
- **Effective context** is what the model sees. It equals the pinned task (everything up
  to and including the first user message), then the latest accepted revision plus every
  raw message appended since that revision was anchored.
- **Mirror** is a text rendering of the effective context after the pinned task. Editing
  it is the only way the model changes its context. It is not byte-for-byte the provider
  input: the system prompt, the pinned task, the continuity note and the one-request
  notices are added outside it.
- **Revision checkpoint** records an accepted edit: which raw prefix it replaces (by
  count, OpenCode message ids and SHA-256 digest), the resulting messages, size estimates,
  and a per-message edit trace.

`src/opencode.ts` converts between OpenCode's messages and the flat message list the core
works on. OpenCode keeps a tool call and its result in one `tool` part; `flatten` splits
each assistant message into an assistant message with tool calls followed by one
`toolResult` message per call, so every tool result is its own mirror block. `flatten`
follows OpenCode's own `toModelMessages` rules (skipped failed replies, the
"[Old tool result content cleared]" text for pruned output, and so on). `unflatten` maps
each untouched block back to the current raw OpenCode object, so untouched messages reach
the provider exactly as OpenCode would send them.

## 2. Request lifecycle

```text
messages.transform   0. re-read overrides.json if it changed; activate the settings
                     1. commit: read the mirror; changed → parse, gate, persist a new revision
                     2. measure the newest provider-reported input (calibration, fixed overhead)
                     3. effective = checkpoint.messages ++ raw suffix; rebase after a
                        compaction; drop the checkpoint on any other prefix mismatch
                     4. hide reasoning if configured; observation cap; overflow guard
                     5. render effective → mirror file (atomic write)
                     6. append notices: last edit outcome, reset, overflow, continuity size,
                        budget reminder
                     7. write pinned ++ effective ++ continuity ++ notices into OpenCode's
                        array in place; replace snapshot.json; log a `request` event
system.transform     append the editing protocol + mirror path (+ steering) to the system prompt
                     (notices-only: steering only)
provider request     the model sees the effective context
assistant step       the model may rewrite the mirror with bash/edit/write
tool.execute.after   a tool call that wrote the mirror gets a dry-run verdict appended
```

`mode notices-only` skips steps 1 and 5 and the checkpoint part of step 3: nothing is
committed or rendered, the accepted checkpoint (if any) stays in `state.json` but is not
applied, and the effective context is the raw history (reasoning view, cap and guard
still apply). There is no baseline, so the bash verdict stays silent and `/clm-compact`
refuses. Notices use wording without the mirror (`budgetNoticeText` and the overflow,
too-small and compaction notices take a notices-only variant). Ignoring the checkpoint
rather than dropping it makes the mode switch reversible: back in `edit` the checkpoint
applies again while it still matches the history, and a compaction signal received
meanwhile is held until then so the rebase can still happen.

OpenCode has no end-of-turn hook, so the edit the model made during step *k* is committed
at the start of step *k+1*'s transform, right before the request it affects. The file
content at that moment wins.

Other hooks: `tool.definition` records each tool's schema size; `experimental.session.compacting`
and `experimental.compaction.autocontinue` and the `session.compacted` event handle
OpenCode's compaction (§6); `command.execute.before` answers `/clm` and `/clm-compact`;
`config` registers both commands and the `clm-context` skill directory. The
`clm_annotate` and `clm_recall` tools manage continuity annotations.

`experimental.chat.messages.transform` receives `{}` as input: the session id comes from
`messages[0].info.sessionID`, and the result must be written into the array in place.
OpenCode calls it before `experimental.chat.system.transform` for the same request, so the
system-prompt size and model limits reach the session one request late. The system
transform skips OpenCode's helper agents (title, summary, compaction). Transforms of one
session run one at a time. A transform that throws fails open: the request goes out with
the raw history and a toast reports the error.

## 3. Mirror format

```text
[[LIVE_CONTEXT version=1 revision=3 document=<nonce> baseline=<digest>]]

# Edit bodies or delete editable CTX_TURN blocks. Keep metadata/header lines intact.

[[CTX_TURN document=<nonce> index=1 role=assistant id=1-b1ba26e534cb protected=false]]
I will count the lines of both commands.

[[CTX_TURN document=<nonce> index=2 role=notes id=new-tracker protected=false]]
TASK TRACKER
- ...
```

- Every structural line carries the document nonce. It is derived from the session id, a
  random value drawn when the session opens in this process, the active checkpoint's
  source digest and the revision number, so it is **stable between accepted edits** even
  as new messages arrive: ids a model reads on one call are valid on the next, and a
  metadata line copied from an earlier read is accepted (only version, revision and nonce
  must match; the ever-changing `baseline=` digest is informational). Because the nonce is
  stable, lines inside bodies that start with `[[CTX_TURN ` or `[[LIVE_CONTEXT ` are
  escaped with a leading backslash at render time and restored when an edited body is
  turned back into a message; a `head LIVE_CONTEXT.md` tool result can therefore never
  inject blocks.
- `id` binds a block to a specific rendered message. `index` is descriptive.
- `protected` is always `false`: every block is editable. The task statement is protected
  by staying outside the mirror instead.
- A block whose id starts with `new-` inserts a message. Any role label is accepted.
- With the `reasoning` setting off, reasoning is hidden from the mirror view only; the
  digest a checkpoint stores still covers it.

## 4. Applying an edit

The apply step is identity-preserving: rendering and re-applying an untouched mirror
yields the original messages, so the plugin's own serialization never counts as change.

| block state                         | result                                                        |
|-------------------------------------|---------------------------------------------------------------|
| unchanged                           | original OpenCode message reused (parts, files, tool calls, reasoning intact) |
| assistant body edited (role kept)   | text-only assistant message; its tool calls are dropped and their results become notes |
| user body edited (role kept)        | user message with the new text                                 |
| tool result body edited (role kept) | the tool part keeps its call; only the output text changes     |
| a block whose role label was changed | a note carrying the text                                      |
| new block (`id=new-*`), any role — including `assistant` or `system` | a note labelled with the requested role; reaches the provider as synthetic user text, never as an assistant or system role |
| removed                             | omitted                                                        |
| text outside any block              | becomes a note at that position                                |

Notes are `clm-note` messages in the core and synthetic user text parts in the request.

Blocks are emitted in document order, so reordering is an edit like any other.

**Tool-call group repair.** OpenCode allows parallel tool calls. An assistant message keeps
its structured tool calls only if every retained call has its tool result retained; a tool
result is kept only if its call is retained. Broken groups are flattened to notes rather
than rejecting the edit.

## 5. Validation

An edit is accepted when:

1. the metadata line matches the rendered one (version, revision and nonce);
2. every header carries the current nonce and refers to a rendered id or a `new-` id, with
   no duplicates and no malformed current headers;
3. the lowered message sequence has legal tool-call structure after repair;
4. the edit gate passes (below);
5. the revision can be serialized as a checkpoint and saved to `state.json`.

A file with no current block headers is accepted as a whole-context rewrite: every block is
removed and the text becomes one `notes` block after the pinned task. A file with no
current headers but with headers or a metadata line from another copy of the mirror is an
old copy written back, and is rejected. Metadata rejections quote the exact first line
expected.

**Edit gate.** The `gate` setting decides whether an edit that grows the context is
accepted. `fit` (the default) accepts growth while the edited context stays within its
share of budget − reserve (the system prompt, tool schemas, pinned task and continuity
note take theirs first). `shrink` rejects any growth. `none` performs no size check, as
pi-clm's CLM mode does. Under every gate, same-size rewrites, insertion, reordering,
deletion and edits to any block are valid.

Persistence completes before a revision is activated; a failed write leaves the previous
revision in force. An edit made against a render that is no longer current (after
`/clm reset`, `/clm on|off`, or a process restart) is dropped without a notice: the next
render overwrites it.

## 6. Persistence, revert and compaction

Each session's state lives in `state.json` in its session directory (§9): the enabled
flag, the revision counter, the active checkpoint, the last outcome and the budget check.
Every change goes through one save queue: the next state is computed, saved atomically,
then activated. Every accepted revision also writes `revisions/rN.md` (the mirror text)
and `revisions/rN.json` (each row's text before and after). Continuity annotations are
lines in `annotations.jsonl`; every request, edit, rejection, reset, compaction, notice and
error is a line in `events.jsonl`.

- Session open (start or resume): `state.json` is loaded, and the checkpoint applies only
  if its raw prefix still validates. An unusable state file starts the session clean with
  a toast.
- **Anchor.** The digest covers the flattened raw prefix with tool-result content left
  out, plus each message's OpenCode id and a per-message stamp (its digest and the
  `time.updated` captured with it). OpenCode's prune (which clears old tool output in
  place) therefore does not discard a checkpoint; a revert removes messages, changes the
  ids, and drops it.
- **Tail re-anchoring.** OpenCode keeps writing message objects after the transform returns
  (an assistant message being finalized) and appends or removes `<system-reminder>`
  mode-change blocks on user messages, so a checkpoint can digest content that changes
  without a revert. When the whole-prefix digest no longer matches but every changed
  message is explained by OpenCode itself — its write time (`time.completed`/`updated`)
  moved past the captured stamp, or the change is confined to `<system-reminder>` blocks
  (verified against a reminder-stripped per-message fingerprint) — the anchor is trimmed to
  the last stable message and the trimmed tail flows as ordinary suffix, with a
  `reanchored` event. This is the same contract as pi-clm's rebasing for appended messages;
  the revision is not dropped and the model gets no notice. Anything else (a revert, a
  compaction, another plugin rewriting in memory, which moves no write time and is not a
  reminder-only edit) still fails closed.
- **Revert and fork.** Each accepted checkpoint is also kept in `checkpoints/rN.json` (the
  newest 8). When the active revision no longer fits (a revert cut into its prefix), the
  newest older checkpoint that still fits becomes the next revision, with a notice and a
  `restored` event. The plugin stamps `metadata.clm.origin` on each OpenCode session; a fork
  copies the metadata, so a fork's first request restores the origin's newest checkpoint
  whose source the fork starts with (compared without message ids). `/clm reset` clears
  the history. The fork's first request also copies the origin's annotations made up to the
  fork point, their sources re-pointed at the fork's copies of the messages.
- Any other prefix mismatch (or a mismatch on a checkpoint without stamps) drops the
  revision: the next request carries the stored history, and the model gets a notice. Two
  consecutive drops add a warning that edits keep being dropped until the start of the
  history stops changing.
- **OpenCode compaction.** `experimental.session.compacting` marks the session and appends
  an instruction plus the active annotations to the compaction prompt, asking the
  summarizer to copy them word for word. The compaction's own `messages.transform` call
  then applies the accepted revision to the head slice it summarizes, so the summary reads
  the model's edited context, not the raw history; nothing is committed, rendered or
  reset in that call. When OpenCode reports a finished compaction (`session.compacted` or
  `experimental.compaction.autocontinue`), the next transform rebases on the summary: the
  revision number moves on, the checkpoint goes, and the model gets no drop note.

A checkpoint anchors to the digest of the messages this plugin receives. OpenCode runs a
hook in each plugin in turn, built-in plugins first, then the configured ones in load
order, all on the same output; a plugin whose `messages.transform` runs earlier and varies
its output between calls invalidates the checkpoint (its in-memory rewrite does not move
`time.updated`, so tail re-anchoring cannot cover it and it fails closed). After two
consecutive drops the plugin toasts once per session, naming that cause and advising to
load opencode-clm before such a plugin.

## 7. Budget and reminders

`src/budget.ts`. The budget is the `budget` setting (`CLM_BUDGET`): a share of the model
window minus its output limit (`contextFraction`, default 50%; `FALLBACK_BUDGET`, 32,000,
while the window is unknown), a token count capped by that same base, or `window` for all
of it; the reserve (default 2,048) is generation headroom. A fallback reading
(`source: "fallback"`) taken before the system transform has seen the model
(`limitsKnown` false) is a placeholder that the next request replaces: the overflow guard
withholds nothing against it (`guardLimit()` is undefined), the fit gate measures against
no limit, the size trailer is omitted, and `BudgetTracker` is not consulted, so no reminder
fires and no tier is marked fired. A model that reports no window keeps the fallback,
which then applies in full. Reminders fire at 25/50/75% of
the budget (`remindAt`) and at budget − reserve, once per tier, re-arming when usage drops.
An accepted edit starts a cooldown (`reminderCooldown`, default 10% of the budget): the
first reading after it records the size E, and until the estimate reaches E + cooldown ×
budget, `BudgetTracker` marks crossed percentage tiers fired without a notice (logged as
`budget-notice-suppressed`). The budget − reserve tier is exempt. A later accepted edit
restarts the cooldown; a tracker reset (budget or reminder change, `/clm reset`,
compaction, a restored revision) and an editing toggle clear it. Without the cooldown an edit that drops the
context below a tier re-arms it, and the model hears the same reminder soon after.

Two numbers are measured and always labelled separately:

- **estimated next request** — system prompt + tool schemas + pinned task + effective
  messages + continuity + notices, using chars/4 × `estimateFactor` × the calibration
  factor;
- **observed previous request** — input + cache read + cache write tokens of the newest
  successful assistant message (the provider's own count). It is one call late and is
  marked stale after an accepted edit, when it no longer describes the current context.

The estimate alone governs reminders; the observed count is shown for reference.
Reminders are advisory; the plugin never rolls back or refuses a request and never
re-executes a tool.

**Fixed overhead.** Once per session the plugin measures the system prompt and tool
schemas as the provider counted them: the previous request's provider count minus its
conversation estimate, taken from a request whose conversation is at most a quarter of
that count. When the provider reports no usage, the hook-measured sizes stand in until a
provider measurement replaces them. If budget − reserve − overhead leaves less than an
8,000-token working margin, the session's effective budget is raised to overhead + margin
+ reserve (capped by the model window), with a one-time toast and notice. The overhead is
stored in `state.json`, so the raise survives a restart.

## 7a. Overflow guard

`src/overflow.ts`. Applied in the transform after the observation cap and before
rendering, when the estimated request (fixed overhead + pinned task + continuity + notices
+ effective messages) exceeds budget − reserve. Unlike pi-clm there is no
`window − 4096` ceiling: that one models a Pi `max_tokens` clamp OpenCode does not have.
The model's output limit is subtracted from the window instead (§7).

Tool results in the raw suffix (after the last accepted edit) are replaced, **oldest
first**, one at a time, by a note of the same `toolResult` role and `toolCallId` — so
tool-call pairing stays legal — until the estimate fits or no candidates remain. Oldest
first is essential: the result the model just requested (typically a re-read of a withheld
file) must stay visible, otherwise withholding becomes a loop. Each note states the tool,
call id, approximate tokens, the limit, and the path of a file under
`<session dir>/withheld/` holding the full text (uncapped, when the observation cap cut
it). Notes are cached per source message (identical objects across calls, never withheld
again), raw history is untouched, tools are never re-run, and a
`[CLM BUDGET] Overflow guard …` notice lists what happened. The model's accepted
projection is never withheld from; if the estimate is still over after all candidates,
the notice says so. `guard: off` (`CLM_OVERFLOW`) disables the guard.

**Calibration.** `EstimateCalibrator` (budget.ts) records the raw estimate of every
request sent and, when the provider reports that request's size, updates a factor
(≥ 1, EMA, capped at 4) applied to all subsequent estimates — reminders, guard, gate and
notices. It learns only from same-scope estimates: with the overhead measured, the
conversation against the provider count minus the overhead; otherwise only once both hook
sizes are known. It restarts at 1 when the provider-measured overhead arrives, and with
each process. `estimateFactor` (`CLM_ESTIMATE_FACTOR`, 1–4) is a separate fixed multiplier
on chars/4.

## 7b. Steering and observation cap

`src/steering.ts`: an optional markdown document (`CLM_STEERING`; `house` names the
shipped `steering/house-brief.md`) appended to the system prompt after the protocol
section as `## Context-management guidance (<name>)`. The base document is loaded when the
plugin loads (a missing or empty file leaves sessions protocol-only, with an error toast,
a log line and a warning in `/clm status`); a per-session
change is loaded when the setting is applied. It is hashed (SHA-256 prefix shown in
`/clm status`) and never part of the mirror. This is the only sanctioned channel for
strategy; the protocol text stays protocol-only.

`src/observation.ts`: an optional per-tool-result character cap (`CLM_OBSERVATION_CAP`)
applied to the *effective* messages in the transform, after the reasoning view and before
the overflow guard. Oversized results keep a head (80 % by default; `10000:0.5` is the
paper's 5k+5k) and a tail with an omission marker stating how much was cut; the minimum
cap is 200 characters. Capped objects are cached per source message so repeated
transforms yield identical objects; the stored tool part is untouched, and an unchanged
capped block is persisted in its capped form when an edit is accepted.

## 7c. Settings

`src/settings.ts` resolves the plugin options (the `plugin` entry in `opencode.json`), then
environment variables, then defaults, once at load; an invalid value fails the plugin with
the setting's name. `src/settings-table.ts` is the one table of the fifteen settings a session
can change — editing, budget, reserve, reminders, reminder cooldown, edit gate, overflow guard, compaction,
observation cap, steering, mode, one-tool, trailer, compact prompt, reasoning — with each one's label, description, choices,
formatting and parsing; values parse with the same functions as options and environment
variables. `enabled`, `mirrorDir`, `estimateFactor`, `skill`, `commands` and
`dumpRequests` are load-time only.

A change from the panel, `/clm config <setting> <value>` or `/clm on|off` goes through
`changeSetting` (`src/overrides.ts`): parse, merge, drop values equal to the base, stage
(resolve the policies, load a steering document or compact prompt strictly), then write
`overrides.json` atomically as `{ "version": 1, "overrides": { … } }`. A change that fails
any step is reported and not written, so it never takes effect. The base is the server's
load-time settings; for `editing` it is `state.json`'s `enabled`. Before each transform,
system transform and `/clm` command the server compares the file's mtime, size and inode
with the last read; on a change it re-reads and activates it from the next request. A
stored value that is malformed is dropped with a warning in `/clm status` and one toast
(again only when the warning changes; delivered with the next request, also while CLM is
off); a steering document that no longer loads leaves the session protocol-only, also with
a warning. The base steering document failing again does not repeat its load-time toast.
`/clm config reset` writes an empty override set. Overrides are per session.

## 7d. Model-driven compaction (`/clm-compact`)

`src/compact.ts`. `/clm-compact [instructions]` is an OpenCode command, so the prompt's
autocomplete lists it beside `/compact`. `command.execute.before` replaces its template
with a fixed prompt, sent as an ordinary user message: compact the live context by editing
the mirror, keeping the task, decisions, open items and exact values, and dropping used
tool output. Text after the command is appended as "Also: …". The model decides how much
to remove; its edit is validated and committed before the next request like any other,
and the plugin removes nothing itself. (OpenCode's `/compact` instead summarizes the
history with a separate model call, §6.) The size in the prompt is estimated when the
command runs, from the stored history through the accepted revision (the system prompt and
tool schemas count once the session has reported them). The stored history is cut as
OpenCode cuts it for a request (`filterCompacted`, a port of `MessageV2.filterCompacted`),
so history before a native compaction does not count. OpenCode runs a command at once,
also during a run, and its prompt joins the running loop; typed mid-run, the size lacks the
rest of the current turn, and the toast says it was measured before the run finishes. A
second `/clm-compact` is refused (toast and one-line note) until the model receives the
first: the first request whose history holds its prompt, or the session going idle or
failing, ends the wait. With CLM off for the session or an
empty history the command is refused with a toast, and the model gets a one-line note
instead of the prompt. The `compact prompt` setting (`CLM_COMPACT_PROMPT`; `default` =
built in) replaces the built-in text with a markdown template using `{{mirror}}`,
`{{current}}`, `{{budget}}` and `{{instructions}}` (typed instructions are appended when
the template has no `{{instructions}}`); the file is read on every use.

## 8. Panel

OpenCode runs server plugins and TUI plugins in separate runtimes and reads them from
separate config lists, so the package ships two plugins:

| target | entry | `package.json` | config list | does |
|---|---|---|---|---|
| server | `index.ts`, default export `{ id: "opencode-clm", server }` | `exports["./server"]` (and `"."`, `main`) | `plugin` in `opencode.json` | hooks, mirror, edits, budget, tools, `/clm` and `/clm-compact` commands |
| TUI | `tui.ts`, default export `{ id: "opencode-clm", tui }` | `exports["./tui"]` | `plugin` in `tui.json` | the `/clm` panel, typed `/clm …` lines |

The two talk only through the session directory: the server writes it, the TUI reads it
and writes only `overrides.json`. `@opentui/core` is an optional peer dependency; OpenCode
provides it to TUI plugins at runtime. The TUI code uses no JSX, because OpenCode's Solid
compile step skips `node_modules`; it builds opentui renderables directly.

`/clm` opens the panel, a plugin route with its own key mode, so the host's prompt and key
bindings are inactive while it is open; it never enters model context. `/clm <page>` opens
a page directly. A key interceptor at priority 100 sees Enter before autocomplete and
prompt submit: a prompt line matching `/clm…` is handled in the TUI and the prompt is
cleared (a usage error keeps the text so it can be fixed); `/clm reset` rewrites
`state.json`, so it goes to the server plugin over a turn-free channel (`src/channel.ts`:
a `tui.command.execute` event the server's `event` hook answers). When the config's `/clm` is not this package's
(a user-defined command, or `commands: false`), the intercept lets every line through.
Without the TUI (`opencode run`, a bare server), the server's `/clm` command returns the
same pages and `/clm status` as text. Four pages:

- **overview** — a bar chart of the size of every request in the session (one column per
  request), the budget as a dashed line, requests followed by an accepted edit marked, and
  the list of edit, reset and compaction points. It opens on **now** (the latest request);
  `← →` step through the points and back to now. `z` cycles the x axis (shown as all /
  detail / turns): `fit` (the whole session bucketed to the width; the default),
  `requests` (one column per request, panning; skipped when fit already shows one request
  per column) and `turns` (one column per user turn). Edit markers sit above their bar
  (`▿`, `▼` selected, or a count when several edits share a column); user turns are `•`
  landmarks on the baseline. The list is collapsed (`▸`) except the selected row (`▾`) and
  shows a window around the selection (`⋯ N earlier` / `⋯ N later`).
- **input** — the fraction of the raw history the model currently sees and the effective
  message list, from `snapshot.json`.
- **edits** — per-revision, per-message rows from `revisions/rN.json`; `Enter` expands a
  row into a side-by-side diff (`src/panel/diff.ts`: line diff with word-level emphasis
  inside changed pairs, unified `-`/`+` below 60 columns). The diff runs on the full text;
  the display is bounded (400 rows for edited messages, 60 for removed or added, 2,000
  characters per line) with an explicit "diff preview truncated" row.
- **settings** — sizes, calibration, the guard limit, the steering document and the
  annotation counts (from `annotations.jsonl`) above the fourteen settings of §7c and a Reset
  row (`Enter` cycles it to "reset now", which resets at once): `Enter` cycles a setting's choices or opens a text prompt; rejected values show a
  warning and keep the value in effect.

The TUI plugin also fills the `session_prompt_right` slot with a one-line footer
(`clm <size> / <budget> · r<revision>`), one renderable per session, refreshed on
`session.idle` and completed replies; while the panel is open for the session it takes the
panel's model instead of reading the files again.

`r` reloads the files; `q` or Esc closes. Colors use OpenCode theme names: bars
`textMuted`, edit events `markdownLink`, `warning` for the budget line and rejected edits,
`diffAdded`/`diffRemoved` for diffs.

`buildPanelModel` (`src/panel/model.ts`) builds the panel from the session files alone:
points from `request` events (a request's size is the next request's `observedPrevious`
unless that came from the same message as its own, or for the newest the host's count of a
reply completed after it, else the estimate), markers from `accepted`, `rejected`,
`reset`, `projection-reset` and `compacted` events, revisions from `revisions/rN.json`,
input from `snapshot.json`, and the budget recomputed with `budgetFit`. `renderPanel`
draws it as lines of styled spans; the opentui adapter maps tones to the theme.
`src/session-files.ts` reads the directory: missing files are normal, torn lines are
skipped, revision files are cached by mtime and size.

## 9. Storage and safety

- Session directory: `<mirrorDir>/clm-<session id>/`, where `mirrorDir` defaults to
  `.opencode/clm` in the project (`CLM_MIRROR_DIR`). The parent gets a `.gitignore` of `*`;
  directories are `0700`, files `0600`, writes are atomic temp-file-plus-rename. A session
  directory that is a symlink or owned by another user is refused, as is a session id
  containing `/`, `\` or `..`. Directories untouched for seven days are swept when another
  session opens.
- No usable session directory (configured `mirrorDir` and the project default both fail):
  the session runs without a mirror from a private `opencode-clm-*` directory under the OS
  temp directory, one per server process, removed on normal exit
  (`ClmSession.mirrorUnavailable`). The model gets no protocol prompt and no mirror;
  requests carry the raw history, the continuity message and its size notice. See
  configuration.md, "No usable mirror directory".

| file | written by | content |
|---|---|---|
| `LIVE_CONTEXT.md` | server | the mirror |
| `state.json` | server | enabled flag, revision, active checkpoint, last outcome, measured fixed overhead and budget decision |
| `annotations.jsonl` | server | continuity annotations |
| `events.jsonl` | server | one JSON line per request, edit, rejection, reset, compaction, notice and error |
| `revisions/rN.md` | server | the mirror text of each accepted revision |
| `revisions/rN.json` | server | each accepted revision row by row: kind, indexes, roles, tokens, text before and after |
| `checkpoints/rN.json` | server | the newest 8 accepted checkpoints, for restore after a revert or into a fork |
| `snapshot.json` | server | replaced on every request: sizes, budget, calibration, steering, the effective input with a preview per message, and the server's base settings |
| `overrides.json` | TUI and server | per-session setting changes (§7c) |
| `withheld/` | server | tool outputs held back by the overflow guard |
| `requests/nN.json` | server | transformed requests, with `dumpRequests` only |

- The session directory contains conversation data and should be treated as sensitive
  local data.
- Model-editable working memory is a prompt-injection surface: text that reaches the
  context can induce the model to rewrite its own constraints. opencode-clm keeps the real
  system prompt and the task statement outside the mirror and lowers every authored role
  to non-authoritative text, but it does not defend against a model that chooses to drop
  important context.
- `opencode attach` when the TUI cannot see the session directory: the panel reads it
  through the server (OpenCode's file API inside the server's directory, else the server
  plugin over the channel), and settings changes go to the server plugin. The server needs
  the same plugin version; without an answer the TUI reports a timeout after 5 s.

## 10. Module map

```text
index.ts                     server entry: hooks, commands, tools, skill path
tui.ts                       TUI entry
src/clm.ts                   ClmSession: the per-request pipeline, commit, state queue, events
src/opencode.ts              OpenCode { info, parts } messages ⇄ flat messages
src/context-document.ts      render / parse / apply, role lowering, tool-group repair
src/policy.ts                edit gate (fit, shrink, none)
src/projection.ts            digests, prefix validation, projection
src/state.ts                 state.json shape, validation, atomic save
src/continuity.ts            annotations, clm_annotate / clm_recall, continuity note
src/mirror-store.ts          session directory, atomic mirror writes, stale-directory sweep
src/mirror-guard.ts          classify tool calls that read or write the mirror
src/budget.ts                budget resolution, tiers, notices, budgetFit, calibration
src/observation.ts           per-tool-result cap in the effective context
src/overflow.ts              overflow guard: withhold the oldest tool results above the limit
src/steering.ts              steering document loading and prompt section
steering/                    shipped steering documents (house-brief.md)
src/presentation.ts          system-prompt protocol section, status text
src/settings.ts              options → environment → defaults
src/settings-table.ts        the ten per-session settings; merge, sanitize, compare overrides
src/overrides.ts             overrides.json read, stage, change, reset
src/compact.ts               /clm-compact prompt and template loading
src/atomic.ts                atomic 0600 writes
src/commands.ts              command names and templates shared by server and TUI
src/session-files.ts         read-only access to a session directory
src/panel/                   pure panel code: model, timeline, diff, view, keys, command parser
src/tui/                     opentui adapter, route, Enter intercept, Tab completion, host data
skills/clm-context/          editing recipes, registered as an OpenCode skill
test/                        unit tests; test/e2e/ drives a real OpenCode against a mock provider
```

Everything under `src/panel/` is pure TypeScript with no opentui import and no file
access; `src/tui/` is the only code that touches the TUI host.

## 11. Design notes

**Validity is the plugin's job; strategy is the model's.** opencode-clm gives the model
write access to the context of its next request, following
[Context Language Models](https://github.com/RulinShao/Context-Language-Model). The plugin
guarantees that the result is *valid* — it can be sent to a provider, raw history is never
lost, revisions are atomic and attributable — and that the model is *budget-aware*: it
always knows how much room it has. When to compact, what to keep, whether to grow a
scratchpad or invent a role belongs to the model, or to a steering document the user
chooses. The one size rule is the edit gate, which the user picks: `fit` (default) keeps an
edit within the budget, `shrink` holds the line, `none` matches pi-clm's CLM mode.

**First user message pinned.** The task statement stays outside the mirror, so the model
cannot delete it. pi-clm instead renders it as an editable block.

**Commit at the next request, last write wins.** The model may write the mirror as often
as it likes during a step; only the content at the next transform is validated. The
verdict reaches the model earlier, appended to the output of the tool call that wrote the
mirror. Staleness is detected through the revision and nonce in the metadata line, not by
counting writes.

**Authored roles are lowered to non-authoritative text.** A `role=notes` block (or
`system`, or any other label) becomes synthetic user text. The real system prompt is never
part of the mirror. Trackers, ledgers and notes can therefore exist without inventing API
roles or granting them authority.

**One estimator, two size numbers.** chars/4 × `estimateFactor` × calibration, in tokens,
serves the gate, tiers, guard and notices. The provider's own count arrives one request
late. Both are shown and labelled, and the estimate is calibrated against the count (§7a).

**Checkpoints survive prune.** The digest excludes tool-result content (§6).

**Separate overrides file.** `state.json` belongs to the server's save queue; the TUI
never writes it.

**The timeline is derived from the event log.** Context size per request and edit points
come from `events.jsonl`, so the panel works on resume without extra persistence.

### Known limitations

- The step that performs an edit — the tool call that wrote the mirror, and its result —
  stays in the context after the edit is accepted, until the model removes it in a later
  edit.
- Editing the body of an assistant message turns its tool results into notes; the
  structured tool calls are not kept.
- Accept and reject notices are shown to the model for one request only.
- `trailer` covers successful tool calls only: OpenCode runs `tool.execute.after` after a
  successful execute (`session/tools.ts:111-125`). `one-tool` counts calls in arrival
  order, and child calls of OpenCode's experimental code mode count as calls too.
- Model limits and the system-prompt size reach the plugin one request late. On the first
  request of a process the model window does not yet cap the budget, a percentage budget
  (the default) is 32,000 tokens (the guard, the fit gate, reminders and the size trailer
  stand down), and the estimate omits the system prompt; with
  `budget: "window"` that request has no budget reading.
- Built-in tool descriptions are measured, but not their parameter schemas; the
  provider-measured overhead covers them once it arrives.
- A checkpoint ignores changes to stored tool output inside the prefix it covers. An output
  rewritten by another plugin or an SDK client goes out with the new text, while the mirror
  and estimate keep the revision's.
- The calibration factor and the render an edit is checked against live in memory: a
  process restart resets the factor to 1 and drops an edit not yet committed.
- A subagent (task) session gets its own mirror and state.
- A setting changed while a request runs applies from the next request.
- Duplicate `/clm` rows appear in autocomplete (the server command and the TUI slash row);
  Enter is handled by the TUI either way.
- Tool backends on another machine or in a container cannot see the mirror. Under
  `opencode attach` the panel reads through the server (§9).
- A fork restores the origin's revision but not its continuity annotations (§6); pi-clm
  branches share them.
- With `compaction: auto`, OpenCode's threshold compaction stays as configured; pi-clm
  pauses it while the guard is on. The guard keeps requests below OpenCode's threshold
  unless the budget exceeds it (e.g. `budget: window`). `compaction: off` gives no notice
  when it suppresses a threshold compaction: OpenCode emits no signal for it.
- `/clm` arguments get no completion menu: the TUI closes slash autocomplete at the first
  space (`tui/src/component/prompt/autocomplete.tsx:681`). Tab on a `/clm …` line completes
  inline (`src/tui/complete.ts`) and lists the choices in a toast when several match.
- Not needed under OpenCode (pi-clm works around Pi behaviour OpenCode lacks): the
  `max_tokens` clamp lift, because OpenCode sends `min(model output limit, 32000)`
  (`provider/transform.ts:1481`); retry-error recovery, because OpenCode retries inside one
  assistant message and drops failed ones from the model input
  (`session/processor.ts:674`, `session/message-v2.ts:252`).
