/**
 * The CLM lifecycle for one OpenCode session, independent of the plugin API so it can be
 * unit tested. Ported from pi-clm src/index.ts (`context` and `turn_end` handlers; MIT,
 * Copyright 2026 Emanuel Casco).
 *
 * Timing differs from pi-clm: OpenCode has no `turn_end` hook, so the edit the model made
 * during step k is read back and committed at the start of step k+1's transform, right
 * before the request it affects. As in pi-clm, the file content at that moment wins.
 *
 * `mode notices-only` (`noticesOnly`) skips steps 1, 2 and 4: the accepted revision, if any,
 * stays in state.json but is not applied, nothing is rendered or committed, and the request
 * carries the raw history (reasoning view, cap and guard still apply) with every notice.
 * Switching back to `edit` applies the kept revision again while it still matches the
 * history; a mismatch then takes the usual restore-or-reset path.
 *
 *   transform(raw)  0. pinned = everything up to and including the first user message;
 *                      source = flatten(rest), the raw prefix a checkpoint digests
 *                   1. commit: read the mirror; if it differs from the last render,
 *                      apply it (edit gate) and save a new checkpoint over that render's source
 *                   2. project: checkpoint.projected ++ source suffix; after a compaction,
 *                      rebase onto the summarized history; on any other mismatch, reset
 *                   3. reasoning view, observation cap, overflow guard (new suffix only)
 *                   4. render the effective context to the mirror
 *                   5. notices: edit outcome, reset, overflow, continuity size, budget tier
 *                   6. output: pinned ++ unflatten(effective) ++ continuity ++ notices
 *
 * Anchor: a checkpoint digests the flattened source with tool-result content left out
 * (projection.ts), so OpenCode's prune does not discard it. The same rule means any other
 * change to a stored tool output inside the covered prefix also goes undetected. For a
 * pruned output the accepted revision keeps the text the model saw, in the request too:
 * `unflatten` sends it with the revision's text, so request, mirror and estimate agree.
 * An output rewritten by another plugin or an SDK client is not restored: the request
 * carries the new text while the mirror and estimate keep the revision's.
 *
 * Measurement: one estimator, chars/4 × `estimateFactor`, then × the calibration factor.
 * The edit gate, the overflow guard and the budget reading all use it, in tokens, and all
 * count the system prompt and tool schemas once `scope` holds their sizes. The
 * calibrator learns only from requests whose full scope (system prompt and tool schemas
 * included) was estimated; without those sizes it stays at 1.
 */
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	budgetFit,
	budgetNoticeText,
	budgetTiers,
	budgetTooSmallAlertText,
	budgetTooSmallNoticeText,
	BudgetTracker,
	EstimateCalibrator,
	formatTokens,
	resolveBudget,
	type BudgetFit,
	type BudgetReading,
} from "./budget.ts";
import { applyContextDocument, renderContextDocument, renderMessage } from "./context-document.ts";
import {
	AnnotationStore,
	ContinuitySizeTracker,
	continuitySizeNoticeText,
	forkAnnotations,
	formatContinuityMessage,
	type ContinuityBlockSource,
	type LiveContextAnnotation,
} from "./continuity.ts";
import { classifyMirrorToolCall } from "./mirror-guard.ts";
import { MirrorDirectoryError, MirrorStore } from "./mirror-store.ts";
import { capObservations } from "./observation.ts";
import { flatten, noteMessage, unflatten, withoutReasoning, type OcInfo, type OcMessage } from "./opencode.ts";
import { sizeTrailer } from "./compaction.ts";
import { applyOverflowGuard, overflowGuardLimit, overflowNoticeText } from "./overflow.ts";
import type { ClmStatus } from "./presentation.ts";
import { applyProjection, createProjectionCheckpoint, digestSourceContent, type ProjectionCheckpoint } from "./projection.ts";
import { clearHistory, loadHistory, remapProjection, saveHistoryEntry, type HistoryEntry } from "./history.ts";
import type { ClmSettings } from "./settings.ts";
import {
	keptFields,
	loadLiveContextState,
	resetProjectionState,
	saveLiveContextState,
	type BudgetCheck,
	type LiveContextState,
} from "./state.ts";
import type { SteeringDocument } from "./steering.ts";
import { overridesPath, readOverrides, stageSettings, type ChangeRequest, type StagedSettings } from "./overrides.ts";
import { changedSummary, settingsAsOverrides, type ClmOverrides, type SettingsValues } from "./settings-table.ts";
import type { ContextDocumentSnapshot, ContextEditTrace, LiveContextMessage, TurnBaseline } from "./types.ts";
import { writeJsonAtomic } from "./atomic.ts";
import { SNAPSHOT_FILE, type RevisionFile, type RevisionFileRow, type SnapshotFile } from "./panel/files.ts";

export interface ModelLimits {
	/** Model context window, tokens. */
	context?: number;
	/** Model output limit, tokens; subtracted from the window by `resolveBudget`. */
	output?: number;
	/** Model input limit, tokens, when the provider sets one; only OpenCode's threshold reads it (src/compaction.ts). */
	input?: number;
}

/** Sizes of the request parts the plugin does not see in the messages hook. */
export interface RequestScope {
	/** Estimated tokens of the system prompt (from `experimental.chat.system.transform`). */
	systemTokens?: number;
	/** Estimated tokens of the tool schemas (from `tool.definition`). */
	toolTokens?: number;
}

/** Toast when edits keep being dropped (pi `compositionWarningText`, reworded for OpenCode). */
export const COMPOSITION_WARNING = "CLM edits keep being dropped: OpenCode's history changed between consecutive requests. " +
	"Another plugin that rewrites already-sent messages (experimental.chat.messages.transform) is the usual cause; " +
	"load opencode-clm before it (earlier in the `plugin` list), or turn CLM off for this session with /clm off.";

export interface TransformResult {
	/** The messages to send; the caller writes them into OpenCode's array in place. */
	messages: OcMessage[];
	/** Notices appended to this request (also inside `messages`, as one user note). */
	notices: string[];
	/** Calibrated estimate of this request, tokens (system prompt and tool schemas included when known); undefined when CLM did not run. */
	estimated?: number;
	reading?: BudgetReading;
	/** User-facing warning for a toast (budget too small, composition warning, ignored saved settings); set on one request only. */
	alert?: string;
	/** User-facing errors for toasts: the mirror could not be read or refreshed, a revision could not be saved. */
	errors?: string[];
}

export interface MirrorCheck {
	changed: boolean;
	accepted: boolean;
	message: string;
}

interface Baseline extends TurnBaseline {
	/** Fit-gate limit for an edit of this render, tokens (guard limit net of the pinned task and continuity). */
	limit?: number;
}

/** OpenCode session ids are `ses_` plus base62; anything else would alias another directory. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const CHARS_PER_TOKEN = 4;

/**
 * Largest share of the provider count the conversation estimate may hold for an overhead
 * measurement; above it the estimate's error would dominate the result.
 */
const MAX_CONVERSATION_SHARE = 0.25;

/** Index after the pinned prefix: everything up to and including the first user message. */
export function pinnedCount(raw: readonly OcMessage[]): number {
	const first = raw.findIndex((message) => message.info.role === "user");
	return first < 0 ? 0 : first + 1;
}

export interface ObservedRequest {
	tokens: number;
	/** Position of the reporting assistant message in the raw OpenCode history. */
	index: number;
	messageID: string;
}

/**
 * Provider-reported input of the newest successful request: the newest assistant message
 * without an error and not a compaction summary, with input + cache read + cache write > 0.
 */
export function lastProviderReported(raw: readonly OcMessage[]): ObservedRequest | undefined {
	for (let index = raw.length - 1; index >= 0; index--) {
		const info = raw[index]!.info;
		if (info.role !== "assistant" || info.error || info.summary || !info.tokens) continue;
		const tokens = info.tokens;
		const total = Number(tokens.input ?? 0) + Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0);
		if (Number.isFinite(total) && total > 0) return { tokens: total, index, messageID: info.id };
	}
	return undefined;
}

/** Id of the newest compaction summary (an assistant message with `summary` set). */
export function compactionSummaryId(raw: readonly OcMessage[]): string | undefined {
	for (let index = raw.length - 1; index >= 0; index--) {
		const info = raw[index]!.info;
		if (info.role === "assistant" && info.summary && !info.error) return info.id;
	}
	return undefined;
}

