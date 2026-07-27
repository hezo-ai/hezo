import { readFile } from 'node:fs/promises';
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
 *  - the READMEs, which the docs loader does not reach.
 *
 * Read the docs straight off the filesystem rather than via `loadDocs()`: that
 * helper prefers `docs-bundle.json` once a build has populated it, which would
 * lint a stale snapshot instead of the tree under review.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');

const README_PATHS = ['README.md', 'packages/server/README.md', 'packages/shared/README.md'];

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
