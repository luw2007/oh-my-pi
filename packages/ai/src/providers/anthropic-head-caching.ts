import type { TextBlockParam, Tool as AnthropicWireTool } from "./anthropic-wire";

type AnthropicCacheControl = NonNullable<TextBlockParam["cache_control"]>;
type AnthropicSystemBlock = {
	type: "text";
	text: string;
	cache_control?: AnthropicCacheControl;
};

const PROJECT_CONTEXT_MARKER = "<project-context>";
const VOLATILE_SYSTEM_SEGMENT_MARKERS = ["<memories>", PROJECT_CONTEXT_MARKER];

function volatileSystemSuffixStart(systemBlocks: readonly AnthropicSystemBlock[]): number {
	const start = systemBlocks.findIndex(block =>
		VOLATILE_SYSTEM_SEGMENT_MARKERS.some(marker => block.text.startsWith(marker)),
	);
	return start === -1 ? systemBlocks.length : start;
}

/**
 * Anchor cache_control on the stable request head — the last (non-deferred)
 * tool definition and the last stable system block. The canonical cache order is
 * tools → system → messages, so a breakpoint on the final stable system block caches
 * the entire tools+stable-system prefix, and the extra tool breakpoint keeps the tool
 * definitions cached even when the system text changes.
 *
 * Volatile memory-recall and project-context system segments sit after the
 * breakpoint, so their refresh re-bills only the suffix and message tail.
 */
export function applyHeadCaching(
	systemBlocks: AnthropicSystemBlock[] | undefined,
	tools: AnthropicWireTool[] | undefined,
	cacheControl?: AnthropicCacheControl,
	messageCount = 0,
): void {
	if (!cacheControl) return;

	if (tools && tools.length > 0 && !tools.some(tool => tool.cache_control != null)) {
		// Deferred tools are not part of the checked prefix until referenced, so
		// anchor the last tool that actually sits in the stable prefix.
		for (let index = tools.length - 1; index >= 0; index--) {
			const tool = tools[index];
			if (!tool || tool.defer_loading) continue;
			tool.cache_control = { ...cacheControl };
			break;
		}
	}

	if (systemBlocks && systemBlocks.length > 0) {
		// Anchor on the last block before the volatile suffix so a recall
		// refresh or a different working directory re-bills only the suffix,
		// not the whole head. An earlier system breakpoint (the OAuth identity
		// block) moves to the anchor rather than staying as a second one.
		const suffixStart = volatileSystemSuffixStart(systemBlocks);
		const anchorIndex = suffixStart === 0 ? systemBlocks.length - 1 : suffixStart - 1;
		const anchor = systemBlocks[anchorIndex];
		if (anchor && anchor.cache_control == null) {
			for (const block of systemBlocks) delete block.cache_control;
			anchor.cache_control = { ...cacheControl };
		}
		// A single message leaves the rolling budget free (the head takes at most two
		// slots), so anchor the working-directory footer: a new session or a
		// compaction then reads it instead of writing it. Only the footer qualifies —
		// per-turn recall changes between requests, so anchoring it would spend the
		// slot on bytes that never repeat. Multi-message requests keep the previous
		// placement; their own tail entry covers the footer.
		const last = systemBlocks[systemBlocks.length - 1];
		if (
			messageCount === 1 &&
			suffixStart > 0 &&
			last !== anchor &&
			last?.text.startsWith(PROJECT_CONTEXT_MARKER) &&
			last.cache_control == null
		) {
			last.cache_control = { ...cacheControl };
		}
	}
}
