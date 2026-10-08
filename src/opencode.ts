/**
 * Conversion between OpenCode's `{ info, parts }` messages (as delivered to
 * `experimental.chat.messages.transform`) and the flat message list the core
 * (context-document.ts, projection.ts, observation.ts, overflow.ts) works on.
 *
 * Takes the place of pi-clm's identity cast between AgentMessage and LiveContextMessage
 * (pi-clm src/index.ts, MIT, Copyright 2026 Emanuel Casco): Pi already stores pi-shaped
 * messages, OpenCode does not.
 *
 * Shape. OpenCode keeps a tool call and its result in one `tool` part of an assistant
 * message. The core expects an assistant message carrying `toolCall` blocks followed by one
 * `toolResult` message per call, so `flatten` splits every assistant message that way and
 * each tool result becomes its own mirror block. Every flat message carries `ocMessageID`,
 * the OpenCode message it came from (projection checkpoints store these as `sourceIds`).
 *
 * Fidelity. `flatten` follows OpenCode 1.18.34 `MessageV2.toModelMessagesEffect`:
 * - a message without parts is skipped;
 * - a failed assistant message (`info.error`) is skipped unless the error is
 *   `MessageAbortedError` and some part is neither `step-start` nor `reasoning`;
 * - user text parts that are `ignored` or empty are skipped; `text/plain` and directory file
 *   parts are skipped (OpenCode inlines their content as synthetic text parts); a
 *   `compaction` part reads "What did we do so far?" and a `subtask` part "The following
 *   tool was executed by the user" (OpenCode's own strings);
 * - a completed tool sends its output, or "[Old tool result content cleared]" once
 *   OpenCode's prune set `time.compacted`; an error sends its error text, or the partial
 *   output of an interrupted call; a pending or running call sends
 *   "[Tool execution was interrupted]".
 * Flattening never depends on settings: the projection digest is computed from it, and a
 * settings toggle must not discard an accepted revision. Reasoning is always flattened;
 * `withoutReasoning` hides it from the mirror view only. Every flat message carries
 * `updatedAt` (`info.time.updated`, else `completed`, else `created`), OpenCode's in-place
 * write marker: digests exclude it (`canonicalMessage`), and the projection reads it only to
 * re-anchor a late rewrite of the tail instead of dropping the revision (projection.ts).
 *
 * Known gap: an assistant message whose only sendable parts are empty text parts has no
 * flat form and is left out of the request. OpenCode sends it as an empty assistant turn.
 *
 * Identity rule for `unflatten`: a block the model did not touch maps back to the current
 * raw OpenCode object (looked up by `ocMessageID` and call id), so untouched messages reach
 * the provider exactly as OpenCode would send them. Only edited user and assistant bodies,
 * tool results flagged `edited`, `withheld` or `capped`, and notes are synthesized. One
 * exception: an untouched result that OpenCode's prune cleared while the flat text kept the
 * full output (inside an accepted revision) is sent with the flat text.
 */
import { createHash } from "node:crypto";

import { NOTE_TYPE, renderMessage } from "./context-document.ts";
import type { LiveContextMessage } from "./types.ts";

// Loose structural types: assignable from @opencode-ai/sdk `Message` / `Part`, which this
// module does not import at runtime (the plugin package is an optional peer dependency).
export type OcPart = { id: string; type: string; [key: string]: any };
export type OcInfo = { id: string; sessionID: string; role: "user" | "assistant"; [key: string]: any };
export interface OcMessage {
	info: OcInfo;
	parts: OcPart[];
}

/** OpenCode's own placeholder texts (packages/opencode/src/session/message-v2.ts). */
export const INTERRUPTED_TOOL_TEXT = "[Tool execution was interrupted]";
export const CLEARED_TOOL_TEXT = "[Old tool result content cleared]";
export const COMPACTION_USER_TEXT = "What did we do so far?";
export const SUBTASK_USER_TEXT = "The following tool was executed by the user";

/** Placeholder for an assistant message whose only content is hidden reasoning. */
export const REASONING_HIDDEN_TEXT = "[reasoning not shown in the mirror]";

