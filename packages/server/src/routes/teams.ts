import type { PGlite } from '@electric-sql/pglite';
import { AuthType, BUILTIN_AGENT_SLUGS, MemberType, OPERATIONS_PROJECT_SLUG } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import { toProjectIssuePrefix, toSlug, uniqueSlug } from '../lib/slug';
import { terminalStatusParams } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireSuperuser, requireTeamAccess } from '../middleware/auth';
import { type ProjectRow, provisionContainer } from '../services/containers';
import { enqueueTeamContextTaskForAllAgents } from '../services/description-tasks';
import { initAgentSystemPrompt } from '../services/documents';
import { downloadSkillContent, SkillDownloadError } from '../services/skill-downloader';

const log = logger.child('routes');

export const teamsRoutes = new Hono<Env>();

teamsRoutes.get('/teams', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');

	const isSuperuser = auth.type === AuthType.Board && auth.isSuperuser;
	const isBoard = auth.type === AuthType.Board;

	let query: string;
	const params: unknown[] = [MemberType.Agent];
	const ts = terminalStatusParams(2);
	params.push(...ts.values);
	const nextIdx = 2 + ts.values.length;

	if (!isBoard || isSuperuser) {
		query = `SELECT c.*,
       (SELECT count(*) FROM members m WHERE m.team_id = c.id AND m.member_type = $1)::int AS agent_count,
       (SELECT count(*) FROM issues i WHERE i.team_id = c.id AND i.status NOT IN (${ts.placeholders}))::int AS open_issue_count
     FROM teams c
     ORDER BY c.created_at DESC`;
	} else {
		query = `SELECT c.*,
       (SELECT count(*) FROM members m WHERE m.team_id = c.id AND m.member_type = $1)::int AS agent_count,
       (SELECT count(*) FROM issues i WHERE i.team_id = c.id AND i.status NOT IN (${ts.placeholders}))::int AS open_issue_count
     FROM teams c
     JOIN members m2 ON m2.team_id = c.id
     JOIN member_users mu ON mu.id = m2.id
     WHERE mu.user_id = $${nextIdx}
     ORDER BY c.created_at DESC`;
		params.push(auth.userId);
	}

	const result = await db.query(query, params);
	return ok(c, result.rows);
});

