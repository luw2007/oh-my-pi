import { OutputSink, type OutputSummary } from "../src/tools/streaming-output";

// Run independently: bun packages/tui/bench/output-sink.bench.ts
// No artifactPath: all samples exercise in-memory capture only.
const WARMUPS = 2;
const SAMPLES = 5;
const COLUMN_CAP = 512;
const MIB = 1024 * 1024;

interface Workload {
	name: string;
	chunks: string[];
	input: string;
	cappedOutput: string;
	cappedLines: number;
	lines: number;
}

function lineWorkload(name: string, line: string, cappedLine: string, lines: number): Workload {
	const chunk = `${line}\n`;
	return {
		name,
		chunks: Array.from({ length: lines }, () => chunk),
		input: chunk.repeat(lines),
		cappedOutput: `${cappedLine}\n`.repeat(lines),
		cappedLines: line === cappedLine ? 0 : lines,
		lines,
	};
}

// Distinct content prevents benchmarking only repeated references to one tiny string.
const tinyInput = Array.from(
	{ length: 4096 },
	(_, index) => `${String(index).padStart(8, "0")}${"a".repeat(392)}\n`,
).join("");
function chunkWorkload(size: number): Workload {
	const chunks: string[] = [];
	for (let offset = 0; offset < tinyInput.length; offset += size) chunks.push(tinyInput.slice(offset, offset + size));
	return {
		name: `400-char ASCII / ${size === 16 ? "16-codeunit chunks" : "16-KiB chunks"}`,
		chunks,
		input: tinyInput,
		cappedOutput: tinyInput,
		cappedLines: 0,
		lines: 4096,
	};
}

const workloads = [
	// At 400 bytes these fit 512, despite exceeding the old 3x conservative bound.
	lineWorkload("400-char ASCII lines", "a".repeat(400), "a".repeat(400), 4096),
	lineWorkload("8192-char ASCII lines", "a".repeat(8192), `${"a".repeat(509)}…`, 1024),
	// UTF-8 boundaries leave two unused bytes: 169 * 3 + 3 = 510.
	lineWorkload("8192-char CJK lines", "界".repeat(8192), `${"界".repeat(169)}…`, 512),
	chunkWorkload(16),
	chunkWorkload(16 * 1024),
];

function assertEqual(actual: unknown, expected: unknown, context: string): void {
	if (actual !== expected) throw new Error(`${context}: expected ${String(expected)}, received ${String(actual)}`);
}

function check(summary: OutputSummary, workload: Workload, cap: number): void {
	const expected = cap > 0 ? workload.cappedOutput : workload.input;
	const cutLines = cap > 0 ? workload.cappedLines : 0;
	const context = `${workload.name} / maxColumns=${cap}`;
	assertEqual(summary.output, expected, `${context} output`);
	assertEqual(summary.totalBytes, Buffer.byteLength(workload.input), `${context} totalBytes`);
	assertEqual(summary.outputBytes, Buffer.byteLength(expected), `${context} outputBytes`);
	assertEqual(summary.totalLines, workload.lines + 1, `${context} totalLines`);
	assertEqual(summary.outputLines, workload.lines + 1, `${context} outputLines`);
	assertEqual(summary.truncated, false, `${context} window truncation`);
	assertEqual(summary.columnTruncatedLines ?? 0, cutLines, `${context} columnTruncatedLines`);
	assertEqual(
		summary.columnDroppedBytes ?? 0,
		Buffer.byteLength(workload.input) - Buffer.byteLength(expected) + cutLines * 3,
		`${context} columnDroppedBytes`,
	);
	assertEqual(summary.columnMax, cutLines > 0 ? cap : undefined, `${context} columnMax`);
	assertEqual(summary.columnTruncatedRange?.first, cutLines > 0 ? 1 : undefined, `${context} first cut line`);
	assertEqual(
		summary.columnTruncatedRange?.last,
		cutLines > 0 ? workload.lines : undefined,
		`${context} last cut line`,
	);
	assertEqual(summary.artifactId, undefined, `${context} artifactId`);
	assertEqual(summary.artifactError, undefined, `${context} artifactError`);
}

function median(values: number[]): number {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

console.log(`OutputSink: ${WARMUPS} warmups, ${SAMPLES} samples; push + dump, no artifact I/O`);
for (const workload of workloads) {
	const inputBytes = Buffer.byteLength(workload.input);
	for (const maxColumns of [COLUMN_CAP, 0]) {
		const wall: number[] = [];
		const cpu: number[] = [];
		for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
			// Retain the entire result, isolating column caps from rolling-tail truncation.
			const sink = new OutputSink({ maxColumns, spillThreshold: inputBytes + 1024 });
			const cpuStart = process.cpuUsage();
			const start = Bun.nanoseconds();
			for (const chunk of workload.chunks) sink.push(chunk);
			const summary = await sink.dump();
			const elapsed = (Bun.nanoseconds() - start) / 1e6;
			const usage = process.cpuUsage(cpuStart);
			// Assertions and input construction are outside the timed region.
			check(summary, workload, maxColumns);
			if (sample >= 0) {
				wall.push(elapsed);
				cpu.push((usage.user + usage.system) / 1000);
			}
		}
		console.log(
			`${workload.name} | maxColumns=${maxColumns} | input UTF-8 ${(inputBytes / MIB).toFixed(2)} MiB | median wall ${median(wall).toFixed(2)} ms | median CPU ${median(cpu).toFixed(2)} ms`,
		);
	}
}