/** The text OpenCode sends as the result of one tool part, and whether it is an error. */
export function toolPartOutput(part: OcPart): { text: string; isError: boolean } {
	const state = part.state ?? {};
	switch (state.status) {
		case "completed":
			return { text: state.time?.compacted ? CLEARED_TOOL_TEXT : String(state.output ?? ""), isError: false };
		case "error": {
			const partial = state.metadata?.interrupted === true ? state.metadata.output : undefined;
			if (typeof partial === "string") return { text: partial, isError: false };
			return { text: String(state.error ?? ""), isError: true };
		}
		default:
			return { text: INTERRUPTED_TOOL_TEXT, isError: true };
	}
}

/** OpenCode drops failed assistant messages, except aborted ones with real content. */
export function sentToModel(message: OcMessage): boolean {
	if (message.parts.length === 0) return false;
	const error = message.info.role === "assistant" ? message.info.error : undefined;
	if (!error) return true;
	return error.name === "MessageAbortedError" &&
		message.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning");
}

function fileBlock(mime: string, filename: unknown): Record<string, unknown> {
	if (mime.startsWith("image/")) return { type: "image", mimeType: mime };
	return { type: "text", text: `[file ${mime}: ${typeof filename === "string" && filename ? filename : "file"}]` };
}

function userContent(message: OcMessage): Record<string, unknown>[] {
	const content: Record<string, unknown>[] = [];
	for (const part of message.parts) {
		if (part.type === "text" && !part.ignored && part.text !== "") content.push({ type: "text", text: String(part.text ?? "") });
		else if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
			content.push(fileBlock(String(part.mime ?? "application/octet-stream"), part.filename));
		} else if (part.type === "compaction") content.push({ type: "text", text: COMPACTION_USER_TEXT });
		else if (part.type === "subtask") content.push({ type: "text", text: SUBTASK_USER_TEXT });
	}
	return content;
}

function toolResultContent(part: OcPart, text: string): Record<string, unknown>[] {
	const content: Record<string, unknown>[] = [{ type: "text", text }];
	const state = part.state ?? {};
	if (state.status === "completed" && !state.time?.compacted && Array.isArray(state.attachments)) {
		for (const attachment of state.attachments) {
			if (attachment && typeof attachment.mime === "string") content.push(fileBlock(attachment.mime, attachment.filename));
		}
	}
	return content;
}

/**
 * OpenCode messages → flat messages, each tagged with `ocMessageID`. Deterministic and
 * independent of settings, so the same stored history always digests the same way.
 */
export function flatten(messages: readonly OcMessage[]): LiveContextMessage[] {
	const out: LiveContextMessage[] = [];
	for (const message of messages) {
		if (!sentToModel(message)) continue;
		const id = message.info.id;
		const timestamp = Number(message.info.time?.created ?? 0);
		// OpenCode writes `completed` (and, on some hosts, `updated`); both move when a message
		// is written in place, `created` does not.
		const updatedAt = Number(message.info.time?.updated ?? message.info.time?.completed ?? message.info.time?.created ?? 0);
		if (message.info.role === "user") {
			const content = userContent(message);
			if (content.length > 0) out.push({ role: "user", content, ocMessageID: id, timestamp, updatedAt });
			continue;
		}
		const content: Record<string, unknown>[] = [];
		const results: LiveContextMessage[] = [];
		for (const part of message.parts) {
			if (part.type === "text" && part.text) content.push({ type: "text", text: String(part.text) });
			else if (part.type === "reasoning" && String(part.text ?? "").trim()) {
				content.push({ type: "thinking", thinking: String(part.text) });
			} else if (part.type === "tool") {
				content.push({ type: "toolCall", id: part.callID, name: part.tool, arguments: part.state?.input ?? {} });
				const output = toolPartOutput(part);
				results.push({
					role: "toolResult",
					toolCallId: part.callID,
					toolName: part.tool,
					content: toolResultContent(part, output.text),
					isError: output.isError,
					ocMessageID: id,
					timestamp,
					updatedAt,
				});
			}
		}
		if (content.length === 0) continue;
		out.push({ role: "assistant", content, ocMessageID: id, timestamp, updatedAt });
		out.push(...results);
	}
	return out;
}

const hiddenReasoning = new WeakMap<LiveContextMessage, LiveContextMessage>();

/**
 * Mirror view without reasoning (`reasoning: false`). Assistant messages lose their
 * `thinking` blocks; one with nothing else keeps a short placeholder, so its block is not
 * empty (an empty body deletes the block). One-to-one, so projection indexes still hold.
 * Unflatten maps untouched assistant blocks back to the raw message, reasoning included.
 */
