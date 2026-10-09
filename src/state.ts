// Adapted from pi-clm src/state.ts (MIT, Copyright 2026 Emanuel Casco).
//
// Pi appends the state as custom session entries and reconstructs the latest one per
// branch. OpenCode gives plugins no session store and has no branches, so the whole state
// lives in one `state.json` in the session directory, replaced atomically on each save.
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProjectionCheckpoint } from "./projection.ts";
import type { ContextEditTrace, LiveContextMessage } from "./types.ts";

export const STATE_FILE = "state.json";
export const STATE_VERSION = 1;

export type OutcomeKind = "applied" | "rejected" | "reset" | "compacted";

export interface LiveContextOutcome {
	kind: OutcomeKind;
	message: string;
	beforeEstimate?: number;
	afterEstimate?: number;
	estimateUnit?: "characters" | "tokens";
	at: string;
}

/**
 * The once-per-session measurement of OpenCode's fixed overhead (system prompt and tool
 * schemas). Its presence means the budget-too-small check has run; the session then derives
 * its effective budget from `overhead` (clm.ts), so a raise survives a restart.
 */
export interface BudgetCheck {
	/** Fixed overhead per request, tokens. */
	overhead: number;
	/** `provider`: the provider's count minus the conversation estimate; `estimate`: chars/4 sizes. */
	source: "provider" | "estimate";
	/** Budget and reserve in force when the check ran, and what it decided. */
	configured: number;
	reserve: number;
	effective: number;
	raised: boolean;
	at: string;
}

export interface LiveContextState {
	version: 1;
	enabled: boolean;
	/** Increases on every accepted edit and every reset. */
	revision: number;
	checkpoint?: ProjectionCheckpoint;
	lastOutcome?: LiveContextOutcome;
	budgetCheck?: BudgetCheck;
}

export interface LoadedState {
	state: LiveContextState;
	/** Set when a state file existed but could not be used; the state is then initial. */
	warning?: string;
	/** Set when an invalid optional field was dropped and the rest of the state kept. */
	repaired?: string;
}

const SOURCE_KINDS = new Set(["kept", "edited", "removed", "restored", "normalized"]);
const OUTCOME_KINDS = new Set(["applied", "rejected", "reset", "compacted"]);

export function initialLiveContextState(): LiveContextState {
	return { version: 1, enabled: true, revision: 0 };
}

export function statePath(directory: string): string {
	return join(directory, STATE_FILE);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0;
}

function isEstimateUnit(value: unknown): boolean {
	return value === "characters" || value === "tokens";
}

/** Content the unflattener can turn into OpenCode parts: absent, a string, or typed parts. */
function isMessageContent(value: unknown): boolean {
	if (value === undefined || typeof value === "string") return true;
	return Array.isArray(value) && value.every((part) => isObject(part) && typeof part.type === "string");
}

function isMessageArray(value: unknown): value is LiveContextMessage[] {
	return (
		Array.isArray(value) &&
		value.every((message) => isObject(message) && typeof message.role === "string" && isMessageContent(message.content))
	);
}

/** Per-message stamps (`projection.ts` SourceStamp): a hex digest and a finite `updatedAt`. */
function isSourceStamps(value: unknown, count: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length === count &&
		value.every(
			(stamp) =>
				isObject(stamp) &&
				typeof stamp.digest === "string" &&
				/^[a-f0-9]{64}$/.test(stamp.digest) &&
				Number.isFinite(stamp.updatedAt) &&
				(stamp.strippedDigest === undefined ||
					(typeof stamp.strippedDigest === "string" && /^[a-f0-9]{64}$/.test(stamp.strippedDigest))),
		)
	);
}

