import { beforeAll, describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { appendUsageRow, demoteLatestUsageRow } from "@oh-my-pi/pi-tui/overlays/usage-row";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const width = 120;
const frame = { tick: 0, now: 0 };
const usageMarker = "retirement-usage-model";
const usage: Usage = {
	input: 100,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function block(rows: string[], finalized = true): Component & { isTranscriptBlockFinalized(): boolean } {
	return { render: () => rows, isTranscriptBlockFinalized: () => finalized };
}

function hiddenTranscript(): TranscriptContainer {
	const transcript = new TranscriptContainer();
	transcript.setToolActivityVisible(false);
	appendUsageRow(transcript, { activity: "2 reads", usage, model: usageMarker });
	return transcript;
}

function viewport(transcript: TranscriptContainer, capacity: number): readonly string[] {
	transcript.beginFrame(frame);
	return transcript.renderViewport(width, capacity, frame);
}

beforeAll(async () => {
	await initTheme(false);
});

describe("request footer retirement", () => {
	it("preserves later rows when a fully committed footer is demoted and replays no stale footer", () => {
		const transcript = hiddenTranscript();
		const following = Array.from({ length: 8 }, (_, index) => `following-${index}`);
		transcript.addChild(block(following));

		const committed = transcript.peekFinalizedBatch(width, 3)!;
		expect(committed.rows.join("\n")).toContain(usageMarker);
		transcript.acknowledgeFinalizedBatch(committed.id);
		demoteLatestUsageRow(transcript);

		const rest = transcript.peekFlushBatch(width)!;
		transcript.acknowledgeFinalizedBatch(rest.id);
		const written = [...committed.rows, ...rest.rows];
		for (const row of following) expect(written.filter(value => value === row)).toHaveLength(1);
		expect(viewport(transcript, 3)).toEqual([]);

		// A user-triggered reset omits the stale footer; already-written scrollback is not rewritten.
		transcript.beginReplay();
		const replay = transcript.peekFinalizedBatch(width, 3)!;
		expect(replay.rows.join("\n")).not.toContain("2 reads");
		expect(replay.rows.join("\n")).not.toContain(usageMarker);
		for (const row of following) expect(replay.rows.filter(value => value === row)).toHaveLength(1);
		transcript.acknowledgeFinalizedBatch(replay.id);
		expect(viewport(transcript, 3)).toEqual([]);
	});

	it("drops the remaining footer when its activity row already crossed the top edge", () => {
		const transcript = hiddenTranscript();
		transcript.addChild(block(["next request"], false));
		// Two footer rows, a separator and one live row: only the activity row is offscreen.
		const head = transcript.peekFinalizedBatch(width, 3)!;
		expect(head.rows.join("\n")).toContain("2 reads");
		expect(head.rows.join("\n")).not.toContain(usageMarker);
		transcript.acknowledgeFinalizedBatch(head.id);

		demoteLatestUsageRow(transcript);
		const remainder = transcript.peekFinalizedBatch(width, 1);
		if (remainder) {
			expect(remainder.rows.join("\n")).not.toContain(usageMarker);
			expect(remainder.rows.join("\n")).not.toContain("2 reads");
			transcript.acknowledgeFinalizedBatch(remainder.id);
		}
		expect(viewport(transcript, 1)).toEqual(["next request"]);
		expect(transcript.peekFinalizedBatch(width, 1)).toBeUndefined();
	});

	it("does not commit stale activity or usage while a long answer streams after demotion", () => {
		const transcript = hiddenTranscript();
		expect(viewport(transcript, 4).join("\n")).toContain(usageMarker);

		// Message start demotes before the streaming answer is inserted.
		demoteLatestUsageRow(transcript);
		const answer = Array.from({ length: 20 }, (_, index) => `answer-${index}`);
		transcript.addChild(block(answer, false));
		const history = transcript.peekFinalizedBatch(width, 4);
		if (history) {
			expect(history.rows.join("\n")).not.toContain("2 reads");
			expect(history.rows.join("\n")).not.toContain(usageMarker);
			transcript.acknowledgeFinalizedBatch(history.id);
		}
		expect(viewport(transcript, 4)).toEqual(answer.slice(-4));
		expect(transcript.peekFinalizedBatch(width, 4)).toBeUndefined();
	});
});