export function withoutReasoning(messages: LiveContextMessage[]): LiveContextMessage[] {
	let changed = false;
	const output = messages.map((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
		const cached = hiddenReasoning.get(message);
		if (cached) {
			changed ||= cached !== message;
			return cached;
		}
		const content = message.content.filter((part) => !(part && typeof part === "object" && (part as { type?: unknown }).type === "thinking"));
		let next = message;
		if (content.length !== message.content.length) {
			next = { ...message, content: content.length > 0 ? content : [{ type: "text", text: REASONING_HIDDEN_TEXT }] };
			changed = true;
		}
		hiddenReasoning.set(message, next);
		return next;
	});
	return changed ? output : messages;
}

function textOf(message: LiveContextMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => Boolean(part) && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export interface UnflattenContext {
	sessionID: string;
	/** Current raw messages by id. */
	rawById: Map<string, OcMessage>;
	/** Info whose agent and model synthetic user messages copy (the newest user message). */
	template?: OcInfo;
}

/** A synthetic user message carrying text: notes, notices, continuity, orphaned results. */
export function noteMessage(text: string, seed: string, context: UnflattenContext, created = Date.now()): OcMessage {
	const hash = shortHash(`${seed}\n${text}`);
	const messageID = `msg_clm${hash}`;
	return {
		info: {
			id: messageID,
			sessionID: context.sessionID,
			role: "user",
			time: { created },
			agent: context.template?.agent ?? "build",
			model: context.template?.model ?? { providerID: "", modelID: "" },
		},
		parts: [{ id: `prt_clm${hash}`, sessionID: context.sessionID, messageID, type: "text", text, synthetic: true }],
	};
}

function textPart(message: OcMessage, text: string, kind: string): OcPart {
	return {
		id: `prt_clm${shortHash(`${message.info.id}:${kind}:${text}`)}`,
		sessionID: message.info.sessionID,
		messageID: message.info.id,
		type: "text",
		text,
		synthetic: true,
	};
}

/**
 * A tool part with its output replaced: the call keeps its pairing, only the result text
 * changes. A capped result keeps its attachments; an edited or withheld one drops them.
 */
function withOutput(part: OcPart, result: LiveContextMessage, output = textOf(result)): OcPart {
	const state = part.state ?? {};
	const start = Number(state.time?.start ?? 0);
	const keepAttachments = result.edited !== true && result.withheld !== true;
	return {
		...part,
		state: {
			status: "completed",
			input: state.input ?? {},
			output,
			title: typeof state.title === "string" ? state.title : "",
			metadata: state.metadata ?? {},
			time: { start, end: Number(state.time?.end ?? start) },
			...(keepAttachments && Array.isArray(state.attachments) ? { attachments: state.attachments } : {}),
		},
	};
}

function rewritten(result: LiveContextMessage): boolean {
	return result.edited === true || result.withheld === true || result.capped === true;
}

/** The tool output text of a flat result: its first block (attachments follow it). */
function resultOutput(result: LiveContextMessage): string | undefined {
	const first = Array.isArray(result.content) ? (result.content[0] as { type?: unknown; text?: unknown } | undefined) : undefined;
	return first?.type === "text" && typeof first.text === "string" ? first.text : undefined;
}

/**
 * The tool part to send for an untouched result. A part OpenCode's prune cleared after a
 * revision stored its full text is sent with the flat text, so the request matches the
 * mirror and the estimate. Other changes to a stored output pass through as OpenCode sends them.
 */
function restored(part: OcPart, result: LiveContextMessage): OcPart {
	if (part.state?.status !== "completed" || !part.state.time?.compacted) return part;
	const output = resultOutput(result);
	if (output === undefined || output === toolPartOutput(part).text) return part;
	return withOutput(part, result, output);
}

/**
 * Flat messages → OpenCode messages. Expects legal tool groups (applyContextDocument
 * repairs them): a kept assistant is followed by the results of all its calls. Anything
 * that cannot be mapped back to a raw message becomes a synthetic user note.
 */
export function unflatten(messages: readonly LiveContextMessage[], context: UnflattenContext): OcMessage[] {
	const out: OcMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		const id = typeof message.ocMessageID === "string" ? message.ocMessageID : undefined;
		const raw = id ? context.rawById.get(id) : undefined;
		if (raw && raw.info.role === "user" && message.role === "user") {
			out.push(message.edited ? { info: raw.info, parts: [textPart(raw, textOf(message), "user")] } : raw);
			continue;
		}
		if (raw && raw.info.role === "assistant" && message.role === "assistant") {
			const results = new Map<string, LiveContextMessage>();
			while (
				index + 1 < messages.length &&
				messages[index + 1]!.role === "toolResult" &&
				messages[index + 1]!.ocMessageID === id
			) {
				const result = messages[++index]!;
				results.set(String(result.toolCallId), result);
			}
			if (message.edited) {
				out.push({ info: raw.info, parts: [textPart(raw, textOf(message), "assistant")] });
				for (const result of results.values()) {
					out.push(noteMessage(renderMessage(result), `orphan:${id}:${String(result.toolCallId)}`, context));
				}
				continue;
			}
			const parts = raw.parts.flatMap((part) => {
				if (part.type !== "tool") return [part];
				const result = results.get(String(part.callID));
				if (!result) return [];
				return [rewritten(result) ? withOutput(part, result) : restored(part, result)];
			});
			const untouched = parts.length === raw.parts.length && parts.every((part, at) => part === raw.parts[at]);
			out.push(untouched ? raw : { info: raw.info, parts });
			continue;
		}
		// Notes the model wrote, bodies whose role changed, results whose call was removed,
		// and anything whose raw source is gone: plain synthetic user text.
		const text = message.role === "custom" && message.customType === NOTE_TYPE ? textOf(message) : renderMessage(message);
		if (text.trim()) {
			const created = typeof message.timestamp === "number" && message.timestamp > 0 ? message.timestamp : Date.now();
			out.push(noteMessage(text, `${index}:${id ?? ""}`, context, created));
		}
	}
	return out;
}