function isContextEditTrace(value: unknown): value is ContextEditTrace {
	if (!isObject(value)) return false;
	const trace = value as Partial<ContextEditTrace>;
	if (
		trace.version !== 1 ||
		!isCount(trace.sourceRevision) ||
		!isCount(trace.sourceMessageCount) ||
		!isCount(trace.outputMessageCount) ||
		!Array.isArray(trace.sources) ||
		!Array.isArray(trace.additions)
	) return false;
	const sourceCount = trace.sourceMessageCount;
	const outputCount = trace.outputMessageCount;
	const isOutputIndex = (index: unknown) => isCount(index) && index < outputCount;
	return (
		trace.sources.every((item) =>
			isObject(item) &&
			isCount(item.sourceIndex) &&
			item.sourceIndex < sourceCount &&
			SOURCE_KINDS.has(item.kind) &&
			(item.outputIndex === undefined || isOutputIndex(item.outputIndex)),
		) &&
		trace.additions.every((item) => isObject(item) && item.kind === "added" && isOutputIndex(item.outputIndex))
	);
}

export function isProjectionCheckpoint(value: unknown): value is ProjectionCheckpoint {
	if (!isObject(value)) return false;
	const checkpoint = value as Partial<ProjectionCheckpoint>;
	return (
		checkpoint.version === 1 &&
		isCount(checkpoint.revision) &&
		isCount(checkpoint.sourceMessageCount) &&
		Array.isArray(checkpoint.sourceIds) &&
		checkpoint.sourceIds.length === checkpoint.sourceMessageCount &&
		checkpoint.sourceIds.every((id) => typeof id === "string") &&
		typeof checkpoint.sourceDigest === "string" &&
		/^[a-f0-9]{64}$/.test(checkpoint.sourceDigest) &&
		(checkpoint.sourceStamps === undefined || isSourceStamps(checkpoint.sourceStamps, checkpoint.sourceMessageCount)) &&
		isMessageArray(checkpoint.projectedMessages) &&
		Number.isFinite(checkpoint.beforeEstimate) &&
		Number.isFinite(checkpoint.afterEstimate) &&
		isEstimateUnit(checkpoint.estimateUnit) &&
		typeof checkpoint.createdAt === "string" &&
		(checkpoint.editTrace === undefined ||
			(isContextEditTrace(checkpoint.editTrace) &&
				checkpoint.editTrace.sourceMessageCount === checkpoint.sourceMessageCount &&
				checkpoint.editTrace.outputMessageCount === checkpoint.projectedMessages.length))
	);
}

function isOutcome(value: unknown): value is LiveContextOutcome {
	if (!isObject(value)) return false;
	return (
		OUTCOME_KINDS.has(value.kind as string) &&
		typeof value.message === "string" &&
		typeof value.at === "string" &&
		(value.beforeEstimate === undefined || Number.isFinite(value.beforeEstimate)) &&
		(value.afterEstimate === undefined || Number.isFinite(value.afterEstimate)) &&
		(value.estimateUnit === undefined || isEstimateUnit(value.estimateUnit))
	);
}

function isBudgetCheck(value: unknown): value is BudgetCheck {
	if (!isObject(value)) return false;
	return (
		isCount(value.overhead) &&
		(value.source === "provider" || value.source === "estimate") &&
		isCount(value.configured) &&
		isCount(value.reserve) &&
		isCount(value.effective) &&
		typeof value.raised === "boolean" &&
		typeof value.at === "string"
	);
}

/** The fields every state rewrite carries over (revision changes keep the budget check). */
export function keptFields(state: LiveContextState): Pick<LiveContextState, "budgetCheck"> {
	return state.budgetCheck ? { budgetCheck: state.budgetCheck } : {};
}

export function isLiveContextState(value: unknown): value is LiveContextState {
	if (!isObject(value)) return false;
	const state = value as Partial<LiveContextState>;
	return (
		state.version === STATE_VERSION &&
		typeof state.enabled === "boolean" &&
		isCount(state.revision) &&
		// Accept writes the checkpoint and the state with the same revision; reset moves past it.
		(state.checkpoint === undefined ||
			(isProjectionCheckpoint(state.checkpoint) && state.checkpoint.revision === state.revision)) &&
		(state.lastOutcome === undefined || isOutcome(state.lastOutcome)) &&
		(state.budgetCheck === undefined || isBudgetCheck(state.budgetCheck))
	);
}

/** Drop the checkpoint and advance the revision past it, keeping `enabled`. */
export function resetProjectionState(
	state: LiveContextState,
	message: string,
	at = new Date().toISOString(),
): LiveContextState {
	return {
		version: 1,
		enabled: state.enabled,
		revision: state.revision + 1,
		lastOutcome: { kind: "reset", message, at },
		...keptFields(state),
	};
}

