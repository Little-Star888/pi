import { existsSync, globSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { readPiManifest } from "./pi-manifest.ts";

const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export interface PackageResourceFilter {
	autoload?: boolean;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

interface PackageResourceResolution {
	handled: boolean;
	resources: Record<ResourceType, Map<string, boolean>>;
}

type SkillDiscoveryMode = "pi" | "agents";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

type ResourceRule =
	| { kind: "source"; value: string; isGlob: boolean }
	| { kind: "exclude"; value: string }
	| { kind: "force-include"; value: string }
	| { kind: "force-exclude"; value: string };

function parseResourceRule(entry: string): ResourceRule {
	if (entry.startsWith("!")) return { kind: "exclude", value: entry.slice(1) };
	if (entry.startsWith("+")) return { kind: "force-include", value: entry.slice(1) };
	if (entry.startsWith("-")) return { kind: "force-exclude", value: entry.slice(1) };
	return { kind: "source", value: entry, isGlob: entry.includes("*") || entry.includes("?") };
}

function normalizePattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalized);
}

/** Glob entries discover visible paths; exact entries can target dot paths or symlinked trees. */
function expandPackageGlob(pattern: string, root: string): string[] {
	return globSync(pattern, { cwd: root })
		.map((match) => resolve(root, match))
		.filter((path) =>
			relative(root, path)
				.split(sep)
				.every((segment) => segment === ".." || !segment.startsWith(".")),
		)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function discoverFiles(
	dir: string,
	filePattern: RegExp,
	recursive: boolean,
	skipNodeModules = true,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (skipNodeModules && entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isDir && recursive) {
				files.push(...discoverFiles(fullPath, filePattern, true, skipNodeModules, ig, root));
			} else if (isFile && filePattern.test(entry.name)) {
				files.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return files;
}

function discoverSkills(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });

		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (isFile && !ig.ignores(relPath)) {
				entries.push(fullPath);
				return entries;
			}
		}

		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const shouldIncludeMarkdownFile =
				isFile &&
				entry.name.endsWith(".md") &&
				!ig.ignores(relPath) &&
				((mode === "pi" && dir === root) || (mode === "agents" && dir !== root));
			if (shouldIncludeMarkdownFile) {
				entries.push(fullPath);
				continue;
			}

			if (!isDir) continue;
			if (ig.ignores(`${relPath}/`)) continue;

			entries.push(...discoverSkills(fullPath, mode, ig, root));
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function resolveExtensionEntries(dir: string): string[] | null {
	const manifest = readPiManifest(join(dir, "package.json"));
	if (manifest?.extensions !== undefined) {
		return resolveManifestResources(manifest.extensions, dir, "extensions");
	}

	const indexTs = join(dir, "index.ts");
	const indexJs = join(dir, "index.js");
	if (existsSync(indexTs)) {
		return [indexTs];
	}
	if (existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

function discoverExtensionDirectoryContents(dir: string): string[] {
	const entries: string[] = [];
	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isFile && /\.(ts|js)$/.test(entry.name)) {
				entries.push(fullPath);
			} else if (isDir) {
				const resolvedEntries = resolveExtensionEntries(fullPath);
				if (resolvedEntries) {
					entries.push(...resolvedEntries);
				}
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

export function discoverExtensionsInDir(dir: string): string[] {
	if (!existsSync(dir)) return [];

	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	return discoverExtensionDirectoryContents(dir);
}

export function resolveResourcesInDirectory(
	dir: string,
	resourceType: ResourceType,
	options: { recursive?: boolean; skillMode?: SkillDiscoveryMode } = {},
): string[] {
	switch (resourceType) {
		case "extensions":
			return discoverExtensionsInDir(dir);
		case "skills":
			return discoverSkills(dir, options.skillMode ?? "pi");
		case "prompts":
			return discoverFiles(dir, /\.md$/, options.recursive ?? false);
		case "themes":
			return discoverFiles(dir, /\.json$/, options.recursive ?? false);
	}
}

function matchesAnyPattern(filePath: string, rules: ResourceRule[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentName = isSkillFile ? basename(parentDir!) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return rules.some((rule) => {
		const normalizedPattern = normalizePattern(rule.value);
		if (
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern)
		) {
			return true;
		}
		if (!isSkillFile) return false;
		return (
			minimatch(parentRel!, normalizedPattern) ||
			minimatch(parentName!, normalizedPattern) ||
			minimatch(parentDirPosix!, normalizedPattern)
		);
	});
}

function matchesAnyExactPattern(filePath: string, rules: ResourceRule[], baseDir: string): boolean {
	if (rules.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return rules.some((rule) => {
		const normalized = normalizePattern(rule.value);
		if (normalized === rel || normalized === filePathPosix) {
			return true;
		}
		if (!isSkillFile) return false;
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

export function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	const rules = patterns.map(parseResourceRule).filter((rule) => rule.kind !== "source");
	return selectResourcePaths([filePath], rules, baseDir).has(filePath);
}

function selectResourcePaths(allPaths: string[], rules: ResourceRule[], baseDir: string): Set<string> {
	const includes = rules.filter((rule) => rule.kind === "source");
	const excludes = rules.filter((rule) => rule.kind === "exclude");
	const forceIncludes = rules.filter((rule) => rule.kind === "force-include");
	const forceExcludes = rules.filter((rule) => rule.kind === "force-exclude");

	let result =
		includes.length === 0
			? [...allPaths]
			: allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));

	if (excludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
	}

	if (forceIncludes.length > 0) {
		for (const filePath of allPaths) {
			if (!result.includes(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
				result.push(filePath);
			}
		}
	}

	if (forceExcludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir));
	}

	return new Set(result);
}

function resolveResourceFilter(allPaths: string[], patterns: string[], baseDir: string): Map<string, boolean> {
	const enabledPaths = selectResourcePaths(allPaths, patterns.map(parseResourceRule), baseDir);
	return new Map(allPaths.map((path) => [path, enabledPaths.has(path)]));
}

function resolveAutoloadDisabledResources(
	allPaths: string[],
	patterns: string[],
	baseDir: string,
): Map<string, boolean> {
	const result = new Map<string, boolean>();
	for (const rule of patterns.map(parseResourceRule)) {
		const enabled = rule.kind === "source" || rule.kind === "force-include";
		const exact = rule.kind === "force-include" || rule.kind === "force-exclude";
		for (const filePath of allPaths) {
			if (exact ? matchesAnyExactPattern(filePath, [rule], baseDir) : matchesAnyPattern(filePath, [rule], baseDir)) {
				result.set(filePath, enabled);
			}
		}
	}
	return result;
}

function resolveResourcePaths(paths: string[], resourceType: ResourceType, manifestRoot?: string): string[] {
	const files: string[] = [];
	const resolvedManifestRoot = manifestRoot ? resolve(manifestRoot) : undefined;
	for (const path of paths) {
		if (!existsSync(path)) continue;

		try {
			const stats = statSync(path);
			if (stats.isFile()) {
				files.push(path);
			} else if (stats.isDirectory()) {
				if (resourceType === "extensions" && resolvedManifestRoot === resolve(path)) {
					files.push(...discoverExtensionDirectoryContents(path));
				} else {
					files.push(...resolveResourcesInDirectory(path, resourceType, { recursive: true }));
				}
			}
		} catch {
			// Ignore errors
		}
	}
	return files;
}

export function resolveConfiguredResources(
	entries: string[],
	resourceType: ResourceType,
	baseDir: string,
	resolveEntry: (entry: string) => string,
): Map<string, boolean> {
	const rules = entries.map(parseResourceRule);
	const sourcePaths = rules
		.filter((rule) => rule.kind === "source" && !rule.isGlob)
		.map((rule) => resolveEntry(rule.value));
	const allPaths = resolveResourcePaths(sourcePaths, resourceType);
	const selectionRules = rules.filter((rule) => rule.kind !== "source" || rule.isGlob);
	const enabledPaths = selectResourcePaths(allPaths, selectionRules, baseDir);
	return new Map(allPaths.map((path) => [path, enabledPaths.has(path)]));
}

/** Resolve one manifest resource array to the concrete files it selects. */
function resolveManifestResources(entries: string[], root: string, resourceType: ResourceType): string[] {
	const rules = entries.map(parseResourceRule);
	const resolved = rules.flatMap((rule) => {
		if (rule.kind !== "source") {
			return [];
		}
		if (rule.isGlob) {
			return expandPackageGlob(rule.value, root);
		}
		return [resolve(root, rule.value)];
	});
	const allFiles = resolveResourcePaths(resolved, resourceType, root);
	return Array.from(
		selectResourcePaths(
			allFiles,
			rules.filter((rule) => rule.kind !== "source"),
			root,
		),
	);
}

function createPackageResourceMaps(): Record<ResourceType, Map<string, boolean>> {
	return {
		extensions: new Map(),
		skills: new Map(),
		prompts: new Map(),
		themes: new Map(),
	};
}

export function resolvePackageResources(
	packageRoot: string,
	filter?: PackageResourceFilter,
): PackageResourceResolution {
	const resources = createPackageResourceMaps();
	const manifest = readPiManifest(join(packageRoot, "package.json"));
	const resolveDefault = (resourceType: ResourceType): string[] => {
		const entries = manifest?.[resourceType];
		if (entries !== undefined) {
			return resolveManifestResources(entries, packageRoot, resourceType);
		}
		const conventionDir = join(packageRoot, resourceType);
		return existsSync(conventionDir)
			? resolveResourcesInDirectory(conventionDir, resourceType, { recursive: true })
			: [];
	};

	if (filter) {
		for (const resourceType of RESOURCE_TYPES) {
			const patterns = filter[resourceType];
			if (filter.autoload === false) {
				if (!patterns || patterns.length === 0) continue;
				for (const [path, enabled] of resolveAutoloadDisabledResources(
					resolveDefault(resourceType),
					patterns,
					packageRoot,
				)) {
					resources[resourceType].set(path, enabled);
				}
				continue;
			}

			const allPaths = resolveDefault(resourceType);
			if (patterns === undefined) {
				for (const path of allPaths) resources[resourceType].set(path, true);
			} else if (patterns.length === 0) {
				for (const path of allPaths) resources[resourceType].set(path, false);
			} else {
				for (const [path, enabled] of resolveResourceFilter(allPaths, patterns, packageRoot)) {
					resources[resourceType].set(path, enabled);
				}
			}
		}
		return { handled: true, resources };
	}

	if (manifest) {
		for (const resourceType of RESOURCE_TYPES) {
			const entries = manifest[resourceType];
			if (entries === undefined) continue;
			for (const path of resolveManifestResources(entries, packageRoot, resourceType)) {
				resources[resourceType].set(path, true);
			}
		}
		return { handled: true, resources };
	}

	let handled = false;
	for (const resourceType of RESOURCE_TYPES) {
		const conventionDir = join(packageRoot, resourceType);
		if (!existsSync(conventionDir)) continue;
		handled = true;
		for (const path of resolveResourcesInDirectory(conventionDir, resourceType, { recursive: true })) {
			resources[resourceType].set(path, true);
		}
	}
	return { handled, resources };
}
