import { describe, expect, it } from "bun:test";
import { toolRenderers } from "../src/tools";
import type { ToolActivityKind } from "../src/tools/renderer";

describe("tool activity taxonomy", () => {
	it("keeps built-in calls in the footer's semantic buckets", () => {
		const groups: Record<ToolActivityKind, string[]> = {
			agent: ["task", "vibe_spawn"],
			edit: ["edit", "apply_patch", "ast_edit", "write"],
			command: ["bash", "eval", "debug"],
			search: ["grep", "glob", "find", "ast_grep", "web_search", "recall", "lsp"],
			read: ["read"],
		};
		for (const kind of Object.keys(groups) as ToolActivityKind[]) {
			for (const name of groups[kind]) {
				expect(toolRenderers[name]?.activityTally?.({})?.kind).toBe(kind);
			}
		}
		expect(toolRenderers.read?.activityTally?.({ path: "https://example.com" })).toEqual({ kind: "read" });
	});

	it("classifies rename actions as edits instead of searches, including device writes", () => {
		for (const action of ["references", "rename", "rename_file"]) {
			const expected = { kind: action === "references" ? "search" : "edit" } satisfies { kind: ToolActivityKind };
			expect(toolRenderers.lsp?.activityTally?.({ action })).toEqual(expected);
			expect(
				toolRenderers.write?.activityTally?.({ path: "xd://lsp", content: JSON.stringify({ action }) }),
			).toEqual(expected);
		}
		expect(toolRenderers.write?.activityTally?.({ path: "xd://task", content: '{"tasks":[{},{},{}]}' })).toEqual({
			kind: "agent",
			count: 3,
		});
	});

	it("counts task batch members, not the single dispatch call", () => {
		expect(toolRenderers.task?.activityTally?.({ task: "single" })).toEqual({ kind: "agent", count: 1 });
		expect(toolRenderers.task?.activityTally?.({ tasks: [{}, {}, {}, {}] })).toEqual({ kind: "agent", count: 4 });
		expect(toolRenderers.task?.activityTally?.({ tasks: [] })).toEqual({ kind: "agent", count: 0 });
	});

	it("leaves messaging, lifecycle, memory mutation and unknown devices generic", () => {
		for (const name of [
			"retain",
			"reflect",
			"wait",
			"todo",
			"ask",
			"think",
			"yield",
			"github",
			"vibe_send",
			"vibe_wait",
			"vibe_kill",
			"vibe_list",
		]) {
			expect(toolRenderers[name]?.activityTally?.({})).toBeUndefined();
		}
		for (const path of ["agent://peer", "proc://job", "cfg://settings", "xd://unregistered", "xd://retain"]) {
			expect(toolRenderers.write?.activityTally?.({ path, content: "{}" })).toBeUndefined();
		}
	});
});
