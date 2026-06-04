import { createHash } from 'node:crypto';
import type { SkillRecord } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import { deriveSkillSummary } from '../lib/skill-summary';
import { toSlug } from '../lib/slug';
import type { Env } from '../lib/types';
import { requireSuperuser } from '../middleware/auth';
import { downloadSkillContent, SkillDownloadError } from '../services/skill-downloader';

export const skillsRoutes = new Hono<Env>();

function downloadErrorStatus(reason: SkillDownloadError['reason']): 400 | 404 | 422 | 503 {
	switch (reason) {
		case 'invalid_url':
		case 'forbidden_scheme':
			return 400;
		case 'not_found':
			return 404;
		case 'too_large':
			return 422;
		case 'timeout':
		case 'network':
			return 503;
	}
}

// Instance-level skills (team_id NULL) are shared across every team. The Admin
// (superuser) manages them here; the per-team skills reads include them.
skillsRoutes.get('/skills', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	const result = await db.query<Omit<SkillRecord, 'content'>>(
		`SELECT id, team_id, name, slug, description, source_url, content_hash,
		        created_by_member_id, tags, is_active, created_at, updated_at
		 FROM skills
		 WHERE team_id IS NULL AND is_active = true
		 ORDER BY name`,
	);
	return ok(c, result.rows);
});

skillsRoutes.post('/skills', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	const body = await c.req.json<{
		name: string;
		content?: string;
		description?: string;
		slug?: string;
		tags?: string[];
	}>();
	if (!body.name?.trim()) return err(c, 'INVALID_REQUEST', 'name is required', 400);
	if (!body.content?.trim()) return err(c, 'INVALID_REQUEST', 'content is required', 400);
	const slug = body.slug?.trim() || toSlug(body.name);
	if (!slug) return err(c, 'INVALID_REQUEST', 'slug could not be derived from name', 400);

	const content = body.content;
	const hash = createHash('sha256').update(content).digest('hex');
	const description = body.description?.trim() || deriveSkillSummary(content);

	const result = await db.query<SkillRecord>(
		`INSERT INTO skills (team_id, name, slug, description, content, source_url, content_hash, tags)
		 VALUES (NULL, $1, $2, $3, $4, NULL, $5, $6::jsonb)
		 ON CONFLICT (slug) WHERE team_id IS NULL DO UPDATE SET
		   name = EXCLUDED.name,
		   description = EXCLUDED.description,
		   content = EXCLUDED.content,
		   content_hash = EXCLUDED.content_hash,
		   tags = EXCLUDED.tags,
		   updated_at = now()
		 RETURNING *`,
		[body.name.trim(), slug, description, content, hash, JSON.stringify(body.tags ?? [])],
	);
	return ok(c, result.rows[0], 201);
});

skillsRoutes.get('/teams/:teamId/skills', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const result = await db.query<Omit<SkillRecord, 'content'>>(
		`SELECT id, team_id, name, slug, description, source_url, content_hash,
		        created_by_member_id, tags, is_active, created_at, updated_at
		 FROM skills
		 WHERE (team_id = $1 OR team_id IS NULL) AND is_active = true
		 ORDER BY name`,
		[teamId],
	);

	return ok(c, result.rows);
});

skillsRoutes.get('/teams/:teamId/skills/:slug', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const slug = c.req.param('slug');

	const result = await db.query<SkillRecord>(
		'SELECT * FROM skills WHERE (team_id = $1 OR team_id IS NULL) AND slug = $2 ORDER BY team_id NULLS LAST LIMIT 1',
		[teamId, slug],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Skill not found', 404);
	}

	return ok(c, result.rows[0]);
});