/** Asks OpenCode's summarizer to carry the plugin's annotations through a compaction. */
export const COMPACTION_INSTRUCTION =
	"CLM note for the summary: copy every pin and continuity annotation listed below " +
	"(id, title, Why, Next, pinned source text) into the summary word for word. " +
	"Do not shorten, merge or reword them.";

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ClmSession {
	readonly tracker = new BudgetTracker();
	readonly calibrator = new EstimateCalibrator();
	readonly continuitySize = new ContinuitySizeTracker();
	readonly annotations: AnnotationStore;
	state: LiveContextState;
	/** Set when `state.json` existed but could not be used (the session then starts clean). */
	readonly loadWarning?: string;
	accepted = 0;
	rejected = 0;
	limits: ModelLimits = {};
	/**
	 * Set once the system transform has seen the model, with or without a window. Until then
	 * a fallback budget is provisional: the guard, fit gate, reminders and trailer stand down.
	 * A model that reports no window keeps the fallback, which then applies in full.
	 */
	limitsKnown = false;
	scope: RequestScope = {};
	/** Set by `experimental.session.compacting`: the next transform carries OpenCode's compaction input. */
	compacting = false;
	/**
	 * Set when OpenCode reports a finished compaction (`session.compacted` event or the
	 * `experimental.compaction.autocontinue` hook); the next transform rebases onto the summary.
	 */
	compacted = false;
	/**
	 * Set by the plugin when OpenCode's session metadata names another session as the origin
	 * (a fork, `Session.fork` copies metadata). The first transform restores the newest of the
	 * origin's checkpoints whose source the forked history still contains, then clears it.
	 */
	forkOrigin?: { sessionID: string; directory: string; /** The fork's creation time (ms), when OpenCode reported it. */ created?: number };
	/** The origin's annotations from cloned session metadata (a fork without a mirror); used when the origin's store yields none. */
	forkPersisted?: LiveContextAnnotation[];
	/** Set when a fork's first request copied annotations in; the plugin then persists them (no mirror). */
	annotationsImported = false;
	/**
	 * Why no mirror directory could be used, set by the plugin (M1). The store then sits in a
	 * private temporary directory the model is never told about; requests carry the raw
	 * history plus the continuity annotations and their size notice, as pi-clm does when its
	 * mirror store fails to initialize.
	 */
	mirrorUnavailable?: string;
	/** What the last transform rendered; the next transform commits the mirror against it. */
	baseline?: Baseline;
	/** The snapshot now in the mirror file; continuity tools resolve block ids against it. */
	lastSnapshot?: ContextDocumentSnapshot;
	lastReading?: BudgetReading;
	lastRequest?: { rawMessages: number; sentMessages: number; mirrorBlocks: number };
	requests = 0;

	private pendingNotices: string[] = [];
	/** Errors for the user (toasts), returned with the next transform result. */
	private pendingErrors: string[] = [];
	/** The mirror could not be written last time; its error toast is not repeated until a write succeeds. */
	private refreshFailing = false;
	/** Why the steering document in the settings did not load, for snapshot.json (the panel). */
	steeringError?: string;
	/** Raw length and conversation estimate (calibrated, tokens) of the last request, for the overhead measurement. */
	private previousRequest?: { rawCount: number; conversation: number };
	private invalidationStreak = 0;
	/** The composition warning toast is shown once per session (pi: `compositionWarned`). */
	private compositionWarned = false;
	/** User-facing warnings for the next transform result (`alert`). */
	private pendingAlerts: string[] = [];
	/** The settings warning last shown to the user, so a new or changed one toasts once. */
	private shownSettingsWarning?: string;
	private readonly tokenCache = new WeakMap<LiveContextMessage, number>();
	private saving: Promise<void> = Promise.resolve();
	private running: Promise<unknown> = Promise.resolve();

	/** Settings in force: `baseSettings` with this session's overrides.json applied (`refreshSettings`). */
	settings: ClmSettings;
	/** Overrides in force, as read from overrides.json. */
	overrides: ClmOverrides = {};
	/** The steering document in force for this session; undefined is protocol only. */
	steering?: SteeringDocument;
	/** Why saved settings or the steering document were (partly) ignored; shown by `/clm status`. */
	settingsWarning?: string;
	/** stat key of the overrides.json last read; a change triggers a re-read. */
	private overridesKey = "";

	private constructor(
		readonly sessionID: string,
		readonly store: MirrorStore,
		readonly baseSettings: ClmSettings,
		loaded: { state: LiveContextState; warning?: string },
		readonly baseSteering?: SteeringDocument,
	) {
		this.settings = baseSettings;
		this.steering = baseSteering;
		this.state = loaded.state;
		this.loadWarning = loaded.warning;
		this.annotations = new AnnotationStore(store.directory, { estimateTokens: (text) => this.textTokens(text) });
	}

	/**
	 * Open (or resume) the session directory `<mirrorDir>/clm-<sessionID>/`. `steering` is the
	 * document the base settings name, already loaded; undefined when it failed to load at start
	 * (each session then retries the path and records the error in `settingsWarning`).
	 */
	static async open(sessionID: string, settings: ClmSettings, options: { steering?: SteeringDocument } = {}): Promise<ClmSession> {
		if (!SESSION_ID_RE.test(sessionID)) throw new Error(`Invalid session id for CLM: ${JSON.stringify(sessionID)}`);
		const store = await MirrorStore.create(sessionID, settings.mirrorDir).catch((error: unknown) => {
			throw new MirrorDirectoryError(settings.mirrorDir, error);
		});
		const loaded = await loadLiveContextState(store.directory);
		const session = new ClmSession(sessionID, store, settings, loaded, options.steering);
		if (loaded.warning) await session.log({ event: "state-warning", warning: loaded.warning });
		if (loaded.repaired) await session.log({ event: "state-repaired", message: loaded.repaired });
		await session.refreshSettings();
		return session;
	}

	/** Whether CLM edits apply in this session: the `editing` override, else state.json. */
	get enabled(): boolean {
		return this.overrides.editing ?? this.state.enabled;
	}

	/** `mode notices-only`: notices and the guard run, the model cannot edit its context. */
	get noticesOnly(): boolean {
		return this.settings.mode === "notices-only";
	}

	/** Base and effective values, for the settings table. */
	settingsValues(): { base: SettingsValues; effective: SettingsValues } {
		return {
			base: { editing: this.state.enabled, settings: this.baseSettings },
			effective: { editing: this.enabled, settings: this.settings },
		};
	}

	/** For `changeSetting` (overrides.ts): where and against what a change is validated. */
	changeRequest(projectDirectory: string): ChangeRequest {
		return {
			sessionDirectory: this.store.directory,
			base: this.baseSettings,
			baseEditing: this.state.enabled,
			projectDirectory,
			format: { modelWindow: this.limits.context, modelOutput: this.limits.output },
		};
	}

	/**
	 * Re-read overrides.json when it changed (stat: mtime, size, inode) and activate it.
	 * Runs before every request and every `/clm` command, so a change written by the TUI or
	 * the server's `/clm config` applies from the next request. Invalid keys are dropped; a
	 * set that does not resolve falls back to the base settings; a steering document that
	 * does not load leaves the session protocol-only. Each case is kept in `settingsWarning`.
	 * `force` re-reads even when the file looks unchanged.
	 */
	async refreshSettings(force = false): Promise<void> {
		const path = overridesPath(this.store.directory);
		let key = "missing";
		try {
			const info = await stat(path);
			key = `${info.mtimeMs}:${info.size}:${info.ino}`;
		} catch {
			// missing: no overrides
		}
		if (!force && key === this.overridesKey) return;
		this.overridesKey = key;
		const read = key === "missing" ? { overrides: {} as ClmOverrides } : await readOverrides(this.store.directory);
		const warnings: string[] = read.warning ? [read.warning] : [];
		let staged: StagedSettings;
		let overrides = read.overrides;
		try {
			staged = stageSettings(this.baseSettings, overrides, { strict: false, loaded: this.steering ?? this.baseSteering });
		} catch (error) {
			warnings.push(`ignored saved settings: ${describe(error)}`);
			overrides = {};
			// The base settings resolved at load; staging them again keeps a base steering error.
			staged = stageSettings(this.baseSettings, {}, { strict: false, loaded: this.baseSteering });
		}
		// Only warnings about saved settings toast here. The base steering document failing
		// again (no override names another path) already toasted once at load (index.ts).
		const alerting = [...warnings];
		if (staged.steeringError) {
			const warning = `steering document not loaded: ${staged.steeringError}`;
			warnings.push(warning);
			if (staged.settings.steeringPath !== this.baseSettings.steeringPath) alerting.push(warning);
		}
		this.steeringError = staged.steeringError;
		await this.activateSettings(staged, overrides);
		this.settingsWarning = warnings.length > 0 ? warnings.join("; ") : undefined;
		const alert = alerting.length > 0 ? alerting.join("; ") : undefined;
		if (alert && alert !== this.shownSettingsWarning) {
			this.pendingAlerts.push(`saved settings partly ignored: ${alert}`);
		}
		this.shownSettingsWarning = alert;
	}

	private async activateSettings(staged: StagedSettings, overrides: ClmOverrides): Promise<void> {
		const before = this.settings.budget;
		const after = staged.settings.budget;
		const wasEnabled = this.enabled;
		const wasMode = this.settings.mode;
		const changed = JSON.stringify(this.overrides) !== JSON.stringify(overrides);
		this.settings = staged.settings;
		this.steering = staged.steering;
		this.overrides = overrides;
		if (before.contextBudget !== after.contextBudget || before.contextFraction !== after.contextFraction || before.reserve !== after.reserve ||
			before.remindAtFractions.join(",") !== after.remindAtFractions.join(",") || before.remindAtReserve !== after.remindAtReserve) {
			this.tracker.reset();
		}
		if (wasEnabled !== this.enabled) {
			this.baseline = undefined;
			this.tracker.clearCooldown();
			if (!this.enabled) this.continuitySize.observe(0);
		}
		if (wasMode !== this.settings.mode) {
			// The render the baseline holds no longer describes what the model is sent.
			this.baseline = undefined;
			this.lastSnapshot = undefined;
			this.tracker.clearCooldown();
		}
		if (changed) await this.log({ event: "settings", overrides });
	}

	get mirrorPath(): string {
		return this.store.filePath;
	}

	// ---- measurement -------------------------------------------------------------------

	/**
	 * System prompt and tool schemas, when the hooks reported them (one request late).
	 * A provider-measured overhead replaces them: it is in real tokens, so it is not
	 * calibrated, and it includes the built-in tool schemas the hooks cannot size. The
	 * hook sizes stay a floor, since they count text that is certainly sent.
	 */
	private scopeSize(): { measuredOverhead?: number; scopeTokens: number } {
		const { systemTokens, toolTokens } = this.scope;
		const measuredOverhead = this.state.budgetCheck?.source === "provider"
			? Math.max(this.state.budgetCheck.overhead, (systemTokens ?? 0) + (toolTokens ?? 0))
			: undefined;
		return { ...(measuredOverhead !== undefined ? { measuredOverhead } : {}), scopeTokens: measuredOverhead ?? this.calibrator.apply((systemTokens ?? 0) + (toolTokens ?? 0)) };
	}

	/**
	 * `/clm-compact`: about how large the next request would be, from the stored history
	 * (as OpenCode sends it, see `filterCompacted`) through the accepted revision (continuity and notices not
	 * counted). Undefined when the history holds no message to compact.
	 */
	idleEstimate(raw: OcMessage[]): number | undefined {
		const pinned = pinnedCount(raw);
		const source = flatten(raw.slice(pinned));
		if (source.length === 0) return undefined;
		const projection = applyProjection(source, this.state.checkpoint);
		const effective = projection.valid ? projection.messages : source;
		return this.scopeSize().scopeTokens + this.estimate(flatten(raw.slice(0, pinned))) + this.estimate(effective);
	}

	/** Uncalibrated tokens of a text: chars/4 × estimateFactor. */
	textTokens(text: string): number {
		return Math.ceil((text.length / CHARS_PER_TOKEN) * this.settings.estimateFactor);
	}

	/** Uncalibrated tokens of messages, cached per message object. */
	rawTokens(messages: readonly LiveContextMessage[]): number {
		let total = 0;
		for (const message of messages) {
			let tokens = this.tokenCache.get(message);
			if (tokens === undefined) {
				tokens = this.textTokens(renderMessage(message));
				this.tokenCache.set(message, tokens);
			}
			total += tokens;
		}
		return total;
	}

	/** Calibrated tokens: the single estimator for gate, guard and budget. */
	estimate = (messages: LiveContextMessage[]): number => this.calibrator.apply(this.rawTokens(messages));

	private noticeTokens(notices: readonly string[]): number {
		return notices.reduce((total, notice) => total + this.textTokens(notice), 0);
	}

	/**
	 * The budget in force: the resolved one (`resolveBudget`), raised when the
	 * session's budget check found it too small for OpenCode's fixed overhead (`budgetFit`).
	 */
	resolvedBudget(): Pick<BudgetReading, "budget" | "reserve" | "source" | "fraction" | "raisedFrom"> | undefined {
		const base = resolveBudget(this.settings.budget, this.limits.context, this.limits.output);
		if (!base) return undefined;
		const fit = budgetFit(base.budget, base.reserve, this.state.budgetCheck?.overhead, this.windowCap());
		return fit.raised ? { ...base, budget: fit.effective, raisedFrom: base.budget } : base;
	}

	/** Model window minus its output limit, when known: the ceiling for a raised budget. */
	private windowCap(): number | undefined {
		return resolveBudget({ ...this.settings.budget, contextBudget: undefined, contextFraction: undefined }, this.limits.context, this.limits.output)?.budget;
	}

	/**
	 * Budget arithmetic for `/clm` and a TUI panel: fixed overhead, usable budget, effective
	 * budget. Undefined while the budget is unknown; `overhead` is unset until measured.
	 */
	budgetFit(): BudgetFit | undefined {
		const base = resolveBudget(this.settings.budget, this.limits.context, this.limits.output);
		return base ? budgetFit(base.budget, base.reserve, this.state.budgetCheck?.overhead, this.windowCap()) : undefined;
	}

	/**
	 * budget − reserve: the limit the overflow guard enforces. Undefined while the budget is
	 * unknown or a fallback (`FALLBACK_BUDGET`, model window not yet known): the guard then
	 * withholds nothing.
	 */
	/** A fallback budget read before the model's limits arrived (see `limitsKnown`). */
	private provisional(resolved: Pick<BudgetReading, "source">): boolean {
		return resolved.source === "fallback" && !this.limitsKnown;
	}

	guardLimit(): number | undefined {
		const resolved = this.resolvedBudget();
		return resolved && !this.provisional(resolved) ? overflowGuardLimit(resolved.budget, resolved.reserve) : undefined;
	}

	/**
	 * Fixed overhead of a request (system prompt + tool schemas), measured once per session.
	 *
	 * Request 1 cannot measure it: OpenCode calls `experimental.chat.system.transform` after
	 * this hook, and the provider count arrives with the reply. So a later transform measures
	 * it: provider-reported input of the previous request minus that request's conversation
	 * estimate. The estimate's error lands in the overhead, so the measurement waits for a
	 * request whose conversation is at most MAX_CONVERSATION_SHARE of the provider count
	 * (a restarted or upgraded session with a long history is measured after the model
	 * shrinks its context, or not at all).
	 *
	 * Fallback: the chars/4 hook sizes, only when the provider answered without reporting
	 * usage. They miss OpenCode's built-in tool schemas (Effect schemas, not measured;
	 * several thousand tokens low), so a fallback result is replaced by the first provider
	 * measurement.
	 */
	private measureOverhead(raw: readonly OcMessage[], observed: ObservedRequest | undefined): Pick<BudgetCheck, "overhead" | "source"> | undefined {
		const previous = this.previousRequest;
		if (!previous) return undefined;
		if (observed && observed.index >= previous.rawCount) {
			if (previous.conversation > observed.tokens * MAX_CONVERSATION_SHARE) return undefined;
			return { overhead: Math.round(observed.tokens - previous.conversation), source: "provider" };
		}
		if (this.state.budgetCheck) return undefined; // an estimate never replaces a measurement
		const answered = raw.slice(previous.rawCount)
			.some((message) => message.info.role === "assistant" && !message.info.error && !message.info.summary);
		const { systemTokens, toolTokens } = this.scope;
		if (answered && systemTokens !== undefined && toolTokens !== undefined) {
			return { overhead: this.calibrator.apply(systemTokens + toolTokens), source: "estimate" };
		}
		return undefined;
	}

	/**
	 * The budget-too-small check, once per session (plus once more when a provider count
	 * replaces a fallback estimate). Decision: raise the effective budget to overhead +
	 * WORKING_MARGIN + reserve (capped by the model window) rather than switch the overflow
	 * guard off. With the guard off, one large tool result can push the request past the
	 * model window; with the budget raised, reminders, the fit gate and the guard keep
	 * working, measured against a budget the conversation can actually use. The overhead is
	 * persisted in `state.budgetCheck` and the raise is derived from it on every request, so
	 * it survives a restart, and the event, toast and notice do not repeat.
	 */
	private async checkBudget(measured: Pick<BudgetCheck, "overhead" | "source">): Promise<string | undefined> {
		const base = resolveBudget(this.settings.budget, this.limits.context, this.limits.output);
		if (!base) return undefined;
		const previous = this.state.budgetCheck;
		const fit = budgetFit(base.budget, base.reserve, measured.overhead, this.windowCap());
		const check: BudgetCheck = {
			...measured,
			configured: base.budget,
			reserve: base.reserve,
			effective: fit.effective,
			raised: fit.raised,
			at: new Date().toISOString(),
		};
		// activateOnFailure: a failed save still applies the raise in this process.
		await this.updateState((state) => ({ ...state, budgetCheck: check }), true).catch(() => undefined);
		// A replaced estimate that already reported "too small" does not warn again.
		const warnedBefore = previous !== undefined && budgetFit(previous.configured, previous.reserve, previous.overhead).tooSmall;
		const warn = fit.tooSmall && !warnedBefore;
		await this.log({
			event: warn ? "budget-too-small" : "budget-check",
			...check,
			usable: fit.usable,
			margin: fit.margin,
			minimum: fit.minimum,
			capped: fit.capped,
			...(previous ? { replaces: previous.source, previousOverhead: previous.overhead } : {}),
		});
		if (!warn) return undefined;
		this.pendingNotices.push(budgetTooSmallNoticeText(fit, { noticesOnly: this.noticesOnly }));
		return budgetTooSmallAlertText(fit);
	}

	// ---- persistence -------------------------------------------------------------------

	/**
	 * Every state change goes through this queue: the next state is computed from the
	 * current one, saved, then activated, one change at a time. So the last rename always
	 * holds the newest state, and concurrent callers (a command during a transform) never
	 * build on a stale state. A failed save throws and leaves the state unchanged, unless
	 * `activateOnFailure` is set (outcomes and resets: in-memory state must move on).
	 */
	private updateState(
		change: (state: LiveContextState) => LiveContextState,
		activateOnFailure = false,
	): Promise<LiveContextState> {
		const run = this.saving.then(async () => {
			const next = change(this.state);
			try {
				await saveLiveContextState(this.store.directory, next);
			} catch (error) {
				if (activateOnFailure) this.state = next;
				await this.log({ event: "save-failed", revision: next.revision, error: describe(error) });
				throw error;
			}
			this.state = next;
			return next;
		});
		this.saving = run.then(() => undefined, () => undefined);
		return run;
	}

	/** One JSON line per event in `<session dir>/events.jsonl`. Best effort. */
	async log(event: Record<string, unknown>): Promise<void> {
		const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
		await appendFile(join(this.store.directory, "events.jsonl"), line, { mode: 0o600 }).catch(() => undefined);
	}

	async setEnabled(enabled: boolean): Promise<void> {
		await this.updateState((state) => ({ ...state, enabled }));
		this.baseline = undefined;
		this.tracker.clearCooldown();
		if (!enabled) this.continuitySize.observe(0);
	}

	/** Drop the accepted revision (e.g. `/clm reset`); the next request sends the raw history. */
	async resetProjection(reason: string): Promise<void> {
		const next = await this.updateState((state) => resetProjectionState(state, reason));
		this.baseline = undefined;
		this.tracker.reset();
		this.continuitySize.reset();
		// The user dropped the edits on purpose: a later revert must not bring one back. Queued
		// behind any history write in flight; writes queued later see no checkpoint and skip.
		await this.historyTask(() => clearHistory(this.store.directory));
		await this.log({ event: "reset", revision: next.revision, reason });
	}

	// ---- edit validation ---------------------------------------------------------------

	private applyOptions(baseline: Baseline) {
		return {
			editingMode: "clm" as const,
			gate: this.settings.gate,
			limit: baseline.limit,
			taskPinned: true,
			estimate: this.estimate,
			estimateUnit: "tokens" as const,
		};
	}

	/** Dry-run validation of mirror text against the last render (receipts). */
	validateMirror(text: string | undefined): MirrorCheck | undefined {
		const baseline = this.baseline;
		if (!baseline || text === undefined) return undefined;
		if (text.trim() === baseline.snapshot.text.trim()) return { changed: false, accepted: true, message: "unchanged" };
		const result = applyContextDocument(text, baseline.snapshot, this.applyOptions(baseline));
		if (!result.accepted) return { changed: true, accepted: false, message: result.reason ?? "refused" };
		const touched = (result.editTrace?.sources ?? [])
			.filter((source) => source.kind !== "kept")
			.map((source) => `${source.sourceIndex + 1} ${baseline.snapshot.blocks[source.sourceIndex]?.role ?? "?"} ${source.kind}`);
		const added = result.editTrace?.additions.length ?? 0;
		const parts = [`about ${formatTokens(result.beforeEstimate)} → ${formatTokens(result.afterEstimate)} tokens`];
		if (touched.length > 0) parts.push(`blocks ${touched.join(", ")}`);
		if (added > 0) parts.push(`${added} new block${added === 1 ? "" : "s"}`);
		const grew = result.afterEstimate > result.beforeEstimate ? " The context grows with this edit." : "";
		const notes = result.diagnostics.length > 0 ? ` ${result.diagnostics.join(" ")}` : "";
		return { changed: true, accepted: true, message: `${parts.join("; ")}.${grew}${notes}` };
	}

	/**
	 * Verdict appended to the result of a tool call that wrote the mirror; undefined for
	 * calls that only read it or do not touch it.
	 */
	receipt(tool: string, args: Record<string, unknown> | undefined, cwd: string): string | undefined {
		if (!this.settings.enabled || !this.enabled || this.noticesOnly) return undefined;
		if (classifyMirrorToolCall(tool, args ?? {}, cwd, this.mirrorPath) !== "write") return undefined;
		const check = this.validateMirror(this.store.readSync());
		if (!check) return undefined;
		if (!check.changed) return "[CLM] Mirror unchanged: the file still matches the last render.";
		return check.accepted
			? `[CLM] Mirror edit valid: ${check.message} It applies from your next request.`
			: `[CLM] Mirror edit would be refused: ${check.message} Correct the file before this step ends, or the context stays as it is.`;
	}

	/**
	 * `setting trailer`: the size trailer for one tool result (the last reading plus the
	 * result's calibrated estimate, against the budget in force); undefined when off or while
	 * the budget is unknown or a provisional fallback.
	 */
	sizeTrailer(output: string): string | undefined {
		if (!this.settings.enabled || !this.enabled || !this.settings.trailer || this.mirrorUnavailable !== undefined) return undefined;
		const resolved = this.resolvedBudget();
		// A fallback budget is a placeholder: "~N of 32,000" would report a limit nothing enforces.
		if (!resolved || this.provisional(resolved)) return undefined;
		return sizeTrailer(this.lastReading?.estimated ?? 0, this.calibrator.apply(this.textTokens(output)), resolved.budget);
	}

	/**
	 * Before an OpenCode compaction (`experimental.session.compacting`): commit the edit the
	 * model made in its final step. No request followed that step (e.g. the user typed
	 * /compact next), so the commit at the start of a transform has not run; without this the
	 * compaction would summarize the pre-edit context and the edit would be lost.
	 */
	async commitBeforeCompaction(): Promise<void> {
		await this.refreshSettings();
		if (!this.settings.enabled || !this.enabled || this.noticesOnly) return;
		await this.commit();
	}

	/** Adds a notice to the next request (e.g. from a bus event). */
	queueNotice(text: string): void {
		this.pendingNotices.push(text);
	}

	/** The mirror block the model last saw, for continuity annotations. */
	blockSource(blockId: string): ContinuityBlockSource | undefined {
		if (this.noticesOnly) throw new Error("CLM runs in notices-only mode: there is no context mirror, so no block can be annotated.");
		const snapshot = this.lastSnapshot;
		const block = snapshot?.blocks.find((candidate) => candidate.id === blockId);
		return snapshot && block ? { message: block.source, revision: snapshot.revision } : undefined;
	}

	/** Step 1: commit the edit made since the last render. */
	private async commit(): Promise<void> {
		const baseline = this.baseline;
		this.baseline = undefined;
		if (!baseline || baseline.snapshot.revision !== this.state.revision) return;
		let text: string | undefined;
		try {
			text = await this.store.read();
		} catch (error) {
			this.pendingNotices.push(`[CLM] Could not read the mirror: ${describe(error)}`);
			this.pendingErrors.push(`could not read the mirror, the edit was not applied: ${describe(error)}`);
			return;
		}
		if (text === undefined || text.trim() === baseline.snapshot.text.trim()) return;
		const result = applyContextDocument(text, baseline.snapshot, this.applyOptions(baseline));
		const at = new Date().toISOString();
		const sizes = { beforeEstimate: result.beforeEstimate, afterEstimate: result.afterEstimate, estimateUnit: "tokens" as const };
		const reject = async (reason: string) => {
			this.rejected += 1;
			await this.updateState((state) => ({ ...state, lastOutcome: { kind: "rejected", message: reason, ...sizes, at } }), true)
				.catch(() => undefined);
			this.pendingNotices.push(`[CLM] Edit rejected; the context is unchanged. ${reason}`);
			await this.log({ event: "rejected", revision: this.state.revision, reason });
		};
		if (!result.accepted) return reject(result.reason ?? "Context edit rejected.");
		if (!result.changed) return;

		const revision = this.state.revision + 1;
		// state.ts requires editTrace.sourceMessageCount === checkpoint.sourceMessageCount.
		// The trace counts rendered blocks (projection + suffix), the checkpoint counts raw
		// source messages; they differ once an earlier revision is active, so the trace is
		// then kept in events.jsonl only.
		const trace = result.editTrace;
		const traceFits = trace !== undefined && trace.sourceMessageCount === baseline.rawMessages.length;
		let checkpoint: ProjectionCheckpoint;
		try {
			checkpoint = createProjectionCheckpoint({
				revision,
				sourceMessages: baseline.rawMessages,
				projectedMessages: result.messages,
				...sizes,
				createdAt: at,
				...(traceFits ? { editTrace: trace } : {}),
			});
		} catch (error) {
			return reject(`The edited context cannot be saved: ${describe(error)}`);
		}
		const applied = `Applied revision ${revision}: editable context about ${formatTokens(result.beforeEstimate)} → ${formatTokens(result.afterEstimate)} tokens.`;
		try {
			await this.updateState((state) => {
				if (state.revision + 1 !== revision) throw new Error("the session state changed while the edit was applied");
				return {
					version: 1,
					enabled: state.enabled,
					revision,
					checkpoint,
					lastOutcome: { kind: "applied", message: applied, ...sizes, at },
					...keptFields(state),
				};
			});
		} catch (error) {
			// Persist before activate: an unsaved revision would vanish on restart.
			this.pendingNotices.push(`[CLM] Revision ${revision} was not applied: it could not be saved (${describe(error)}); the previous context stays in effect.`);
			this.pendingErrors.push(`revision ${revision} could not be saved, the previous context stays in effect: ${describe(error)}`);
			return;
		}
		this.accepted += 1;
		this.tracker.editAccepted();
		await this.remember({ version: 1, checkpoint, contentDigest: digestSourceContent(baseline.rawMessages) });
		const revisions = join(this.store.directory, "revisions");
		await mkdir(revisions, { recursive: true, mode: 0o700 }).catch(() => undefined);
		await writeFile(join(revisions, `r${revision}.md`), text, { mode: 0o600 }).catch(() => undefined);
		if (trace) {
			await writeJsonAtomic(join(revisions, `r${revision}.json`), this.revisionFile(revision, at, baseline, result.messages, trace, sizes))
				.catch((error: unknown) => this.log({ event: "revision-file-error", revision, error: describe(error) }));
		}
		const notes = result.diagnostics.length > 0 ? ` ${result.diagnostics.join(" ")}` : "";
		this.pendingNotices.push(`[CLM] ${applied}${notes}`);
		await this.log({
			event: "accepted",
			revision,
			before: result.beforeEstimate,
			after: result.afterEstimate,
			trace: trace
				? {
					sourceCount: trace.sourceMessageCount,
					kept: trace.sources.filter((source) => source.kind === "kept").length,
					edited: trace.sources.filter((source) => source.kind === "edited" || source.kind === "normalized").length,
					removed: trace.sources.filter((source) => source.kind === "removed").length,
					restored: trace.sources.filter((source) => source.kind === "restored").length,
					added: trace.additions.length,
					stored: traceFits,
				}
				: undefined,
		});
	}

	/** `revisions/rN.json` for the panel: every row's full text and role before and after. */
	private revisionFile(
		revision: number,
		at: string,
		baseline: Baseline,
		output: readonly LiveContextMessage[],
		trace: ContextEditTrace,
		sizes: { beforeEstimate: number; afterEstimate: number },
	): RevisionFile {
		const rows: RevisionFileRow[] = [];
		const roleOf = (message: LiveContextMessage | undefined) => (message ? String(message.role) : "?");
		for (const source of trace.sources) {
			const before = baseline.snapshot.blocks[source.sourceIndex]?.source;
			const after = source.outputIndex !== undefined ? output[source.outputIndex] : undefined;
			const row: RevisionFileRow = { kind: source.kind, sourceIndex: source.sourceIndex, role: roleOf(after ?? before) };
			if (source.outputIndex !== undefined) row.outputIndex = source.outputIndex;
			if (before && after && roleOf(before) !== roleOf(after)) {
				row.beforeRole = roleOf(before);
				row.afterRole = roleOf(after);
			}
			if (before) row.beforeTokens = this.estimate([before]);
			if (after && source.kind !== "removed") row.afterTokens = this.estimate([after]);
			const beforeText = before ? renderMessage(before) : undefined;
			const afterText = after && source.kind !== "removed" ? renderMessage(after) : undefined;
			// Unchanged rows (kept, most restored) store their text once.
			if (beforeText !== undefined && beforeText === afterText) row.text = beforeText;
			else {
				if (beforeText !== undefined) row.before = beforeText;
				if (afterText !== undefined) row.after = afterText;
			}
			rows.push(row);
		}
		for (const addition of trace.additions) {
			const after = output[addition.outputIndex];
			rows.push({
				kind: "added",
				outputIndex: addition.outputIndex,
				role: roleOf(after),
				...(after ? { after: renderMessage(after), afterTokens: this.estimate([after]) } : {}),
			});
		}
		return {
			version: 1,
			revision,
			sourceRevision: trace.sourceRevision,
			at,
			beforeTokens: sizes.beforeEstimate,
			afterTokens: sizes.afterEstimate,
			rows,
		};
	}

	/** `snapshot.json` for the panel: the request just built, replaced atomically. */
	private snapshotFile(input: {
		pinned: readonly LiveContextMessage[];
		effective: readonly LiveContextMessage[];
		sourceTokens: number;
		raw: number;
		sent: number;
		suffix: number;
		estimated: number;
		observed?: number;
	}): SnapshotFile | undefined {
		const base = resolveBudget(this.settings.budget, this.limits.context, this.limits.output);
		const resolved = this.resolvedBudget();
		if (!base || !resolved) return undefined;
		const shown = [...input.pinned, ...input.effective];
		const steering = this.steering;
		return {
			at: new Date().toISOString(),
			request: this.requests,
			revision: this.state.revision,
			enabled: this.enabled,
			budget: { budget: base.budget, reserve: base.reserve, limit: overflowGuardLimit(resolved.budget, resolved.reserve), source: base.source },
			calibration: { factor: this.calibrator.factor, samples: this.calibrator.sampleCount },
			...(steering ? { steering: { name: steering.name, hash: steering.hash, path: steering.path } } : {}),
			...(this.steeringError ? { steeringError: this.steeringError } : {}),
			sizes: { estimated: input.estimated, ...(input.observed !== undefined ? { observedPrevious: input.observed } : {}) },
			input: {
				raw: input.raw,
				sent: input.sent,
				suffix: input.suffix,
				rawTokens: input.sourceTokens,
				effectiveTokens: this.estimate([...shown]),
				messages: shown.map((message, index) => ({
					index: index + 1,
					role: String(message.role),
					tokens: this.estimate([message]),
					preview: renderMessage(message).replace(/\s+/g, " ").trim().slice(0, 120),
				})),
			},
			...(this.state.budgetCheck ? { overhead: this.state.budgetCheck.overhead } : {}),
			base: settingsAsOverrides(this.baseSettings) as Record<string, unknown>,
		};
	}

	// ---- the transform -----------------------------------------------------------------

	/** Transforms of one session run one at a time. */
	transform(raw: OcMessage[]): Promise<TransformResult> {
		const run = this.running.then(() => this.transformNow(raw));
		this.running = run.catch(() => undefined);
		return run;
	}

	private context(raw: readonly OcMessage[]) {
		const rawById = new Map(raw.map((message) => [message.info.id, message]));
		const template = [...raw].reverse().find((message) => message.info.role === "user")?.info as OcInfo | undefined;
		return { sessionID: this.sessionID, rawById, template };
	}

	/** Text for `experimental.session.compacting`'s `output.context`: the instruction plus the active annotations. */
	async compactionContext(): Promise<string | undefined> {
		if (!this.settings.enabled || !this.enabled) return undefined;
		const continuity = formatContinuityMessage({ annotations: await this.loadAnnotations(), effectiveMessages: [] });
		return continuity ? `${COMPACTION_INSTRUCTION}\n\n${continuity}` : COMPACTION_INSTRUCTION;
	}

	/**
	 * After a compaction the history starts at the summary, which the compacting transform
	 * built from the accepted revision. Start a fresh baseline there: the revision number
	 * moves on, the checkpoint goes, and the model gets no drop note.
	 */
	private async rebaseAfterCompaction(summaryId: string): Promise<void> {
		const previous = this.state.checkpoint?.revision;
		const message = `Rebased on compaction summary ${summaryId}.`;
		const at = new Date().toISOString();
		let written = true;
		const next = await this.updateState((state) => ({
			version: 1,
			enabled: state.enabled,
			revision: state.revision + 1,
			lastOutcome: { kind: "compacted", message, at },
			...keptFields(state),
		}), true).catch(() => {
			written = false;
			return this.state;
		});
		this.invalidationStreak = 0;
		this.tracker.reset();
		await this.log({ event: "compacted", revision: next.revision, previous, summary: summaryId, written });
	}

	// ---- checkpoint history (revert and fork) ------------------------------------------

	/** History writes and clears run one at a time (`/clm reset` runs outside the transform queue). */
	private historyQueue: Promise<void> = Promise.resolve();

	private historyTask(task: () => Promise<void>): Promise<void> {
		const run = this.historyQueue.then(task).catch(() => undefined);
		this.historyQueue = run;
		return run;
	}

	/**
	 * Add an accepted checkpoint to `checkpoints/`. Best effort: the revision is already saved.
	 * Skipped when the checkpoint is no longer the active one by the time the write runs (a
	 * `/clm reset` came in between), so a reset edit never lands in the history.
	 */
	private remember(entry: HistoryEntry): Promise<void> {
		return this.historyTask(async () => {
			if (this.state.checkpoint?.revision !== entry.checkpoint.revision) return;
			await saveHistoryEntry(this.store.directory, entry)
				.catch((error: unknown) => this.log({ event: "history-error", revision: entry.checkpoint.revision, error: describe(error) }));
		});
	}

	/**
	 * Make `entry`'s projection, with `projected` standing for `source`, the next revision.
	 * Persisted before it takes effect, like an accepted edit.
	 */
	private async activateRestored(
		entry: HistoryEntry,
		source: readonly LiveContextMessage[],
		projected: readonly LiveContextMessage[],
		describeRestore: (revision: number) => string,
	): Promise<boolean> {
		const at = new Date().toISOString();
		const old = entry.checkpoint;
		const revision = this.state.revision + 1;
		let checkpoint: ProjectionCheckpoint;
		try {
			checkpoint = createProjectionCheckpoint({
				revision,
				sourceMessages: source,
				projectedMessages: projected,
				beforeEstimate: old.beforeEstimate,
				afterEstimate: old.afterEstimate,
				estimateUnit: old.estimateUnit,
				createdAt: at,
				...(old.editTrace ? { editTrace: old.editTrace } : {}),
			});
		} catch {
			return false;
		}
		const message = describeRestore(revision);
		try {
			await this.updateState((state) => {
				if (state.revision + 1 !== revision) throw new Error("the session state changed while the revision was restored");
				return {
					version: 1,
					enabled: state.enabled,
					revision,
					checkpoint,
					lastOutcome: { kind: "applied", message, beforeEstimate: old.beforeEstimate, afterEstimate: old.afterEstimate, estimateUnit: old.estimateUnit, at },
					...keptFields(state),
				};
			});
		} catch {
			return false;
		}
		this.tracker.reset();
		await this.remember({ version: 1, checkpoint, contentDigest: entry.contentDigest });
		this.pendingNotices.push(`[CLM] ${message} The mirror shows it.`);
		return true;
	}

	/**
	 * The active revision no longer fits the history (a revert cut into its prefix): restore
	 * the newest older checkpoint that still fits, as pi-clm restores the checkpoint of the
	 * branch `/tree` selects. False when none fits; the caller then resets.
	 */
	private async restoreAfterMismatch(source: readonly LiveContextMessage[], reason: string): Promise<boolean> {
		const dropped = this.state.checkpoint?.revision;
		const { entries, ignored } = await loadHistory(this.store.directory);
		if (ignored.length > 0) await this.log({ event: "history-ignored", files: ignored });
		for (const entry of entries) {
			if (entry.checkpoint.revision === dropped) continue;
			const candidate = applyProjection(source, entry.checkpoint);
			if (!candidate.valid) continue;
			const from = entry.checkpoint.revision;
			const prefix = source.slice(0, entry.checkpoint.sourceMessageCount);
			const restored = await this.activateRestored(entry, prefix, entry.checkpoint.projectedMessages, (revision) =>
				`Revision ${dropped} no longer matches OpenCode's history: ${reason.replace(/\.\s*$/, "")}; restored revision ${from}, which still does, as revision ${revision}.`);
			if (!restored) return false;
			await this.log({ event: "restored", revision: this.state.revision, from, dropped, reason });
			return true;
		}
		return false;
	}

	/**
	 * First request of a forked session: find the newest origin checkpoint whose source the
	 * fork's history starts with (compared without message ids, which the fork renews) and
	 * restore it with the ids mapped to the fork's.
	 */
	private async restoreFromFork(origin: { sessionID: string; directory: string }, source: readonly LiveContextMessage[]): Promise<boolean> {
		const { entries, ignored } = await loadHistory(origin.directory);
		if (ignored.length > 0) await this.log({ event: "history-ignored", origin: origin.sessionID, files: ignored });
		for (const entry of entries) {
			const count = entry.checkpoint.sourceMessageCount;
			if (count > source.length) continue;
			const prefix = source.slice(0, count);
			if (digestSourceContent(prefix) !== entry.contentDigest) continue;
			const from = entry.checkpoint.revision;
			const restored = await this.activateRestored(entry, prefix, remapProjection(entry.checkpoint, prefix), (revision) =>
				`This session is a fork of ${origin.sessionID}; restored its revision ${from} as revision ${revision}.`);
			if (!restored) return false;
			await this.log({ event: "restored", revision: this.state.revision, from, origin: origin.sessionID });
			return true;
		}
		return false;
	}

	/**
	 * First request of a forked session: copy the origin's annotations made up to the fork
	 * point, their sources re-pointed at the fork's messages (`forkAnnotations`). The fork
	 * point is the newest completion among the messages created before the fork itself
	 * (OpenCode keeps message times in a fork); newer messages are the fork's own.
	 */
	private async copyForkAnnotations(origin: { sessionID: string; directory: string; created?: number }, raw: readonly OcMessage[], effective: readonly LiveContextMessage[]): Promise<void> {
		let annotations: LiveContextAnnotation[] = [];
		try {
			annotations = await new AnnotationStore(origin.directory).list();
		} catch (error) {
			await this.log({ event: "annotations-unreadable", origin: origin.sessionID, error: describe(error) });
		}
		// Without a mirror the origin's directory is usually out of reach too: fall back to the
		// set the origin kept in OpenCode's metadata, which the fork cloned (index.ts).
		if (annotations.length === 0) annotations = this.forkPersisted ?? [];
		this.forkPersisted = undefined;
		if (annotations.length === 0) return;
		let cutoff: number | undefined;
		for (const { info } of raw) {
			const created = Number(info.time?.created ?? 0);
			if (origin.created !== undefined && created >= origin.created) continue;
			const end = Number(info.time?.completed ?? 0) || created;
			if (cutoff === undefined || end > cutoff) cutoff = end;
		}
		const copied = forkAnnotations(annotations, effective, { sessionId: this.sessionID, ...(cutoff !== undefined ? { cutoff } : {}) });
		try {
			const written = await this.annotations.importAll(copied);
			// Without the fork's creation time the fork's own new messages count too, so origin
			// annotations made between the fork and its first request are carried as well.
			if (written > 0) {
				this.annotationsImported = true;
				await this.log({
					event: "annotations-forked",
					origin: origin.sessionID,
					count: written,
					mapped: copied.filter((annotation) => annotation.source.sessionId === this.sessionID).length,
					cutoff: origin.created === undefined ? "unbounded" : cutoff ?? null,
				});
			}
		} catch (error) {
			await this.log({ event: "annotations-fork-error", origin: origin.sessionID, error: describe(error) });
		}
	}

	private async loadAnnotations(): Promise<LiveContextAnnotation[]> {
		try {
			return await this.annotations.list();
		} catch (error) {
			await this.log({ event: "annotations-unreadable", error: describe(error) });
			return [];
		}
	}

	/**
	 * Without a mirror (`mirrorUnavailable`): the raw history, then the continuity message and
	 * its size notice. Nothing is projected, rendered or measured; queued notices name the
	 * mirror, so they are dropped. pi-clm src/index.ts `context` handler, `!store` branch.
	 */
	private async transformWithoutMirror(raw: OcMessage[]): Promise<TransformResult> {
		this.baseline = undefined;
		this.compacted = false;
		this.pendingNotices = [];
		if (this.compacting) {
			this.compacting = false;
			return { messages: raw, notices: [] };
		}
		this.requests += 1;
		const origin = this.forkOrigin;
		this.forkOrigin = undefined;
		if (origin) await this.copyForkAnnotations(origin, raw, flatten(raw));
		const continuity = formatContinuityMessage({ annotations: await this.loadAnnotations(), effectiveMessages: flatten(raw) });
		const tokens = continuity ? this.textTokens(continuity) : 0;
		const notices = this.continuitySize.observe(tokens) ? [continuitySizeNoticeText(tokens)] : [];
		const context = this.context(raw);
		const messages = [
			...raw,
			...(continuity ? [noteMessage(continuity, "continuity", context)] : []),
			...(notices.length > 0 ? [noteMessage(notices.join("\n\n"), `notice:${this.requests}`, context)] : []),
		];
		this.lastRequest = { rawMessages: raw.length, sentMessages: messages.length, mirrorBlocks: 0 };
		const errors = this.pendingErrors;
		this.pendingErrors = [];
		return { messages, notices, ...(errors.length > 0 ? { errors } : {}) };
	}

	private async transformNow(raw: OcMessage[]): Promise<TransformResult> {
		await this.refreshSettings();
		if (!this.settings.enabled || !this.enabled) {
			this.baseline = undefined;
			this.compacting = false;
			return { messages: raw, notices: [], ...this.drainAlerts() };
		}
		if (this.mirrorUnavailable !== undefined) return await this.transformWithoutMirror(raw);
		const noticesOnly = this.noticesOnly;
		const pinned = pinnedCount(raw);
		const pinnedMessages = raw.slice(0, pinned);
		const context = this.context(raw);

		// OpenCode's compaction passes a head slice of the history through this hook. Apply
		// the accepted revision when it still covers that slice; never commit, render,
		// notify or reset (the slice is shorter than the history the checkpoint covers).
		// A pending edit was committed by `commitBeforeCompaction` just before.
		if (this.compacting) {
			this.compacting = false;
			// notices-only: the summary is made from the history the model was sent, the raw one.
			if (noticesOnly) return { messages: raw, notices: [], ...this.drainAlerts() };
			const projection = applyProjection(flatten(raw.slice(pinned)), this.state.checkpoint);
			if (!projection.valid || !this.state.checkpoint) return { messages: raw, notices: [], ...this.drainAlerts() };
			return { messages: [...pinnedMessages, ...unflatten(projection.messages, context)], notices: [], ...this.drainAlerts() };
		}

		if (noticesOnly) {
			// No render to commit against; a mirror written meanwhile is never applied.
			this.baseline = undefined;
			this.lastSnapshot = undefined;
		} else await this.commit();
		this.requests += 1;
		// notices-only leaves a compaction signal pending: back in `edit`, the kept revision
		// rebases onto the summary as it would have at the time.
		const compacted = noticesOnly ? false : this.compacted;
		if (!noticesOnly) this.compacted = false;

		// The raw source prefix is digested as flattened, before any view, cap or guard.
		const source = flatten(raw.slice(pinned));
		const observed = lastProviderReported(raw);
		this.calibrator.observe(observed);
		// Before the guard and the reading, so a raise applies to this request already.
		const measured = this.state.budgetCheck?.source === "provider" ? undefined : this.measureOverhead(raw, observed);
		const alert = measured ? await this.checkBudget(measured) : undefined;
		// Samples taken before the overhead was measured read the unmeasured part of the
		// overhead (built-in tool schemas) as undercounting; start calibration over.
		if (measured?.source === "provider") this.calibrator.reset();

		// notices-only: the kept revision is ignored, not dropped (see the header comment).
		let projection = applyProjection(source, noticesOnly ? undefined : this.state.checkpoint);
		// A late or repeated compaction signal must not swallow a later revert: rebase only
		// onto a summary the active checkpoint does not already cover.
		const summaryId = compacted ? compactionSummaryId(raw) : undefined;
		const rebase = summaryId !== undefined && !projection.valid && this.state.checkpoint !== undefined &&
			!this.state.checkpoint.sourceIds.includes(summaryId);
		if (noticesOnly) {
			// Raw history: nothing to rebase, restore or reset.
		} else if (rebase) {
			await this.rebaseAfterCompaction(summaryId);
			projection = applyProjection(source, undefined);
		} else if (!projection.valid && (await this.restoreAfterMismatch(source, projection.reason))) {
			// A revert cut into the active revision's prefix; an older revision still fits.
			this.invalidationStreak = 0;
			projection = applyProjection(source, this.state.checkpoint);
		} else if (!projection.valid) {
			const dropped = this.state.checkpoint?.revision;
			// The edit the cooldown measures from no longer applies.
			this.tracker.clearCooldown();
			this.invalidationStreak += 1;
			const reason = projection.reason;
			await this.updateState((state) => resetProjectionState(state, reason), true).catch(() => undefined);
			let notice = `[CLM] Revision ${dropped} was dropped because OpenCode's history changed under it: ${projection.reason} The mirror now shows the stored history.`;
			if (this.invalidationStreak >= 2) {
				notice += " This happened on consecutive requests; edits keep being dropped until the start of the history stops changing.";
				if (!this.compositionWarned) {
					this.compositionWarned = true;
					this.pendingAlerts.push(COMPOSITION_WARNING);
				}
			}
			this.pendingNotices.push(notice);
			await this.log({ event: "projection-reset", revision: dropped, reason: projection.reason });
			projection = applyProjection(source, undefined);
		} else if (this.state.checkpoint) {
			this.invalidationStreak = 0;
		}
		if (projection.valid && projection.reanchor) {
			// OpenCode rewrote messages of the current turn after the checkpoint was captured
			// (an assistant message still being finalized). Trim the anchor to the stable head
			// instead of dropping the revision: the trimmed tail becomes ordinary suffix,
			// exactly as if the edit had been committed a moment later. Silent by design;
			// `reanchored` in events.jsonl records it for the panel and for debugging.
			this.invalidationStreak = 0;
			const reanchor = projection.reanchor;
			const revision = this.state.revision;
			await this.updateState(
				(state) =>
					state.checkpoint && state.revision === revision
						? { ...state, checkpoint: { ...state.checkpoint, ...reanchor } }
						: state,
				true,
			).catch(() => undefined);
			await this.log({ event: "reanchored", revision, sourceMessageCount: reanchor.sourceMessageCount });
		}
		const origin = this.forkOrigin;
		this.forkOrigin = undefined;
		if (origin && !noticesOnly && !this.state.checkpoint && this.state.revision === 0 && (await this.restoreFromFork(origin, source))) {
			projection = applyProjection(source, this.state.checkpoint);
		}
		const checkpoint = noticesOnly ? undefined : this.state.checkpoint;
		const suffixLength = projection.valid ? projection.suffix.length : 0;

		let effective = projection.messages;
		if (!this.settings.reasoning) effective = withoutReasoning(effective);
		effective = capObservations(effective, this.settings.observationCap);

		if (origin) await this.copyForkAnnotations(origin, raw, effective);
		const annotations = await this.loadAnnotations();
		const continuityText = (messages: LiveContextMessage[]) =>
			formatContinuityMessage({ annotations, effectiveMessages: messages });
		const pinnedTokens = this.estimate(flatten(pinnedMessages));
		const resolved = this.resolvedBudget();
		// Model limits arrive one request late, so the first request of a process reads the
		// FALLBACK_BUDGET placeholder. Withholding, reminding or refusing an edit against it is
		// undone on the next request (a prompt-cache miss, a spurious notice, an edit the real
		// budget would accept), so none acts on a fallback: `guardLimit()` is undefined, which
		// also leaves the fit gate unlimited, as with no budget at all.
		const limit = this.guardLimit();
		const provisional = resolved !== undefined && this.provisional(resolved);
		const { systemTokens, toolTokens } = this.scope;
		const { measuredOverhead, scopeTokens } = this.scopeSize();
		const excluded = measuredOverhead !== undefined ? [] : [
			...(systemTokens === undefined ? ["the system prompt"] : []),
			...(toolTokens === undefined ? ["tool schemas"] : []),
		];

		let withheldCount = 0;
		if (this.settings.guard === "withhold" && limit !== undefined) {
			const before = continuityText(effective);
			const fixedTokens = pinnedTokens + scopeTokens +
				this.calibrator.apply((before ? this.textTokens(before) : 0) + this.noticeTokens(this.pendingNotices));
			const guarded = applyOverflowGuard(effective, {
				limit,
				fixedTokens,
				estimate: this.estimate,
				saveDirectory: join(this.store.directory, "withheld"),
				// The model's accepted context is respected; only the new raw suffix is withheld.
				protectBefore: checkpoint ? effective.length - suffixLength : 0,
			});
			if (guarded.withheld.length > 0) {
				effective = guarded.messages;
				withheldCount = guarded.withheld.length;
				this.pendingNotices.push(overflowNoticeText(guarded, limit, { noticesOnly }));
				await this.log({
					event: "overflow-guard",
					withheld: guarded.withheld.map((record) => ({ id: record.toolCallId, tokens: record.tokens, file: record.file })),
				});
			}
		}

		// Continuity sits after the editable context, outside the mirror.
		const continuity = continuityText(effective);
		const continuityTokens = continuity ? this.calibrator.apply(this.textTokens(continuity)) : 0;
		if (this.continuitySize.observe(continuity ? this.textTokens(continuity) : 0)) {
			this.pendingNotices.push(continuitySizeNoticeText(this.textTokens(continuity ?? "")));
		}

		// notices-only: no mirror is rendered or written, so no edit can be validated or applied.
		const snapshot = noticesOnly ? undefined : renderContextDocument(effective, {
			revision: this.state.revision,
			protectedIndexes: new Set<number>(),
			// Constant until the next accepted edit or reset — and across process restarts,
			// as pi-clm's is — so header ids read on one call remain valid on the next;
			// bodies are escaped accordingly.
			documentSeed: `${this.sessionID}:${checkpoint?.sourceDigest ?? "raw"}`,
		});
		if (snapshot) {
			try {
				await this.store.write(snapshot.text);
				this.refreshFailing = false;
				this.lastSnapshot = snapshot;
				this.baseline = {
					rawMessages: source,
					effectiveMessages: effective,
					snapshot,
					// The fit gate measures the editable context alone; the system prompt, tool
					// schemas, pinned task and continuity message take their share of budget − reserve first.
					limit: limit === undefined ? undefined : Math.max(1, limit - scopeTokens - pinnedTokens - continuityTokens),
				};
			} catch (error) {
				this.baseline = undefined;
				this.pendingNotices.push(`[CLM] Could not refresh the mirror: ${describe(error)}`);
				if (!this.refreshFailing) this.pendingErrors.push(`could not refresh the mirror, edits are off until it can be written: ${describe(error)}`);
				this.refreshFailing = true;
			}
		}

		const conversationTokens = pinnedTokens + this.estimate(effective) + continuityTokens;
		const requestTokens = scopeTokens + conversationTokens;
		let reading: BudgetReading | undefined;
		if (resolved) {
			reading = {
				...resolved,
				estimated: requestTokens + this.calibrator.apply(this.noticeTokens(this.pendingNotices)),
				...(excluded.length > 0 ? { estimateExcludes: excluded.join(" and ") } : {}),
				calibration: this.calibrator.factor,
				observed: observed?.tokens,
				// The measured request was answered inside the prefix the active revision replaced.
				observedStale: observed !== undefined && checkpoint !== undefined && checkpoint.sourceIds.includes(observed.messageID),
			};
			// A fallback reading skips the tracker: no tier fires or is marked fired, and a pending
			// cooldown waits, so reminders start from the real budget once the window is known.
			const { tier, suppressed, cooldownUntil } = provisional ? { tier: undefined, suppressed: [] } : this.tracker.check(
				reading, budgetTiers(this.settings.budget, resolved.budget, resolved.reserve), this.settings.budget.reminderCooldown);
			for (const skipped of suppressed) {
				await this.log({ event: "budget-notice-suppressed", tier: skipped.label, estimated: reading.estimated, cooldownUntil });
			}
			if (tier) {
				// With the guard off nothing is withheld, so the notice must not describe it.
				this.pendingNotices.push(budgetNoticeText(reading, tier, noticesOnly ? undefined : this.mirrorPath, this.settings.guard === "off" ? null : limit, { noticesOnly }));
				await this.log({ event: "budget-notice", tier: tier.label, estimated: reading.estimated });
			}
			this.lastReading = reading;
		}

		const notices = this.pendingNotices;
		this.pendingNotices = [];
		const messages = [
			...pinnedMessages,
			...unflatten(effective, context),
			...(continuity ? [noteMessage(continuity, "continuity", context)] : []),
			...(notices.length > 0 ? [noteMessage(notices.join("\n\n"), `notice:${this.requests}`, context)] : []),
		];

		// Calibrate only against a same-scope estimate: the provider count includes the system
		// prompt and tool schemas. With a measured overhead the calibrator compares the
		// conversation with the provider count minus that overhead; otherwise both hook sizes
		// must be known.
		const conversationRaw = this.rawTokens(flatten(pinnedMessages)) + this.rawTokens(effective) +
			(continuity ? this.textTokens(continuity) : 0) + this.noticeTokens(notices);
		if (measuredOverhead !== undefined) {
			this.calibrator.record(conversationRaw, raw.length, measuredOverhead);
		} else if (systemTokens !== undefined && toolTokens !== undefined) {
			this.calibrator.record(systemTokens + toolTokens + conversationRaw, raw.length);
		}

		this.previousRequest = { rawCount: raw.length, conversation: conversationTokens + this.calibrator.apply(this.noticeTokens(notices)) };
		this.lastRequest = { rawMessages: raw.length, sentMessages: messages.length, mirrorBlocks: snapshot?.blocks.length ?? 0 };
		if (this.settings.dumpRequests) {
			const directory = join(this.store.directory, "requests");
			await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => undefined);
			await writeFile(join(directory, `n${this.requests}.json`), JSON.stringify(messages, null, 1), { mode: 0o600 }).catch(() => undefined);
		}
		const snapshotFile = this.snapshotFile({
			pinned: flatten(pinnedMessages),
			effective,
			sourceTokens: pinnedTokens + this.estimate(source),
			raw: raw.length,
			sent: messages.length,
			suffix: suffixLength,
			estimated: reading?.estimated ?? requestTokens,
			...(observed ? { observed: observed.tokens } : {}),
		});
		if (snapshotFile) {
			await writeJsonAtomic(join(this.store.directory, SNAPSHOT_FILE), snapshotFile)
				.catch((error: unknown) => this.log({ event: "snapshot-error", error: describe(error) }));
		}
		await this.log({
			event: "request",
			n: this.requests,
			revision: this.state.revision,
			users: raw.filter((message) => message.info.role === "user").length,
			raw: raw.length,
			sent: messages.length,
			blocks: snapshot?.blocks.length ?? 0,
			...(noticesOnly ? { mode: "notices-only" } : {}),
			withheld: withheldCount,
			estimated: reading?.estimated ?? requestTokens,
			observedPrevious: observed?.tokens,
			// The assistant message that reported `observedPrevious`; a new id means a new count.
			observedMessage: observed?.messageID,
			calibration: this.calibrator.factor,
			notices: notices.map((notice) => notice.slice(0, 80)),
		});
		return {
			messages,
			notices,
			estimated: reading?.estimated ?? requestTokens,
			reading,
			...this.drainAlerts(alert),
		};
	}

	/** The queued toasts (`alert`, `errors`) for a transform result, cleared once taken. */
	private drainAlerts(alert?: string): Pick<TransformResult, "alert" | "errors"> {
		const alerts = [...(alert ? [alert] : []), ...this.pendingAlerts];
		this.pendingAlerts = [];
		const errors = this.pendingErrors;
		this.pendingErrors = [];
		return {
			...(alerts.length > 0 ? { alert: alerts.join("\n") } : {}),
			...(errors.length > 0 ? { errors } : {}),
		};
	}

	/** Inputs for presentation.ts `statusText` / `statusLine`. */
	status(steering: SteeringDocument | undefined = this.steering): ClmStatus {
		const checkpoint = this.state.checkpoint;
		const { base, effective } = this.settingsValues();
		const changed = changedSummary(base, effective, { modelWindow: this.limits.context, modelOutput: this.limits.output });
		return {
			...(changed ? { changed } : {}),
			...(this.settingsWarning ? { settingsWarning: this.settingsWarning } : {}),
			sessionID: this.sessionID,
			mirrorPath: this.mirrorUnavailable !== undefined
				? `unavailable, requests carry the raw history (${this.mirrorUnavailable})`
				: this.noticesOnly ? "not used (mode notices-only)" : this.mirrorPath,
			...(this.noticesOnly ? { mode: "notices-only" as const } : {}),
			revision: this.state.revision,
			accepted: this.accepted,
			rejected: this.rejected,
			gate: this.settings.gate,
			guard: this.settings.guard,
			reading: this.lastReading,
			fit: this.budgetFit(),
			modelWindow: this.limits.context,
			checkpoint: checkpoint
				? {
					revision: checkpoint.revision,
					anchorCount: checkpoint.sourceMessageCount,
					beforeEstimate: checkpoint.beforeEstimate,
					afterEstimate: checkpoint.afterEstimate,
				}
				: undefined,
			lastRequest: this.lastRequest,
			steering,
		};
	}
}
