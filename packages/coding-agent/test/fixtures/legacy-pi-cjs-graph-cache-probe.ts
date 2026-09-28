import { spyOn } from "bun:test";
import * as parser from "@babel/parser";
import { __collectLegacyPiExtensionSourcesForTests } from "../../src/extensibility/plugins/legacy-pi-compat";

const [entryPath] = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
const parseSpy = spyOn(parser, "parse");
try {
	const modules = await __collectLegacyPiExtensionSourcesForTests(entryPath);
	if (process.argv.includes("--expect-cache-hit") && parseSpy.mock.calls.length !== 0) {
		throw new Error(`Warm CommonJS graph walk reparsed ${parseSpy.mock.calls.length} source(s)`);
	}
	process.stdout.write(`${modules.size}\n`);
} finally {
	parseSpy.mockRestore();
}