skillsRoutes.post('/teams/:teamId/skills', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const body = await c.req.json<{
		name: string;
		source_url?: string;
		content?: string;
		description?: string;
		slug?: string;
		tags?: string[];
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}
	const hasSourceUrl = !!body.source_url?.trim();
	const hasContent = typeof body.content === 'string' && body.content.length > 0;
	if (!hasSourceUrl && !hasContent) {
		return err(c, 'INVALID_REQUEST', 'source_url or content is required', 400);
	}

	const slug = body.slug?.trim() || toSlug(body.name);
	if (!slug) {
		return err(c, 'INVALID_REQUEST', 'slug could not be derived from name', 400);
	}

	// Inline-content path: the skill body is supplied directly (no download).
	if (!hasSourceUrl) {
		const content = body.content as string;
		const hash = createHash('sha256').update(content).digest('hex');
		const description = body.description?.trim() || deriveSkillSummary(content);

		const result = await db.query<SkillRecord>(
			`INSERT INTO skills (team_id, name, slug, description, content, source_url, content_hash, tags)
			 VALUES ($1, $2, $3, $4, $5, NULL, $6, $7::jsonb)
			 ON CONFLICT (team_id, slug) DO UPDATE SET
			   name = EXCLUDED.name,
			   description = EXCLUDED.description,
			   content = EXCLUDED.content,
			   source_url = EXCLUDED.source_url,
			   content_hash = EXCLUDED.content_hash,
			   tags = EXCLUDED.tags,
			   updated_at = now()
			 RETURNING *`,
			[teamId, body.name.trim(), slug, description, content, hash, JSON.stringify(body.tags ?? [])],
		);

		const skill = result.rows[0];

		// Create initial revision
		await db.query(
			`INSERT INTO skill_revisions (skill_id, revision_number, content, content_hash, change_summary)
			 VALUES ($1, 1, $2, $3, 'Initial version')
			 ON CONFLICT (skill_id, revision_number) DO NOTHING`,
			[skill.id, content, hash],
		);

		return ok(c, skill, 201);
	}

	try {
		const { content, hash } = await downloadSkillContent((body.source_url as string).trim());

		const result = await db.query<SkillRecord>(
			`INSERT INTO skills (team_id, name, slug, description, content, source_url, content_hash, tags)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
			 ON CONFLICT (team_id, slug) DO UPDATE SET
			   name = EXCLUDED.name,
			   description = EXCLUDED.description,
			   content = EXCLUDED.content,
			   source_url = EXCLUDED.source_url,
			   content_hash = EXCLUDED.content_hash,
			   tags = EXCLUDED.tags,
			   updated_at = now()
			 RETURNING *`,
			[
				teamId,
				body.name.trim(),
				slug,
				body.description?.trim() || deriveSkillSummary(content),
				content,
				(body.source_url as string).trim(),
				hash,
				JSON.stringify(body.tags ?? []),
			],
		);

		const skill = result.rows[0];

		// Create initial revision
		await db.query(
			`INSERT INTO skill_revisions (skill_id, revision_number, content, content_hash, change_summary)
			 VALUES ($1, 1, $2, $3, 'Initial version')
			 ON CONFLICT (skill_id, revision_number) DO NOTHING`,
			[skill.id, content, hash],
		);

		return ok(c, skill, 201);
	} catch (e) {
		if (e instanceof SkillDownloadError) {
			return err(c, 'SKILL_DOWNLOAD_FAILED', e.message, downloadErrorStatus(e.reason));
		}
		throw e;
	}
});