teamsRoutes.post('/teams', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;

	const body = await c.req.json<{
		name: string;
		description?: string;
		template_id?: string;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}

	const db = c.get('db');
	const auth = c.get('auth');

	const slug = await uniqueSlug(toSlug(body.name), async (s) => {
		const r = await db.query('SELECT 1 FROM teams WHERE slug = $1', [s]);
		return r.rows.length > 0;
	});

	await db.query('BEGIN');
	try {
		const teamSummaryResult = body.template_id
			? await db.query<{ default_summary: string }>(
					'SELECT default_summary FROM team_templates WHERE id = $1',
					[body.template_id],
				)
			: null;
		const teamSummary = teamSummaryResult?.rows[0]?.default_summary ?? '';

		const teamResult = await db.query(
			`INSERT INTO teams (name, slug, description, summary)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
			[body.name.trim(), slug, body.description ?? '', teamSummary],
		);
		const team = teamResult.rows[0] as { id: string; [key: string]: unknown };

		// Auto-create board membership for the creator
		if (auth.type === AuthType.Board) {
			const memberResult = await db.query<{ id: string }>(
				`INSERT INTO members (team_id, member_type, display_name)
         VALUES ($1, $2, (SELECT display_name FROM users WHERE id = $3))
         RETURNING id`,
				[team.id, MemberType.User, auth.userId],
			);
			await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'board')`, [
				memberResult.rows[0].id,
				auth.userId,
			]);
		}

		const opsProjectResult = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, issue_prefix, description, is_internal)
			 VALUES ($1, 'Operations', $2, $3, 'Administrative workspace for internal operations such as agent onboarding, team coordination, and team-wide tasks.', true)
			 RETURNING id`,
			[team.id, OPERATIONS_PROJECT_SLUG, toProjectIssuePrefix('Operations')],
		);
		await db.query('INSERT INTO project_issue_counters (project_id, next_number) VALUES ($1, 1)', [
			opsProjectResult.rows[0].id,
		]);

		if (body.template_id) {
			await db.query(
				'INSERT INTO team_template_assignments (team_id, team_template_id) VALUES ($1, $2)',
				[team.id, body.template_id],
			);
			await createAgentsFromTeamTypes(db, team.id, [body.template_id]);
			await createKbDocsFromTemplate(db, team.id, body.template_id);
		}

		await ensureBuiltinAgents(db, team.id);

		await db.query('COMMIT');

		enqueueTeamContextTaskForAllAgents(db, team.id, 'initial').catch((e) =>
			log.error('Failed to bootstrap team_context tasks for new team:', e),
		);

		const dataDir = c.get('dataDir');

		if (body.template_id) {
			await createSkillsFromTemplate(db, team.id, body.template_id, dataDir);
		}

		const opsResult = await db.query<ProjectRow>(
			`SELECT id, team_id, slug, docker_base_image, container_id, container_status, dev_ports
			 FROM projects WHERE team_id = $1 AND slug = $2`,
			[team.id, OPERATIONS_PROJECT_SLUG],
		);
		if (opsResult.rows[0]) {
			provisionContainer(
				{
					db,
					docker: c.get('docker'),
					dataDir,
					wsManager: c.get('wsManager'),
					masterKeyManager: c.get('masterKeyManager'),
					logs: c.get('logs'),
				},
				opsResult.rows[0],
				slug,
			).catch((error) => {
				log.error(`Failed to provision container for operations project:`, error);
			});
		}

		const result = await db.query(
			`SELECT c.*,
         (SELECT count(*) FROM members m WHERE m.team_id = c.id AND m.member_type = $2)::int AS agent_count,
         0 AS open_issue_count
       FROM teams c WHERE c.id = $1`,
			[team.id, MemberType.Agent],
		);

		return ok(c, result.rows[0], 201);
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}
});

teamsRoutes.get('/teams/:teamId', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;

	const ts2 = terminalStatusParams(3);
	const result = await db.query(
		`SELECT c.*,
       (SELECT count(*) FROM members m WHERE m.team_id = c.id AND m.member_type = $2)::int AS agent_count,
       (SELECT count(*) FROM issues i WHERE i.team_id = c.id AND i.status NOT IN (${ts2.placeholders}))::int AS open_issue_count
     FROM teams c WHERE c.id = $1`,
		[teamId, MemberType.Agent, ...ts2.values],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Team not found', 404);
	}

	return ok(c, result.rows[0]);
});

teamsRoutes.patch('/teams/:teamId', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;

	const existing = await db.query('SELECT id FROM teams WHERE id = $1', [teamId]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Team not found', 404);
	}

	const body = await c.req.json<{
		name?: string;
		description?: string;
		mcp_servers?: unknown[];
		mpp_config?: Record<string, unknown>;
		settings?: Record<string, unknown>;
	}>();

	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	const addField = (field: string, value: unknown, jsonb = false) => {
		if (value !== undefined) {
			sets.push(`${field} = $${idx}${jsonb ? '::jsonb' : ''}`);
			params.push(jsonb ? JSON.stringify(value) : value);
			idx++;
		}
	};

	if (body.name?.trim()) {
		const newSlug = await uniqueSlug(toSlug(body.name), async (s) => {
			const r = await db.query('SELECT 1 FROM teams WHERE slug = $1 AND id != $2', [s, teamId]);
			return r.rows.length > 0;
		});
		addField('name', body.name.trim());
		addField('slug', newSlug);
	}
	addField('description', body.description);
	addField('mcp_servers', body.mcp_servers, true);
	addField('mpp_config', body.mpp_config, true);
	if (body.settings !== undefined) {
		sets.push(`settings = settings || $${idx}::jsonb`);
		params.push(JSON.stringify(body.settings));
		idx++;
	}

	if (sets.length === 0) {
		const result = await db.query('SELECT * FROM teams WHERE id = $1', [teamId]);
		return ok(c, result.rows[0]);
	}

	params.push(teamId);
	const result = await db.query(
		`UPDATE teams SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
		params,
	);

	return ok(c, result.rows[0]);
});

