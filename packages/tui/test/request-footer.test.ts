import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { requestFooterInput } from "@oh-my-pi/pi-tui/chat/request-footer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { appendUsageRow, demoteLatestUsageRow } from "@oh-my-pi/pi-tui/overlays/usage-row";
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

function assistant(content: AssistantMessage["content"], usage = zeroUsage): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
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
			{ showUsage: true },
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
			{ showUsage: true },
		);
		expect(input?.activity).toBe("2 tool calls");
	});

	it("can hide usage without losing activity and omit activity without losing billed usage", () => {
		const message = assistant([call("read")], billedUsage);
		const activityOnly = requestFooterInput(message, {}, { showUsage: false });
		expect(activityOnly?.activity).toBe("1 read");
		expect(activityOnly?.usage).toBeUndefined();
		const usageOnly = requestFooterInput(message, {}, { showUsage: true, omitActivity: true });
		expect(usageOnly?.activity).toBeUndefined();
		expect(usageOnly?.usage).toEqual(billedUsage);
	});

	it("omits unbilled text and does not count normalized stripped tool calls", () => {
		const message = assistant([{ type: "text", text: "done" }]);
		expect(requestFooterInput(message, {}, { showUsage: true })).toBeUndefined();
		const normalized = Object.assign(assistant([{ type: "text", text: "done" }]), { strippedToolCalls: 2 });
		expect(requestFooterInput(normalized, {}, { showUsage: true })).toBeUndefined();
	});
});

describe("request footer native state", () => {
	it("hides activity and usage when the latest billed footer is demoted", () => {
		const container = new TranscriptContainer();
		container.setToolActivityVisible(false);
		appendUsageRow(container, { activity: "2 reads", usage: billedUsage });
		const latest = footer(container);
		expect(latest.p?.hidden).not.toBe(true);
		expect(keys(latest)).toEqual(["activity", "usage"]);
		expect(activityText(latest)).toBe("2 reads");
		expect(nodes(latest).find(child => child.key === "usage")?.p?.role).toBe("omp.usage.turn");
		demoteLatestUsageRow(container);
		expect(keys(footer(container))).toEqual([]);
		expect(footer(container).p?.hidden).toBe(true);
		expect(container.children[0]!.render(100)).toEqual([]);
	});

	it("toggles current activity independently of usage without restoring demoted counts", () => {
		const container = new TranscriptContainer();
		appendUsageRow(container, { activity: "2 reads", usage: billedUsage });
		expect(keys(footer(container))).toEqual(["usage"]);
		container.setToolActivityVisible(false);
		expect(keys(footer(container))).toEqual(["activity", "usage"]);
		expect(activityText(footer(container))).toBe("2 reads");
		container.setToolActivityVisible(true);
		expect(keys(footer(container))).toEqual(["usage"]);
		demoteLatestUsageRow(container);
		expect(keys(footer(container))).toEqual([]);
		expect(footer(container).p?.hidden).toBe(true);
		container.setToolActivityVisible(false);
		expect(keys(footer(container))).toEqual([]);
		expect(footer(container).p?.hidden).toBe(true);
	});

	it("demotes the previous billed footer when the next request has only unbilled activity", () => {
		const container = new TranscriptContainer();
		container.setToolActivityVisible(false);
		appendUsageRow(container, { activity: "2 reads", usage: billedUsage });
		const next = requestFooterInput(assistant([call("read")]), {}, { showUsage: true });
		expect(next?.activity).toBe("1 read");
		expect(next?.usage).toBeUndefined();
		if (!next) throw new Error("unbilled tool request has no footer");
		appendUsageRow(container, next);
		expect(keys(footer(container, 0))).toEqual([]);
		expect(container.children[0]!.render(100)).toEqual([]);
		expect(keys(footer(container, 1))).toEqual(["activity"]);
		expect(activityText(footer(container, 1))).toBe("1 read");
	});

	it("keeps exactly the latest activity row with token usage off", () => {
		const container = new TranscriptContainer();
		container.setToolActivityVisible(false);
		for (const name of ["read", "grep"]) {
			const input = requestFooterInput(assistant([call(name)], billedUsage), {}, { showUsage: false });
			if (!input) throw new Error("tool request has no footer");
			appendUsageRow(container, input);
		}
		expect(keys(footer(container, 0))).toEqual([]);
		expect(keys(footer(container, 1))).toEqual(["activity"]);
		expect(activityText(footer(container, 1))).toBe("1 search");
		const rendered = Bun.stripANSI(container.render(100).join("\n"));
		expect(rendered).not.toContain("1 read");
		expect(rendered.match(/1 search/g)).toHaveLength(1);
		demoteLatestUsageRow(container);
		expect(container.children.every(child => child.render(100).length === 0)).toBe(true);
	});
});
