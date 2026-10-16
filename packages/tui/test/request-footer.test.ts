import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { requestFooterInput, TurnActivityTally } from "@oh-my-pi/pi-tui/chat/request-footer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { appendUsageRow, demoteLatestUsageRow, transferLatestUsageRow } from "@oh-my-pi/pi-tui/overlays/usage-row";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const cx = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const billedUsage: Usage = {
	input: 100,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120,
	cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
};

function assistant(
	content: AssistantMessage["content"],
	usage = zeroUsage,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason,
		usage,
		timestamp: 1,
	};
}

function call(name: string, args: Record<string, unknown> = {}): AssistantMessage["content"][number] {
	return { type: "toolCall", id: name, name, arguments: args };
}

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child;
}

function footer(container: TranscriptContainer, index = container.children.length - 1): NativeNode {
	const root = container.children[index]?.describe?.(cx);
	if (!root || root.k !== "col") throw new Error("footer did not describe a col");
	return root;
}

function nodes(root: NativeNode): NativeNode[] {
	return (root.c ?? []).filter(isNode);
}

function keys(root: NativeNode): (string | undefined)[] {
	return nodes(root).map(child => child.key);
}

function activityText(root: NativeNode): string {
	const activity = nodes(root).find(child => child.key === "activity");
	if (!activity || activity.k !== "text") throw new Error("footer has no activity text");
	return activity.p?.text ?? activity.p?.spans?.map(span => span.t).join("") ?? "";
}

beforeAll(async () => {
	await initTheme(false);
});

describe("requestFooterInput", () => {
	it("resolves canonical edit aliases and orders batch activity without a redundant total", () => {
		const input = requestFooterInput(
			assistant([
				call("mcp__server__unknown"),
				call("read"),
				call("grep"),
				call("bash"),
				call("wire_patch"),
				call("task", { tasks: [{ task: "one" }, { task: "two" }] }),
			]),
			{ getTool: name => (name === "wire_patch" ? ({ name: "apply_patch" } as unknown as AgentTool) : undefined) },
			{ showUsage: true, turnActivity: new TurnActivityTally() },
		);
		expect(input?.activity).toBe("2 agents · 1 edit · 1 command · 1 search · 1 read · 1 tool call");
	});

	it("counts custom built-in shadows and unregistered MCP tools as generic calls", () => {
		const input = requestFooterInput(
			assistant([call("custom_read"), call("mcp__server__unknown")]),
			{
				getTool: name => (name === "custom_read" ? ({ name: "read" } as unknown as AgentTool) : undefined),
				isBuiltInTool: () => false,
			},
			{ showUsage: true, turnActivity: new TurnActivityTally() },
		);
		expect(input?.activity).toBe("2 tool calls");
	});

	it("can hide usage without losing activity and omit activity without losing billed usage", () => {
		const message = assistant([call("read")], billedUsage);
		const activityOnly = requestFooterInput(message, {}, { showUsage: false, turnActivity: new TurnActivityTally() });
		expect(activityOnly?.activity).toBe("1 read");
		expect(activityOnly?.usage).toBeUndefined();
		const usageOnly = requestFooterInput(
			message,
			{},
			{ showUsage: true, omitActivity: true, turnActivity: new TurnActivityTally() },
		);
		expect(usageOnly?.activity).toBeUndefined();
		expect(usageOnly?.usage).toEqual(billedUsage);
	});

	it("omits unbilled text and does not count normalized stripped tool calls", () => {
		const turnActivity = new TurnActivityTally();
		const message = assistant([{ type: "text", text: "done" }]);
		expect(requestFooterInput(message, {}, { showUsage: true, turnActivity })).toBeUndefined();
		const normalized = Object.assign(assistant([{ type: "text", text: "done" }]), { strippedToolCalls: 2 });
		expect(requestFooterInput(normalized, {}, { showUsage: true, turnActivity })).toBeUndefined();
	});
});

