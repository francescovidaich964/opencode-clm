import { describe, expect, test } from "bun:test";

import { digestSourcePrefix } from "../src/projection.ts";
import {
	CLEARED_TOOL_TEXT,
	COMPACTION_USER_TEXT,
	flatten,
	INTERRUPTED_TOOL_TEXT,
	noteMessage,
	REASONING_HIDDEN_TEXT,
	replaceInPlace,
	sentToModel,
	unflatten,
	withoutReasoning,
	type OcMessage,
} from "../src/opencode.ts";
import { assistant, conversation, part, SESSION, toolOutput, user } from "./fixtures.ts";

function context(raw: OcMessage[]) {
	return { sessionID: SESSION, rawById: new Map(raw.map((message) => [message.info.id, message])), template: raw[0]!.info };
}

describe("flatten", () => {
	test("splits tool parts into toolCall blocks and toolResult messages tagged with the message id", () => {
		const flat = flatten(conversation("abc"));
		expect(flat.map((message) => [message.role, message.ocMessageID])).toEqual([
			["user", "msg_u1"],
			["assistant", "msg_a1"],
			["toolResult", "msg_a1"],
			["toolResult", "msg_a1"],
			["assistant", "msg_a2"],
		]);
		expect(flat[1]!.content).toEqual([
			{ type: "text", text: "Looking at files." },
			{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "cmd call_1" } },
			{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "cmd call_2" } },
		]);
		expect(flat[2]).toMatchObject({ toolCallId: "call_1", toolName: "bash", isError: false, content: [{ type: "text", text: "big output\nabc" }] });
	});

	test("drops failed assistant messages as OpenCode's toModelMessages does", () => {
		const failed = assistant("msg_f", "partial");
		failed.info.error = { name: "APIError", data: { message: "boom", isRetryable: true } };
		const abortedWithText = assistant("msg_ab", "half an answer");
		abortedWithText.info.error = { name: "MessageAbortedError", data: { message: "aborted" } };
		const abortedReasoningOnly = assistant("msg_ar", "");
		abortedReasoningOnly.parts.push(part("msg_ar", { type: "reasoning", text: "thinking", time: { start: 1 } }));
		abortedReasoningOnly.info.error = { name: "MessageAbortedError", data: { message: "aborted" } };
		const empty: OcMessage = { info: { ...assistant("msg_e", "").info }, parts: [] };
		expect([failed, abortedWithText, abortedReasoningOnly, empty].map(sentToModel)).toEqual([false, true, false, false]);
		const ids = flatten([user("msg_u1", "task"), failed, abortedWithText, abortedReasoningOnly, empty]).map((message) => message.ocMessageID);
		expect(ids).toEqual(["msg_u1", "msg_ab"]);
	});

	test("user parts follow OpenCode: ignored and empty text skipped, compaction and subtask texts", () => {
		const message: OcMessage = {
			info: user("msg_u", "").info,
			parts: [
				part("msg_u", { type: "text", text: "kept" }),
				part("msg_u", { type: "text", text: "hidden", ignored: true }),
				part("msg_u", { type: "text", text: "" }),
				part("msg_u", { type: "file", mime: "text/plain", url: "file:///a", filename: "a.txt" }),
				part("msg_u", { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "p.png" }),
				part("msg_u", { type: "compaction", auto: true }),
				part("msg_u", { type: "subtask", prompt: "p", description: "d", agent: "a" }),
			],
		};
		const [flat] = flatten([message]);
		expect(flat!.content).toEqual([
			{ type: "text", text: "kept" },
			{ type: "image", mimeType: "image/png" },
			{ type: "text", text: COMPACTION_USER_TEXT },
			{ type: "text", text: "The following tool was executed by the user" },
		]);
		expect(JSON.stringify(flat)).not.toContain("base64");
	});

	test("tool states: pruned, error, interrupted with partial output, pending", () => {
		const message = assistant("msg_a", "", [
			{ callID: "c1", output: "old" },
			{ callID: "c2", output: "" },
			{ callID: "c3", output: "" },
			{ callID: "c4", output: "" },
		]);
		const tools = message.parts.filter((candidate) => candidate.type === "tool");
		tools[0]!.state.time.compacted = 5;
		tools[1]!.state = { status: "error", input: {}, error: "bad input", time: { start: 1, end: 2 } };
		tools[2]!.state = { status: "error", input: {}, error: "aborted", metadata: { interrupted: true, output: "partial" }, time: { start: 1, end: 2 } };
		tools[3]!.state = { status: "running", input: {}, time: { start: 1 } };
		const results = flatten([message]).filter((flat) => flat.role === "toolResult");
		expect(results.map((result) => [(result.content as Array<{ text: string }>)[0]!.text, result.isError])).toEqual([
			[CLEARED_TOOL_TEXT, false],
			["bad input", true],
			["partial", false],
			[INTERRUPTED_TOOL_TEXT, true],
		]);
	});

	test("reasoning is always flattened; withoutReasoning hides it one-to-one", () => {
		const message = assistant("msg_a", "answer");
		message.parts.splice(1, 0, part("msg_a", { type: "reasoning", text: "because", time: { start: 1 } }));
		const only = assistant("msg_r", "");
		only.parts.push(part("msg_r", { type: "reasoning", text: "just thinking", time: { start: 1 } }));
		const flat = flatten([message, only]);
		expect(flat[0]!.content).toEqual([{ type: "thinking", thinking: "because" }, { type: "text", text: "answer" }]);
		const view = withoutReasoning(flat);
		expect(view).toHaveLength(flat.length);
		expect(view[0]!.content).toEqual([{ type: "text", text: "answer" }]);
		expect(view[1]!.content).toEqual([{ type: "text", text: REASONING_HIDDEN_TEXT }]);
		expect(withoutReasoning(flat)[0]).toBe(view[0]!); // cached per source
		// The digest input never depends on the view.
		expect(digestSourcePrefix(flatten([message, only]))).toBe(digestSourcePrefix(flat));
	});

	test("flat messages carry the updatedAt write marker, falling back to created", () => {
		const raw = conversation();
		raw[0]!.info.time = { created: 111, updated: 222 };
		const flat = flatten(raw);
		expect(flat.find((message) => message.ocMessageID === "msg_u1")!.updatedAt).toBe(222);
		// The assistant fixture has only `created`, so updatedAt falls back to it.
		expect(flat.find((message) => message.ocMessageID === "msg_a1")!.updatedAt).toBe(2);
	});
});

