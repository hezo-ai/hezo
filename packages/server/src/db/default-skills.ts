import { createHash } from 'node:crypto';
import { DEFAULT_TEAM_ID } from '@hezo/shared';
import { parseFrontmatter } from '../lib/frontmatter';
import { deriveSkillSummary } from '../lib/skill-summary';
import { withTransaction } from '../lib/sql';
import { setSystemMeta } from '../lib/system-meta';
import { logger } from '../logger';
import { recordSkillRevisionIfChanged } from '../services/skill-revisions';
import type { Db } from './database';

const log = logger.child('default-skills');

/**
 * Per-skill marker in `system_meta` recording that this instance has already
 * handled a given default skill — set to the sha256 of the installed content.
 * Its presence (any value) means "handled": the skill was installed here (or a
 * user-authored skill already owned the slug when an older Hezo auto-seeded).
 * A default with no marker and no existing global row is "missing" and can be
 * offered on the global Skills page. Keeping the marker means a default the
 * operator installed and later deleted is NOT re-offered.
 */
export const DEFAULT_SKILL_MARKER_PREFIX = 'default_skill_shipped_hash:';

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

export interface MissingDefaultSkill {
	slug: string;
	name: string;
	description: string;
}

/**
 * A default this instance installed, and whose shipped body has changed since —
 * the set offered for refresh on the global Skills page. `locally_edited` means
 * the installed row no longer matches what was installed, so a refresh discards
 * the operator's own edits; the UI confirms that case separately, and the prior
 * content stays recoverable from the skill's revision history.
 */
export interface OutdatedDefaultSkill extends MissingDefaultSkill {
	locally_edited: boolean;
}

/** What the global Skills page can offer for this instance's default skills. */
export interface DefaultSkillStatus {
	missing: MissingDefaultSkill[];
	outdated: OutdatedDefaultSkill[];
}

/**
 * Both offers the global Skills page makes about the shipped catalog, resolved
 * in one pass: two queries rather than one per slug, since the page asks for
 * them together. `defs` defaults to the bundled catalog; tests pass a synthetic
 * set.
 *
 * Marker semantics decide everything here, and the two silences are deliberate:
 * a default installed here and later **deleted** keeps its marker and no row, so
 * it is neither missing nor outdated (Hezo never re-adds what the operator
 * removed); a row with **no** marker is user-authored, or predates the marker,
 * so it is never ours to overwrite.
 */
export async function listDefaultSkillStatus(
	db: Db,
	defs?: DefaultSkillDef[],
): Promise<DefaultSkillStatus> {
	const catalog = defs ?? (await loadDefaultSkills());
	if (catalog.length === 0) return { missing: [], outdated: [] };

	const slugs = catalog.map((d) => d.slug);
	const present = await db.query<{ slug: string; content_hash: string }>(
		'SELECT slug, content_hash FROM skills WHERE project_id IS NULL AND slug = ANY($1)',
		[slugs],
	);
	const installedHashes = new Map(present.rows.map((r) => [r.slug, r.content_hash]));

	const markerRows = await db.query<{ key: string; value: string }>(
		'SELECT key, value FROM system_meta WHERE key = ANY($1)',
		[slugs.map((slug) => DEFAULT_SKILL_MARKER_PREFIX + slug)],
	);
	const markers = new Map(
		markerRows.rows.map((r) => [r.key.slice(DEFAULT_SKILL_MARKER_PREFIX.length), r.value]),
	);

	const missing: MissingDefaultSkill[] = [];
	const outdated: OutdatedDefaultSkill[] = [];
	for (const def of catalog) {
		const offer = { slug: def.slug, name: def.name, description: def.description };
		const installedHash = installedHashes.get(def.slug);
		const marker = markers.get(def.slug) ?? null;

		if (installedHash === undefined) {
			if (marker === null) missing.push(offer); // never handled here
			continue;
		}
		if (marker === null) continue; // not a row this instance installed
		if (marker === def.contentHash) continue; // shipped body unchanged since install
		if (installedHash === def.contentHash) continue; // row already matches what ships
		outdated.push({ ...offer, locally_edited: installedHash !== marker });
	}
	return { missing, outdated };
}

/**
 * The default skills this instance has never installed and that no existing
 * global skill already occupies — the set offered on the global Skills page.
 * `defs` defaults to the bundled catalog; tests pass a synthetic set.
 */
export async function listMissingDefaultSkills(
	db: Db,
	defs?: DefaultSkillDef[],
): Promise<MissingDefaultSkill[]> {
	return (await listDefaultSkillStatus(db, defs)).missing;
}

/**
 * Install the requested default skills (defaulting to every missing one) as
 * ordinary global skills. Only skills that are genuinely missing are inserted;
 * each insert records the shipped-hash marker so it is never re-offered. Returns
 * the skills actually inserted. `defs` defaults to the bundled catalog.
 */
