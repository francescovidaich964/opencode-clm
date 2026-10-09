// Tests for src/state.ts (adapted from pi-clm src/state.ts, MIT, Copyright 2026 Emanuel Casco).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProjectionCheckpoint } from "../src/projection.ts";
import {
	initialLiveContextState,
	isLiveContextState,
	isProjectionCheckpoint,
	loadLiveContextState,
	resetProjectionState,
	saveLiveContextState,
	STATE_FILE,
	statePath,
	type LiveContextState,
} from "../src/state.ts";
import type { LiveContextMessage } from "../src/types.ts";

const raw: LiveContextMessage[] = [
	{ role: "user", content: "task", ocMessageID: "msg_1", timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "long answer".repeat(50) }], ocMessageID: "msg_2", timestamp: 2 },
];

function checkpoint(revision = 1) {
	return createProjectionCheckpoint({
		revision,
		sourceMessages: raw,
		projectedMessages: [raw[0]!, { role: "custom", customType: "clm-note", content: "summary" }],
		beforeEstimate: 150,
		afterEstimate: 10,
		estimateUnit: "tokens",
		createdAt: "2026-08-29T00:00:00.000Z",
		editTrace: {
			version: 1,
			sourceRevision: revision - 1,
			sourceMessageCount: 2,
			outputMessageCount: 2,
			sources: [
				{ sourceIndex: 0, outputIndex: 0, kind: "kept" },
				{ sourceIndex: 1, kind: "removed" },
			],
			additions: [{ outputIndex: 1, kind: "added" }],
		},
	});
}

function applied(revision = 1): LiveContextState {
	return {
		version: 1,
		enabled: true,
		revision,
		checkpoint: checkpoint(revision),
		lastOutcome: {
			kind: "applied",
			message: `Applied revision ${revision}`,
			beforeEstimate: 150,
			afterEstimate: 10,
			estimateUnit: "tokens",
			at: "2026-08-29T00:00:00.000Z",
		},
	};
}

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "clm-state-test-"));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("state validation", () => {
	test("initial state is enabled at revision 0 without a checkpoint", () => {
		expect(initialLiveContextState()).toEqual({ version: 1, enabled: true, revision: 0 });
		expect(isLiveContextState(initialLiveContextState())).toBe(true);
	});

	test("accepts a full applied state", () => {
		expect(isLiveContextState(applied())).toBe(true);
		expect(isProjectionCheckpoint(checkpoint())).toBe(true);
	});

	test("accepts a checkpoint without per-message stamps (an older version)", () => {
		const { sourceStamps: _stamps, ...older } = checkpoint();
		expect(isProjectionCheckpoint(older)).toBe(true);
	});

	test.each([
		["missing version", { enabled: true, revision: 0 }],
		["foreign version", { version: 2, enabled: true, revision: 0 }],
		["string revision", { version: 1, enabled: true, revision: "1" }],
		["negative revision", { version: 1, enabled: true, revision: -1 }],
		["non-boolean enabled", { version: 1, enabled: "yes", revision: 0 }],
		["unknown outcome kind", { version: 1, enabled: true, revision: 0, lastOutcome: { kind: "won", message: "", at: "" } }],
		["outcome without message", { version: 1, enabled: true, revision: 0, lastOutcome: { kind: "reset", at: "" } }],
		["array", []],
		["null", null],
	])("rejects %s", (_name, value) => {
		expect(isLiveContextState(value)).toBe(false);
	});

	test.each([
		["short digest", { sourceDigest: "abc" }],
		["missing unit", { estimateUnit: undefined }],
		["bad unit", { estimateUnit: "bytes" }],
		["non-array projection", { projectedMessages: {} }],
		["message without role", { projectedMessages: [{ content: "x" }] }],
		["negative source count", { sourceMessageCount: -1 }],
		["NaN estimate", { beforeEstimate: Number.NaN }],
		["trace index past output", { editTrace: { ...checkpoint().editTrace!, additions: [{ outputIndex: 5, kind: "added" }] } }],
		["trace source past count", { editTrace: { ...checkpoint().editTrace!, sources: [{ sourceIndex: 9, kind: "kept" }] } }],
		["trace source count unlike checkpoint", { editTrace: { ...checkpoint().editTrace!, sourceMessageCount: 3 } }],
		["trace output count unlike projection", { editTrace: { ...checkpoint().editTrace!, outputMessageCount: 3 } }],
		["missing sourceIds", { sourceIds: undefined }],
		["sourceIds length unlike count", { sourceIds: ["msg_1"] }],
		["non-string source id", { sourceIds: ["msg_1", 2] }],
		["stamps length unlike count", { sourceStamps: [{ digest: "a".repeat(64), updatedAt: 1 }] }],
		["stamp digest not hex", { sourceStamps: [{ digest: "nope", updatedAt: 1 }, { digest: "a".repeat(64), updatedAt: 1 }] }],
		["stamp updatedAt not finite", { sourceStamps: [{ digest: "a".repeat(64), updatedAt: "now" }, { digest: "a".repeat(64), updatedAt: 1 }] }],
		["stamp strippedDigest not hex", { sourceStamps: [{ digest: "a".repeat(64), updatedAt: 1, strippedDigest: "nope" }, { digest: "a".repeat(64), updatedAt: 1 }] }],
		["numeric content", { projectedMessages: [{ role: "user", content: 5 }, { role: "user", content: "x" }] }],
		["untyped content part", { projectedMessages: [{ role: "user", content: [{ text: "x" }] }, { role: "user", content: "x" }] }],
	])("rejects a checkpoint with %s", (_name, patch) => {
		const value = { ...checkpoint(), ...patch };
		expect(isProjectionCheckpoint(value)).toBe(false);
		expect(isLiveContextState({ ...applied(), checkpoint: value })).toBe(false);
	});

	test("accepts projected content that is absent, a string or typed parts", () => {
		const value = {
			...checkpoint(),
			projectedMessages: [{ role: "custom" }, { role: "user", content: [{ type: "text", text: "x" }] }],
		};
		expect(isProjectionCheckpoint(value)).toBe(true);
	});

	test("rejects a state whose checkpoint revision differs from the state revision", () => {
		expect(isLiveContextState({ ...applied(2), checkpoint: checkpoint(1) })).toBe(false);
		expect(isLiveContextState({ ...applied(2), revision: 3 })).toBe(false);
	});
});

