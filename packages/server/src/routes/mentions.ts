import { ADMIN_MENTION_SLUG } from '@hezo/shared';
import { Hono } from 'hono';
import { signAssetUrl } from '../lib/asset-urls';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const mentionsRoutes = new Hono<Env>();

type MentionKind = 'agent' | 'task' | 'kb' | 'doc';

const BOARD_SUGGESTION: SearchResult = {
	kind: 'agent',
	handle: ADMIN_MENTION_SLUG,
	label: 'the admin',
	sublabel: '@admin · notifies all project owners',
};

interface SearchResult {
	kind: MentionKind;
	handle: string;
	label: string;
	sublabel?: string;
}

mentionsRoutes.post('/projects/:projectId/docs/resolve', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const body = await c.req.json<{
		kb_slugs?: unknown;
		project_docs?: unknown;
		assets?: unknown;
	}>();

	const kbSlugsRaw = Array.isArray(body.kb_slugs) ? body.kb_slugs : [];
	const projectDocsRaw = Array.isArray(body.project_docs) ? body.project_docs : [];
	const assetsRaw = Array.isArray(body.assets) ? body.assets : [];

	if (kbSlugsRaw.length > 100 || projectDocsRaw.length > 100 || assetsRaw.length > 100) {
		return err(
			c,
			'INVALID_REQUEST',
			'kb_slugs / project_docs / assets may not exceed 100 entries',
			400,
		);
	}

	const kbSlugs = Array.from(
		new Set(
			kbSlugsRaw
				.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
				.map((v) => v.trim().toLowerCase()),
		),
	);

	interface ProjectRef {
		project_slug: string;
		filename: string;
	}
	// Parse a `[{ project_slug, filename }]` array, trimming and de-duping. Shared
	// by project-doc and asset references (both are project-scoped filenames).
	const parseProjectRefs = (raw: unknown[]): ProjectRef[] => {
		const out: ProjectRef[] = [];
		const seen = new Set<string>();
		for (const entry of raw) {
			if (!entry || typeof entry !== 'object') continue;
			const e = entry as Record<string, unknown>;
			const projectSlug = typeof e.project_slug === 'string' ? e.project_slug.trim() : '';
			const filename = typeof e.filename === 'string' ? e.filename.trim() : '';
			if (!projectSlug || !filename) continue;
			const key = `${projectSlug.toLowerCase()}/${filename.toLowerCase()}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ project_slug: projectSlug, filename });
		}
		return out;
	};
	const projectDocs = parseProjectRefs(projectDocsRaw);
	const assetRefs = parseProjectRefs(assetsRaw);

	let kbDocs: Array<{ slug: string; title: string; size: number; updated_at: string }> = [];
	if (kbSlugs.length > 0) {
		const result = await db.query<{
			slug: string;
			title: string;
			size: number;
			updated_at: string;
		}>(
			`SELECT slug, name AS title, octet_length(content)::int AS size, updated_at
			 FROM skills
			 WHERE LOWER(slug) = ANY($1::text[])`,
			[kbSlugs],
		);
		kbDocs = result.rows;
	}

	let resolvedProjectDocs: Array<{
		project_slug: string;
		filename: string;
		size: number;
		updated_at: string;
	}> = [];
	if (projectDocs.length > 0) {
		const slugs = projectDocs.map((d) => d.project_slug.toLowerCase());
		const filenames = projectDocs.map((d) => d.filename);
		const result = await db.query<{
			project_slug: string;
			filename: string;
			size: number;
			updated_at: string;
		}>(
			`SELECT p.slug AS project_slug, pd.slug AS filename,
			        octet_length(pd.content)::int AS size, pd.updated_at
			 FROM documents pd
			 JOIN projects p ON p.id = pd.project_id
			 WHERE pd.type = 'project_doc'
			   AND pd.team_id = $1
			   AND LOWER(p.slug) = ANY($2::text[])
			   AND pd.slug = ANY($3::text[])`,
			[teamId, slugs, filenames],
		);
		const requested = new Set(
			projectDocs.map((d) => `${d.project_slug.toLowerCase()}/${d.filename}`),
		);
		resolvedProjectDocs = result.rows.filter((r) =>
			requested.has(`${r.project_slug.toLowerCase()}/${r.filename}`),
		);
	}

	let resolvedAssets: Array<{
		project_slug: string;
		filename: string;
		id: string;
		content_type: string;
		signed_url: string;
	}> = [];
	if (assetRefs.length > 0) {
		const slugs = assetRefs.map((a) => a.project_slug.toLowerCase());
		const filenames = assetRefs.map((a) => a.filename);
		const result = await db.query<{
			project_slug: string;
			filename: string;
			id: string;
			content_type: string;
		}>(
			`SELECT p.slug AS project_slug, a.original_filename AS filename, a.id, a.content_type
			 FROM assets a
			 JOIN projects p ON p.id = a.project_id
			 WHERE a.team_id = $1
			   AND LOWER(p.slug) = ANY($2::text[])
			   AND a.original_filename = ANY($3::text[])`,
			[teamId, slugs, filenames],
		);
		const requested = new Set(
			assetRefs.map((a) => `${a.project_slug.toLowerCase()}/${a.filename}`),
		);
		const masterKeyManager = c.get('masterKeyManager');
		resolvedAssets = await Promise.all(
			result.rows
				.filter((r) => requested.has(`${r.project_slug.toLowerCase()}/${r.filename}`))
				.map(async (r) => ({ ...r, signed_url: await signAssetUrl(r.id, masterKeyManager) })),
		);
	}

	return ok(c, { kb_docs: kbDocs, project_docs: resolvedProjectDocs, assets: resolvedAssets });
});

mentionsRoutes.get('/projects/:projectId/mentions/search', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const q = (c.req.query('q') ?? '').trim();
	const kind = (c.req.query('kind') ?? 'all') as MentionKind | 'all';
	const projectSlug = c.req.query('project_slug')?.trim() ?? null;
	const limitRaw = Number.parseInt(c.req.query('limit') ?? '20', 10);
	const perKind = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1), 50);

	const pattern = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
	const prefix = `${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

	const kinds: MentionKind[] =
		kind === 'all' ? ['agent', 'task', 'kb', 'doc'] : ([kind] as MentionKind[]);

	const results: SearchResult[] = [];

	if (kinds.includes('agent')) {
		const lq = q.toLowerCase();
		if (q === '' || ADMIN_MENTION_SLUG.startsWith(lq) || ADMIN_MENTION_SLUG.includes(lq)) {
			results.push(BOARD_SUGGESTION);
		}
		const r = await db.query<{ slug: string; title: string }>(
			`SELECT ma.slug, ma.title
			 FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1
			   AND ma.admin_status = 'enabled'
			   AND ($2 = '' OR ma.slug ILIKE $3 OR ma.title ILIKE $3)
			 ORDER BY ma.title
			 LIMIT $4`,
			[teamId, q, pattern, perKind],
		);
		for (const row of r.rows) {
			results.push({
				kind: 'agent',
				handle: row.slug,
				label: row.title,
				sublabel: `@${row.slug}`,
			});
		}
	}

	if (kinds.includes('task')) {
		const r = await db.query<{ identifier: string; title: string; project_slug: string }>(
			`SELECT i.identifier, i.title, p.slug AS project_slug
			 FROM tasks i
			 JOIN projects p ON p.id = i.project_id
			 WHERE i.team_id = $1
			   AND ($2 = '' OR LOWER(i.identifier) LIKE LOWER($4) OR i.title ILIKE $3)
			 ORDER BY i.updated_at DESC
			 LIMIT $5`,
			[teamId, q, pattern, prefix, perKind],
		);
		for (const row of r.rows) {
			results.push({
				kind: 'task',
				handle: row.identifier,
				label: row.title,
				sublabel: `${row.identifier} · ${row.project_slug}`,
			});
		}
	}

	if (kinds.includes('kb')) {
		const r = await db.query<{ slug: string; title: string }>(
			`SELECT slug, name AS title
			 FROM skills
			 WHERE ($1 = '' OR slug ILIKE $2 OR name ILIKE $2)
			 ORDER BY name
			 LIMIT $3`,
			[q, pattern, perKind],
		);
		for (const row of r.rows) {
			results.push({
				kind: 'kb',
				handle: row.slug,
				label: row.title,
				sublabel: 'Skill',
			});
		}
	}

	if (kinds.includes('doc') && projectSlug) {
		const r = await db.query<{ filename: string; project_slug: string }>(
			`SELECT pd.slug AS filename, p.slug AS project_slug
			 FROM documents pd
			 JOIN projects p ON p.id = pd.project_id
			 WHERE pd.type = 'project_doc' AND pd.team_id = $1
			   AND LOWER(p.slug) = LOWER($4)
			   AND ($2 = '' OR pd.slug ILIKE $3)
			 ORDER BY pd.slug
			 LIMIT $5`,
			[teamId, q, pattern, projectSlug, perKind],
		);
		for (const row of r.rows) {
			results.push({
				kind: 'doc',
				handle: row.filename,
				label: row.filename,
				sublabel: `Project doc · ${row.project_slug}`,
			});
		}
	}

	return ok(c, results);
});
