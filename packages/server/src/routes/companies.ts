import type { PGlite } from '@electric-sql/pglite';
import { AuthType, MemberType, TERMINAL_ISSUE_STATUSES } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import { toIssuePrefix, toSlug, uniqueSlug } from '../lib/slug';
import type { Env } from '../lib/types';
import { requireCompanyAccess, requireSuperuser } from '../middleware/auth';
import { type ProjectRow, provisionContainer } from '../services/containers';
import { downloadAndSaveSkill, SkillDownloadError } from '../services/skill-downloader';

export const companiesRoutes = new Hono<Env>();

/** Generate parameterized placeholders for terminal issue statuses, starting at the given index. */
function terminalStatusParams(startIdx: number): { placeholders: string; values: string[] } {
	const placeholders = TERMINAL_ISSUE_STATUSES.map((_, i) => `$${startIdx + i}::issue_status`).join(
		', ',
	);
	return { placeholders, values: [...TERMINAL_ISSUE_STATUSES] };
}

companiesRoutes.get('/companies', async (c) => {
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
       (SELECT count(*) FROM members m WHERE m.company_id = c.id AND m.member_type = $1)::int AS agent_count,
       (SELECT count(*) FROM issues i WHERE i.company_id = c.id AND i.status NOT IN (${ts.placeholders}))::int AS open_issue_count
     FROM companies c
     ORDER BY c.created_at DESC`;
	} else {
		query = `SELECT c.*,
       (SELECT count(*) FROM members m WHERE m.company_id = c.id AND m.member_type = $1)::int AS agent_count,
       (SELECT count(*) FROM issues i WHERE i.company_id = c.id AND i.status NOT IN (${ts.placeholders}))::int AS open_issue_count
     FROM companies c
     JOIN members m2 ON m2.company_id = c.id
     JOIN member_users mu ON mu.id = m2.id
     WHERE mu.user_id = $${nextIdx}
     ORDER BY c.created_at DESC`;
		params.push(auth.userId);
	}

	const result = await db.query(query, params);
	return ok(c, result.rows);
});

companiesRoutes.post('/companies', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;

	const body = await c.req.json<{
		name: string;
		description?: string;
		template_id?: string;
		issue_prefix?: string;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}

	const db = c.get('db');
	const auth = c.get('auth');
	const issuePrefix = body.issue_prefix?.trim() || toIssuePrefix(body.name);

	const prefixCheck = await db.query('SELECT id FROM companies WHERE issue_prefix = $1', [
		issuePrefix,
	]);
	if (prefixCheck.rows.length > 0) {
		return err(c, 'CONFLICT', `Issue prefix '${issuePrefix}' is already in use`, 409);
	}

	const slug = await uniqueSlug(toSlug(body.name), async (s) => {
		const r = await db.query('SELECT 1 FROM companies WHERE slug = $1', [s]);
		return r.rows.length > 0;
	});

	await db.query('BEGIN');
	try {
		const companyResult = await db.query(
			`INSERT INTO companies (name, slug, description, issue_prefix)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
			[body.name.trim(), slug, body.description ?? '', issuePrefix],
		);
		const company = companyResult.rows[0] as { id: string; [key: string]: unknown };

		await db.query('INSERT INTO company_issue_counters (company_id, next_number) VALUES ($1, 1)', [
			company.id,
		]);

		// Auto-create board membership for the creator
		if (auth.type === AuthType.Board) {
			const memberResult = await db.query<{ id: string }>(
				`INSERT INTO members (company_id, member_type, display_name)
         VALUES ($1, $2, (SELECT display_name FROM users WHERE id = $3))
         RETURNING id`,
				[company.id, MemberType.User, auth.userId],
			);
			await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'board')`, [
				memberResult.rows[0].id,
				auth.userId,
			]);
		}

		await db.query(
			`INSERT INTO projects (company_id, name, slug, goal, is_internal)
			 VALUES ($1, 'Operations', 'operations', 'Administrative workspace for internal operations such as agent onboarding, team coordination, and company-wide tasks.', true)`,
			[company.id],
		);

		if (body.template_id) {
			await db.query(
				'INSERT INTO company_team_types (company_id, company_type_id) VALUES ($1, $2)',
				[company.id, body.template_id],
			);
			await createAgentsFromTeamTypes(db, company.id, [body.template_id]);
			await createKbDocsFromTemplate(db, company.id, body.template_id);
		}

		await db.query('COMMIT');

		const dataDir = c.get('dataDir');

		if (body.template_id) {
			await createSkillsFromTemplate(db, company.id, body.template_id, dataDir);
		}

		const opsResult = await db.query<ProjectRow>(
			`SELECT id, company_id, slug, docker_base_image, container_id, container_status, dev_ports
			 FROM projects WHERE company_id = $1 AND slug = 'operations'`,
			[company.id],
		);
		if (opsResult.rows[0]) {
			const docker = c.get('docker');
			provisionContainer(db, docker, opsResult.rows[0], slug, dataDir).catch((error) => {
				console.error(`Failed to provision container for operations project:`, error);
			});
		}

		const result = await db.query(
			`SELECT c.*,
         (SELECT count(*) FROM members m WHERE m.company_id = c.id AND m.member_type = $2)::int AS agent_count,
         0 AS open_issue_count
       FROM companies c WHERE c.id = $1`,
			[company.id, MemberType.Agent],
		);

		return ok(c, result.rows[0], 201);
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}
});

companiesRoutes.get('/companies/:companyId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const ts2 = terminalStatusParams(3);
	const result = await db.query(
		`SELECT c.*,
       (SELECT count(*) FROM members m WHERE m.company_id = c.id AND m.member_type = $2)::int AS agent_count,
       (SELECT count(*) FROM issues i WHERE i.company_id = c.id AND i.status NOT IN (${ts2.placeholders}))::int AS open_issue_count
     FROM companies c WHERE c.id = $1`,
		[companyId, MemberType.Agent, ...ts2.values],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company not found', 404);
	}

	return ok(c, result.rows[0]);
});

companiesRoutes.patch('/companies/:companyId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const existing = await db.query('SELECT id FROM companies WHERE id = $1', [companyId]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company not found', 404);
	}

	const body = await c.req.json<{
		name?: string;
		description?: string;
		mcp_servers?: unknown[];
		mpp_config?: Record<string, unknown>;
		coach_auto_apply?: boolean;
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
			const r = await db.query('SELECT 1 FROM companies WHERE slug = $1 AND id != $2', [
				s,
				companyId,
			]);
			return r.rows.length > 0;
		});
		addField('name', body.name.trim());
		addField('slug', newSlug);
	}
	addField('description', body.description);
	addField('mcp_servers', body.mcp_servers, true);
	addField('mpp_config', body.mpp_config, true);
	addField('coach_auto_apply', body.coach_auto_apply);

	if (sets.length === 0) {
		const result = await db.query('SELECT * FROM companies WHERE id = $1', [companyId]);
		return ok(c, result.rows[0]);
	}

	params.push(companyId);
	const result = await db.query(
		`UPDATE companies SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
		params,
	);

	return ok(c, result.rows[0]);
});

