import { createHash } from 'node:crypto';
import type { SkillRecord } from '@hezo/shared';
import { Hono } from 'hono';
import { installDefaultSkills, listMissingDefaultSkills } from '../db/default-skills';
import { err, ok } from '../lib/response';
import { deriveSkillSummary } from '../lib/skill-summary';
import { toSlug } from '../lib/slug';
import { isUniqueViolation } from '../lib/sql';
import type { Env } from '../lib/types';
import { requireAdminEquivalent } from '../middleware/auth';
import {
	buildConnectorRecipesSkill,
	CONNECTOR_RECIPES_SLUG,
	isConnectorRecipesSlug,
} from '../services/connector-registry';
import {
	listSkillRevisions,
	recordSkillRevisionIfChanged,
	restoreSkillRevision,
} from '../services/skill-revisions';
import {
	getRegistryToken,
	hasRegistryToken,
	installRegistrySkill,
	SkillsRegistryError,
	searchRegistry,
	setRegistryToken,
} from '../services/skills-registry';

export const skillsRoutes = new Hono<Env>();

// List columns (content omitted) plus the scope key, `s.`-qualified for queries
// that JOIN `projects` to annotate the owning project.
const SKILL_LIST_COLUMNS_S = `s.id, s.name, s.slug, s.description, s.source_url, s.content_hash,
        s.created_by_member_id, s.project_id, s.tags, s.is_active, s.auto_load, s.created_at, s.updated_at`;

/**
 * Build the SET clause + params for a skill content edit (name/description/tags/
 * content). `$1` is reserved for the row's `id`; params returned start at `$2`.
 * Returns null when the body carries no editable field. Shared by the admin and
 * per-project PATCH routes so both edit paths behave identically.
 */
function buildSkillEdit(
	body: {
		name?: string;
		description?: string;
		tags?: string[];
		content?: string;
	},
	startIndex = 2,
): { sets: string[]; params: unknown[] } | null {
	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = startIndex; // first param placeholder for an edit field

	if (body.name !== undefined) {
		sets.push(`name = $${idx++}`);
		params.push(body.name.trim());
	}
	const trimmedDescription = body.description?.trim();
	let resolvedDescription: string | undefined =
		body.description !== undefined ? trimmedDescription : undefined;
	if (!trimmedDescription && body.content !== undefined) {
		resolvedDescription = deriveSkillSummary(body.content);
	}
	if (resolvedDescription !== undefined) {
		sets.push(`description = $${idx++}`);
		params.push(resolvedDescription);
	}
	if (body.tags !== undefined) {
		sets.push(`tags = $${idx++}::jsonb`);
		params.push(JSON.stringify(body.tags));
	}
	if (body.content !== undefined) {
		const hash = createHash('sha256').update(body.content).digest('hex');
		sets.push(`content = $${idx++}`);
		params.push(body.content);
		sets.push(`content_hash = $${idx++}`);
		params.push(hash);
	}
	if (sets.length === 0) return null;
	return { sets, params };
}

// The virtual `connector-recipes` skill is generated from the connector
// registry, not stored in the DB. It is surfaced read-only on the admin skills
// surface (list + detail); the create/edit/delete paths reject its slug.
// `readonly: true` lets the UI hide edit/delete affordances.
function connectorRecipesSkillRow(includeContent: boolean): Record<string, unknown> {
	const s = buildConnectorRecipesSkill();
	const now = new Date().toISOString();
	const row: Record<string, unknown> = {
		id: CONNECTOR_RECIPES_SLUG,
		name: s.name,
		slug: s.slug,
		description: s.description,
		source_url: null,
		content_hash: null,
		created_by_member_id: null,
		project_id: null,
		project_name: null,
		project_slug: null,
		tags: [],
		is_active: true,
		auto_load: false,
		created_at: now,
		updated_at: now,
		readonly: true,
	};
	if (includeContent) row.content = s.content;
	return row;
}

