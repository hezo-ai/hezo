import { createHash } from 'node:crypto';
import type { SkillRecord } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import { deriveSkillSummary } from '../lib/skill-summary';
import { toSlug } from '../lib/slug';
import type { Env } from '../lib/types';
import { requireAdminEquivalent } from '../middleware/auth';
import {
	getRegistryToken,
	hasRegistryToken,
	installRegistrySkill,
	SkillsRegistryError,
	searchRegistry,
	setRegistryToken,
} from '../services/skills-registry';

export const skillsRoutes = new Hono<Env>();

// Skills are instance-global: one reusable-skill catalog shared with every
// team's agents (admin-authored here, or agent-fetched via fetch_skill_file).
// The Admin (superuser) manages them.
skillsRoutes.get('/skills', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const result = await db.query<Omit<SkillRecord, 'content'>>(
		`SELECT id, name, slug, description, source_url, content_hash,
		        created_by_member_id, tags, is_active, auto_load, created_at, updated_at
		 FROM skills
		 WHERE is_active = true
		 ORDER BY name`,
	);
	return ok(c, result.rows);
});

skillsRoutes.post('/skills', async (c) => {
	const denied = requireAdminEquivalent(c);
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
		`INSERT INTO skills (name, slug, description, content, source_url, content_hash, tags)
		 VALUES ($1, $2, $3, $4, NULL, $5, $6::jsonb)
		 ON CONFLICT (slug) DO UPDATE SET
		   name = EXCLUDED.name,
		   description = EXCLUDED.description,
		   content = EXCLUDED.content,
		   content_hash = EXCLUDED.content_hash,
		   tags = EXCLUDED.tags,
		   updated_at = now()
		 RETURNING *`,
		[body.name.trim(), slug, description, content, hash, JSON.stringify(body.tags ?? [])],
	);
	const skill = result.rows[0];
	c.get('events').emit({
		type: 'skill.created',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		skillId: skill.id,
		slug: skill.slug,
		name: skill.name,
	});
	return ok(c, skill, 201);
});

// --- skills.sh registry: admin "search and add" (token-gated; agents bypass this
// and use the `npx skills` CLI directly). Registered before /skills/:slug; the
// two-segment paths don't collide with the single-segment slug route. ---

skillsRoutes.get('/skills/registry/token', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	return ok(c, { configured: await hasRegistryToken(c.get('db')) });
});

skillsRoutes.put('/skills/registry/token', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const key = c.get('masterKeyManager').getKey();
	if (!key) return err(c, 'LOCKED', 'Server must be unlocked to manage the token', 401);
	const body = await c.req.json<{ token?: string }>();
	await setRegistryToken(c.get('db'), key, body.token ?? '');
	return ok(c, { configured: (body.token ?? '').trim().length > 0 });
});

skillsRoutes.get('/skills/registry/search', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const key = c.get('masterKeyManager').getKey();
	if (!key) return err(c, 'LOCKED', 'Server must be unlocked', 401);
	const token = await getRegistryToken(c.get('db'), key);
	if (!token) {
		return err(
			c,
			'REGISTRY_TOKEN_REQUIRED',
			'Configure a skills.sh token to search the registry',
			400,
		);
	}
	const limit = Number.parseInt(c.req.query('limit') ?? '20', 10);
	try {
		return ok(c, await searchRegistry(token, c.req.query('q') ?? '', limit));
	} catch (e) {
		if (e instanceof SkillsRegistryError) {
			return err(c, 'REGISTRY_ERROR', e.message, e.status >= 500 ? 503 : 400);
		}
		throw e;
	}
});

skillsRoutes.post('/skills/registry/install', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const key = c.get('masterKeyManager').getKey();
	if (!key) return err(c, 'LOCKED', 'Server must be unlocked', 401);
	const body = await c.req.json<{ id?: string }>();
	if (!body.id?.trim()) return err(c, 'INVALID_REQUEST', 'id is required', 400);
	const token = await getRegistryToken(c.get('db'), key);
	try {
		const skill = await installRegistrySkill(c.get('db'), body.id.trim(), token, null);
		c.get('events').emit({
			type: 'skill.created',
			teamId: null,
			actorType: 'admin',
			actorMemberId: null,
			skillId: skill.id,
			slug: skill.slug,
			name: skill.name,
		});
		return ok(c, skill, skill.reused ? 200 : 201);
	} catch (e) {
		if (e instanceof SkillsRegistryError) {
			return err(c, 'REGISTRY_ERROR', e.message, e.status >= 500 ? 503 : 400);
		}
		throw e;
	}
});

skillsRoutes.get('/skills/:slug', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const slug = c.req.param('slug');
	const result = await db.query<SkillRecord>('SELECT * FROM skills WHERE slug = $1', [slug]);
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'Skill not found', 404);
	return ok(c, result.rows[0]);
});

skillsRoutes.patch('/skills/:slug', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
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
	let paramIdx = 2; // $1 = slug

	if (body.name !== undefined) {
		sets.push(`name = $${paramIdx++}`);
		params.push(body.name.trim());
	}
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
		 WHERE slug = $1
		 RETURNING *`,
		[slug, ...params],
	);
	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Skill not found', 404);
	}
	const skill = result.rows[0];

	if (body.content !== undefined) {
		const revCount = await db.query<{ cnt: string }>(
			'SELECT COUNT(*)::text AS cnt FROM skill_revisions WHERE skill_id = $1',
			[skill.id],
		);
		const nextRev = Number.parseInt(revCount.rows[0].cnt, 10) + 1;
		await db.query(
			`INSERT INTO skill_revisions (skill_id, revision_number, content, content_hash, change_summary)
			 VALUES ($1, $2, $3, $4, 'Content updated')`,
			[skill.id, nextRev, body.content, skill.content_hash],
		);
	}
	c.get('events').emit({
		type: 'skill.updated',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		skillId: skill.id,
		slug: skill.slug,
		name: skill.name,
	});
	return ok(c, skill);
});

skillsRoutes.delete('/skills/:slug', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const slug = c.req.param('slug');
	const existing = await db.query<{ id: string; name: string }>(
		'SELECT id, name FROM skills WHERE slug = $1',
		[slug],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Skill not found', 404);
	}
	await db.query('DELETE FROM skills WHERE slug = $1', [slug]);
	c.get('events').emit({
		type: 'skill.deleted',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		skillId: existing.rows[0].id,
		slug,
		name: existing.rows[0].name,
	});
	return c.json({ data: null }, 200);
});
