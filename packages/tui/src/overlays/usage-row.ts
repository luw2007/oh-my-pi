import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { Container } from "../tui";
import { Spacer } from "../components/spacer";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { theme } from "../theme/theme";
import { sanitizeDisplayLineField } from "../overlays/extensions/display-text";
import { formatMetricRow, MetricRow, type MetricSpec } from "../components/metric";
import { node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode } from "../native/node";
import { Text } from "../components/text";
import { col, keyed, withHidden } from "../native/describe";
import type { TranscriptContainer } from "../chrome/transcript-container";

export interface RequestFooterInput {
	activity?: string;
	usage?: Usage;
	durationMs?: number;
	ttftMs?: number;
	timestamp?: number;
	turnElapsedMs?: number;
	model?: string;
}

/** Below this the rate is nonsense (cached/instant responses yield absurd tok/s). */
const MIN_DURATION_MS = 100;

/** Local ISO date with a wall-clock time; only the hour cycle follows the terminal. */
function formatUsageTimestamp(ms: number, hour12 = false): string {
	const d = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const time = hour12
		? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12 })
		: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	return `${date} ${time}`;
}

/**
 * Prompt→yield wall time for a turn, from pure local timestamps: the user
 * prompt's timestamp to the response's completion time (`completedAt`, stamped
 * by the session at `message_end`). No provider-reported duration is involved —
 * messages persisted before the stamp existed simply have no span.
 * Undefined when either end is unknown (mid-attach or unstamped message).
 */
export function turnElapsedMs(
	turnStartedAt: number | undefined,
	message: { completedAt?: number },
): number | undefined {
	if (turnStartedAt === undefined || message.completedAt === undefined) return undefined;
	const elapsed = message.completedAt - turnStartedAt;
	return elapsed > 0 ? Math.round(elapsed) : undefined;
}

/** Magpie's canonical served identity, or the configured model and effective thinking effort. */
export function formatUsageModel(
	provider: string,
	model: string,
	reasoningEffort?: Effort,
	upstreamModel?: string,
): string {
	if (provider === "magpie" && upstreamModel?.includes("/")) return upstreamModel;
	return `${provider}/${model}${reasoningEffort ? `:${reasoningEffort}` : ""}`;
}

/** A finished turn's totals, the native `omp.turn.usage` line under its last answer. */
export interface TurnUsageSummary {
	/** Prompt→yield wall time; undefined when either end is unknown. */
	readonly elapsedMs: number | undefined;
	/**
	 * Prompt tokens: input, cache writes and orchestration input. Cache reads
	 * re-read the context each request, so they stay out (as in the status
	 * line's total).
	 */
	readonly input: number;
	/** Output tokens, orchestration output included. */
	readonly output: number;
	/** Billed cost in dollars. */
	readonly cost: number;
}

/**
 * Sums the requests of a turn. {@link add} returns the turn's summary on the
 * message that ends the run (any stop but `toolUse`) and starts over.
 */
export class TurnUsageTally {
	#input = 0;
	#output = 0;
	#cost = 0;

	/** Drop a partial turn (a new prompt, a fresh run). */
	reset(): void {
		this.#input = 0;
		this.#output = 0;
		this.#cost = 0;
	}

	add(message: AssistantMessage, turnStartedAt: number | undefined): TurnUsageSummary | undefined {
		const { usage } = message;
		this.#input += usage.input + usage.cacheWrite + (usage.orchestration?.input ?? 0);
		this.#output += usage.output + (usage.orchestration?.output ?? 0);
		this.#cost += usage.cost.total;
		if (message.stopReason === "toolUse") return undefined;
		const summary =
			this.#input + this.#output > 0 || this.#cost > 0
				? {
						elapsedMs: turnElapsedMs(turnStartedAt, message),
						input: this.#input,
						output: this.#output,
						cost: this.#cost,
					}
				: undefined;
		this.reset();
		return summary;
	}
}

/**
 * The native turn line: `12.4s · 19K tok · $0.02 this turn` (the time drops
 * out when unknown, the cost when nothing was billed), and its tooltip with
 * exact counts.
 */
export function formatTurnUsage(summary: TurnUsageSummary): { text: string; title: string } {
	const tokens = summary.input + summary.output;
	const cost = summary.cost > 0 ? (summary.cost < 0.005 ? "<$0.01" : `$${summary.cost.toFixed(2)}`) : undefined;
	const time = summary.elapsedMs === undefined ? undefined : formatDuration(summary.elapsedMs);
	const text = [time, `${formatNumber(tokens)} tok`, cost].filter(part => part !== undefined).join(" · ");
	const exact = `${tokens.toLocaleString("en-US")} tokens (${summary.input.toLocaleString("en-US")} in · ${summary.output.toLocaleString("en-US")} out)`;
	const title = [time, exact, cost].filter(part => part !== undefined).join(" · ");
	return { text: `${text} this turn`, title: `This turn: ${title}` };
}

