import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadFilesystemDocs } from '../src/services/docs-bundle';

/**
 * Guard for the user-facing terminology rules in AGENTS.md (§ User-facing docs
 * terminology): user-facing prose never uses an em dash (U+2014) or an en dash
 * (U+2013), only a plain hyphen.
 *
 * Scope is the two published prose surfaces, with no allowlist:
 *  - the whole `docs/` tree, including the generated `docs/reference/mcp-api.md`
 *    (it is not exempt — its dashes are fixed in the MCP tool descriptions and
 *    `TOOL_DOC_META` that generate it, then `bun run build:docs` re-emits it);
 *  - the READMEs, which the docs loader does not reach;
 *  - the web app's own source, whose UI strings the rule covers too and which
 *    nothing checked until 207 of them had accumulated. Code comments are
 *    exempt by AGENTS.md, so comment-only lines are skipped - the same rule the
 *    sweep that cleared them used, so guard and fix cannot disagree.
 *
 * Read the docs straight off the filesystem rather than via `loadDocs()`: that
 * helper prefers `docs-bundle.json` once a build has populated it, which would
 * lint a stale snapshot instead of the tree under review.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');

const README_PATHS = ['README.md', 'packages/server/README.md', 'packages/shared/README.md'];

const WEB_SRC_DIR = join(REPO_ROOT, 'packages', 'web', 'src');
/**
 * The message catalogs have their own dash guard in `i18n-catalog.test.ts`,
 * which checks all twelve languages rather than just the source strings.
 */
const WEB_SKIP = join('lib', 'i18n', 'catalog');

/** A line that is wholly a comment. Exempt, per AGENTS.md § terminology. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

async function walkWebSource(dir: string, rel = ''): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		const childRel = join(rel, entry.name);
		if (childRel.startsWith(WEB_SKIP)) continue;
		if (entry.isDirectory()) out.push(...(await walkWebSource(join(dir, entry.name), childRel)));
		else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(childRel);
	}
	return out;
}

/** Dashes banned from user-facing prose, with the name to print on a failure. */
const BANNED_DASHES = [
	{ char: '—', name: 'em dash' },
	{ char: '–', name: 'en dash' },
] as const;

interface Violation {
	file: string;
	line: number;
	dash: string;
	excerpt: string;
}

/** Every banned dash in `text`, reported as file:line with a trimmed excerpt. */
function findDashes(file: string, text: string): Violation[] {
	const found: Violation[] = [];
	text.split('\n').forEach((line, i) => {
		for (const { char, name } of BANNED_DASHES) {
			if (!line.includes(char)) continue;
			const at = line.indexOf(char);
			found.push({
				file,
				line: i + 1,
				dash: name,
				excerpt: line.slice(Math.max(0, at - 40), at + 40).trim(),
			});
		}
	});
	return found;
}

const FIX = 'Use a plain hyphen instead (AGENTS.md § User-facing docs terminology).';

describe('user-facing prose uses hyphens, never em or en dashes', () => {
	it('no docs/ page contains an em or en dash', async () => {
		const docs = await loadFilesystemDocs(DOCS_DIR);
		// Guard the guard: a broken path would make every assertion below vacuous.
		expect(Object.keys(docs).length).toBeGreaterThan(0);

		const violations = Object.entries(docs).flatMap(([rel, raw]) => findDashes(`docs/${rel}`, raw));

		expect(
			violations.slice(0, 25),
			`${violations.length} banned dash(es) in docs/. ${FIX} docs/reference/mcp-api.md is generated: fix the tool description or TOOL_DOC_META in packages/server/src/mcp/ and re-run 'bun run build:docs'.`,
		).toEqual([]);
	});

	it('no web UI string contains an em or en dash', async () => {
		const files = await walkWebSource(WEB_SRC_DIR);
		// Guard the guard: a broken path would make the assertion below vacuous.
		expect(files.length).toBeGreaterThan(100);

		const violations = (
			await Promise.all(
				files.map(async (rel) => {
					const raw = await readFile(join(WEB_SRC_DIR, rel), 'utf-8');
					const withoutComments = raw
						.split('\n')
						.map((line) => (COMMENT_LINE.test(line) ? '' : line))
						.join('\n');
					return findDashes(join('packages/web/src', rel), withoutComments);
				}),
			)
		).flat();

		expect(
			violations.slice(0, 25),
			`${violations.length} banned dash(es) in web UI strings. ${FIX}`,
		).toEqual([]);
	});

	it('no README contains an em or en dash', async () => {
		const violations = (
			await Promise.all(
				README_PATHS.map(async (rel) =>
					findDashes(rel, await readFile(join(REPO_ROOT, rel), 'utf-8')),
				),
			)
		).flat();

		expect(
			violations.slice(0, 25),
			`${violations.length} banned dash(es) in the READMEs. ${FIX}`,
		).toEqual([]);
	});
});