// --------------------------------------------------------------------------
// Admin surface (superuser): the global catalog + every project's skills, each
// annotated with its owning project. Skills are scoped like MCP connectors —
// NULL project_id is global ("all projects"); a non-NULL project_id is private
// to that project. The scope drop-down on /settings/skills re-scopes via PATCH.
// --------------------------------------------------------------------------

skillsRoutes.get('/skills', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const result = await db.query(
		`SELECT ${SKILL_LIST_COLUMNS_S}, p.name AS project_name, p.slug AS project_slug
		 FROM skills s
		 LEFT JOIN projects p ON p.id = s.project_id
		 WHERE s.is_active = true
		 ORDER BY s.name`,
	);
	// Surface the built-in `connector-recipes` virtual skill read-only alongside
	// the DB rows (annotate stored rows so the UI can tell them apart).
	const rows: Record<string, unknown>[] = result.rows.map((r) => ({
		...(r as Record<string, unknown>),
		readonly: false,
	}));
	rows.push(connectorRecipesSkillRow(false));
	return ok(c, rows);
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
		project_id?: string | null;
	}>();
	if (!body.name?.trim()) return err(c, 'INVALID_REQUEST', 'name is required', 400);
	if (!body.content?.trim()) return err(c, 'INVALID_REQUEST', 'content is required', 400);
	const slug = body.slug?.trim() || toSlug(body.name);
	if (!slug) return err(c, 'INVALID_REQUEST', 'slug could not be derived from name', 400);
	if (isConnectorRecipesSlug(slug)) {
		return err(
			c,
			'INVALID_REQUEST',
			'connector-recipes is a reserved built-in skill and cannot be created',
			400,
		);
	}

	// The admin may create a global skill (project_id null) or scope it to a
	// specific project via the create-form picker. Validate a named project.
	const projectId = body.project_id?.trim() || null;
	if (projectId) {
		const proj = await db.query<{ id: string }>('SELECT id FROM projects WHERE id = $1', [
			projectId,
		]);
		if (proj.rows.length === 0) return err(c, 'NOT_FOUND', 'project_id not found', 404);
	}

	const content = body.content;
	const hash = createHash('sha256').update(content).digest('hex');
	const description = body.description?.trim() || deriveSkillSummary(content);

	// Snapshot the prior content (matched within the same scope) so re-adding an
	// existing skill records a revision. `IS NOT DISTINCT FROM` null-safely
	// matches the global (NULL) or per-project scope.
	const prior = await db.query<{ content: string }>(
		'SELECT content FROM skills WHERE slug = $1 AND project_id IS NOT DISTINCT FROM $2',
		[slug, projectId],
	);

	// Upsert against the partial unique index matching the row's scope.
	const conflictTarget = projectId
		? '(project_id, slug) WHERE project_id IS NOT NULL'
		: '(slug) WHERE project_id IS NULL';
	let result: Awaited<ReturnType<typeof db.query<SkillRecord>>>;
	try {
		result = await db.query<SkillRecord>(
			`INSERT INTO skills (name, slug, description, content, source_url, content_hash, tags, project_id)
			 VALUES ($1, $2, $3, $4, NULL, $5, $6::jsonb, $7)
			 ON CONFLICT ${conflictTarget} DO UPDATE SET
			   name = EXCLUDED.name,
			   description = EXCLUDED.description,
			   content = EXCLUDED.content,
			   content_hash = EXCLUDED.content_hash,
			   tags = EXCLUDED.tags,
			   updated_at = now()
			 RETURNING *`,
			[
				body.name.trim(),
				slug,
				description,
				content,
				hash,
				JSON.stringify(body.tags ?? []),
				projectId,
			],
		);
	} catch (e) {
		if (isUniqueViolation(e)) {
			return err(c, 'CONFLICT', 'a skill with this slug already exists in this scope', 409);
		}
		throw e;
	}
	const skill = result.rows[0];
	await recordSkillRevisionIfChanged(
		db,
		skill.id,
		prior.rows[0]?.content ?? null,
		content,
		'Content updated',
		null,
	);
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
// and use the `npx skills` CLI directly). Registered before /skills/:id; the
// two-segment paths don't collide with the single-segment id route. Registry
// installs land as global skills. ---

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

