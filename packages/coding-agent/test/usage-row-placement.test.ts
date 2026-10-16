/**
 * Regression coverage for per-turn usage placement across transcript rebuilds.
 * Read-only turns retain compact tool groups while the latest request's metrics
 * appear in a standalone footer below its visible content/tools.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import {
	appendUsageRow,
	demoteLatestUsageRow,
	isUsageRowBlock,
	isUsageRowVisible,
	transferLatestUsageRow,
} from "@oh-my-pi/pi-tui/overlays/usage-row";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { TUI } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

import { cfgDisplayShowTokenUsage } from "@oh-my-pi/pi-coding-agent/modes/settings";

// 4242 → "4.2K": distinctive enough not to collide with a read group's render.
const USAGE_INPUT = 4242;
const USAGE_LABEL = formatNumber(USAGE_INPUT);
// Fixed local wall-clock time so the rendered stamp is deterministic across time zones.
// Single-digit month/day/hour/minute/second exercise the formatter's zero-padding.
const USAGE_TS = new Date(2026, 0, 2, 3, 4, 5).getTime();
const USAGE_TS_LABEL = "2026-01-02 03:04:05";
const SECOND_USAGE_TS = new Date(2026, 0, 2, 3, 4, 6).getTime();
const SECOND_USAGE_TS_LABEL = "2026-01-02 03:04:06";

function readTurn(
	toolCallId = "r1",
	filePath = "src/foo.ts",
	usageInput = USAGE_INPUT,
	timestamp = USAGE_TS,
): AgentMessage[] {
	const assistant = {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: filePath } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: usageInput,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: usageInput + 7,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	} as unknown as AgentMessage;
	const toolResult = {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "line1\nline2" }],
		timestamp,
	} as unknown as AgentMessage;
	return [assistant, toolResult];
}

function makeHarness(showTokenUsage: boolean): { ctx: InteractiveModeContext; helpers: UiHelpers } {
	const ctx = createInteractiveModeContext({
		settings: Settings.isolated({ "display.showTokenUsage": showTokenUsage }),
	});
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
	return { ctx, helpers };
}

describe("UiHelpers.renderSessionContext token-usage row placement", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		cfgDisplayShowTokenUsage.set(settings, true);
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	it("places the latest usage row after the read group for a read-only turn", () => {
		const { ctx, helpers } = makeHarness(true);
		helpers.renderSessionContext({ messages: readTurn() } as SessionContext);

		const children = ctx.chatContainer.children;
		const group = children.find(
			(component): component is ReadToolGroupComponent => component instanceof ReadToolGroupComponent,
		);
		expect(group).toBeDefined();

		const footer = children[children.length - 1]!;
		expect(isUsageRowBlock(footer)).toBe(true);
		expect(isUsageRowVisible(footer)).toBe(true);
		expect(children.indexOf(group!)).toBeLessThan(children.indexOf(footer));
		expect(group!.render(120).join("\n")).not.toContain(USAGE_LABEL);
		expect(footer.render(120).join("\n")).toContain(USAGE_LABEL);
		expect(footer.render(120).join("\n")).toContain(USAGE_TS_LABEL);
	});

	it("interleaves consecutive read-only turns with their paths in one group", () => {
		const { ctx, helpers } = makeHarness(true);
		const messages = [...readTurn(), ...readTurn("r2", "src/bar.ts", 2121, SECOND_USAGE_TS)];
		helpers.renderSessionContext({ messages } as SessionContext);

		const groups = ctx.chatContainer.children.filter(
			(component): component is ReadToolGroupComponent => component instanceof ReadToolGroupComponent,
		);
		expect(groups).toHaveLength(1);
		const rendered = ctx.chatContainer.render(120).join("\n");
		expect(rendered.indexOf("src/foo.ts")).toBeLessThan(rendered.indexOf("src/bar.ts"));
		expect(rendered).not.toContain(USAGE_LABEL);
		expect(rendered).not.toContain(USAGE_TS_LABEL);
		expect(rendered).toContain(SECOND_USAGE_TS_LABEL);
		const footers = ctx.chatContainer.children.filter(isUsageRowBlock);
		expect(footers).toHaveLength(2);
		expect(footers.map(isUsageRowVisible)).toEqual([false, true]);
	});

	it("rebuilds hidden history with exactly one current activity row", () => {
		const { ctx, helpers } = makeHarness(true);
		ctx.chatContainer.setToolActivityVisible(false);
		helpers.renderSessionContext({ messages: [...bashTurn(), ...readTurn()] } as SessionContext);
		const footers = ctx.chatContainer.children.filter(isUsageRowBlock);
		expect(footers).toHaveLength(2);
		expect(footers[0]!.render(120)).toEqual([]);
		const activity = footers.map(row => Bun.stripANSI(row.render(120).join("\n"))).join("\n");
		expect(activity).not.toContain("1 command");
		expect(activity.match(/1 read/g)).toHaveLength(1);
	});

	it("renders no usage row when showTokenUsage is off", () => {
		const { ctx, helpers } = makeHarness(false);
		helpers.renderSessionContext({ messages: readTurn() } as SessionContext);

		const children = ctx.chatContainer.children;
		expect(children.some(c => c.render(120).join("\n").includes(USAGE_LABEL))).toBe(false);
		const group = children.find(child => child instanceof ReadToolGroupComponent)!;
		const rendered = ctx.chatContainer.render(120).join("\n").trimEnd();
		expect(rendered).toContain("src/foo.ts");
		expect(rendered.endsWith(group.render(120).join("\n").trimEnd())).toBe(true);
	});
});

describe("ChatTranscriptBuilder token-usage row timestamp", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		cfgDisplayShowTokenUsage.set(settings, true);
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	it("renders the turn's local timestamp on the rebuilt usage row", () => {
		const builder = new ChatTranscriptBuilder({
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
			cwd: process.cwd(),
			requestRender: () => {},
		});
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: USAGE_INPUT,
				output: 7,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: USAGE_INPUT + 7,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: USAGE_TS,
		} as unknown as AgentMessage;
		builder.rebuild([{ type: "message", id: "m1", parentId: null, timestamp: new Date(0).toISOString(), message }]);
		const children = builder.container.children;
		const last = children[children.length - 1]!;
		const rendered = last.render(120).join("\n");
		expect(rendered).toContain(USAGE_TS_LABEL);
		expect(rendered).toContain(USAGE_LABEL);
	});

	it("deep-links tool-only assistant entries to their first rendered row", () => {
		const builder = new ChatTranscriptBuilder({
			ui: new TUI(new VirtualTerminal(120, 20)),
			cwd: process.cwd(),
			requestRender: () => {},
		});
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo ok" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1_000,
		};
		builder.rebuild([
			{ type: "message", id: "tool-entry", parentId: null, timestamp: new Date(0).toISOString(), message },
		]);

		const rendered = builder.container.render(120);
		expect(Bun.stripANSI(rendered.join("\n"))).toContain("echo ok");
		expect(builder.rowForEntry("tool-entry")).toBe(0);
	});

	it("keeps only the latest read metrics visible on the reusable transcript-builder path", () => {
		const builder = new ChatTranscriptBuilder({
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
			cwd: process.cwd(),
			requestRender: () => {},
		});
		const messages = [...readTurn(), ...readTurn("r2", "src/bar.ts", 2121, SECOND_USAGE_TS)];
		builder.rebuild(
			messages.map((message, index) => ({
				type: "message",
				id: `m${index}`,
				parentId: index === 0 ? null : `m${index - 1}`,
				timestamp: new Date(0).toISOString(),
				message,
			})),
		);

		const groups = builder.container.children.filter(
			(component): component is ReadToolGroupComponent => component instanceof ReadToolGroupComponent,
		);
		expect(groups).toHaveLength(1);
		const footers = builder.container.children.filter(isUsageRowBlock);
		expect(footers).toHaveLength(2);
		expect(footers.map(isUsageRowVisible)).toEqual([false, true]);
		const rendered = builder.container.render(120).join("\n");
		expect(rendered).not.toContain(USAGE_TS_LABEL);
		expect(rendered).toContain(SECOND_USAGE_TS_LABEL);
		expect(groups[0]!.render(120).join("\n")).not.toContain(USAGE_LABEL);
	});
});

function bashTurn(): AgentMessage[] {
	const [assistant, result] = readTurn();
	return [
		{
			...assistant,
			content: [{ type: "toolCall", id: "r1", name: "bash", arguments: { command: "echo ok" } }],
		} as AgentMessage,
		{ ...result, toolName: "bash", content: [{ type: "text", text: "ok" }] } as AgentMessage,
	];
}

describe("UsageRowBlock demotion lifecycle", () => {
	beforeAll(async () => {
		await initTheme();
	});
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		cfgDisplayShowTokenUsage.set(settings, true);
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	it("demoteLatestUsageRow is a no-op on an empty container", () => {
		const container = new TranscriptContainer();
		expect(() => demoteLatestUsageRow(container)).not.toThrow();
		expect(container.children.filter(isUsageRowBlock)).toHaveLength(0);
	});

	it("demoteLatestUsageRow hides the whole footer after a tool call turn", () => {
		const { ctx, helpers } = makeHarness(true);
		ctx.chatContainer.setToolActivityVisible(false);
		helpers.renderSessionContext({ messages: bashTurn() } as SessionContext);
		const footer = ctx.chatContainer.children.at(-1)!;
		expect(isUsageRowBlock(footer)).toBe(true);
		expect(isUsageRowVisible(footer)).toBe(true);
		const before = Bun.stripANSI(footer.render(120).join("\n"));
		expect(before).toContain(USAGE_LABEL);
		demoteLatestUsageRow(ctx.chatContainer);
		expect(ctx.chatContainer.children.at(-1)).toBe(footer);
		expect(isUsageRowVisible(footer)).toBe(false);
		const after = Bun.stripANSI(footer.render(120).join("\n"));
		expect(after).not.toContain(USAGE_LABEL);
		expect(after).not.toContain("1 command");
		expect(footer.render(120)).toEqual([]);
	});

	it("second turn start demotes the first turn's footer before appending", () => {
		const { ctx, helpers } = makeHarness(true);
		helpers.renderSessionContext({ messages: bashTurn() } as SessionContext);
		const footer = ctx.chatContainer.children.at(-1)!;
		expect(isUsageRowVisible(footer)).toBe(true);
		helpers.addMessageToChat(readTurn()[0]!);
		expect(ctx.chatContainer.children).toContain(footer);
		expect(isUsageRowVisible(footer)).toBe(false);
	});

	it("showTokenUsage=false: only the latest hidden activity footer remains", () => {
		const { ctx, helpers } = makeHarness(false);
		ctx.chatContainer.setToolActivityVisible(false);
		helpers.renderSessionContext({ messages: bashTurn() } as SessionContext);
		const footer = ctx.chatContainer.children.at(-1)!;
		expect(isUsageRowBlock(footer)).toBe(true);
		expect(isUsageRowVisible(footer)).toBe(false);
		const rendered = Bun.stripANSI(footer.render(120).join("\n"));
		expect(rendered).not.toContain(USAGE_LABEL);
		expect(rendered).toContain("1 command");
		const nextTurn = readTurn();
		helpers.addMessageToChat(nextTurn[0]!);
		expect(footer.render(120)).toEqual([]);
		helpers.renderSessionContext({ messages: [...bashTurn(), ...nextTurn] } as SessionContext);
		expect(footer.render(120)).toEqual([]);
		const current = ctx.chatContainer.children.filter(isUsageRowBlock).filter(row => row.render(120).length > 0);
		expect(current).toHaveLength(1);
		expect(Bun.stripANSI(current[0]!.render(120).join("\n"))).toContain("1 read");
	});

	it("rebuild then addMessageToChat demotes the replayed footer", () => {
		const { ctx, helpers } = makeHarness(true);
		helpers.renderSessionContext({ messages: readTurn() } as SessionContext);
		const footer = ctx.chatContainer.children.at(-1)!;
		expect(isUsageRowVisible(footer)).toBe(true);
		helpers.addMessageToChat(bashTurn()[0]!);
		expect(isUsageRowVisible(footer)).toBe(false);
		expect(footer.render(120).join("\n")).not.toContain(USAGE_LABEL);
	});
});

describe("transferLatestUsageRow", () => {
	it("transfers the latest usage row from source to destination", () => {
		const source = new TranscriptContainer();
		const destination = new TranscriptContainer();
		appendUsageRow(source, { usage: (readTurn()[0] as AssistantMessage).usage });
		const footer = source.children.at(-1)!;
		expect(isUsageRowVisible(footer)).toBe(true);
		// Rebuild moves the staged children before transferring their latest-row ownership.
		source.removeChild(footer);
		destination.addChild(footer);
		transferLatestUsageRow(source, destination);
		expect(source.children).not.toContain(footer);
		expect(destination.children).toContain(footer);
		demoteLatestUsageRow(source);
		expect(isUsageRowVisible(footer)).toBe(true);
		demoteLatestUsageRow(destination);
		expect(isUsageRowVisible(footer)).toBe(false);
	});

	it("preserves an existing destination footer if it's later than the transferred row", () => {
		const source = new TranscriptContainer();
		const destination = new TranscriptContainer();
		const usage = (readTurn()[0] as AssistantMessage).usage;
		appendUsageRow(destination, { usage });
		const existing = destination.children.at(-1)!;
		appendUsageRow(source, { usage });
		const staged = source.children.at(-1)!;
		source.removeChild(staged);
		destination.removeChild(existing);
		destination.addChild(staged);
		destination.addChild(existing);
		transferLatestUsageRow(source, destination);
		expect(destination.children).toEqual([staged, existing]);
		expect(isUsageRowVisible(staged)).toBe(false);
		expect(isUsageRowVisible(existing)).toBe(true);
		demoteLatestUsageRow(destination);
		expect(isUsageRowVisible(existing)).toBe(false);
	});
});

describe("preserveExistingChat footer ownership", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		cfgDisplayShowTokenUsage.set(settings, true);
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	it("keeps the preserved later footer latest after staged replay", async () => {
		const messages = readTurn();
		const context = { messages } as SessionContext;
		const ctx = createInteractiveModeContext({
			settings: Settings.isolated({ "display.showTokenUsage": true }),
			session: { isStreaming: true, buildTranscriptSessionContext: () => context },
			hideToolActivity: true,
		});
		const helpers = new UiHelpers(ctx);
		ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
		ctx.renderSessionContext = helpers.renderSessionContext.bind(helpers);
		ctx.chatContainer.setToolActivityVisible(false);
		appendUsageRow(ctx.chatContainer, {
			activity: "preserved activity",
			usage: (messages[0] as AssistantMessage).usage,
		});
		const preserved = ctx.chatContainer.children.at(-1)!;
		await helpers.renderInitialMessages({ preserveExistingChat: true });
		const footers = ctx.chatContainer.children.filter(isUsageRowBlock);
		expect(footers).toHaveLength(2);
		expect(footers.at(-1)).toBe(preserved);
		expect(footers.map(isUsageRowVisible)).toEqual([false, true]);
		demoteLatestUsageRow(ctx.chatContainer);
		expect(isUsageRowVisible(preserved)).toBe(false);
		expect(preserved.render(120)).toEqual([]);
	});
});
