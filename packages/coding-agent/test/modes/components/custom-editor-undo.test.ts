import { beforeAll, describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme(false);
});

describe("composer undo", () => {
	it("recovers a cleared draft with its attachment payloads", () => {
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		const editor = new CustomEditor(getEditorTheme());
		editor.setDraft("look [Image #1]", [image]);
		editor.insertTextAttachment("important paste");
		const original = editor.getExpandedText();
		editor.clearDraftForRecall();
		expect(editor.getText()).toBe("");

		editor.handleInput("\x1a");
		expect(editor.getExpandedText()).toBe(original);
		expect(editor.composerChips().map(chip => chip.kind)).toEqual(["image", "paste"]);
	});

	it("rebuilds a pending image link when undo restores a cleared draft", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		const first = Promise.withResolvers<(string | undefined)[]>();
		const restored = Promise.withResolvers<(string | undefined)[]>();
		let calls = 0;
		editor.draftImageLinkMaterializer = () => (++calls === 1 ? first.promise : restored.promise);
		editor.setDraft("[Image #1]", [image]);
		editor.clearDraftUndoably();
		editor.handleInput("\x1a");
		restored.resolve(["file:///tmp/restored.png"]);
		await restored.promise;
		const chip = editor.composerChips()[0];
		expect(chip?.kind).toBe("image");
		if (chip?.kind === "image") expect(chip.link).toBe("file:///tmp/restored.png");
	});

	it("recovers a draft cleared beneath an Ask overlay", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.handleInput("unfinished response");
		editor.handleDraftEdit("\x03");
		expect(editor.getText()).toBe("");
		editor.handleDraftEdit("\x1a");
		expect(editor.getText()).toBe("unfinished response");
	});

	it("does not revive an already submitted draft", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("sent response");
		editor.clearDraft("sent response");
		editor.handleInput("\x1a");
		expect(editor.getText()).toBe("");
	});
});