teamsRoutes.delete('/teams/:teamId', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;

	const existing = await db.query('SELECT id FROM teams WHERE id = $1', [teamId]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Team not found', 404);
	}

	await db.query('DELETE FROM teams WHERE id = $1', [teamId]);
	return c.json({ data: null }, 200);
});

interface AgentTypeRow {
	id: string;
	name: string;
	slug: string;
	role_description: string;
	default_summary: string;
	default_team_context: string;
	system_prompt_template: string;
	default_effort: string;
	heartbeat_interval_min: number;
	monthly_budget_cents: number;
	touches_code: boolean;
	reports_to_slug: string | null;
	heartbeat_interval_override: number | null;
	monthly_budget_override: number | null;
}

async function createAgentsFromTeamTypes(
	db: PGlite,
	teamId: string,
	teamTypeIds: string[],
): Promise<void> {
	const allRows: AgentTypeRow[] = [];
	for (const typeId of teamTypeIds) {
		const joinRows = await db.query<AgentTypeRow>(
			`SELECT at.id, at.name, at.slug, at.role_description, at.default_summary,
			        at.default_team_context, at.system_prompt_template,
			        at.default_effort, at.heartbeat_interval_min, at.monthly_budget_cents,
			        at.touches_code,
			        ctat.reports_to_slug,
			        ctat.heartbeat_interval_override, ctat.monthly_budget_override
			 FROM team_template_agent_types ctat
			 JOIN agent_types at ON at.id = ctat.agent_type_id
			 WHERE ctat.team_template_id = $1
			 ORDER BY ctat.sort_order ASC`,
			[typeId],
		);
		allRows.push(...joinRows.rows);
	}

	const seen = new Set<string>();
	const dedupedRows: AgentTypeRow[] = [];
	for (const row of allRows) {
		if (!seen.has(row.id)) {
			seen.add(row.id);
			dedupedRows.push(row);
		}
	}

	if (dedupedRows.length === 0) return;

	const slugToMemberId = new Map<string, string>();

	for (const row of dedupedRows) {
		const heartbeat = row.heartbeat_interval_override ?? row.heartbeat_interval_min;
		const budget = row.monthly_budget_override ?? row.monthly_budget_cents;

		const memberResult = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, $2, $3)
			 RETURNING id`,
			[teamId, MemberType.Agent, row.name],
		);
		const memberId = memberResult.rows[0].id;
		slugToMemberId.set(row.slug, memberId);

		await db.query(
			`INSERT INTO member_agents (id, agent_type_id, title, slug, role_description, summary,
			                            team_context,
			                            default_effort, heartbeat_interval_min, monthly_budget_cents,
			                            touches_code)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::agent_effort, $9, $10, $11)`,
			[
				memberId,
				row.id,
				row.name,
				row.slug,
				row.role_description,
				row.default_summary ?? '',
				row.default_team_context ?? '',
				row.default_effort,
				heartbeat,
				budget,
				row.touches_code ?? false,
			],
		);

		await initAgentSystemPrompt(db, teamId, memberId, row.system_prompt_template, null);
	}

	for (const row of dedupedRows) {
		if (row.reports_to_slug && row.reports_to_slug !== 'board') {
			const reportsToId = slugToMemberId.get(row.reports_to_slug);
			const memberId = slugToMemberId.get(row.slug);
			if (reportsToId && memberId) {
				await db.query('UPDATE member_agents SET reports_to = $1 WHERE id = $2', [
					reportsToId,
					memberId,
				]);
			}
		}
	}
}

async function ensureBuiltinAgents(db: PGlite, teamId: string): Promise<void> {
	const existing = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = ANY($2)`,
		[teamId, [...BUILTIN_AGENT_SLUGS]],
	);
	const existingSlugs = new Set(existing.rows.map((r) => r.slug));
	const missingSlugs = BUILTIN_AGENT_SLUGS.filter((s) => !existingSlugs.has(s));
	if (missingSlugs.length === 0) return;

	const overrideResult = await db.query<{
		builtin_agent_prompts: Record<string, string> | null;
		builtin_agent_team_contexts: Record<string, string> | null;
	}>(
		`SELECT ct.builtin_agent_prompts, ct.builtin_agent_team_contexts
		 FROM team_template_assignments ctt
		 JOIN team_templates ct ON ct.id = ctt.team_template_id
		 WHERE ctt.team_id = $1`,
		[teamId],
	);
	const promptOverrides: Record<string, string> = {};
	const teamContextOverrides: Record<string, string> = {};
	for (const row of overrideResult.rows) {
		for (const [slug, prompt] of Object.entries(row.builtin_agent_prompts ?? {})) {
			if (prompt && !promptOverrides[slug]) promptOverrides[slug] = prompt;
		}
		for (const [slug, context] of Object.entries(row.builtin_agent_team_contexts ?? {})) {
			if (context && !teamContextOverrides[slug]) teamContextOverrides[slug] = context;
		}
	}

	const agentTypes = await db.query<{
		id: string;
		name: string;
		slug: string;
		role_description: string;
		default_summary: string;
		default_team_context: string;
		system_prompt_template: string;
		default_effort: string;
		heartbeat_interval_min: number;
		monthly_budget_cents: number;
		touches_code: boolean;
	}>(
		`SELECT id, name, slug, role_description, default_summary, default_team_context,
		        system_prompt_template,
		        default_effort, heartbeat_interval_min, monthly_budget_cents, touches_code
		 FROM agent_types WHERE slug = ANY($1)`,
		[missingSlugs],
	);

	for (const at of agentTypes.rows) {
		const memberResult = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, $2, $3)
			 RETURNING id`,
			[teamId, MemberType.Agent, at.name],
		);
		await db.query(
			`INSERT INTO member_agents (id, agent_type_id, title, slug, role_description, summary,
			                            team_context,
			                            default_effort, heartbeat_interval_min, monthly_budget_cents,
			                            touches_code)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::agent_effort, $9, $10, $11)`,
			[
				memberResult.rows[0].id,
				at.id,
				at.name,
				at.slug,
				at.role_description,
				at.default_summary ?? '',
				teamContextOverrides[at.slug] || at.default_team_context || '',
				at.default_effort,
				at.heartbeat_interval_min,
				at.monthly_budget_cents,
				at.touches_code ?? false,
			],
		);

		await initAgentSystemPrompt(
			db,
			teamId,
			memberResult.rows[0].id,
			promptOverrides[at.slug] || at.system_prompt_template,
			null,
		);
	}
}

async function createKbDocsFromTemplate(
	db: PGlite,
	teamId: string,
	templateId: string,
): Promise<void> {
	const result = await db.query<{
		kb_docs_config: Array<{ title: string; slug: string; content: string }>;
	}>('SELECT kb_docs_config FROM team_templates WHERE id = $1', [templateId]);

	const docs = result.rows[0]?.kb_docs_config ?? [];
	for (const doc of docs) {
		await db.query(
			`INSERT INTO documents (team_id, type, slug, title, content)
			 VALUES ($1, 'kb_doc', $2, $3, $4)
			 ON CONFLICT DO NOTHING`,
			[teamId, doc.slug, doc.title, doc.content],
		);
	}
}

async function createSkillsFromTemplate(
	db: PGlite,
	teamId: string,
	templateId: string,
	_dataDir: string,
): Promise<void> {
	const result = await db.query<{
		skills_config: Array<{ name: string; source_url: string; description?: string }>;
	}>('SELECT skills_config FROM team_templates WHERE id = $1', [templateId]);

	const skills = result.rows[0]?.skills_config ?? [];
	if (skills.length === 0) return;

	for (const skill of skills) {
		const slug = toSlug(skill.name);
		if (!slug) continue;
		try {
			const { content, hash } = await downloadSkillContent(skill.source_url);
			await db.query(
				`INSERT INTO skills (team_id, name, slug, description, content, source_url, content_hash)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)
				 ON CONFLICT (team_id, slug) DO NOTHING`,
				[teamId, skill.name, slug, skill.description ?? '', content, skill.source_url, hash],
			);
		} catch (e) {
			if (e instanceof SkillDownloadError) {
				log.warn(`Failed to download template skill "${skill.name}": ${e.message}`);
				continue;
			}
			throw e;
		}
	}
}

export { createAgentsFromTeamTypes };
