// Adapted from pi-clm src/__tests__/projection.test.ts (MIT, Copyright 2026 Emanuel Casco).

import { describe, expect, test } from "bun:test";

import { digestMessages } from "../src/context-document.ts";
import {
	applyProjection,
	createProjectionCheckpoint,
	digestSourceMessage,
	digestSourcePrefix,
	PROJECTION_PREFIX_MISMATCH_REASON,
	PROJECTION_SOURCE_IDS_REASON,
	sourceStamp,
	type ProjectionCheckpoint,
} from "../src/projection.ts";
import type { LiveContextMessage } from "../src/types.ts";

// Flattened OpenCode messages, as opencode.ts produces them.
const raw: LiveContextMessage[] = [
	{ role: "user", content: "task", ocMessageID: "msg_1", timestamp: 1 },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "large investigation" },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { filePath: "a.ts" } },
		],
		ocMessageID: "msg_2",
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text", text: "tool output".repeat(100) }],
		isError: false,
		ocMessageID: "msg_2",
		timestamp: 2,
	},
];
const projected: LiveContextMessage[] = [
	raw[0]!,
	{ role: "custom", customType: "clm-note", content: "Investigation summary", timestamp: 2 },
];

function checkpoint(revision = 1): ProjectionCheckpoint {
	return createProjectionCheckpoint({
		revision,
		sourceMessages: raw,
		projectedMessages: projected,
		beforeEstimate: 1_200,
		afterEstimate: 30,
		estimateUnit: "tokens",
		createdAt: "2026-08-29T00:00:00.000Z",
	});
}

