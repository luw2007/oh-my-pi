import * as path from "node:path";
// Deep import: the pi-utils barrel loads the host native addon, which is
// absent on cross-compiling release runners.
import { USER_AGENT, validateBuildTag } from "@oh-my-pi/pi-utils/dirs";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { embeddedAddonFiles, type NativeEmbedTarget } from "../../natives/scripts/embed-native";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { createJsonParsePlugin } from "./json-parse-plugin";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";

/** Native runtime dependencies always resolved from the on-demand install instead of embedded into compiled binaries. */
export const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = Object.freeze(["fastembed", "onnxruntime-node"]);

/**
 * Process environment a Pi-Bolt runtime (https://github.com/opensec-git/Pi-Bolt) needs while it compiles an
 * ahead-of-time image: static heap, machine code for every function, JIT off at run time, no bytecode kept in
 * the heap, and loop splitting. JSC reads the `BUN_JSC_*` options at process start, so the build must be
 * launched with them rather than set them in-process.
 */
export const AOT_BUILD_ENV: Readonly<Record<string, string>> = Object.freeze({
	BUN_STATIC_HEAP: "1",
	BUN_AOT: "1",
	BUN_AOT_JIT: "0",
	BUN_JSC_omitBytecodeFromStaticHeap: "1",
	BUN_JSC_useAOTLoopSplitting: "1",
	BUN_JSC_aotLoopSplittingPolicy: "5",
});

/**
 * A shared chunk is one module to JSC; once its first-party code passes this size its top-level function
 * exceeds the AOT compiler's candidate limit and the whole chunk stays uncompiled. Promoting such a chunk's
 * source modules to entrypoints splits it into per-module chunks the compiler accepts.
 */
const AOT_SPLIT_CHUNK_BYTES = 1 << 20;

/**
 * `bytecodeOrder` is what makes the Pi-Bolt runtime link the static heap and code image. A profile that
 * names no real function keeps the bundler's default layout; on omp it boots as fast as a trained profile.
 */
const AOT_LAYOUT_PROFILE = "v2\nF 0000000000000000\n";

/** Inputs shared by local and release coding-agent binary builds. */
export interface CodingAgentCompileOptions {
	/** Absolute repository root used for package resolution. */
	readonly repoRoot: string;
	/** Absolute CLI entrypoint. */
	readonly entrypoint: string;
	/** Absolute standalone executable output path. */
	readonly outfile: string;
	/** Concrete Transformers.js version baked into the tiny-model worker. */
	readonly transformersVersion: string;
	/**
	 * Native addon target embedded for the runtime loader to extract; `null`
	 * compiles without one (probe builds that never load the addon).
	 */
	readonly native: NativeEmbedTarget | null;
	/** Optional cross-compilation runtime target. */
	readonly target?: Bun.Build.CompileTarget;
	/** Optional unmodified Bun executable used as the standalone runtime template. */
	readonly executablePath?: string;
	/** Match release builds that minify identifiers while retaining names. */
	readonly minifyIdentifiers?: boolean;
	/** Disable Bun's built-in Darwin signing before the caller re-signs. */
	readonly skipBuiltinCodesign?: boolean;
	/** Optional local owner tag shown after `@` by the compiled CLI version command. */
	readonly buildTag?: string;
	/**
	 * Compile an ahead-of-time image. The calling process must be a Pi-Bolt runtime started with
	 * {@link AOT_BUILD_ENV}; AOT images target the host platform only.
	 */
	readonly aot?: boolean;
}

/** First-party source modules of the shared chunks too large for the AOT compiler, as absolute paths. */
async function aotSplitEntrypoints(config: Bun.BuildConfig, repoRoot: string): Promise<string[]> {
	const { compile: _compile, ...bundleConfig } = config;
	const output = await Bun.build({ ...bundleConfig, target: "bun", bytecode: false, metafile: true });
	if (!output.success || !output.metafile) {
		throw new Error(`Coding-agent AOT split analysis failed:\n${output.logs.map(log => log.message).join("\n")}`);
	}
	// Metafile input paths are relative to the process cwd, not to `root`.
	const packagesDir = path.join(repoRoot, "packages") + path.sep;
	const entrypoints = new Set<string>();
	for (const chunk of Object.values(output.metafile.outputs)) {
		if (chunk.entryPoint) continue;
		const sources = Object.entries(chunk.inputs)
			.map(([input, contribution]) => [path.resolve(input), contribution.bytesInOutput] as const)
			.filter(([source, bytes]) => source.startsWith(packagesDir) && /\.tsx?$/.test(source) && bytes > 0);
		const sourceBytes = sources.reduce((total, [, bytes]) => total + bytes, 0);
		if (sourceBytes < AOT_SPLIT_CHUNK_BYTES) continue;
		for (const [source] of sources) entrypoints.add(source);
	}
	if (entrypoints.size === 0) throw new Error("Coding-agent AOT split analysis found no first-party chunk to split");
	return [...entrypoints];
}