skillsRoutes.patch('/teams/:teamId/skills/:slug', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const slug = c.req.param('slug');

	const body = await c.req.json<{
		name?: string;
		description?: string;
		tags?: string[];
		content?: string;
	}>();

	const sets: string[] = [];
	const params: unknown[] = [];
	let paramIdx = 3; // $1 = teamId, $2 = slug

	if (body.name !== undefined) {
		sets.push(`name = $${paramIdx++}`);
		params.push(body.name.trim());
	}
	// Resolve description: an explicit non-empty value wins; otherwise, when it is
	// empty/missing and new content is supplied, backfill a one-line summary from
	// the body so the per-run skills manifest always has a usable description.
	const trimmedDescription = body.description?.trim();
	let resolvedDescription: string | undefined =
		body.description !== undefined ? trimmedDescription : undefined;
	if (!trimmedDescription && body.content !== undefined) {
		resolvedDescription = deriveSkillSummary(body.content);
	}
	if (resolvedDescription !== undefined) {
		sets.push(`description = $${paramIdx++}`);
		params.push(resolvedDescription);
	}
	if (body.tags !== undefined) {
		sets.push(`tags = $${paramIdx++}::jsonb`);
		params.push(JSON.stringify(body.tags));
	}
	if (body.content !== undefined) {
		const hash = createHash('sha256').update(body.content).digest('hex');
		sets.push(`content = $${paramIdx++}`);
		params.push(body.content);
		sets.push(`content_hash = $${paramIdx++}`);
		params.push(hash);
	}

	if (sets.length === 0) {
		return err(c, 'INVALID_REQUEST', 'No fields to update', 400);
	}

	sets.push('updated_at = now()');

	const result = await db.query<SkillRecord>(
		`UPDATE skills SET ${sets.join(', ')}
		 WHERE team_id = $1 AND slug = $2
		 RETURNING *`,
		[teamId, slug, ...params],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Skill not found', 404);
	}

	const skill = result.rows[0];

	// Create revision if content changed
	if (body.content !== undefined) {
		const revCount = await db.query<{ cnt: string }>(
			'SELECT COUNT(*)::text AS cnt FROM skill_revisions WHERE skill_id = $1',
			[skill.id],
		);
		const nextRev = Number.parseInt(revCount.rows[0].cnt, 10) + 1;
		await db.query(
			`INSERT INTO skill_revisions (skill_id, revision_number, content, content_hash, change_summary)
			 VALUES ($1, $2, $3, $4, $5)`,
			[skill.id, nextRev, body.content, skill.content_hash, 'Content updated'],
		);
	}

	return ok(c, skill);
});

skillsRoutes.post('/teams/:teamId/skills/:slug/sync', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const slug = c.req.param('slug');

	const existing = await db.query<{ id: string; source_url: string | null }>(
		'SELECT id, source_url FROM skills WHERE team_id = $1 AND slug = $2',
		[teamId, slug],
	);

	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Skill not found', 404);
	}

	if (!existing.rows[0].source_url) {
		return err(c, 'INVALID_REQUEST', 'Skill has no source URL to sync from', 400);
	}

	try {
		const { content, hash } = await downloadSkillContent(existing.rows[0].source_url);

		const result = await db.query<SkillRecord>(
			`UPDATE skills SET content = $1, content_hash = $2, updated_at = now()
			 WHERE id = $3
			 RETURNING *`,
			[content, hash, existing.rows[0].id],
		);

		const skill = result.rows[0];

		// Create revision
		const revCount = await db.query<{ cnt: string }>(
			'SELECT COUNT(*)::text AS cnt FROM skill_revisions WHERE skill_id = $1',
			[skill.id],
		);
		const nextRev = Number.parseInt(revCount.rows[0].cnt, 10) + 1;
		await db.query(
			`INSERT INTO skill_revisions (skill_id, revision_number, content, content_hash, change_summary)
			 VALUES ($1, $2, $3, $4, 'Synced from source')`,
			[skill.id, nextRev, content, hash],
		);

		return ok(c, skill);
	} catch (e) {
		if (e instanceof SkillDownloadError) {
			return err(c, 'SKILL_DOWNLOAD_FAILED', e.message, downloadErrorStatus(e.reason));
		}
		throw e;
	}
});

skillsRoutes.delete('/teams/:teamId/skills/:slug', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const slug = c.req.param('slug');

	const result = await db.query(
		'DELETE FROM skills WHERE team_id = $1 AND slug = $2 RETURNING id',
		[teamId, slug],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Skill not found', 404);
	}

	return c.json({ data: null }, 200);
});
