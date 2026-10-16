import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { formatCount } from "@oh-my-pi/pi-utils";
import { type RequestFooterInput, formatUsageModel } from "../overlays/usage-row";
import { TOOL_ACTIVITY_KINDS, type ToolActivityKind, toolRenderers } from "../tools/index";
import { toolRenderName } from "./tool-execution";
import { assistantUsageIsBilled } from "./transcript-render-helpers";

export interface RequestFooterLookup {
	getTool?: (name: string) => AgentTool | undefined;
	isBuiltInTool?: (name: string) => boolean;
}

/** Final arguments only: progress frames and tool results never affect accounting. */
export function requestFooterInput(
	message: AssistantMessage,
	lookup: RequestFooterLookup,
	options: { showUsage: boolean; turnElapsedMs?: number; omitActivity?: boolean },
): RequestFooterInput | undefined {
	const counts = new Map<ToolActivityKind | "tool call", number>();
	if (!options.omitActivity) {
		for (const call of message.content) {
			if (call.type !== "toolCall") continue;
			const name = toolRenderName(call.name, lookup.getTool?.(call.name));
			const renderer = (lookup.isBuiltInTool?.(name) ?? true) ? toolRenderers[name] : undefined;
			const tally = renderer?.activityTally?.(call.arguments);
			const kind = tally?.kind ?? "tool call";
			counts.set(kind, (counts.get(kind) ?? 0) + (tally?.count ?? 1));
		}
	}
	const activity = [...TOOL_ACTIVITY_KINDS, "tool call" as const]
		.flatMap(kind => {
			const count = counts.get(kind) ?? 0;
			return count > 0 ? [formatCount(kind, count)] : [];
		})
		.join(" · ");
	const usage = options.showUsage && assistantUsageIsBilled(message.usage) ? message.usage : undefined;
	if (!activity && !usage) return undefined;
	return {
		activity: activity || undefined,
		usage,
		durationMs: message.duration,
		ttftMs: message.ttft,
		timestamp: message.timestamp,
		turnElapsedMs: options.turnElapsedMs,
		model: formatUsageModel(message.provider, message.model, message.reasoningEffort, message.upstreamModel),
	};
}