describe("request footer native state", () => {
	it("keeps activity but hides usage when the latest billed footer is demoted", () => {
		const container = new TranscriptContainer();
		container.setToolActivityVisible(false);
		appendUsageRow(container, { activity: "2 reads", usage: billedUsage });
		const latest = footer(container);
		expect(latest.p?.hidden).not.toBe(true);
		expect(keys(latest)).toEqual(["activity", "usage"]);
		expect(activityText(latest)).toBe("2 reads");
		expect(nodes(latest).find(child => child.key === "usage")?.p?.role).toBe("omp.usage.turn");
		demoteLatestUsageRow(container);
		expect(keys(footer(container))).toEqual(["activity"]);
		expect(activityText(footer(container))).toBe("2 reads");
	});

	it("toggles activity independently of usage", () => {
		const container = new TranscriptContainer();
		appendUsageRow(container, { activity: "2 reads", usage: billedUsage });
		expect(keys(footer(container))).toEqual(["usage"]);
		container.setToolActivityVisible(false);
		expect(keys(footer(container))).toEqual(["activity", "usage"]);
		container.setToolActivityVisible(true);
		expect(keys(footer(container))).toEqual(["usage"]);
		demoteLatestUsageRow(container);
		expect(keys(footer(container))).toEqual([]);
		expect(footer(container).p?.hidden).toBe(true);
		container.setToolActivityVisible(false);
		expect(keys(footer(container))).toEqual(["activity"]);
	});

	it("demotes the previous billed footer when the next request has only unbilled activity", () => {
		const container = new TranscriptContainer();
		container.setToolActivityVisible(false);
		appendUsageRow(container, { activity: "2 reads", usage: billedUsage });
		const next = requestFooterInput(
			assistant([call("read")]),
			{},
			{ showUsage: true, turnActivity: new TurnActivityTally() },
		);
		expect(next?.activity).toBe("1 read");
		expect(next?.usage).toBeUndefined();
		if (!next) throw new Error("unbilled tool request has no footer");
		appendUsageRow(container, next);
		expect(keys(footer(container, 0))).toEqual(["activity"]);
		expect(activityText(footer(container, 0))).toBe("2 reads");
		expect(keys(footer(container, 1))).toEqual(["activity"]);
		expect(activityText(footer(container, 1))).toBe("1 read");
	});

	it("keeps each turn's summary and collapses a turn's partial summaries into its final one", () => {
		const container = new TranscriptContainer();
		container.setToolActivityVisible(false);
		const turnActivity = new TurnActivityTally();
		const requests = [
			assistant([call("read")], billedUsage, "toolUse"),
			assistant([call("bash")], billedUsage, "toolUse"),
			assistant([{ type: "text", text: "done" }], billedUsage),
			assistant([call("read")], billedUsage),
		];
		for (const message of requests) {
			const input = requestFooterInput(message, {}, { showUsage: false, turnActivity });
			if (!input) throw new Error("request has no footer");
			appendUsageRow(container, input);
		}
		const visible = container.children.map(child => Bun.stripANSI(child.render(100).join("\n")).trim());
		expect(visible).toEqual(["", "", "1 command · 1 read", "1 read"]);
		demoteLatestUsageRow(container);
		expect(container.children.map(child => Bun.stripANSI(child.render(100).join("\n")).trim())).toEqual([
			"",
			"",
			"1 command · 1 read",
			"1 read",
		]);
	});

	it("does not carry an interrupted turn's partial summary into a reset turn", () => {
		const turnActivity = new TurnActivityTally();
		const first = requestFooterInput(
			assistant([call("read")], zeroUsage, "toolUse"),
			{},
			{ showUsage: false, turnActivity },
		);
		expect(first?.activity).toBe("1 read");
		turnActivity.reset();
		const next = requestFooterInput(assistant([call("bash")]), {}, { showUsage: false, turnActivity });
		expect(next?.activity).toBe("1 command");
		expect(next?.continuesTurn).toBe(false);
		expect(first?.activityTurnId).toBe("read");
		expect(next?.activityTurnId).toBe("bash");
	});

	it("merges overlapping replay and live summaries by stable turn id before terminal continuation", () => {
		const staged = new TranscriptContainer();
		const live = new TranscriptContainer();
		live.setToolActivityVisible(false);
		const replayTally = new TurnActivityTally();
		const liveTally = new TurnActivityTally();
		const first = assistant([call("read")], billedUsage, "toolUse");
		const second = assistant([call("bash")], billedUsage, "toolUse");
		appendUsageRow(staged, requestFooterInput(first, {}, { showUsage: true, turnActivity: replayTally })!);
		requestFooterInput(first, {}, { showUsage: true, turnActivity: liveTally });
		appendUsageRow(live, requestFooterInput(second, {}, { showUsage: true, turnActivity: liveTally })!);
		const preserved = [...live.children];
		live.clear();
		for (const child of [...staged.children, ...preserved]) live.addChild(child);
		transferLatestUsageRow(staged, live);
		expect(keys(footer(live, 0))).toEqual([]);
		expect(activityText(footer(live, 1))).toBe("1 command · 1 read");
		appendUsageRow(
			live,
			requestFooterInput(
				assistant([{ type: "text", text: "done" }], billedUsage),
				{},
				{
					showUsage: true,
					turnActivity: liveTally,
				},
			)!,
		);
		expect(
			live.children.map((_, index) =>
				keys(footer(live, index)).includes("activity") ? activityText(footer(live, index)) : "",
			),
		).toEqual(["", "", "1 command · 1 read"]);
		expect(keys(footer(live))).toEqual(["activity", "usage"]);
	});

	it("retains distinct interrupted-turn summaries in either transfer order", () => {
		for (const stagedLater of [false, true]) {
			const staged = new TranscriptContainer();
			const live = new TranscriptContainer();
			live.setToolActivityVisible(false);
			appendUsageRow(staged, { activity: "1 read", activityTurnId: "interrupted-read", usage: billedUsage });
			appendUsageRow(live, { activity: "1 command", activityTurnId: "new-prompt-bash", usage: billedUsage });
			const preserved = [...live.children];
			live.clear();
			const children = stagedLater ? [...preserved, ...staged.children] : [...staged.children, ...preserved];
			for (const child of children) live.addChild(child);
			transferLatestUsageRow(staged, live);
			expect(live.children.map((_, index) => activityText(footer(live, index)))).toEqual(
				stagedLater ? ["1 command", "1 read"] : ["1 read", "1 command"],
			);
			expect(keys(footer(live, 0))).toEqual(["activity"]);
			expect(keys(footer(live, 1))).toEqual(["activity", "usage"]);
		}
	});

	it("supersedes only a matching row present in the destination, in transcript order", () => {
		for (const existingPresent of [false, true]) {
			const staged = new TranscriptContainer();
			const live = new TranscriptContainer();
			live.setToolActivityVisible(false);
			appendUsageRow(staged, { activity: "2 reads", activityTurnId: "same-turn" });
			appendUsageRow(live, { activity: "1 read", activityTurnId: "same-turn" });
			if (!existingPresent) live.clear();
			for (const child of staged.children) live.addChild(child);
			transferLatestUsageRow(staged, live);
			if (existingPresent) expect(keys(footer(live, 0))).toEqual([]);
			expect(activityText(footer(live))).toBe("2 reads");
		}
	});

	it("treats a runnable `stop` with tool calls as a continuation, like the agent loop", () => {
		const turnActivity = new TurnActivityTally();
		const first = requestFooterInput(assistant([call("read")]), {}, { showUsage: false, turnActivity });
		expect(first?.activityTurnId).toBe("read");
		const second = requestFooterInput(assistant([call("bash")]), {}, { showUsage: false, turnActivity });
		expect(second?.activity).toBe("1 command · 1 read");
		expect(second?.continuesTurn).toBe(true);
		expect(second?.activityTurnId).toBe("read");
		const done = requestFooterInput(
			assistant([{ type: "text", text: "done" }], billedUsage),
			{},
			{ showUsage: false, turnActivity },
		);
		expect(done?.activity).toBe("1 command · 1 read");
		expect(done?.activityTurnId).toBe("read");
		const errored = requestFooterInput(
			assistant([call("read")], zeroUsage, "error"),
			{},
			{ showUsage: false, turnActivity },
		);
		expect(errored?.activity).toBe("1 read");
		expect(errored?.continuesTurn).toBe(false);
		expect(errored?.activityTurnId).toBe("read");
		const next = requestFooterInput(assistant([call("bash")]), {}, { showUsage: false, turnActivity });
		expect(next?.activity).toBe("1 command");
		expect(next?.continuesTurn).toBe(false);
		expect(next?.activityTurnId).toBe("bash");
	});
});