companiesRoutes.delete('/companies/:companyId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const existing = await db.query('SELECT id FROM companies WHERE id = $1', [companyId]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company not found', 404);
	}

	await db.query('DELETE FROM companies WHERE id = $1', [companyId]);
	return c.json({ data: null }, 200);
});

interface AgentTypeRow {
	id: string;
	name: string;
	slug: string;
	role_description: string;
	system_prompt_template: string;
	runtime_type: string;
	heartbeat_interval_min: number;
	monthly_budget_cents: number;
	reports_to_slug: string | null;
	runtime_type_override: string | null;
	heartbeat_interval_override: number | null;
	monthly_budget_override: number | null;
}

async function createAgentsFromTeamTypes(
	db: PGlite,
	companyId: string,
	teamTypeIds: string[],
): Promise<void> {
	const allRows: AgentTypeRow[] = [];
	for (const typeId of teamTypeIds) {
		const joinRows = await db.query<AgentTypeRow>(
			`SELECT at.id, at.name, at.slug, at.role_description, at.system_prompt_template,
			        at.runtime_type, at.heartbeat_interval_min, at.monthly_budget_cents,
			        ctat.reports_to_slug,
			        ctat.runtime_type_override, ctat.heartbeat_interval_override, ctat.monthly_budget_override
			 FROM company_type_agent_types ctat
			 JOIN agent_types at ON at.id = ctat.agent_type_id
			 WHERE ctat.company_type_id = $1
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
		const runtimeType = row.runtime_type_override ?? row.runtime_type;
		const heartbeat = row.heartbeat_interval_override ?? row.heartbeat_interval_min;
		const budget = row.monthly_budget_override ?? row.monthly_budget_cents;

		const memberResult = await db.query<{ id: string }>(
			`INSERT INTO members (company_id, member_type, display_name)
			 VALUES ($1, $2, $3)
			 RETURNING id`,
			[companyId, MemberType.Agent, row.name],
		);
		const memberId = memberResult.rows[0].id;
		slugToMemberId.set(row.slug, memberId);

		await db.query(
			`INSERT INTO member_agents (id, agent_type_id, title, slug, role_description, system_prompt,
			                            runtime_type, heartbeat_interval_min, monthly_budget_cents)
			 VALUES ($1, $2, $3, $4, $5, $6, $7::agent_runtime, $8, $9)`,
			[
				memberId,
				row.id,
				row.name,
				row.slug,
				row.role_description,
				row.system_prompt_template,
				runtimeType,
				heartbeat,
				budget,
			],
		);
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

async function createKbDocsFromTemplate(
	db: PGlite,
	companyId: string,
	templateId: string,
): Promise<void> {
	const result = await db.query<{
		kb_docs_config: Array<{ title: string; slug: string; content: string }>;
	}>('SELECT kb_docs_config FROM company_types WHERE id = $1', [templateId]);

	const docs = result.rows[0]?.kb_docs_config ?? [];
	for (const doc of docs) {
		await db.query(
			`INSERT INTO kb_docs (company_id, title, slug, content)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (company_id, slug) DO NOTHING`,
			[companyId, doc.title, doc.slug, doc.content],
		);
	}
}

async function createSkillsFromTemplate(
	db: PGlite,
	companyId: string,
	templateId: string,
	dataDir: string,
): Promise<void> {
	const result = await db.query<{
		skills_config: Array<{ name: string; source_url: string; description?: string }>;
	}>('SELECT skills_config FROM company_types WHERE id = $1', [templateId]);

	const skills = result.rows[0]?.skills_config ?? [];
	if (skills.length === 0) return;

	const company = await db.query<{ slug: string }>('SELECT slug FROM companies WHERE id = $1', [
		companyId,
	]);
	const companySlug = company.rows[0]?.slug;
	if (!companySlug) return;

	for (const skill of skills) {
		const slug = toSlug(skill.name);
		if (!slug) continue;
		try {
			await downloadAndSaveSkill(dataDir, companySlug, {
				name: skill.name,
				slug,
				description: skill.description ?? '',
				source_url: skill.source_url,
			});
		} catch (e) {
			if (e instanceof SkillDownloadError) {
				console.warn(`Failed to download template skill "${skill.name}": ${e.message}`);
				continue;
			}
			throw e;
		}
	}
}

export { createAgentsFromTeamTypes };
