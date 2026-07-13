import { createHash } from 'node:crypto';
import { parseFrontmatter } from '../lib/frontmatter';
import { deriveSkillSummary } from '../lib/skill-summary';
import { logger } from '../logger';

const log = logger.child('default-skills');

/**
 * The default global skills Hezo ships. Source of truth is the top-level
 * `skills/` directory (one `<slug>.md` per skill, filename = slug), bundled
 * into the binary as `skills-bundle.json` by `bun run build:skills` and seeded
 * as ordinary editable `skills` rows by `seedDefaultSkills`.
 */
export interface DefaultSkillDef {
	slug: string;
	name: string;
	description: string;
	sourceUrl: string | null;
	/** Markdown body with frontmatter stripped — what lands in `skills.content`. */
	content: string;
	/** sha256 hex of `content` — the repo-wide skill content-hash convention. */
	contentHash: string;
}

// ATTRIBUTION.md documents upstream licenses for adapted skills; it is not a
// skill and never reaches the bundle map consumers.
const EXCLUDED_FILES = new Set(['ATTRIBUTION.md']);

export async function loadBundledDefaultSkills(): Promise<Record<string, string>> {
	// Literal dynamic import so `bun build --compile` embeds the JSON into the
	// binary's virtual FS (a runtime `readFile` of a sibling path is not embedded
	// and ENOENTs at `/$bunfs/root/...`). In dev the file may be absent — the
	// import rejects and `loadDefaultSkills` falls back to the filesystem walk.
	let mod: { default: Record<string, string> };
	try {
		mod = (await import('./skills-bundle.json')) as { default: Record<string, string> };
	} catch {
		throw new Error("Failed to load default skills bundle. Run 'bun run build:skills' first.");
	}
	// An empty stub (written by `scripts/ensure-bundles.ts` so tsc/vite can
	// resolve the literal import) means the bundle was never generated — treat it
	// as absent so `loadDefaultSkills` falls back to the filesystem walk.
	if (Object.keys(mod.default).length === 0) {
		throw new Error('Default skills bundle is empty. Run "bun run build:skills" first.');
	}
	return mod.default;
}

export async function loadFilesystemDefaultSkills(
	skillsDir: string,
): Promise<Record<string, string>> {
	const { readdir, readFile } = await import('node:fs/promises');
	const { join } = await import('node:path');

	// Flat directory by design — one markdown file per skill, no nesting.
	const entries = await readdir(skillsDir, { withFileTypes: true });
	const files = entries
		.filter((e) => e.isFile() && e.name.endsWith('.md'))
		.map((e) => e.name)
		.sort();
	const skills: Record<string, string> = {};
	await Promise.all(
		files.map(async (name) => {
			skills[name] = await readFile(join(skillsDir, name), 'utf-8');
		}),
	);
	return skills;
}

/** Parse a filename → raw-markdown map into skill definitions. */
export function parseDefaultSkills(raw: Record<string, string>): DefaultSkillDef[] {
	const defs: DefaultSkillDef[] = [];
	for (const [filename, markdown] of Object.entries(raw)) {
		if (EXCLUDED_FILES.has(filename) || !filename.endsWith('.md')) continue;
		const slug = filename.slice(0, -'.md'.length);
		const { data, body } = parseFrontmatter(markdown);
		const content = body.trim();
		const name = data.name?.trim();
		if (!name || !content) {
			log.warn(`Skipping default skill ${filename}: missing frontmatter name or empty body`);
			continue;
		}
		defs.push({
			slug,
			name,
			description: data.description?.trim() || deriveSkillSummary(content),
			sourceUrl: data.source_url?.trim() || null,
			content,
			contentHash: createHash('sha256').update(content).digest('hex'),
		});
	}
	return defs.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function loadDefaultSkills(): Promise<DefaultSkillDef[]> {
	// Test harnesses (vitest under vite) can set HEZO_SKILLS_DIR to bypass the
	// import.meta.url resolution that vite rewrites into a `/@fs/...` virtual
	// URL the filesystem can't read.
	if (process.env.HEZO_SKILLS_DIR) {
		return parseDefaultSkills(await loadFilesystemDefaultSkills(process.env.HEZO_SKILLS_DIR));
	}
	try {
		return parseDefaultSkills(await loadBundledDefaultSkills());
	} catch {
		const { join } = await import('node:path');
		const skillsDir = join(
			new URL('.', import.meta.url).pathname,
			'..',
			'..',
			'..',
			'..',
			'skills',
		);
		return parseDefaultSkills(await loadFilesystemDefaultSkills(skillsDir));
	}
}
