// Adapted from pi-clm src/projection.ts (MIT, Copyright 2026 Emanuel Casco).
//
// A checkpoint records one accepted mirror edit: the flattened raw prefix it replaces
// (count + SHA-256 digest) and the projected messages that stand in for that prefix.
// Messages are the flat form `opencode.ts` produces from OpenCode's `{ info, parts }`
// history. `digestSourcePrefix` hashes a key-sorted JSON serialization, so a checkpoint saved
// by one process validates against the same history flattened by another.
//
// The anchor is prune-invariant. OpenCode's `compaction.prune` (opt-in) clears old tool
// outputs in place (`state.time.compacted`), exactly in the old prefix a checkpoint covers.
// The source digest therefore hashes each `toolResult` without its content, and the
// checkpoint also stores the `ocMessageID` of every flat source message. Revert removes
// whole messages (ids change) or truncates the parts of a kept message (its toolCall and
// toolResult disappear, so the digest changes); both still fail closed.
//
// One mismatch source is OpenCode's own late writes: it keeps updating message objects
// after `experimental.chat.messages.transform` returns (an assistant message being
// finalized, turn diffs attached to a user message). A checkpoint taken mid-turn digests
// those still-mutable tail messages, and the late write flips the digest. `sourceStamps`
// (per-message digest + captured `time.updated`) lets `applyProjection` attribute such a
// mismatch to a post-capture OpenCode write and re-anchor the checkpoint to the stable
// head instead of dropping the revision (see `reanchorTail`); anything not attributable
// stays fail-closed.
//
// pi-clm's `recoverProjectionFromRetryErrors` is not ported. Pi writes failed assistant
// responses to its session log but drops them from live state, so a resumed log hashes
// differently. OpenCode keeps the error on the assistant message (`info.error`), and the
// flattener drops failed assistant messages before digesting, both when the checkpoint is
// created and when it is applied. The mismatch that recovery repairs cannot occur.
import { digestMessages } from "./context-document.ts";
import type { ContextEditTrace, LiveContextMessage } from "./types.ts";

export const PROJECTION_PREFIX_MISMATCH_REASON =
	"Raw context prefix no longer matches the projection checkpoint.";
export const PROJECTION_SOURCE_IDS_REASON =
	"Raw context prefix message ids no longer match the projection checkpoint (revert or compaction).";
export const PROJECTION_SHORTER_REASON = "Raw context is shorter than the projection source prefix.";

export type EstimateUnit = "characters" | "tokens";

/** One source message's content digest plus the write time captured with it. */
export interface SourceStamp {
	digest: string;
	updatedAt: number;
	/**
	 * Digest of the same message with OpenCode's `<system-reminder>` blocks removed
	 * (whitespace-normalized). OpenCode appends and removes mode-change reminders on user
	 * messages between requests without moving any write-time field; a change confined to
	 * those blocks is attributable against this fingerprint.
	 */
	strippedDigest?: string;
}

export interface ProjectionCheckpoint {
	version: 1;
	revision: number;
	/** Number of flattened raw messages the projection replaces. */
	sourceMessageCount: number;
	/** `ocMessageID` of each of those messages ("" when absent); length is sourceMessageCount. */
	sourceIds: string[];
	/** `digestSourcePrefix` of those messages. */
	sourceDigest: string;
	/**
	 * Per-message digest and captured write time (length is sourceMessageCount). Lets a
	 * mismatch be attributed to specific messages and a late OpenCode write of the tail be
	 * re-anchored instead of dropped; absent on checkpoints written by older versions.
	 */
	sourceStamps?: SourceStamp[];
	projectedMessages: LiveContextMessage[];
	beforeEstimate: number;
	afterEstimate: number;
	estimateUnit: EstimateUnit;
	createdAt: string;
	/** Provenance for the accepted edit that produced projectedMessages. */
	editTrace?: ContextEditTrace;
}

/** The trimmed anchor returned when a late tail rewrite was re-anchored instead of dropped. */
export interface ProjectionReanchor {
	sourceMessageCount: number;
	sourceIds: string[];
	sourceStamps: SourceStamp[];
	sourceDigest: string;
}

export type ProjectionApplication =
	| {
			valid: true;
			messages: LiveContextMessage[];
			suffix: LiveContextMessage[];
			/** Set when the anchor was trimmed to the stable head (see `reanchorTail`). */
			reanchor?: ProjectionReanchor;
	  }
	| {
			valid: false;
			messages: LiveContextMessage[];
			reason: string;
	  };