/**
 * Read `state.json` from the session directory. A missing file is a new session. An
 * unreadable, malformed or foreign-version file yields the initial state and a warning;
 * this function never throws.
 */
export async function loadLiveContextState(directory: string): Promise<LoadedState> {
	const path = statePath(directory);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { state: initialLiveContextState() };
		return { state: initialLiveContextState(), warning: `Could not read ${path}: ${describe(error)}; starting clean.` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { state: initialLiveContextState(), warning: `${path} is not valid JSON (${describe(error)}); starting clean.` };
	}
	if (isObject(parsed) && parsed.version !== STATE_VERSION) {
		return {
			state: initialLiveContextState(),
			warning: `${path} has unsupported version ${JSON.stringify(parsed.version)}; starting clean.`,
		};
	}
	// A malformed budget check costs only itself: the session re-measures the overhead.
	let repaired: string | undefined;
	if (isObject(parsed) && parsed.budgetCheck !== undefined && !isBudgetCheck(parsed.budgetCheck)) {
		delete parsed.budgetCheck;
		repaired = `${path} had an invalid budgetCheck; dropped it, the fixed overhead is measured again.`;
	}
	// A malformed outcome costs only itself: the panel loses one line, the checkpoint stays.
	if (isObject(parsed) && parsed.lastOutcome !== undefined && !isOutcome(parsed.lastOutcome)) {
		delete parsed.lastOutcome;
		repaired = `${path} had an invalid lastOutcome; dropped it, the last outcome is unknown.`;
	}
	// Malformed per-message stamps cost only tail re-anchoring: the checkpoint keeps working
	// with the whole-prefix digest and fails closed on a mismatch, as before.
	if (
		isObject(parsed) &&
		isObject(parsed.checkpoint) &&
		parsed.checkpoint.sourceStamps !== undefined &&
		!isSourceStamps(parsed.checkpoint.sourceStamps, parsed.checkpoint.sourceMessageCount)
	) {
		delete parsed.checkpoint.sourceStamps;
		repaired = `${path} had invalid sourceStamps; dropped them, tail re-anchoring is off for this checkpoint.`;
	}
	if (!isLiveContextState(parsed)) {
		return { state: initialLiveContextState(), warning: `${path} has an invalid shape (${stateProblem(parsed)}); starting clean.` };
	}
	return repaired ? { state: parsed, repaired } : { state: parsed };
}

/** Names the first state check `value` fails, so a load warning locates the bad field. */
function stateProblem(value: unknown): string {
	if (!isObject(value)) return "not an object";
	if (value.version !== STATE_VERSION) return `unsupported version ${JSON.stringify(value.version)}`;
	if (typeof value.enabled !== "boolean") return "enabled is not a boolean";
	if (!isCount(value.revision)) return "revision is not a count";
	if (value.checkpoint !== undefined) {
		if (!isProjectionCheckpoint(value.checkpoint)) return "checkpoint is invalid";
		if (value.checkpoint.revision !== value.revision) return "checkpoint revision does not match the state revision";
	}
	if (value.lastOutcome !== undefined && !isOutcome(value.lastOutcome)) return "lastOutcome is invalid";
	if (value.budgetCheck !== undefined && !isBudgetCheck(value.budgetCheck)) return "budgetCheck is invalid";
	return "unknown";
}

/**
 * Write `state.json` atomically with mode 0600: temp file, fsync, rename, then fsync the
 * directory (best effort). Concurrent saves are not ordered: the last rename wins, so an
 * older state can replace a newer one. Callers must serialize saves per session.
 */
export async function saveLiveContextState(directory: string, state: LiveContextState): Promise<void> {
	const path = statePath(directory);
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const text = `${JSON.stringify(state)}\n`;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(text, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
	await syncDirectory(dirname(path));
}

/** Persist the rename. Some platforms refuse to open or fsync a directory; ignore that. */
async function syncDirectory(directory: string): Promise<void> {
	try {
		const handle = await open(directory, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		// Best effort.
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
