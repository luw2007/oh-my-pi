import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { resolveDelegationBias } from "@oh-my-pi/pi-catalog/compat/delegation";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

async function expectPromptDateFromStartupTimezone(options: {
	tempDir: string;
	tempHomeDir: string;
	timeZone: string;
	now: string;
	expectedDate: string;
	rejectedDate: string;
}): Promise<void> {
	const scenarioPath = path.join(options.tempDir, "prompt-date-timezone.test.ts");
	await Bun.write(
		scenarioPath,
		`import { setSystemTime } from "bun:test";
import { renderDateCwdReminder } from ${JSON.stringify(
			path.resolve(import.meta.dir, "../src/session/date-cwd-reminder.ts"),
		)};
import { formatLocalCalendarDate } from ${JSON.stringify(path.resolve(import.meta.dir, "../../tui/src/chrome/local-date.ts"))};

setSystemTime(new Date(process.env.OMP_TEST_NOW!));
try {
	// The date/cwd reminder is built per request in the startup local timezone;
	// the system prompt no longer embeds the date (#7404).
	const reminder = renderDateCwdReminder(formatLocalCalendarDate(), "/cwd");
	if (!reminder.includes(\`Today: \${process.env.OMP_EXPECTED_DATE}\`)) {
		throw new Error(\`Reminder did not contain expected local date:\\n\${reminder}\`);
	}
	if (reminder.includes(\`Today: \${process.env.OMP_REJECTED_DATE}\`)) {
		throw new Error(\`Reminder contained rejected UTC date:\\n\${reminder}\`);
	}
} finally {
	setSystemTime();
}
`,
	);
	const child = Bun.spawn([process.execPath, scenarioPath], {
		cwd: options.tempDir,
		env: {
			...process.env,
			HOME: options.tempHomeDir,
			TZ: options.timeZone,
			OMP_TEST_NOW: options.now,
			OMP_EXPECTED_DATE: options.expectedDate,
			OMP_REJECTED_DATE: options.rejectedDate,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
}

describe("system prompt model identifier", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("keeps workstation facts without exposing a model identifier", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});

		const workstation = systemPrompt.join("\n\n").match(/<workstation>[\s\S]*?<\/workstation>/)?.[0];
		expect(workstation).toContain("OS:");
		expect(workstation).toContain("Arch:");
		expect(systemPrompt.join("\n\n")).not.toContain("Model:");
	});

	it("renders the first-turn reminder date from the startup local timezone rather than UTC", async () => {
		await expectPromptDateFromStartupTimezone({
			tempDir,
			tempHomeDir,
			timeZone: "America/Los_Angeles",
			now: "2026-07-01T03:15:00Z",
			expectedDate: "2026-06-30",
			rejectedDate: "2026-07-01",
		});
	});
});

describe("model-independent session prompts", () => {
	let authStorage: AuthStorage;
	let tempDir: string;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-session-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	async function createSession(modelRegistry: ModelRegistry, model: Model, toolNames: string[] = []) {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.keepRecentTokens": 1,
				"compaction.methodOrder": ["soft"],
				inlineToolDescriptors: "off",
			}),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames,
		});
		sessions.push(session);
		return session;
	}

	it("keeps prompt bytes stable across switching and compaction while routing requests to the correct models", async () => {
		type RequestBody = { model: string; messages: Array<{ role: string; content: unknown }> };
		const requests: RequestBody[] = [];
		const summary = "## Summary\nCompleted the first task; continue with the next user request.";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as RequestBody;
				requests.push(body);
				const chunk = (delta: object, finishReason: string | null) =>
					`data: ${JSON.stringify({
						id: "prompt-model-regression",
						object: "chat.completion.chunk",
						created: 1,
						model: body.model,
						choices: [{ index: 0, delta, finish_reason: finishReason }],
					})}\n\n`;
				return new Response(
					chunk({ role: "assistant", content: body.model === "compact-c" ? summary : "Acknowledged." }, null) +
						chunk({}, "stop") +
						"data: [DONE]\n\n",
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			const modelsPath = path.join(tempDir, "models.yml");
			await Bun.write(
				modelsPath,
				`providers:
  smoke:
    baseUrl: http://127.0.0.1:${server.port}/v1
    auth: none
    api: openai-completions
    models:
      - id: active-a
      - id: active-b
        compactionModel: smoke/compact-c
      - id: compact-c
`,
			);
			const registry = new ModelRegistry(authStorage, modelsPath);
			const modelA = registry.find("smoke", "active-a")!;
			const modelB = registry.find("smoke", "active-b")!;
			const session = await createSession(registry, modelA);
			const initial = [...session.agent.state.systemPrompt];
			expect(initial.join("\n")).not.toContain("Model:");
			await session.prompt("Record the first task.");
			await session.waitForIdle();
			await session.setModel(modelB);
			expect(session.agent.state.systemPrompt).toEqual(initial);
			await session.prompt("Continue the second task.");
			await session.waitForIdle();
			const compact = await session.compact();
			expect(compact.summary).toContain("Completed the first task");
			expect(session.model?.id).toBe("active-b");
			expect(session.agent.state.systemPrompt).toEqual(initial);
			await session.prompt("Continue after compact.");
			await session.waitForIdle();
			const chatRequests = requests.filter(request => request.model !== "compact-c");
			expect(chatRequests.map(request => request.model)).toEqual(["active-a", "active-b", "active-b"]);
			expect(requests.some(request => request.model === "compact-c")).toBe(true);
			const systemMessages = chatRequests.map(request =>
				request.messages.filter(message => message.role === "system" || message.role === "developer"),
			);
			expect(systemMessages[0]).toEqual(systemMessages[1]);
			expect(systemMessages[1]).toEqual(systemMessages[2]);
			expect(JSON.stringify(systemMessages)).not.toContain("Model:");
		} finally {
			await server.stop(true);
		}
	});

	it("updates delegation policy on a model switch to match a fresh session for that model", async () => {
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const models = registry.getAll();
		const gated = models.find(model => resolveDelegationBias(model) === "gated")!;
		const restrained = models.find(model => resolveDelegationBias(model) === "restrained")!;
		authStorage.keys.setRuntime(gated.provider, "test-key");
		authStorage.keys.setRuntime(restrained.provider, "test-key");
		const session = await createSession(registry, gated, ["task"]);
		const fresh = await createSession(registry, restrained, ["task"]);
		expect(session.agent.state.systemPrompt).not.toEqual(fresh.agent.state.systemPrompt);
		await session.setModel(restrained);
		expect(session.agent.state.systemPrompt).toEqual(fresh.agent.state.systemPrompt);
	});
});