/**
 * Compile the coding-agent executable with its legacy Pi compatibility module
 * graph supplied by an in-memory build plugin rather than generated files.
 */
export async function compileCodingAgent(options: CodingAgentCompileOptions): Promise<void> {
	const buildTag = validateBuildTag(options.buildTag);
	if (options.aot) {
		// The image is built by and for the running Pi-Bolt runtime; a cross target or another template drops it.
		if (options.target || options.executablePath) {
			throw new Error("AOT compile embeds the running Pi-Bolt runtime; target and executablePath are unsupported");
		}
		const missing = Object.entries(AOT_BUILD_ENV).filter(([key, value]) => Bun.env[key] !== value);
		if (missing.length > 0) {
			throw new Error(
				`AOT compile must run on a Pi-Bolt runtime started with ${missing.map(([key, value]) => `${key}=${value}`).join(" ")}`,
			);
		}
	}
	const previousCodesignSetting = Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
	if (options.skipBuiltinCodesign) {
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = "1";
	}
	await using aotDir = options.aot ? TempDir.createSync("@omp-aot-") : undefined;
	try {
		const compile: Bun.CompileBuildOptions & { bytecodeOrder?: string } = {
			// Bun's process-wide fetch User-Agent default. Any explicit
			// provider fingerprint (Anthropic/Codex OAuth) still wins.
			execArgv: [`--user-agent=${USER_AGENT}`],
			...(options.executablePath
				? { executablePath: options.executablePath }
				: options.target
					? { target: options.target }
					: {}),
			outfile: options.outfile,
			autoloadBunfig: false,
			autoloadDotenv: false,
			autoloadTsconfig: false,
			autoloadPackageJson: false,
		};
		const config = {
			entrypoints: [options.entrypoint],
			root: options.repoRoot,
			external: [...COMPILED_EXTERNAL_DEPENDENCIES],
			files: options.native ? await embeddedAddonFiles(options.native) : {},
			define: {
				"process.env.PI_COMPILED": JSON.stringify("true"),
				"process.env.PI_TINY_TRANSFORMERS_VERSION": JSON.stringify(options.transformersVersion),
				"process.env.PI_DOCS_EMBED": JSON.stringify((await buildDocsIndexPayload()).payload),
				"process.env.PI_BUILD_TAG": JSON.stringify(buildTag ?? ""),
			},
			// Precompiled bytecode skips parsing the ~20 MB bundle at boot:
			// `omp --version` 256 ms -> 30 ms on M4 Max (+52 MB binary).
			// Keep import.meta.resolve in bundled dependencies valid under bytecode.
			format: "esm",
			bytecode: true,
			splitting: true,
			// Discovery entry chunks can share a hash; include their source names to avoid collisions.
			naming: { chunk: "chunks/[name]-[hash].[ext]" },
			minify: {
				identifiers: options.minifyIdentifiers ?? false,
				keepNames: true,
			},
			plugins: [createJsonParsePlugin(), await createLegacyPiVirtualModulePlugin()],
			compile,
			throw: false,
		} satisfies Bun.BuildConfig;
		if (aotDir) {
			config.entrypoints.push(...(await aotSplitEntrypoints(config, options.repoRoot)));
			compile.bytecodeOrder = aotDir.join("bytecode.order");
			await Bun.write(compile.bytecodeOrder, AOT_LAYOUT_PROFILE);
		}
		const output = await Bun.build(config);
		if (!output.success) {
			throw new Error(`Coding-agent binary bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
		}
	} finally {
		if (previousCodesignSetting === undefined) {
			delete Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
		} else {
			Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = previousCodesignSetting;
		}
	}
}
