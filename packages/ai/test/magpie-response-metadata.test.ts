import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const fixtures = [
	{
		api: "openai-completions" as const,
		stream: streamOpenAICompletions,
		body: 'data: {"id":"chat-1","model":"vendor-body-model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\ndata: {"id":"chat-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\ndata: [DONE]\n\n',
	},
	{
		api: "openai-responses" as const,
		stream: streamOpenAIResponses,
		body: 'data: {"type":"response.created","response":{"id":"resp-1","status":"in_progress"}}\n\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg-1","role":"assistant","content":[]}}\n\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"item_id":"msg-1","part":{"type":"output_text","text":"","annotations":[]}}\n\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg-1","delta":"hello"}\n\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","model":"vendor-body-model","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n',
	},
	{
		api: "anthropic-messages" as const,
		stream: streamAnthropic,
		body: 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","type":"message","role":"assistant","model":"vendor-body-model","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
	},
];

describe("Magpie response metadata", () => {
	for (const fixture of fixtures) {
		for (const actual of ["traex/gpt-5.6-luna:medium", "traex/gpt-5.6-luna", undefined]) {
			it(`${fixture.api} retains canonical headers ${actual ?? "when absent"}`, async () => {
				const model = buildModel({
					api: fixture.api,
					provider: "magpie",
					id: "group/iq-task",
					name: "Magpie route",
					baseUrl: "https://magpie.invalid/v1",
					input: ["text"],
					reasoning: false,
					contextWindow: 8192,
					maxTokens: 2048,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				});
				const fetch = (async () => new Response(fixture.body, {
					headers: {
						"content-type": "text/event-stream",
						...(actual ? { "X-Magpie-Model": actual, "X-Magpie-Provider": "traex" } : {}),
					},
				})) as FetchImpl;
				const result = await fixture.stream(model as never, {
					messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
				}, { apiKey: "test-key", fetch }).result();
				expect(result.stopReason).toBe("stop");
				expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "hello" }));
				expect(result.provider).toBe("magpie");
				expect(result.model).toBe("group/iq-task");
				expect(result.upstreamModel).toBe(actual);
				expect(result.upstreamProvider).toBe(actual ? "traex" : undefined);
				const replayed = JSON.parse(JSON.stringify(result));
				expect(replayed.upstreamModel).toBe(actual);
				expect(replayed.upstreamProvider).toBe(actual ? "traex" : undefined);
			});
		}
	}
});