describe("resetProjectionState", () => {
	test("clears the checkpoint, advances the revision and keeps enabled", () => {
		const state = { ...applied(4), enabled: false };
		const reset = resetProjectionState(state, "OpenCode compaction", "2026-08-29T00:00:00.000Z");
		expect(reset).toEqual({
			version: 1,
			enabled: false,
			revision: 5,
			lastOutcome: { kind: "reset", message: "OpenCode compaction", at: "2026-08-29T00:00:00.000Z" },
		});
		expect(isLiveContextState(reset)).toBe(true);
	});
});

describe("state.json persistence", () => {
	test("a missing file loads the initial state without a warning", async () => {
		expect(await loadLiveContextState(directory)).toEqual({ state: initialLiveContextState() });
	});

	test("round-trips an applied state with checkpoint and outcome", async () => {
		const state = applied(3);
		await saveLiveContextState(directory, state);
		const loaded = await loadLiveContextState(directory);
		expect(loaded.warning).toBeUndefined();
		expect(loaded.state).toEqual(state);
	});

	test("round-trips a reset state", async () => {
		const reset = resetProjectionState(applied(2), "revert", "2026-08-29T00:00:00.000Z");
		await saveLiveContextState(directory, reset);
		expect((await loadLiveContextState(directory)).state).toEqual(reset);
	});

	test("writes state.json with mode 0600 and leaves no temp file", async () => {
		await saveLiveContextState(directory, applied());
		await saveLiveContextState(directory, applied(2));
		expect(statePath(directory)).toBe(join(directory, STATE_FILE));
		expect((await stat(statePath(directory))).mode & 0o777).toBe(0o600);
		expect(await readdir(directory)).toEqual([STATE_FILE]);
	});

	test("a failed write keeps the previous file intact and cleans up", async () => {
		const state = applied();
		await saveLiveContextState(directory, state);
		const cyclic = { ...applied(2) } as LiveContextState & { self?: unknown };
		cyclic.self = cyclic;
		await expect(saveLiveContextState(directory, cyclic)).rejects.toThrow();
		expect((await loadLiveContextState(directory)).state).toEqual(state);
		expect(await readdir(directory)).toEqual([STATE_FILE]);
	});

	test("a failed rename removes the temp file", async () => {
		// A directory at the target path makes rename fail after the temp file is written.
		await mkdir(statePath(directory));
		await expect(saveLiveContextState(directory, applied())).rejects.toThrow();
		expect(await readdir(directory)).toEqual([STATE_FILE]);
	});

	test("concurrent saves leave one complete, valid file", async () => {
		await Promise.all([1, 2, 3, 4, 5].map((revision) => saveLiveContextState(directory, applied(revision))));
		const loaded = await loadLiveContextState(directory);
		expect(loaded.warning).toBeUndefined();
		expect([1, 2, 3, 4, 5]).toContain(loaded.state.revision);
		expect(await readdir(directory)).toEqual([STATE_FILE]);
	});

	test("save into a missing directory rejects", async () => {
		await expect(saveLiveContextState(join(directory, "absent"), applied())).rejects.toThrow();
	});

	test.each([
		["truncated JSON", '{"version":1,"enabled":tr', /not valid JSON/],
		["empty file", "", /not valid JSON/],
		["foreign version", JSON.stringify({ version: 2, enabled: true, revision: 7 }), /unsupported version 2/],
		["bad shape", JSON.stringify({ version: 1, enabled: true, revision: "7" }), /invalid shape/],
		["bad checkpoint", JSON.stringify({ ...applied(), checkpoint: { version: 1 } }), /invalid shape/],
		["array", "[]", /invalid shape/],
	])("%s loads as initial state with a warning", async (_name, text, warning) => {
		await writeFile(statePath(directory), text);
		const loaded = await loadLiveContextState(directory);
		expect(loaded.state).toEqual(initialLiveContextState());
		expect(loaded.warning).toMatch(warning);
	});

	test("an unreadable path loads as initial state with a warning", async () => {
		await mkdir(statePath(directory));
		const loaded = await loadLiveContextState(directory);
		expect(loaded.state).toEqual(initialLiveContextState());
		expect(loaded.warning).toMatch(/Could not read/);
	});

	test("the saved file is plain JSON a reader can inspect", async () => {
		await saveLiveContextState(directory, applied());
		const parsed = JSON.parse(await readFile(statePath(directory), "utf8"));
		expect(parsed.checkpoint.sourceDigest).toBe(checkpoint().sourceDigest);
	});
});