describe("unflatten", () => {
	test("untouched blocks map back to the raw objects", () => {
		const raw = conversation();
		const out = unflatten(flatten(raw.slice(1)), context(raw));
		expect(out).toHaveLength(2);
		expect(out[0]).toBe(raw[1]!);
		expect(out[1]).toBe(raw[2]!);
	});

	test("writes back tool results flagged edited, withheld or capped; the tool call stays", () => {
		const raw = conversation();
		const flat = flatten(raw.slice(1));
		flat[1] = { ...flat[1]!, content: [{ type: "text", text: "edited" }], edited: true };
		flat[2] = { ...flat[2]!, content: [{ type: "text", text: "held" }], withheld: true };
		const out = unflatten(flat, context(raw));
		expect(out[0]).not.toBe(raw[1]!);
		expect(out[0]!.info).toBe(raw[1]!.info);
		expect(toolOutput(out[0], "call_1")).toBe("edited");
		expect(toolOutput(out[0], "call_2")).toBe("held");
		expect(out[0]!.parts.find((candidate) => candidate.callID === "call_1")!.state.status).toBe("completed");
		expect(toolOutput(raw[1], "call_1")).toStartWith("big output"); // raw untouched
		const capped = flatten(raw.slice(1));
		capped[1] = { ...capped[1]!, content: [{ type: "text", text: "cut" }], capped: true };
		expect(toolOutput(unflatten(capped, context(raw))[0], "call_1")).toBe("cut");
		// A changed result without a flag is not written back.
		const unflagged = flatten(raw.slice(1));
		unflagged[1] = { ...unflagged[1]!, content: [{ type: "text", text: "silent" }] };
		expect(unflatten(unflagged, context(raw))[0]).toBe(raw[1]!);
	});

	test("a pruned result whose flat text kept the full output is sent with that text", () => {
		const raw = conversation();
		const flat = flatten(raw.slice(1)); // as a checkpoint stored it, before the prune
		const pruned = structuredClone(raw);
		pruned[1]!.parts.find((candidate) => candidate.callID === "call_1")!.state.time.compacted = 5;
		const sent = unflatten(flat, context(pruned))[0]!.parts.find((candidate) => candidate.callID === "call_1")!;
		expect(sent.state.output).toStartWith("big output");
		expect(sent.state.time.compacted).toBeUndefined();
		// Flat text that is itself the placeholder (pruned before the checkpoint) leaves the raw part.
		expect(unflatten(flatten(pruned.slice(1)), context(pruned))[0]).toBe(pruned[1]!);
	});

	test("an edited assistant becomes text only; notes become synthetic user messages", () => {
		const raw = conversation();
		const out = unflatten(
			[
				{ role: "assistant", content: [{ type: "text", text: "short" }], edited: true, ocMessageID: "msg_a2" },
				{ role: "custom", customType: "clm-note", content: "[context role=notes]\nremember x", timestamp: 9 },
			],
			context(raw),
		);
		expect(out[0]!.info).toBe(raw[2]!.info);
		expect(out[0]!.parts).toHaveLength(1);
		expect(out[0]!.parts[0]).toMatchObject({ type: "text", text: "short", synthetic: true });
		expect(out[1]!.info.role).toBe("user");
		expect(out[1]!.info.model).toEqual({ providerID: "p", modelID: "m" });
		expect(out[1]!.parts[0]!.text).toBe("[context role=notes]\nremember x");
	});

	test("note ids are deterministic and replaceInPlace keeps the array object", () => {
		const raw = conversation();
		expect(noteMessage("a", "s", context(raw), 1)).toEqual(noteMessage("a", "s", context(raw), 1));
		const target = [...raw];
		const same = target;
		replaceInPlace(target, [raw[0]!]);
		expect(same).toBe(target);
		expect(target).toEqual([raw[0]!]);
	});
});