export async function installDefaultSkills(
	db: Db,
	options: { slugs?: string[]; defs?: DefaultSkillDef[] } = {},
): Promise<Array<{ id: string; slug: string; name: string }>> {
	const catalog = options.defs ?? (await loadDefaultSkills());
	const missing = await listMissingDefaultSkills(db, catalog);
	let toInstall = missing;
	if (options.slugs) {
		const requested = new Set(options.slugs);
		toInstall = missing.filter((m) => requested.has(m.slug));
	}
	const byslug = new Map(catalog.map((d) => [d.slug, d]));

	const installed: Array<{ id: string; slug: string; name: string }> = [];
	for (const m of toInstall) {
		const def = byslug.get(m.slug);
		if (!def) continue;
		try {
			const added = await withTransaction(db, async () => {
				const res = await db.query<{ id: string }>(
					`INSERT INTO skills (name, slug, description, content, source_url, content_hash, tags, project_id, created_by_member_id)
					 VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, NULL, NULL)
					 ON CONFLICT (slug) WHERE project_id IS NULL DO NOTHING
					 RETURNING id`,
					[def.name, def.slug, def.description, def.content, def.sourceUrl, def.contentHash],
				);
				const row = res.rows[0];
				if (!row) return null; // lost a race for the slug — leave it to the winner
				await setSystemMeta(db, DEFAULT_SKILL_MARKER_PREFIX + def.slug, def.contentHash);
				return row.id;
			});
			if (added) installed.push({ id: added, slug: def.slug, name: def.name });
		} catch (err) {
			log.error(`Failed to install default skill '${def.slug}':`, err);
		}
	}
	return installed;
}

/**
 * Rewrite the requested installed defaults (defaulting to every outdated one)
 * with the body Hezo now ships, snapshotting what was there as a skill revision
 * so the operator can roll back. Each row is re-read inside its own transaction
 * and skipped if it already matches, so a row that changed since the status pass
 * is never written twice and never written unchanged. Returns the skills
 * actually rewritten. `defs` defaults to the bundled catalog.
 */
export async function refreshDefaultSkills(
	db: Db,
	options: { slugs?: string[]; defs?: DefaultSkillDef[] } = {},
): Promise<Array<{ id: string; slug: string; name: string }>> {
	const catalog = options.defs ?? (await loadDefaultSkills());
	const { outdated } = await listDefaultSkillStatus(db, catalog);
	let toRefresh = outdated;
	if (options.slugs) {
		const requested = new Set(options.slugs);
		toRefresh = outdated.filter((o) => requested.has(o.slug));
	}
	const byslug = new Map(catalog.map((d) => [d.slug, d]));

	const refreshed: Array<{ id: string; slug: string; name: string }> = [];
	for (const item of toRefresh) {
		const def = byslug.get(item.slug);
		if (!def) continue;
		try {
			const updated = await withTransaction(db, async () => {
				const before = await db.query<{ id: string; content: string; content_hash: string }>(
					'SELECT id, content, content_hash FROM skills WHERE project_id IS NULL AND slug = $1',
					[def.slug],
				);
				const row = before.rows[0];
				if (!row) return null; // deleted between the status pass and here
				if (row.content_hash === def.contentHash) return null; // already current
				await db.query(
					`UPDATE skills
					 SET name = $1, description = $2, content = $3, source_url = $4,
					     content_hash = $5, updated_at = now()
					 WHERE id = $6`,
					[def.name, def.description, def.content, def.sourceUrl, def.contentHash, row.id],
				);
				await recordSkillRevisionIfChanged(
					db,
					row.id,
					row.content,
					def.content,
					'Refreshed from the shipped default skill',
					null,
				);
				await setSystemMeta(db, DEFAULT_SKILL_MARKER_PREFIX + def.slug, def.contentHash);
				return row.id;
			});
			if (updated) refreshed.push({ id: updated, slug: def.slug, name: def.name });
		} catch (err) {
			log.error(`Failed to refresh default skill '${def.slug}':`, err);
		}
	}
	return refreshed;
}

/**
 * Install the default skills automatically **only on a genuinely fresh
 * instance** — a fresh database whose HQ team hasn't been seeded yet. A fresh
 * install shouldn't make the operator opt in; an upgrade of an existing instance
 * must not (that's what the global Skills page button is for). Called at startup
 * before `seedDefaultTeam` creates HQ, so "HQ absent" means "first boot". No-op
 * (returns []) once HQ exists. Not run by test harnesses, which call
 * `seedDefaultTeam` directly rather than through startup.
 */
export async function installDefaultSkillsIfFreshInstance(
	db: Db,
): Promise<Array<{ id: string; slug: string; name: string }>> {
	const hq = await db.query('SELECT 1 FROM teams WHERE id = $1', [DEFAULT_TEAM_ID]);
	if (hq.rows.length > 0) return []; // existing instance — opt-in via the Skills page
	const installed = await installDefaultSkills(db);
	if (installed.length > 0) {
		log.info(`Installed ${installed.length} default skills on fresh instance`);
	}
	return installed;
}