describe("projection checkpoint", () => {
	test("records revision, source count, ids and digest, projection, estimates and unit", () => {
		const created = checkpoint(3);
		expect(created).toEqual({
			version: 1,
			revision: 3,
			sourceMessageCount: 3,
			sourceIds: ["msg_1", "msg_2", "msg_2"],
			sourceDigest: digestSourcePrefix(raw),
			sourceStamps: raw.map(sourceStamp),
			projectedMessages: projected,
			beforeEstimate: 1_200,
			afterEstimate: 30,
			estimateUnit: "tokens",
			createdAt: "2026-08-29T00:00:00.000Z",
		});
		expect(created.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	test("copies the projected array and keeps the edit trace", () => {
		const editTrace = {
			version: 1 as const,
			sourceRevision: 0,
			sourceMessageCount: 3,
			outputMessageCount: 2,
			sources: [
				{ sourceIndex: 0, outputIndex: 0, kind: "kept" as const },
				{ sourceIndex: 1, kind: "removed" as const },
				{ sourceIndex: 2, kind: "removed" as const },
			],
			additions: [{ outputIndex: 1, kind: "added" as const }],
		};
		const input = [...projected];
		const created = createProjectionCheckpoint({
			revision: 1,
			sourceMessages: raw,
			projectedMessages: input,
			beforeEstimate: 10,
			afterEstimate: 5,
			estimateUnit: "characters",
			editTrace,
		});
		input.pop();
		expect(created.projectedMessages).toHaveLength(2);
		expect(created.editTrace).toEqual(editTrace);
		expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);
	});

	test("checkpoint creation verifies JSON serialization", () => {
		const created = checkpoint();
		expect(() => JSON.stringify(created)).not.toThrow();
		const cyclic: LiveContextMessage = { role: "user", content: "x" };
		cyclic.self = cyclic;
		expect(() =>
			createProjectionCheckpoint({
				revision: 1,
				sourceMessages: raw,
				projectedMessages: [cyclic],
				beforeEstimate: 1,
				afterEstimate: 1,
				estimateUnit: "tokens",
			}),
		).toThrow();
	});

	test("canonical message digests ignore object key order", () => {
		const left = [{ role: "user", content: "x", timestamp: 1 }];
		const right = [{ timestamp: 1, content: "x", role: "user" }];
		expect(digestMessages(left)).toBe(digestMessages(right));
	});

	test("the source digest ignores the updatedAt write marker", () => {
		const stamped = raw.map((message) => ({ ...message, updatedAt: 99 }));
		expect(digestSourcePrefix(stamped)).toBe(digestSourcePrefix(raw));
		expect(digestSourceMessage(stamped[1]!)).toBe(digestSourceMessage(raw[1]!));
	});

	test("the source digest ignores tool result content and nothing else", () => {
		const cleared = raw.map((message) => ({ ...message }));
		cleared[2] = { ...cleared[2]!, content: [{ type: "text", text: "[Old tool result content cleared]" }] };
		expect(digestSourcePrefix(cleared)).toBe(digestSourcePrefix(raw));
		expect(digestMessages(cleared)).not.toBe(digestMessages(raw));
		for (const key of ["toolCallId", "toolName", "isError", "ocMessageID"]) {
			const changed = raw.map((message) => ({ ...message }));
			changed[2] = { ...changed[2]!, [key]: "other" };
			expect(digestSourcePrefix(changed)).not.toBe(digestSourcePrefix(raw));
		}
		const assistant = raw.map((message) => ({ ...message }));
		assistant[1] = { ...assistant[1]!, content: [{ type: "text", text: "other" }] };
		expect(digestSourcePrefix(assistant)).not.toBe(digestSourcePrefix(raw));
	});

	test("a flat message without ocMessageID records an empty id", () => {
		const created = createProjectionCheckpoint({
			revision: 1,
			sourceMessages: [{ role: "user", content: "x" }],
			projectedMessages: [],
			beforeEstimate: 1,
			afterEstimate: 0,
			estimateUnit: "tokens",
		});
		expect(created.sourceIds).toEqual([""]);
		expect(applyProjection([{ role: "user", content: "x" }], created).valid).toBe(true);
	});

	test("the digest survives a JSON round trip (resume in another process)", () => {
		const created = checkpoint();
		const reloaded = JSON.parse(JSON.stringify(created)) as ProjectionCheckpoint;
		const rawReloaded = JSON.parse(JSON.stringify(raw)) as LiveContextMessage[];
		const result = applyProjection(rawReloaded, reloaded);
		expect(result.valid).toBe(true);
		expect(result.messages).toEqual(projected);
	});
});

describe("projection rebasing", () => {
	test("replaces the source prefix and appends the raw suffix", () => {
		const suffix: LiveContextMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "new turn" }], ocMessageID: "msg_3", timestamp: 4 },
			{ role: "user", content: "new result", ocMessageID: "msg_4", timestamp: 5 },
		];
		const result = applyProjection([...raw, ...suffix], checkpoint());
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(result.messages).toEqual([...projected, ...suffix]);
		expect(result.suffix).toEqual(suffix);
	});

	test("an exact-length raw context yields the projection and an empty suffix", () => {
		const result = applyProjection(raw, checkpoint());
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(result.messages).toEqual(projected);
		expect(result.suffix).toEqual([]);
	});

	test("fails closed when the raw prefix changed", () => {
		const changed = raw.map((message) => ({ ...message }));
		changed[1] = { ...changed[1]!, content: "changed outside projection" };
		const result = applyProjection(changed, checkpoint());
		expect(result.valid).toBe(false);
		expect(result.messages).toEqual(changed);
		expect(result.messages).not.toBe(changed);
		expect(result.valid ? "" : result.reason).toBe(PROJECTION_PREFIX_MISMATCH_REASON);
	});

	test("survives OpenCode's prune clearing an old tool output in the prefix", () => {
		const suffix: LiveContextMessage = { role: "user", content: "next", ocMessageID: "msg_3", timestamp: 3 };
		const pruned = raw.map((message) => ({ ...message }));
		pruned[2] = { ...pruned[2]!, content: [{ type: "text", text: "[Old tool result content cleared]" }] };
		const result = applyProjection([...pruned, suffix], checkpoint());
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(result.messages).toEqual([...projected, suffix]);
	});

	test("fails closed when a prefix message was replaced by another id (revert, then a new turn)", () => {
		const reverted = [...raw.slice(0, 2), { ...raw[2]!, ocMessageID: "msg_9" }];
		const result = applyProjection(reverted, checkpoint());
		expect(result.valid).toBe(false);
		expect(result.valid ? "" : result.reason).toBe(PROJECTION_SOURCE_IDS_REASON);
	});

	test("fails closed on a part-level revert that keeps the message id", () => {
		// Revert with a partID truncates the parts of msg_2: its toolCall and toolResult go,
		// and a later turn appends a new message under msg_2's flat count.
		const truncated: LiveContextMessage[] = [
			raw[0]!,
			{ ...raw[1]!, content: [{ type: "text", text: "large investigation" }] },
			{ role: "user", content: "after revert", ocMessageID: "msg_2", timestamp: 3 },
		];
		const result = applyProjection(truncated, checkpoint());
		expect(result.valid).toBe(false);
		expect(result.valid ? "" : result.reason).toBe(PROJECTION_PREFIX_MISMATCH_REASON);
	});

	test("fails closed on a checkpoint whose sourceIds length disagrees", () => {
		const broken = { ...checkpoint(), sourceIds: ["msg_1"] };
		const result = applyProjection(raw, broken);
		expect(result.valid ? "" : result.reason).toBe(PROJECTION_SOURCE_IDS_REASON);
	});

	test("fails closed when the raw context is shorter than the anchor", () => {
		const result = applyProjection(raw.slice(0, 1), checkpoint());
		expect(result.valid).toBe(false);
		expect(result.valid ? "" : result.reason).toMatch(/shorter/);
	});

	test("fails closed on an unknown checkpoint version", () => {
		const foreign = { ...checkpoint(), version: 2 } as unknown as ProjectionCheckpoint;
		const result = applyProjection(raw, foreign);
		expect(result.valid).toBe(false);
		expect(result.valid ? "" : result.reason).toMatch(/version/);
	});

	test("no checkpoint returns a defensive top-level copy", () => {
		const result = applyProjection(raw, undefined);
		expect(result.valid).toBe(true);
		expect(result.messages).not.toBe(raw);
		expect(result.messages).toEqual(raw);
	});

	test("an empty source prefix prepends the projection to all raw messages", () => {
		const empty = createProjectionCheckpoint({
			revision: 1,
			sourceMessages: [],
			projectedMessages: [{ role: "custom", customType: "clm-note", content: "note" }],
			beforeEstimate: 0,
			afterEstimate: 1,
			estimateUnit: "tokens",
		});
		const result = applyProjection(raw, empty);
		expect(result.valid).toBe(true);
		expect(result.messages).toHaveLength(raw.length + 1);
	});
});