/** Replace the contents of OpenCode's message array in place (the hook's output object). */
export function replaceInPlace(target: OcMessage[], next: readonly OcMessage[]): void {
	target.splice(0, target.length, ...next);
}

/**
 * The part of a stored history OpenCode sends to the model: port of OpenCode 1.18.34
 * `MessageV2.filterCompacted` (packages/opencode/src/session/message-v2.ts:525-576), which
 * the prompt loop applies to the stored stream (session/prompt.ts:1092). `client.session.messages`
 * returns the full history, oldest first (no filter); OpenCode's `stream` walks it newest
 * first, so this walks `messages` backwards. After a completed compaction the result is
 * [compaction user message, summary, retained tail (`tail_start_id`), newer messages];
 * without one it is `messages` unchanged.
 */
export function filterCompacted(messages: readonly OcMessage[]): OcMessage[] {
	const result: OcMessage[] = [];
	const completed = new Set<string>();
	let retain: string | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		result.push(message);
		if (retain) {
			if (message.info.id === retain) break;
			continue;
		}
		if (message.info.role === "user" && completed.has(message.info.id)) {
			const part = message.parts.find((item) => item.type === "compaction");
			if (!part) continue;
			if (!part.tail_start_id) break;
			retain = String(part.tail_start_id);
			if (message.info.id === retain) break;
			continue;
		}
		if (message.info.role === "assistant" && message.info.summary && message.info.finish && !message.info.error) {
			completed.add(message.info.parentID);
		}
	}
	result.reverse();
	const isTailCompaction = (item: OcPart) => item.type === "compaction" && item.tail_start_id !== undefined;
	let compactionIndex = -1;
	for (let i = result.length - 1; i >= 0; i--) {
		const message = result[i]!;
		if (message.info.role === "user" && message.parts.some(isTailCompaction)) {
			compactionIndex = i;
			break;
		}
	}
	const compaction = result[compactionIndex];
	const part = compaction?.parts.find(isTailCompaction);
	const summaryIndex = compaction
		? result.findIndex((message, index) =>
			index > compactionIndex && message.info.role === "assistant" && message.info.summary && message.info.parentID === compaction.info.id)
		: -1;
	const tailIndex = part?.tail_start_id ? result.findIndex((message) => message.info.id === part.tail_start_id) : -1;
	if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
		return [
			...result.slice(compactionIndex, summaryIndex + 1),
			...result.slice(tailIndex, compactionIndex),
			...result.slice(summaryIndex + 1),
		];
	}
	return result;
}