/** Output tokens per second over the whole request; undefined when the duration is too short to mean anything. */
function usageThroughput(usage: Usage, durationMs: number | undefined): number | undefined {
	if (!durationMs || durationMs <= MIN_DURATION_MS || usage.output <= 0) return undefined;
	// TPS over the total request duration — the post-TTFT window undercounts
	// generation time when reasoning tokens are hidden before the first
	// visible byte, inflating the rate.
	return (usage.output / durationMs) * 1000;
}

/** Every metric except throughput, which the native row declares as a `rate`. */
function usageRowBaseSpecs(
	usage: Usage,
	ttftMs?: number,
	timestamp?: number,
	turnElapsedMs?: number,
	model?: string,
): MetricSpec[] {
	const totalInput = usage.input + usage.cacheWrite;
	const specs: MetricSpec[] = [];
	// Lead with the turn's local wall-clock time (down to the second), log-line style.
	if (timestamp !== undefined && Number.isFinite(timestamp) && timestamp > 0) {
		specs.push({ value: formatUsageTimestamp(timestamp) });
	}
	// The delta the operator actually waited, bare with a space so it scans
	// apart from the TTFT figure below (which keeps the clock icon).
	// `message.duration` comes from performance.now(), so the combined value is
	// fractional; round before formatDuration so the label never prints a raw
	// float (e.g. `347.28381699998863ms`).
	if (turnElapsedMs !== undefined && turnElapsedMs > 0) {
		specs.push({ value: `Δ ${formatDuration(Math.round(turnElapsedMs))}` });
	}
	const modelLabel = sanitizeDisplayLineField(model);
	if (modelLabel) specs.push({ value: modelLabel });
	specs.push({ leading: theme.icon.input, value: formatNumber(totalInput) });
	specs.push({ leading: theme.icon.output, value: formatNumber(usage.output) });
	if (usage.cacheRead > 0) {
		specs.push({ leading: theme.icon.cache, value: formatNumber(usage.cacheRead) });
	}
	if (ttftMs && ttftMs > 0) {
		specs.push({ leading: theme.icon.time, value: `${(ttftMs / 1000).toFixed(1)}s` });
	}
	return specs;
}

function usageRowSpecs(
	usage: Usage,
	durationMs?: number,
	ttftMs?: number,
	timestamp?: number,
	turnElapsedMs?: number,
	model?: string,
): MetricSpec[] {
	const specs = usageRowBaseSpecs(usage, ttftMs, timestamp, turnElapsedMs, model);
	const tokPerSec = usageThroughput(usage, durationMs);
	if (tokPerSec !== undefined) {
		specs.push({ leading: theme.icon.throughput, value: `${tokPerSec.toFixed(1)}/s` });
	}
	return specs;
}

/** Per-turn usage block: a dim metric strip under the turn; natively a wrapping row with a `rate` for throughput. */
class UsageRowBlock extends Container {
	readonly #input: RequestFooterInput;
	#latest = true;
	#toolActivityVisible = true;
	#nativeNode: NativeNode | undefined;
	#nativeHour12: boolean | undefined;

	constructor(input: RequestFooterInput) {
		super();
		this.#input = input;
		this.#refresh();
	}

	isTranscriptBlockFinalized(): boolean {
		return true;
	}

	get showsUsage(): boolean {
		return this.#latest && this.#input.usage !== undefined;
	}

	demote(): void {
		if (!this.#latest) return;
		this.#latest = false;
		this.#refresh();
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		this.#refresh();
	}

	#refresh(): void {
		this.#nativeNode = undefined;
		this.clear();
		const input = this.#input;
		const activity = this.#latest && !this.#toolActivityVisible ? input.activity : undefined;
		if (activity || this.showsUsage) this.addChild(new Spacer(1));
		if (activity) this.addChild(new Text(theme.fg("dim", activity), 1, 0));
		if (this.showsUsage && input.usage) {
			this.addChild(
				new MetricRow(
					usageRowSpecs(
						input.usage,
						input.durationMs,
						input.ttftMs,
						input.timestamp,
						input.turnElapsedMs,
						input.model,
					),
					{
						separator: "  ",
						overflow: "wrap",
						paddingX: 1,
						paddingY: 0,
						style: value => theme.fg("dim", value),
					},
				),
			);
		}
		this.invalidate();
	}