describe("tail re-anchoring", () => {
	const at = Date.parse("2026-08-29T00:00:00.000Z");
	const stamped: LiveContextMessage[] = [
		{ role: "user", content: "task", ocMessageID: "msg_1", timestamp: 1, updatedAt: at - 10_000 },
		{ role: "assistant", content: [{ type: "text", text: "still streaming" }], ocMessageID: "msg_2", timestamp: 2, updatedAt: at - 10_000 },
	];

	function stampedCheckpoint(): ProjectionCheckpoint {
		return createProjectionCheckpoint({
			revision: 1,
			sourceMessages: stamped,
			projectedMessages: [stamped[0]!, { role: "custom", customType: "clm-note", content: "summary" }],
			beforeEstimate: 100,
			afterEstimate: 10,
			estimateUnit: "tokens",
			createdAt: "2026-08-29T00:00:00.000Z",
		});
	}

	test("re-anchors to the stable head when the changed tail message was written after the checkpoint", () => {
		const finalized: LiveContextMessage = { ...stamped[1]!, content: [{ type: "text", text: "finalized" }], updatedAt: at + 20_000 };
		const next: LiveContextMessage = { role: "user", content: "next turn", ocMessageID: "msg_3", timestamp: 3, updatedAt: at + 30_000 };
		const result = applyProjection([stamped[0]!, finalized, next], stampedCheckpoint());
		expect(result.valid).toBe(true);
		if (!result.valid) return;
		expect(result.reanchor).toEqual({
			sourceMessageCount: 1,
			sourceIds: ["msg_1"],
			sourceStamps: [sourceStamp(stamped[0]!)],
			sourceDigest: digestSourcePrefix([stamped[0]!]),
		});
		expect(result.messages).toEqual([...stampedCheckpoint().projectedMessages, finalized, next]);
		expect(result.suffix).toEqual([finalized, next]);
	});

	test("a re-anchored checkpoint validates against the same history on the next request", () => {
		const finalized: LiveContextMessage = { ...stamped[1]!, content: [{ type: "text", text: "finalized" }], updatedAt: at + 20_000 };
		const context = [stamped[0]!, finalized];
		const result = applyProjection(context, stampedCheckpoint());
		if (!result.valid || !result.reanchor) throw new Error("expected a re-anchor");
		const trimmed = { ...stampedCheckpoint(), ...result.reanchor };
		const again = applyProjection(context, trimmed);
		expect(again.valid).toBe(true);
		if (!again.valid) return;
		expect(again.reanchor).toBeUndefined();
		expect(again.messages).toEqual(result.messages);
	});

	test("fails closed when the changed message was not written after the checkpoint", () => {
		const edited: LiveContextMessage = { ...stamped[1]!, content: [{ type: "text", text: "changed in place" }] };
		const result = applyProjection([stamped[0]!, edited], stampedCheckpoint());
		expect(result.valid).toBe(false);
		expect(result.valid ? "" : result.reason).toBe(PROJECTION_PREFIX_MISMATCH_REASON);
	});

	test("fails closed when the first source message changed", () => {
		const head: LiveContextMessage = { ...stamped[0]!, content: "changed head", updatedAt: at + 20_000 };
		const result = applyProjection([head, stamped[1]!], stampedCheckpoint());
		expect(result.valid).toBe(false);
		expect(result.valid ? "" : result.reason).toBe(PROJECTION_PREFIX_MISMATCH_REASON);
	});

	test("fails closed without per-message stamps (a checkpoint from an older version)", () => {
		const older = stampedCheckpoint();
		delete older.sourceStamps;
		const finalized: LiveContextMessage = { ...stamped[1]!, content: [{ type: "text", text: "finalized" }], updatedAt: at + 20_000 };
		const result = applyProjection([stamped[0]!, finalized], older);
		expect(result.valid).toBe(false);
		expect(result.valid ? "" : result.reason).toBe(PROJECTION_PREFIX_MISMATCH_REASON);
	});
});