// Default global skills that Hezo ships but this instance hasn't installed. Not
// auto-seeded — the global Skills page shows a button when this list is
// non-empty and installs behind a confirmation. Registered before `/skills/:id`
// so the literal `defaults` segment isn't captured as an id.
skillsRoutes.get('/skills/defaults', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const missing = await listMissingDefaultSkills(c.get('db'));
	return ok(c, { missing });
});

skillsRoutes.post('/skills/defaults/install', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const body = await c.req.json<{ slugs?: string[] }>().catch(() => ({}) as { slugs?: string[] });
	const slugs = Array.isArray(body.slugs)
		? body.slugs.filter((s): s is string => typeof s === 'string')
		: undefined;
	const installed = await installDefaultSkills(c.get('db'), { slugs });
	const events = c.get('events');
	for (const skill of installed) {
		events.emit({
			type: 'skill.created',
			teamId: null,
			actorType: 'admin',
			actorMemberId: null,
			skillId: skill.id,
			slug: skill.slug,
			name: skill.name,
		});
	}
	return ok(c, { installed });
});

skillsRoutes.get('/skills/:id', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	// The built-in virtual skill is generated, not a DB row (and its id is not a
	// UUID, so it must be intercepted before the query).
	if (c.req.param('id') === CONNECTOR_RECIPES_SLUG) {
		return ok(c, connectorRecipesSkillRow(true));
	}
	const db = c.get('db');
	const result = await db.query<SkillRecord>('SELECT * FROM skills WHERE id = $1', [
		c.req.param('id'),
	]);
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'Skill not found', 404);
	return ok(c, result.rows[0]);
});

// Revision history + restore — mirrors document/agent-prompt revisions
// (project-docs / agents routes). Admin-only, like the rest of this surface.
skillsRoutes.get('/skills/:id/revisions', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const skill = await db.query<{ id: string }>('SELECT id FROM skills WHERE id = $1', [
		c.req.param('id'),
	]);
	if (skill.rows.length === 0) return err(c, 'NOT_FOUND', 'Skill not found', 404);
	return ok(c, await listSkillRevisions(db, skill.rows[0].id));
});

skillsRoutes.post('/skills/:id/restore', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const body = await c.req.json<{ revision_number?: number }>();
	if (typeof body.revision_number !== 'number') {
		return err(c, 'INVALID_REQUEST', 'revision_number is required', 400);
	}
	const id = c.req.param('id');
	const skill = await db.query<{ id: string }>('SELECT id FROM skills WHERE id = $1', [id]);
	if (skill.rows.length === 0) return err(c, 'NOT_FOUND', 'Skill not found', 404);
	const restored = await restoreSkillRevision(db, skill.rows[0].id, body.revision_number, null);
	if (!restored) return err(c, 'NOT_FOUND', 'Revision not found', 404);
	c.get('events').emit({
		type: 'skill.updated',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		skillId: restored.id,
		slug: restored.slug,
		name: restored.name,
	});
	return ok(c, restored);
});

