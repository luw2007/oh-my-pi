import { afterEach, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import { defaultEditorTheme } from "./test-themes";

afterEach(() => setKittyProtocolActive(false));

it("restores the current line after Command+Backspace with Ctrl+Z", () => {
	setKittyProtocolActive(true);
	const editor = new Editor(defaultEditorTheme);
	editor.setText("first line\nsecond line");
	editor.handleInput("\x1b[127;9u"); // Command+Backspace
	expect(editor.getText()).toBe("first line\n");
	editor.handleInput("\x1a"); // Ctrl+Z
	expect(editor.getText()).toBe("first line\nsecond line");
});