	/**
	 * One quiet mono line (`18:02 · Δ 6.2s · in 18.4K · out 640 · cache 12K ·
	 * ttft 0.9s · 96 tok/s`): worded metrics instead of the ANSI icons, the
	 * full timestamp in the tooltip, and throughput as a `rate`.
	 */
	override describe(cx?: DescribeContext): NativeNode {
		// The terminal's clock: the process locale doesn't reliably carry the user's 12/24-hour choice.
		const hour12 = cx?.hour12;
		if (this.#nativeNode && this.#nativeHour12 === hour12) return this.#nativeNode;
		this.#nativeHour12 = hour12;
		const children: NativeChild[] = [];
		if (this.#latest && !this.#toolActivityVisible && this.#input.activity) {
			children.push(keyed(text([span(this.#input.activity, "dim")]), "activity"));
		}
		if (this.showsUsage) children.push(keyed(this.#describeUsage(hour12), "usage"));
		this.#nativeNode = withHidden(col(children), children.length === 0);
		return this.#nativeNode;
	}

	#describeUsage(hour12?: boolean): NativeNode {
		const usage = this.#input.usage!;
		const parts: string[] = [];
		const timestamp = this.#input.timestamp;
		const stamped = timestamp !== undefined && Number.isFinite(timestamp) && timestamp > 0;
		// Only a 12-hour clock goes through the locale; 24-hour keeps the tooltip's own `HH:mm`.
		if (stamped) {
			parts.push(
				hour12
					? new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12 })
					: formatUsageTimestamp(timestamp).slice(11, 16),
			);
		}
		if (this.#input.turnElapsedMs !== undefined && this.#input.turnElapsedMs > 0) {
			parts.push(`Δ ${formatDuration(Math.round(this.#input.turnElapsedMs))}`);
		}
		const modelLabel = sanitizeDisplayLineField(this.#input.model);
		if (modelLabel) parts.push(modelLabel);
		parts.push(`in ${formatNumber(usage.input + usage.cacheWrite)}`, `out ${formatNumber(usage.output)}`);
		if (usage.cacheRead > 0) parts.push(`cache ${formatNumber(usage.cacheRead)}`);
		if (this.#input.ttftMs && this.#input.ttftMs > 0) parts.push(`ttft ${(this.#input.ttftMs / 1000).toFixed(1)}s`);
		const children: NativeChild[] = [text([span(parts.join(" · "), "dim")])];
		const tokPerSec = usageThroughput(usage, this.#input.durationMs);
		if (tokPerSec !== undefined) {
			children.push(
				text([span(" · ", "dim")]),
				node("rate", { value: Math.round(tokPerSec * 10) / 10, unit: "tok/s" }),
			);
		}
		return row(children, {
			role: "omp.usage.turn",
			gap: "none",
			align: "baseline",
			...(stamped ? { title: formatUsageTimestamp(timestamp, hour12) } : {}),
		});
	}
}

/** Format the metrics shared by standalone usage blocks and compact tool groups. */
export function formatUsageRow(
	usage: Usage,
	durationMs?: number,
	ttftMs?: number,
	timestamp?: number,
	turnElapsedMs?: number,
	model?: string,
): string {
	return formatMetricRow(usageRowSpecs(usage, durationMs, ttftMs, timestamp, turnElapsedMs, model), {
		separator: "  ",
	});
}

/** Blocks minted by {@link createUsageRowBlock}, so transcript walkers can attribute them to the turn above. */
const usageRowBlocks = new WeakSet<Container>();

/** Whether `component` is a per-turn usage/metrics row from {@link createUsageRowBlock}. */
export function isUsageRowBlock(component: object): boolean {
	return usageRowBlocks.has(component as Container);
}

/** New callers pass the whole footer; positional usage remains source-compatible. */
export function createUsageRowBlock(input: RequestFooterInput): Container;
export function createUsageRowBlock(
	usage: Usage,
	durationMs?: number,
	ttftMs?: number,
	timestamp?: number,
	turnElapsedMs?: number,
	model?: string,
): Container;
export function createUsageRowBlock(
	input: RequestFooterInput | Usage,
	durationMs?: number,
	ttftMs?: number,
	timestamp?: number,
	turnElapsedMs?: number,
	model?: string,
): Container {
	const footer = "input" in input ? { usage: input, durationMs, ttftMs, timestamp, turnElapsedMs, model } : input;
	const block = new UsageRowBlock(footer);
	usageRowBlocks.add(block);
	return block;
}

const latestUsageRows = new WeakMap<TranscriptContainer, UsageRowBlock>();

export function demoteLatestUsageRow(container: TranscriptContainer): void {
	latestUsageRows.get(container)?.demote();
	latestUsageRows.delete(container);
}

/** Rebuilds stage components off-screen before moving them to the live transcript. */
export function transferLatestUsageRow(from: TranscriptContainer, to: TranscriptContainer): void {
	if (from === to) return;
	const staged = latestUsageRows.get(from);
	const existing = latestUsageRows.get(to);
	latestUsageRows.delete(from);
	// Preserved live children may follow the replayed children. Actual transcript
	// order, not which container was staged, determines the newest request.
	const stagedIndex = staged ? to.children.indexOf(staged) : -1;
	const existingIndex = existing ? to.children.indexOf(existing) : -1;
	if (existingIndex > stagedIndex) {
		staged?.demote();
		return;
	}
	existing?.demote();
	latestUsageRows.delete(to);
	if (staged && stagedIndex >= 0) latestUsageRows.set(to, staged);
}

export function appendUsageRow(container: TranscriptContainer, input: RequestFooterInput): void {
	demoteLatestUsageRow(container);
	const block = createUsageRowBlock(input) as UsageRowBlock;
	latestUsageRows.set(container, block);
	container.addChild(block);
}

/** The wait-poll displacement guard cares about current usage, not historical counts. */
export function isUsageRowVisible(component: object): boolean {
	return component instanceof UsageRowBlock && component.showsUsage;
}
