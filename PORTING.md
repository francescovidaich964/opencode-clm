# Porting map: pi-clm → opencode-clm

Source: [pi-clm](https://github.com/lolipopshock/pi-clm) v1.0.0 (commit `b84a9d7`, MIT),
a Pi extension that accompanies the CLM paper. Earlier OpenCode port used as a starting point:
a private plugin (same author as this repo) whose upstream-harness wording was licensed
CC BY-NC; every model-facing sentence here is rewritten so the package stays MIT.

Work went one block at a time: a subagent ported the block with bun tests, a second
subagent reviewed it against the pi-clm original and the OpenCode plugin API.

| block | pi-clm file(s) | opencode-clm file(s) | notes |
|---|---|---|---|
| 1 | `types.ts`, `context-document.ts`, `policy.ts` (shrink check) | `src/types.ts`, `src/context-document.ts`, `src/policy.ts` | render / parse / apply, tool-group repair, stable nonce. `policy.ts` holds the edit gate (`fit` / `shrink` / `none`); pi-clm's conservative-mode protected indexes and `PressureTracker` are not ported (OpenCode port is CLM mode only; budget tiers replace pressure tiers). Gate default differs from pi-clm, whose CLM mode has no size gate: here CLM mode defaults to `fit` (growth accepted while within budget − reserve; with no valid limit it accepts everything), and `shrink` accepts same-size edits (pi-clm required savings ≥ 1; `minSavings` removed). An edited tool result stays a `toolResult` with new output (pi-clm turns it into a note). |
| 2 | `mirror-store.ts`, `mirror-guard.ts` | same names | private atomic mirror file; classify tool calls that touch it. OpenCode 1.18 tool names: `bash`, `edit`, `write`, `read`, `apply_patch` (`patchText` headers). |
| 3 | `budget.ts` | `src/budget.ts` | budget, tiers, nudge text (rewritten), `EstimateCalibrator`. Defaults differ from pi-clm: a budget of 50% of the model window minus its output limit (32,000 tokens while the window is unknown) and 25/50/75% tiers (pi-clm: model window and 50/75/90%). The estimate alone governs tiers. Env readers (`budgetPolicyFromEnv`, `estimateFactorFromEnv`) move to `settings.ts` (block 7). |
| 4 | `overflow.ts`, `observation.ts` | same names | overflow guard (withhold oldest new tool results to files); per-result observation cap, off by default. The guard limit has no `window − 4096` ceiling (that models pi-ai's `max_tokens` clamp); the model's output limit is subtracted from the window instead. |
| 5 | `projection.ts`, `state.ts` | same names | checkpoint digest, prefix validation, persisted revision. Pi stores revisions as session entries; OpenCode has no plugin session store, so state lives in `state.json` in the session directory. The digest leaves tool-result content out and the checkpoint stores OpenCode message ids, so OpenCode's prune keeps it valid and a revert invalidates it. `recoverProjectionFromRetryErrors` is not ported: the flattener drops failed assistant messages, so the mismatch it repairs cannot occur. |
| 6 | `continuity.ts` | `src/continuity.ts` + tools in `index.ts` | pin / continuity / archive annotations and recall, exposed as OpenCode tools. Stored in `annotations.jsonl`. |
| 7 | `settings.ts`, `steering.ts`, `compact.ts`, `presentation.ts`, `steering/house-brief.md` | same names | plugin options (`["opencode-clm", {…}]` in opencode.json) → `CLM_*` env → defaults; `skill` and `commands` are options only. Default mirror parent `<project>/.opencode/clm`. Per-session overrides arrive in 0.2.0 (block 3 of 0.2.0 below). `presentation.ts` is written fresh; `house-brief.md` is byte-identical to pi-clm's. |
| 8 | `src/index.ts` (lifecycle) | `src/opencode.ts`, `src/clm.ts` | OpenCode `{info, parts}` ⇄ flat messages; per-request commit / project / guard / render / notices. OpenCode has no `turn_end` hook: the edit is committed at the start of the next request. The first user message is pinned outside the mirror. One estimator, chars/4 × `estimateFactor` × calibration, in tokens; the budget estimate counts the system prompt and tool schemas once their sizes are known (pi counts the system prompt), and calibration runs only when both sizes are known. The gate limit is budget − reserve minus the system prompt, tool schemas, pinned and continuity tokens. A pruned tool output inside an accepted revision is sent with the revision's text. Edited tool results stay `toolResult` parts with new output. Checkpoint history: `src/history.ts` (parity round). |
| 9 | `index.ts`, `src/index.ts` (hooks, commands), `skills/live-context/SKILL.md` | `index.ts`, `skills/clm-context/SKILL.md` | hooks: `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.session.compacting`, `tool.definition` (tool schema sizes), `tool.execute.after` (edit verdict appended to bash output), `command.execute.before`, `config` (commands, `skills.paths`), `tool` (`clm_annotate`, `clm_recall`). `/clm` replaces the command text and costs a model turn, because OpenCode cannot cancel a command. Helper agents (title, summary, compaction) get no protocol text. Hooks fail open: a throwing transform sends the raw history, a failing command prints `[CLM] /<name> failed: <reason>`. A `clm` or `clm-compact` command the user already defined is kept and left alone. pi-clm registers its skill only outside CLM mode, because that skill teaches the shrink-only protocol; `clm-context` teaches this port's CLM protocol, so it is on by default and `skill: false` restores pi-clm's behaviour. |
| 0.2.0-1 | `timeline.ts`, `diff.ts`, `viewer.ts` (view model shape) | `src/panel/timeline.ts`, `src/panel/diff.ts`, `src/panel/lines.ts`, `src/panel/model.ts`, `src/panel/files.ts`, `src/session-files.ts` | panel data layer, pure. pi builds the timeline from session entries; here `buildPanelModel` reads the session directory (`events.jsonl`, `state.json`, `snapshot.json`, `revisions/rN.json`). Chart and diff emit styled spans (theme tones) instead of ANSI. Bar size: the server's provider measure (input + cache read + cache write) where pi uses `totalTokens`. Extra marker kind `compacted`; `projection-reset` shows as a reset. The 400/60-row diff bounds move from `viewer.ts` into `diff.ts`. |
| 0.2.0-2 | `viewer.ts` (pages, `handleInput`) | `src/panel/view.ts`, `src/panel/keys.ts`, `src/panel/command.ts`, `src/tui/*`, `tui.ts` | the `/clm` panel as an OpenCode **TUI plugin**. OpenCode 1.18 loads TUI plugins from `tui.json` (`exports["./tui"]`) in a runtime separate from the server plugin; they can register routes, key layers in their own mode, slash rows and dialogs, and draw opentui renderables. The panel is a full-screen route (pi: an overlay at 62% height). Same four pages, key table and help rows, plus `r` reload. Typed `/clm …` lines are caught by a key interceptor before the prompt submits, so they cost no model turn; only `/clm reset` reaches the server command (since 0.2.0-3; `on` and `off` set the `editing` override in the TUI). Since the parity round `/clm reset` is turn-free too: the TUI publishes a `tui.command.execute` event that the server plugin's `event` hook handles (`src/channel.ts`); the same channel carries settings changes and session-file reads under `opencode attach`. No JSX: OpenCode's Solid compile step skips `node_modules`. |
| 0.2.0-3 | `settings.ts` (descriptor table, overrides), `/clm config` in `src/index.ts` | `src/settings-table.ts`, `src/overrides.ts`, `src/atomic.ts`, `src/commands.ts`, `src/tui/intercept.ts`; `src/clm.ts` and `index.ts` (refresh, snapshot.json, revisions/rN.json) | per-session settings. Pi appends overrides as session entries and restores the newest on the branch; here they live in `overrides.json`, written by the TUI and the server command and re-read by the server before each request. Thirteen settings (pi's `compaction`, `one-tool` and `trailer` since the parity round); `editing` replaces state.json's flag for `/clm on|off`. The server writes `snapshot.json` every request and `revisions/rN.json` at accept, for the panel. The server `/clm config` prints the settings as text, and `/clm overview|input|edits` print those pages as text at width 72, as pi-clm does outside its TUI. |

Blocks 1–9 are 0.1.0; rows `0.2.0-n` are the 0.2.0 blocks.

Branch-aware restore on `/tree` maps to OpenCode's revert and fork: `src/history.ts` keeps
the newest checkpoints, and `src/clm.ts` restores the newest one that still fits after a
revert, or the origin's into a fork (found through a `metadata.clm.origin` stamp).

Not ported, by reason (OpenCode v1.18.34 source):

- **Not needed.** The `max_tokens` clamp lift (`before_provider_request`) and its status
  line: OpenCode sends `min(model output limit, 32000)`, not a transcript-derived limit
  (`provider/transform.ts:1481`). Retry-error recovery (`recoverProjectionFromRetryErrors`):
  OpenCode retries inside one assistant message (`session/processor.ts:674`) and drops
  failed messages from the model input (`session/message-v2.ts:252`), so the mismatch it
  repairs cannot arise.
- **Not possible.** A completion menu for `/clm` arguments: OpenCode commands carry no
  completion field (`core/src/v1/config/command.ts:5`), and the TUI closes slash
  autocomplete at the first space (`tui/src/component/prompt/autocomplete.tsx:681`). The TUI
  plugin completes inline instead: Tab on a `/clm …` line (`src/tui/complete.ts`).
- **Chosen differently.** Without the TUI plugin, `/clm` costs one model turn: OpenCode
  cannot cancel a command's prompt short of failing it (`session/prompt.ts:1460`). With the
  TUI plugin typed `/clm` lines cost none. `compaction: auto` pauses threshold compaction
  per request (OpenCode has no cancel hook): the flag is off only for a request that can
  reach OpenCode's threshold, which also turns off overflow recovery for that request.
- **Without a usable mirror directory** the session runs as pi-clm's store-less mode
  (raw history, continuity, size notice), from a private temp directory. Its annotations
  survive a restart in OpenCode's session metadata (bounded), `clm_annotate` cannot create
  one (no mirror block ids), and there are no budget notices or size trailers.
- **`opencode attach`.** The panel reads the session directory locally when it can, else
  through the server: OpenCode's file API inside the server's directory, or the server
  plugin over the `tui.command.execute` channel. Settings changes and `/clm reset` go over
  the channel; the server needs the same plugin version.
- Forks restore the origin's revision but not its annotations; `trailer` misses failed
  tool calls, because OpenCode skips `tool.execute.after` for them (`session/tools.ts:111-125`).

## Fork additions (francescovidaich964/opencode-clm)

Two fixes on top of upstream, both in the projection's fail-closed path; neither changes
the model-facing protocol, the ported strategy or the checkpoint semantics.

- **Per-message stamps and tail re-anchoring.** OpenCode keeps writing message objects
  after `messages.transform` returns (an assistant message being finalized) and appends or
  removes `<system-reminder>` mode-change blocks on user messages. A checkpoint can
  therefore digest content that changes without a revert. `sourceStamps` (per-message
  digest, captured write time, reminder-stripped fingerprint) let `applyProjection`
  attribute such a change and trim the anchor to the stable head (`reanchored` event)
  instead of dropping the revision; anything else still fails closed. pi-clm needs none of
  this because Pi's log is immutable. See bcmyguest/opencode-clm#3.
- **Restart-stable document nonce.** The seed is `sessionId:sourceDigest`, as pi-clm's is,
  without upstream's per-process random component, so block ids the model read survive an
  OpenCode restart.

Recommended paper-parity configuration for the plugin entry: `"budget": "window"`
(upstream defaults to 50% of the window minus its output limit; the paper's harness
budgets the window minus `max_tokens`), and for paper-faithful runs `/clm config
one-tool on`, `/clm config trailer on`, `/clm config cap 10000:0.5`.
