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

/**
 * Sums the tool calls of one logical turn: consecutive `toolUse` requests up to
 * the terminal stop. Final arguments only; progress frames and tool results
 * never affect accounting.
 */
export class TurnActivityTally {
	#counts = new Map<ToolActivityKind | "tool call", number>();
	#shown = false;
	#activityTurnId: string | undefined;

	/** Drop a partial turn (a new prompt, a rebuild). */
	reset(): void {
		this.#counts.clear();
		this.#shown = false;
		this.#activityTurnId = undefined;
	}

	/** Fold in one request; a stop the agent loop will not continue closes the turn after reporting it. */
	add(
		message: AssistantMessage,
		lookup: RequestFooterLookup,
		omitActivity?: boolean,
	): { activity: string | undefined; continuesTurn: boolean; activityTurnId: string | undefined } {
		// Only a request that already showed a summary leaves a partial one to supersede.
		const continuesTurn = this.#shown;
		if (!omitActivity) {
			for (const call of message.content) {
				if (call.type !== "toolCall") continue;
				this.#activityTurnId ??= call.id;
				const name = toolRenderName(call.name, lookup.getTool?.(call.name));
				const renderer = (lookup.isBuiltInTool?.(name) ?? true) ? toolRenderers[name] : undefined;
				const tally = renderer?.activityTally?.(call.arguments);
				const kind = tally?.kind ?? "tool call";
				this.#counts.set(kind, (this.#counts.get(kind) ?? 0) + (tally?.count ?? 1));
			}
		}
		const activity =
			[...TOOL_ACTIVITY_KINDS, "tool call" as const]
				.flatMap(kind => {
					const count = this.#counts.get(kind) ?? 0;
					return count > 0 ? [formatCount(kind, count)] : [];
				})
				.join(" · ") || undefined;
		this.#shown = activity !== undefined;
		// Mirrors the agent loop's `runnableStop`: `toolUse` and `stop` with calls run tools and continue the turn.
		const turnOpen =
			(message.stopReason === "toolUse" || message.stopReason === "stop") &&
			message.content.some(block => block.type === "toolCall");
		const activityTurnId = this.#activityTurnId;
		if (!turnOpen) this.reset();
		return { activity, continuesTurn, activityTurnId };
	}
}

/** `turnActivity` accumulates across the turn's requests; `activity` is the turn's running total. */
export function requestFooterInput(
	message: AssistantMessage,
	lookup: RequestFooterLookup,
	options: {
		showUsage: boolean;
		turnElapsedMs?: number;
		omitActivity?: boolean;
		turnActivity: TurnActivityTally;
	},
): RequestFooterInput | undefined {
	const { activity, continuesTurn, activityTurnId } = options.turnActivity.add(message, lookup, options.omitActivity);
	const usage = options.showUsage && assistantUsageIsBilled(message.usage) ? message.usage : undefined;
	if (!activity && !usage) return undefined;
	return {
		activity,
		continuesTurn,
		activityTurnId,
		usage,
		durationMs: message.duration,
		ttftMs: message.ttft,
		timestamp: message.timestamp,
		turnElapsedMs: options.turnElapsedMs,
		model: formatUsageModel(message.provider, message.model, message.reasoningEffort, message.upstreamModel),
	};
}
