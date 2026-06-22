import { HEZO_DOCS_URL } from '@hezo/shared';

/**
 * The user-facing docs (`docs/**​/*.md`) bundled for runtime injection into the
 * CEO chat context. Mirrors the agent-roles bundling pattern: a build-time
 * `bundle-docs.ts` writes `docs-bundle.json`, which a *literal* dynamic import
 * embeds into the compiled binary; dev/test falls back to a filesystem walk.
 */

export interface ParsedDoc {
	/** Frontmatter `title`. */
	title: string;
	/** Frontmatter `section` (grouping label, e.g. "Concepts"). */
	section: string;
	/** Frontmatter `order` (global ordering; missing → Infinity, sorts last). */
	order: number;
	/** Markdown body with the leading YAML frontmatter block stripped. */
	body: string;
}

export async function loadBundledDocs(): Promise<Record<string, string>> {
	// Literal dynamic import so `bun build --compile` embeds the JSON into the
	// binary's virtual FS (a runtime `readFile` of a sibling path is not embedded
	// and ENOENTs at `/$bunfs/root/...`). In dev the file may be absent — the
	// import rejects and `loadDocs` falls back to the filesystem walk.
	let mod: { default: Record<string, string> };
	try {
		mod = (await import('./docs-bundle.json')) as { default: Record<string, string> };
	} catch {
		throw new Error("Failed to load docs bundle. Run 'bun run build:docs' first.");
	}
	// An empty stub (written by `scripts/ensure-bundles.ts` so tsc/vite can
	// resolve the literal import) means the bundle was never generated — treat it
	// as absent so `loadDocs` falls back to the filesystem walk.
	if (Object.keys(mod.default).length === 0) {
		throw new Error('Docs bundle is empty. Run "bun run build:docs" first.');
	}
	return mod.default;
}

export async function loadFilesystemDocs(docsDir: string): Promise<Record<string, string>> {
	const { readdir, readFile } = await import('node:fs/promises');
	const { join, relative, sep } = await import('node:path');

	async function walk(dir: string): Promise<string[]> {
		const entries = await readdir(dir, { withFileTypes: true });
		const results: string[] = [];
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) results.push(...(await walk(full)));
			else if (entry.isFile() && entry.name.endsWith('.md')) results.push(full);
		}
		return results;
	}

	const files = (await walk(docsDir)).sort();
	const docs: Record<string, string> = {};
	await Promise.all(
		files.map(async (full) => {
			const key = relative(docsDir, full).split(sep).join('/');
			docs[key] = await readFile(full, 'utf-8');
		}),
	);
	return docs;
}

export async function loadDocs(): Promise<Record<string, string>> {
	// Test harnesses (vitest under vite) can set HEZO_DOCS_DIR to bypass the
	// import.meta.url resolution that vite rewrites into a `/@fs/...` virtual URL
	// the filesystem can't read (mirrors HEZO_AGENTS_DIR for agent roles).
	if (process.env.HEZO_DOCS_DIR) {
		return loadFilesystemDocs(process.env.HEZO_DOCS_DIR);
	}
	try {
		return await loadBundledDocs();
	} catch {
		const { join } = await import('node:path');
		const docsDir = join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..', 'docs');
		return loadFilesystemDocs(docsDir);
	}
}

/**
 * Strip the leading `---…---` YAML frontmatter block and read the flat
 * `title` / `order` / `section` scalars. The docs use only flat string/number
 * frontmatter, so a line parser is sufficient (no YAML dependency needed).
 */
export function parseDoc(raw: string): ParsedDoc {
	let title = '';
	let section = '';
	let order = Number.POSITIVE_INFINITY;
	let body = raw;

	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	if (match) {
		body = raw.slice(match[0].length);
		for (const line of match[1].split(/\r?\n/)) {
			const kv = /^(\w+):\s*(.*)$/.exec(line);
			if (!kv) continue;
			const key = kv[1];
			const value = kv[2].trim().replace(/^['"]|['"]$/g, '');
			if (key === 'title') title = value;
			else if (key === 'section') section = value;
			else if (key === 'order') {
				const n = Number(value);
				if (Number.isFinite(n)) order = n;
			}
		}
	}

	return { title, section, order, body: body.trim() };
}

let cachedDocsBlock: string | null = null;

/**
 * The full documentation as a single markdown block for the CEO chat prompt:
 * every doc ordered by frontmatter `order`, grouped under its `section`, with
 * frontmatter stripped and a header pointing at the live docs site. Cached after
 * the first build (docs are static for the process lifetime).
 */
export async function buildHezoDocsBlock(): Promise<string> {
	if (cachedDocsBlock !== null) return cachedDocsBlock;

	const raw = await loadDocs();
	const docs = Object.values(raw)
		.map(parseDoc)
		.sort((a, b) => a.order - b.order);

	const lines: string[] = [
		'# Hezo documentation',
		'',
		`The full Hezo product & API documentation is embedded below so you can answer setup and usage questions authoritatively. The live version is published at ${HEZO_DOCS_URL}.`,
		'',
	];

	let currentSection: string | null = null;
	for (const doc of docs) {
		if (doc.section && doc.section !== currentSection) {
			currentSection = doc.section;
			lines.push(`## ${doc.section}`, '');
		}
		if (doc.title) lines.push(`### ${doc.title}`, '');
		lines.push(doc.body, '');
	}

	cachedDocsBlock = lines.join('\n').trim();
	return cachedDocsBlock;
}

/** Test-only: reset the module-level cache so a different HEZO_DOCS_DIR takes effect. */
export function resetDocsBlockCache(): void {
	cachedDocsBlock = null;
}