/** The OpenCode message id a flat message came from, or "" when it has none. */
export function sourceMessageId(message: LiveContextMessage): string {
	return typeof message.ocMessageID === "string" ? message.ocMessageID : "";
}

/** The prune-invariant form of one source message (see `digestSourcePrefix`). */
function sourceDigestForm(message: LiveContextMessage): LiveContextMessage {
	if (message.role !== "toolResult") return message;
	return {
		role: message.role,
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		isError: message.isError,
		ocMessageID: message.ocMessageID,
	};
}

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Whitespace-normalized text without OpenCode's reminder blocks, for the stripped fingerprint. */
function normalizeReminderFingerprint(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(SYSTEM_REMINDER_RE, "")
		.replace(/\n{2,}/g, "\n\n")
		.trim();
}

/**
 * The message with OpenCode's `<system-reminder>` blocks removed from its text parts; parts
 * that become empty are dropped. OpenCode appends and removes mode-change reminders on user
 * messages between requests without touching any write-time field, so a digest over this
 * form tells a reminder-only edit apart from a real content change.
 */
export function stripSystemReminders(message: LiveContextMessage): LiveContextMessage {
	const content = message.content;
	if (!Array.isArray(content)) return message;
	const stripped: unknown[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			stripped.push(part);
			continue;
		}
		const block = part as Record<string, unknown>;
		if (block.type !== "text" || typeof block.text !== "string") {
			stripped.push(block);
			continue;
		}
		const text = normalizeReminderFingerprint(block.text);
		if (text !== "") stripped.push({ ...block, text });
	}
	return { ...message, content: stripped };
}

/** `digestSourceMessage` of the message without OpenCode's system-reminder blocks. */
export function digestSourceMessageWithoutReminders(message: LiveContextMessage): string {
	return digestMessages([sourceDigestForm(stripSystemReminders(message))]);
}

/**
 * Digest a raw source prefix in a form OpenCode's prune cannot change: every `toolResult`
 * keeps only role, toolCallId, toolName, isError and ocMessageID. Content is dropped for
 * every tool result, not only cleared ones: the output is intact when the checkpoint is
 * created and may be cleared when it is validated.
 */
export function digestSourcePrefix(messages: readonly LiveContextMessage[]): string {
	return digestMessages(messages.map(sourceDigestForm));
}

/** `digestSourcePrefix` of one message: per-message attribution for tail re-anchoring. */
export function digestSourceMessage(message: LiveContextMessage): string {
	return digestMessages([sourceDigestForm(message)]);
}

/** A message's stamp: its content digest, the write time OpenCode last wrote, and the
 * reminder-stripped fingerprint. */
export function sourceStamp(message: LiveContextMessage): SourceStamp {
	return {
		digest: digestSourceMessage(message),
		updatedAt: typeof message.updatedAt === "number" ? message.updatedAt : 0,
		strippedDigest: digestSourceMessageWithoutReminders(message),
	};
}

/**
 * `digestSourcePrefix` without OpenCode message ids. `Session.fork` copies every message
 * under a new id, so the copied history digests the same way as the original.
 */
export function digestSourceContent(messages: readonly LiveContextMessage[]): string {
	return digestSourcePrefix(messages.map(({ ocMessageID: _id, ...rest }) => rest as LiveContextMessage));
}

export function createProjectionCheckpoint(options: {
	revision: number;
	sourceMessages: readonly LiveContextMessage[];
	projectedMessages: readonly LiveContextMessage[];
	beforeEstimate: number;
	afterEstimate: number;
	estimateUnit: EstimateUnit;
	createdAt?: string;
	editTrace?: ContextEditTrace;
}): ProjectionCheckpoint {
	const checkpoint: ProjectionCheckpoint = {
		version: 1,
		revision: options.revision,
		sourceMessageCount: options.sourceMessages.length,
		sourceIds: options.sourceMessages.map(sourceMessageId),
		sourceDigest: digestSourcePrefix(options.sourceMessages),
		sourceStamps: options.sourceMessages.map(sourceStamp),
		projectedMessages: [...options.projectedMessages],
		beforeEstimate: options.beforeEstimate,
		afterEstimate: options.afterEstimate,
		estimateUnit: options.estimateUnit,
		createdAt: options.createdAt ?? new Date().toISOString(),
	};
	if (options.editTrace) checkpoint.editTrace = options.editTrace;

	// Fail at creation rather than when state.json is written.
	JSON.stringify(checkpoint);
	return checkpoint;
}