// Edit (name/description/tags/content) and/or re-scope (project_id). The scope
// drop-down on /settings/skills posts only { project_id } here; the edit form
// posts the content fields. Empty/whitespace project_id collapses to global.
skillsRoutes.patch('/skills/:id', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	if (c.req.param('id') === CONNECTOR_RECIPES_SLUG) {
		return err(
			c,
			'INVALID_REQUEST',
			'connector-recipes is a built-in skill and is not editable',
			400,
		);
	}
	const db = c.get('db');
	const id = c.req.param('id');

	const body = await c.req.json<{
		name?: string;
		description?: string;
		tags?: string[];
		content?: string;
		project_id?: string | null;
	}>();

	const edit = buildSkillEdit(body);
	const sets = edit?.sets ?? [];
	const params = edit?.params ?? [];

	if ('project_id' in body) {
		const projectId = body.project_id?.trim() || null;
		if (projectId) {
			const proj = await db.query<{ id: string }>('SELECT id FROM projects WHERE id = $1', [
				projectId,
			]);
			if (proj.rows.length === 0) return err(c, 'NOT_FOUND', 'project_id not found', 404);
		}
		sets.push(`project_id = $${params.length + 2}`);
		params.push(projectId);
	}

	if (sets.length === 0) {
		return err(c, 'INVALID_REQUEST', 'No fields to update', 400);
	}
	sets.push('updated_at = now()');

	// Capture prior content before overwriting so a content edit records a revision.
	const prior =
		body.content !== undefined
			? await db.query<{ content: string }>('SELECT content FROM skills WHERE id = $1', [id])
			: null;

	let result: Awaited<ReturnType<typeof db.query<SkillRecord>>>;
	try {
		result = await db.query<SkillRecord>(
			`UPDATE skills SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
			[id, ...params],
		);
	} catch (e) {
		// Re-scoping into a scope that already holds this slug trips a partial
		// unique index (global slug / per-project slug).
		if (isUniqueViolation(e)) {
			return err(c, 'CONFLICT', 'a skill with this slug already exists in the target scope', 409);
		}
		throw e;
	}
	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Skill not found', 404);
	}
	const skill = result.rows[0];

	if (body.content !== undefined) {
		await recordSkillRevisionIfChanged(
			db,
			skill.id,
			prior?.rows[0]?.content ?? null,
			body.content,
			'Content updated',
			null,
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

skillsRoutes.delete('/skills/:id', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	if (c.req.param('id') === CONNECTOR_RECIPES_SLUG) {
		return err(
			c,
			'INVALID_REQUEST',
			'connector-recipes is a built-in skill and is not deletable',
			400,
		);
	}
	const db = c.get('db');
	const id = c.req.param('id');
	const existing = await db.query<{ id: string; slug: string; name: string }>(
		'SELECT id, slug, name FROM skills WHERE id = $1',
		[id],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Skill not found', 404);
	}
	await db.query('DELETE FROM skills WHERE id = $1', [id]);
	c.get('events').emit({
		type: 'skill.deleted',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		skillId: existing.rows[0].id,
		slug: existing.rows[0].slug,
		name: existing.rows[0].name,
	});
	return c.json({ data: null }, 200);
});

// --------------------------------------------------------------------------
// Per-project surface: any project member (team access enforced by
// requireProjectAccessMiddleware on /api/projects/:projectId/*). Lists this
// project's own skills plus globals; edit/remove act ONLY on this project's own
// skills (a global or another project's skill can't be mutated here — the
// WHERE project_id = :projectId guard enforces it server-side). Scope changes
// are not possible here — those live on the global admin page.
// --------------------------------------------------------------------------

skillsRoutes.get('/projects/:projectId/skills', async (c) => {
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const result = await db.query(
		`SELECT ${SKILL_LIST_COLUMNS_S}, p.name AS project_name, p.slug AS project_slug
		 FROM skills s
		 LEFT JOIN projects p ON p.id = s.project_id
		 WHERE s.is_active = true AND (s.project_id = $1 OR s.project_id IS NULL)
		 ORDER BY s.name`,
		[projectId],
	);
	// The built-in `connector-recipes` virtual skill is global (project_id null) —
	// every project's runs see it — so surface it read-only alongside the stored
	// rows here too, exactly as the admin /skills list does.
	const rows: Record<string, unknown>[] = result.rows.map((r) => ({
		...(r as Record<string, unknown>),
		readonly: false,
	}));
	rows.push(connectorRecipesSkillRow(false));
	return ok(c, rows);
});

skillsRoutes.get('/projects/:projectId/skills/:id', async (c) => {
	// The built-in virtual skill is generated (global, not a DB row); serve it
	// read-only here so the per-project viewer can render its content.
	if (c.req.param('id') === CONNECTOR_RECIPES_SLUG) {
		return ok(c, connectorRecipesSkillRow(true));
	}
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	// Read-only scope mirrors the list route: this project's own skills PLUS
	// globals (project_id IS NULL). The per-project Skills page renders global
	// rows and lets them be viewed here; restricting to `project_id = $2` would
	// 404 every global and leave the viewer stuck loading. Edit/delete/restore
	// below stay strictly `project_id = $2` — globals are read-only here.
	const result = await db.query<SkillRecord>(
		'SELECT * FROM skills WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)',
		[c.req.param('id'), projectId],
	);
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'Skill not found', 404);
	return ok(c, result.rows[0]);
});

skillsRoutes.get('/projects/:projectId/skills/:id/revisions', async (c) => {
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const skill = await db.query<{ id: string }>(
		'SELECT id FROM skills WHERE id = $1 AND project_id = $2',
		[c.req.param('id'), projectId],
	);
	if (skill.rows.length === 0) return err(c, 'NOT_FOUND', 'Skill not found', 404);
	return ok(c, await listSkillRevisions(db, skill.rows[0].id));
});

skillsRoutes.post('/projects/:projectId/skills/:id/restore', async (c) => {
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const body = await c.req.json<{ revision_number?: number }>();
	if (typeof body.revision_number !== 'number') {
		return err(c, 'INVALID_REQUEST', 'revision_number is required', 400);
	}
	const skill = await db.query<{ id: string }>(
		'SELECT id FROM skills WHERE id = $1 AND project_id = $2',
		[c.req.param('id'), projectId],
	);
	if (skill.rows.length === 0) return err(c, 'NOT_FOUND', 'Skill not found', 404);
	const restored = await restoreSkillRevision(db, skill.rows[0].id, body.revision_number, null);
	if (!restored) return err(c, 'NOT_FOUND', 'Revision not found', 404);
	c.get('events').emit({
		type: 'skill.updated',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		skillId: restored.id,
		slug: restored.slug,
		name: restored.name,
	});
	return ok(c, restored);
});

skillsRoutes.patch('/projects/:projectId/skills/:id', async (c) => {
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const id = c.req.param('id');
	const body = await c.req.json<{
		name?: string;
		description?: string;
		tags?: string[];
		content?: string;
	}>();

	// $1 = id, $2 = projectId, so edit placeholders start at $3.
	const edit = buildSkillEdit(body, 3);
	if (!edit) return err(c, 'INVALID_REQUEST', 'No fields to update', 400);
	edit.sets.push('updated_at = now()');

	const prior =
		body.content !== undefined
			? await db.query<{ content: string }>(
					'SELECT content FROM skills WHERE id = $1 AND project_id = $2',
					[id, projectId],
				)
			: null;

	const result = await db.query<SkillRecord>(
		`UPDATE skills SET ${edit.sets.join(', ')} WHERE id = $1 AND project_id = $2 RETURNING *`,
		[id, projectId, ...edit.params],
	);
	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Skill not found', 404);
	}
	const skill = result.rows[0];
	if (body.content !== undefined) {
		await recordSkillRevisionIfChanged(
			db,
			skill.id,
			prior?.rows[0]?.content ?? null,
			body.content,
			'Content updated',
			null,
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

skillsRoutes.delete('/projects/:projectId/skills/:id', async (c) => {
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const id = c.req.param('id');
	const existing = await db.query<{ id: string; slug: string; name: string }>(
		'SELECT id, slug, name FROM skills WHERE id = $1 AND project_id = $2',
		[id, projectId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Skill not found', 404);
	}
	await db.query('DELETE FROM skills WHERE id = $1 AND project_id = $2', [id, projectId]);
	c.get('events').emit({
		type: 'skill.deleted',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		skillId: existing.rows[0].id,
		slug: existing.rows[0].slug,
		name: existing.rows[0].name,
	});
	return c.json({ data: null }, 200);
});
