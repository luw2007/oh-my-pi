import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __collectLegacyPiExtensionSourcesForTests } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempRoots: string[] = [];

afterAll(async () => {
	for (const dir of tempRoots) {
		await removeWithRetries(dir);
	}
});

describe("legacy extension graph walk realpaths", () => {
	it("keys modules by realpath through symlinked files and directories", async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-graph-realpath-")));
		tempRoots.push(root);
		const ext = path.join(root, "ext");
		const shared = path.join(root, "shared");
		fs.mkdirSync(ext);
		fs.mkdirSync(shared);
		fs.writeFileSync(path.join(shared, "a.ts"), 'import { b } from "./b.ts";\nexport const a = b;\n');
		fs.writeFileSync(path.join(shared, "b.ts"), "export const b = 1;\n");
		fs.writeFileSync(path.join(root, "target.ts"), "export const t = 2;\n");
		// pnpm/`bun link` style directory symlink plus a symlinked leaf file.
		fs.symlinkSync(shared, path.join(ext, "linked"));
		fs.symlinkSync(path.join(root, "target.ts"), path.join(ext, "leaf.ts"));
		fs.writeFileSync(
			path.join(ext, "index.ts"),
			'import { a } from "./linked/a.ts";\nimport { t } from "./leaf.ts";\nexport default a + t;\n',
		);

		const modules = await __collectLegacyPiExtensionSourcesForTests(path.join(ext, "index.ts"));

		expect([...modules.keys()].sort()).toEqual(
			[
				path.join(ext, "index.ts"),
				path.join(root, "target.ts"),
				path.join(shared, "a.ts"),
				path.join(shared, "b.ts"),
			].sort(),
		);
	});

	it("resolves each directory once instead of every module file", async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-graph-realpath-count-")));
		tempRoots.push(root);
		const fileCount = 40;
		const lib = path.join(root, "lib");
		fs.mkdirSync(lib);
		for (let i = 0; i < fileCount; i++) {
			fs.writeFileSync(path.join(lib, `m${i}.ts`), `export const v${i} = ${i};\n`);
		}
		fs.writeFileSync(
			path.join(root, "index.ts"),
			Array.from({ length: fileCount }, (_, i) => `export * from "./lib/m${i}.ts";`).join("\n"),
		);

		// `realpath` opens the file on macOS, which endpoint security scanners
		// intercept; per-file calls dominated startup for large extension graphs.
		const realpathSpy = spyOn(fs.promises, "realpath");
		try {
			const modules = await __collectLegacyPiExtensionSourcesForTests(path.join(root, "index.ts"));
			expect(modules.size).toBe(fileCount + 1);
			expect(realpathSpy.mock.calls.length).toBeLessThan(fileCount);
		} finally {
			realpathSpy.mockRestore();
		}
	});
});