/**
 * Replace the checkpoint's raw source prefix and keep every raw message appended after
 * it. A mismatch fails closed and returns a copy of the untouched raw context — unless the
 * checkpoint has per-message stamps and every changed message was written by OpenCode after
 * it was captured (the current turn's tail still being finalized): then the anchor is
 * trimmed to the stable head, the trimmed tail flows as ordinary suffix, and the caller
 * persists `reanchor` on the checkpoint.
 */
export function applyProjection(
	rawMessages: readonly LiveContextMessage[],
	checkpoint: ProjectionCheckpoint | undefined,
): ProjectionApplication {
	if (!checkpoint) return { valid: true, messages: [...rawMessages], suffix: [] };
	if (checkpoint.version !== 1) {
		return { valid: false, messages: [...rawMessages], reason: `Unsupported projection version: ${checkpoint.version}.` };
	}
	if (rawMessages.length < checkpoint.sourceMessageCount) {
		return { valid: false, messages: [...rawMessages], reason: PROJECTION_SHORTER_REASON };
	}
	const prefix = rawMessages.slice(0, checkpoint.sourceMessageCount);
	const ids = checkpoint.sourceIds;
	if (
		!Array.isArray(ids) ||
		ids.length !== prefix.length ||
		prefix.some((message, index) => sourceMessageId(message) !== ids[index])
	) {
		return { valid: false, messages: [...rawMessages], reason: PROJECTION_SOURCE_IDS_REASON };
	}
	if (digestSourcePrefix(prefix) !== checkpoint.sourceDigest) {
		return reanchorTail(rawMessages, prefix, checkpoint) ??
			{ valid: false, messages: [...rawMessages], reason: PROJECTION_PREFIX_MISMATCH_REASON };
	}
	const suffix = rawMessages.slice(checkpoint.sourceMessageCount);
	return { valid: true, messages: [...checkpoint.projectedMessages, ...suffix], suffix };
}

/**
 * A mismatch OpenCode itself caused. Every changed message must be explained by an
 * OpenCode write: either its write time (`time.completed`/`updated`, not `created`) moved
 * past the stamp, or the change is confined to OpenCode's `<system-reminder>` mode-change
 * blocks (verified against the reminder-stripped per-message digest). That is the tail of
 * the current turn still being finalized or a mode switch — not a revert, a compaction or
 * a foreign transform, which change ids or content in ways neither check explains and stay
 * fail-closed. The anchor is trimmed to the last stable message; the trimmed tail becomes
 * ordinary suffix, the same contract as pi-clm's rebasing for appended messages.
 */
function reanchorTail(
	rawMessages: readonly LiveContextMessage[],
	prefix: readonly LiveContextMessage[],
	checkpoint: ProjectionCheckpoint,
): ProjectionApplication | undefined {
	const stamps = checkpoint.sourceStamps;
	if (!Array.isArray(stamps) || stamps.length !== prefix.length) return undefined;
	const changed = prefix.map((message, index) => digestSourceMessage(message) !== stamps[index]!.digest);
	const first = changed.indexOf(true);
	if (first <= 0) return undefined;
	const attributable = prefix.every((message, index) => {
		if (!changed[index]) return true;
		const stamp = stamps[index]!;
		if (typeof message.updatedAt === "number" && message.updatedAt > stamp.updatedAt) return true;
		// OpenCode appends and removes `<system-reminder>` blocks (mode changes) on user
		// messages without moving any write time; a change confined to those blocks is still
		// an OpenCode edit. Everything else fails closed.
		return typeof stamp.strippedDigest === "string" && digestSourceMessageWithoutReminders(message) === stamp.strippedDigest;
	});
	if (!attributable) return undefined;
	const stable = prefix.slice(0, first);
	const reanchor: ProjectionReanchor = {
		sourceMessageCount: stable.length,
		sourceIds: stable.map(sourceMessageId),
		sourceStamps: stable.map(sourceStamp),
		sourceDigest: digestSourcePrefix(stable),
	};
	const suffix = rawMessages.slice(stable.length);
	return { valid: true, messages: [...checkpoint.projectedMessages, ...suffix], suffix, reanchor };
}