describe("budgetCheck", () => {
	const check = { overhead: 18_000, source: "provider" as const, configured: 12_000, reserve: 2048, effective: 28_048, raised: true, at: "2026-10-03T00:00:00.000Z" };

	test("round-trips and survives a reset", async () => {
		const directory = await mkdtemp(join(tmpdir(), "clm-state-"));
		const state = { ...initialLiveContextState(), budgetCheck: check };
		await saveLiveContextState(directory, state);
		expect(await loadLiveContextState(directory)).toEqual({ state });
		expect(resetProjectionState(state, "x").budgetCheck).toEqual(check);
		await rm(directory, { recursive: true, force: true });
	});

	test("a malformed check is dropped; the rest of the state is kept", async () => {
		const directory = await mkdtemp(join(tmpdir(), "clm-state-"));
		const state = { ...initialLiveContextState(), revision: 4 };
		await writeFile(join(directory, STATE_FILE), JSON.stringify({ ...state, budgetCheck: { ...check, overhead: -1 } }));
		const loaded = await loadLiveContextState(directory);
		expect(loaded.state).toEqual(state);
		expect(loaded.warning).toBeUndefined();
		expect(loaded.repaired).toContain("invalid budgetCheck");
		await rm(directory, { recursive: true, force: true });
	});

	test("malformed sourceStamps are dropped; the rest of the state is kept", async () => {
		const directory = await mkdtemp(join(tmpdir(), "clm-state-"));
		const state = applied(3);
		const broken = structuredClone(state);
		broken.checkpoint!.sourceStamps = [{ digest: "nope", updatedAt: 1 }];
		await writeFile(join(directory, STATE_FILE), JSON.stringify(broken));
		const loaded = await loadLiveContextState(directory);
		const expected = structuredClone(state);
		delete expected.checkpoint!.sourceStamps;
		expect(loaded.state).toEqual(expected);
		expect(loaded.warning).toBeUndefined();
		expect(loaded.repaired).toContain("invalid sourceStamps");
		await rm(directory, { recursive: true, force: true });
	});
});
