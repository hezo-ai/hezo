import {
	AgentAdminStatus,
	type AiProvider,
	ALL_AI_PROVIDERS,
	ApprovalStatus,
	ApprovalType,
	AuthType,
	CEO_AGENT_SLUG,
	DEFAULT_EFFORT,
	DocumentType,
	IssuePriority,
	IssueStatus,
	isAgentEffort,
	MemberType,
	OPERATIONS_PROJECT_SLUG,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { allocateIssueIdentifier } from '../lib/issue-identifier';
import { err, ok } from '../lib/response';
import { toSlug } from '../lib/slug';
import { buildUpdateSet, terminalStatusParams } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireCompanyAccess } from '../middleware/auth';
import { enqueueAgentSummaryTask, enqueueTeamSummaryTask } from '../services/description-tasks';
import {
	getDocument,
	initAgentSystemPrompt,
	listRevisions,
	restoreRevision,
	upsertDocument,
} from '../services/documents';
import { createWakeup } from '../services/wakeup';

const log = logger.child('routes');

export const agentsRoutes = new Hono<Env>();

/**
 * Common projection for agent rows. JOIN against `members m` and `member_agents ma`.
 * `assigned_issue_count` requires the caller to bind terminal statuses via `terminalStatusParams`.
 */
const AGENT_BASE_COLUMNS = `m.id, m.company_id, m.display_name, m.created_at,
	ma.agent_type_id, ma.title, ma.slug, ma.role_description, ma.summary,
	ma.default_effort,
	ma.heartbeat_interval_min, ma.monthly_budget_cents, ma.budget_used_cents,
	ma.touches_code,
	ma.budget_reset_at, ma.runtime_status, ma.admin_status, ma.last_heartbeat_at, ma.reports_to,
	ma.mcp_servers, ma.model_override_provider, ma.model_override_model, ma.updated_at`;

const HEARTBEAT_RUN_COLUMNS = `hr.id, hr.member_id, hr.company_id, hr.wakeup_id, hr.issue_id,
	hr.status, hr.started_at, hr.finished_at, hr.exit_code, hr.error,
	hr.input_tokens, hr.output_tokens, hr.cost_cents,
	hr.invocation_command, hr.log_text, hr.working_dir,
	hr.process_pid, hr.retry_of_run_id, hr.process_loss_retry_count,
	i.identifier AS issue_identifier, i.title AS issue_title,
	i.project_id AS project_id, p.slug AS project_slug,
	COALESCE(
		(SELECT jsonb_agg(
			jsonb_build_object(
				'id', ci.id,
				'identifier', ci.identifier,
				'title', ci.title,
				'project_slug', cp.slug
			)
			ORDER BY ci.created_at ASC
		)
		FROM issues ci
		JOIN projects cp ON cp.id = ci.project_id
		WHERE ci.created_by_run_id = hr.id),
		'[]'::jsonb
	) AS created_issues`;

agentsRoutes.get('/companies/:companyId/agents', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const adminFilter = c.req.query('admin_status');

	const ts = terminalStatusParams(2);
	let query = `
		SELECT ${AGENT_BASE_COLUMNS},
			(SELECT ma2.title FROM member_agents ma2 WHERE ma2.id = ma.reports_to) AS reports_to_title,
			(SELECT count(*) FROM issues i WHERE i.assignee_id = m.id AND i.status NOT IN (${ts.placeholders}))::int AS assigned_issue_count
		FROM members m
		JOIN member_agents ma ON ma.id = m.id
		WHERE m.company_id = $1`;
	const params: unknown[] = [companyId, ...ts.values];

	if (adminFilter) {
		const statuses = adminFilter.split(',').map((s) => s.trim());
		const placeholders = statuses
			.map((_, i) => `$${params.length + 1 + i}::agent_admin_status`)
			.join(', ');
		query += ` AND ma.admin_status IN (${placeholders})`;
		params.push(...statuses);
	}

	query += ' ORDER BY ma.title ASC';

	const result = await db.query(query, params);
	return ok(c, result.rows);
});

agentsRoutes.post('/companies/:companyId/agents', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const companyCheck = await db.query('SELECT id FROM companies WHERE id = $1', [companyId]);
	if (companyCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company not found', 404);
	}

	const body = await c.req.json<{
		title: string;
		role_description?: string;
		system_prompt?: string;
		reports_to?: string;
		default_effort?: string;
		heartbeat_interval_min?: number;
		monthly_budget_cents?: number;
		touches_code?: boolean;
		mcp_servers?: unknown[];
	}>();

	if (!body.title?.trim()) {
		return err(c, 'INVALID_REQUEST', 'title is required', 400);
	}

	if (body.default_effort !== undefined && !isAgentEffort(body.default_effort)) {
		return err(c, 'INVALID_REQUEST', `Invalid default_effort: ${body.default_effort}`, 400);
	}

	const slug = toSlug(body.title);

	const slugCheck = await db.query(
		`SELECT ma.id FROM member_agents ma
     JOIN members m ON m.id = ma.id
     WHERE m.company_id = $1 AND ma.slug = $2`,
		[companyId, slug],
	);
	if (slugCheck.rows.length > 0) {
		return err(c, 'CONFLICT', `Agent with slug '${slug}' already exists in this company`, 409);
	}

	await db.query('BEGIN');
	try {
		const memberResult = await db.query<{ id: string }>(
			`INSERT INTO members (company_id, member_type, display_name)
       VALUES ($1, $2, $3)
       RETURNING id`,
			[companyId, MemberType.Agent, body.title.trim()],
		);
		const memberId = memberResult.rows[0].id;

		await db.query(
			`INSERT INTO member_agents (id, title, slug, role_description, reports_to, default_effort, heartbeat_interval_min, monthly_budget_cents, touches_code, mcp_servers)
       VALUES ($1, $2, $3, $4, $5, $6::agent_effort, $7, $8, $9, $10::jsonb)`,
			[
				memberId,
				body.title.trim(),
				slug,
				body.role_description ?? '',
				body.reports_to ?? null,
				body.default_effort ?? DEFAULT_EFFORT,
				body.heartbeat_interval_min ?? 60,
				body.monthly_budget_cents ?? 3000,
				body.touches_code ?? false,
				JSON.stringify(body.mcp_servers ?? []),
			],
		);

		await initAgentSystemPrompt(db, companyId, memberId, body.system_prompt ?? '', null);

		await db.query('COMMIT');

		const result = await db.query(
			`SELECT ${AGENT_BASE_COLUMNS}
			 FROM members m
			 JOIN member_agents ma ON ma.id = m.id
			 WHERE m.id = $1`,
			[memberId],
		);

		broadcastChange(
			c,
			wsRoom.company(companyId),
			'member_agents',
			'INSERT',
			result.rows[0] as Record<string, unknown>,
		);

		enqueueAgentSummaryTask(db, companyId, memberId, 'created').catch((e) =>
			log.error('Failed to enqueue agent summary task:', e),
		);
		enqueueTeamSummaryTask(db, companyId, 'agent_added').catch((e) =>
			log.error('Failed to enqueue team summary task:', e),
		);

		return ok(c, result.rows[0], 201);
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}
});

agentsRoutes.post('/companies/:companyId/agents/onboard', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const body = await c.req.json<{
		title: string;
		role_description?: string;
		system_prompt?: string;
		default_effort?: string;
		heartbeat_interval_min?: number;
		monthly_budget_cents?: number;
		touches_code?: boolean;
	}>();

	if (!body.title?.trim()) {
		return err(c, 'INVALID_REQUEST', 'title is required', 400);
	}

	if (body.default_effort !== undefined && !isAgentEffort(body.default_effort)) {
		return err(c, 'INVALID_REQUEST', `Invalid default_effort: ${body.default_effort}`, 400);
	}

	const slug = toSlug(body.title);
	const slugCheck = await db.query(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.company_id = $1 AND ma.slug = $2`,
		[companyId, slug],
	);
	if (slugCheck.rows.length > 0) {
		return err(c, 'CONFLICT', `Agent with slug '${slug}' already exists in this company`, 409);
	}

	const pendingCheck = await db.query(
		`SELECT id FROM approvals
		 WHERE company_id = $1 AND type = $2::approval_type AND status = $3::approval_status
		   AND payload->>'slug' = $4`,
		[companyId, ApprovalType.Hire, ApprovalStatus.Pending, slug],
	);
	if (pendingCheck.rows.length > 0) {
		return err(c, 'CONFLICT', `A pending hire proposal for slug '${slug}' already exists`, 409);
	}

	const ceoResult = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.company_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status`,
		[companyId, AgentAdminStatus.Enabled, CEO_AGENT_SLUG],
	);

	const opsProject = await db.query<{ id: string }>(
		`SELECT id FROM projects WHERE company_id = $1 AND is_internal = true AND slug = $2`,
		[companyId, OPERATIONS_PROJECT_SLUG],
	);

	const hasCeo = ceoResult.rows.length > 0;
	const hasOpsProject = opsProject.rows.length > 0;

	const proposal = {
		title: body.title.trim(),
		slug,
		role_description: body.role_description ?? '',
		system_prompt: body.system_prompt ?? '',
		default_effort: body.default_effort ?? DEFAULT_EFFORT,
		heartbeat_interval_min: body.heartbeat_interval_min ?? 60,
		monthly_budget_cents: body.monthly_budget_cents ?? 3000,
		touches_code: body.touches_code ?? false,
	};

	if (!hasCeo || !hasOpsProject) {
		await db.query('BEGIN');
		try {
			const memberResult = await db.query<{ id: string }>(
				`INSERT INTO members (company_id, member_type, display_name)
				 VALUES ($1, $2, $3)
				 RETURNING id`,
				[companyId, MemberType.Agent, proposal.title],
			);
			const memberId = memberResult.rows[0].id;

			await db.query(
				`INSERT INTO member_agents (id, title, slug, role_description,
				                            default_effort, heartbeat_interval_min, monthly_budget_cents,
				                            touches_code, admin_status)
				 VALUES ($1, $2, $3, $4, $5::agent_effort, $6, $7, $8, $9::agent_admin_status)`,
				[
					memberId,
					proposal.title,
					proposal.slug,
					proposal.role_description,
					proposal.default_effort,
					proposal.heartbeat_interval_min,
					proposal.monthly_budget_cents,
					proposal.touches_code,
					AgentAdminStatus.Enabled,
				],
			);

			await initAgentSystemPrompt(db, companyId, memberId, proposal.system_prompt, null);

			await db.query('COMMIT');
		} catch (e) {
			await db.query('ROLLBACK');
			throw e;
		}

		const agentResult = await db.query(
			`SELECT ${AGENT_BASE_COLUMNS}
			 FROM members m
			 JOIN member_agents ma ON ma.id = m.id
			 WHERE ma.slug = $1 AND m.company_id = $2`,
			[slug, companyId],
		);
		const agentRow = agentResult.rows[0] as Record<string, unknown>;

		broadcastChange(c, wsRoom.company(companyId), 'member_agents', 'INSERT', agentRow);
		enqueueAgentSummaryTask(db, companyId, agentRow.id as string, 'created').catch((e) =>
			log.error('Failed to enqueue agent summary task:', e),
		);
		enqueueTeamSummaryTask(db, companyId, 'agent_added').catch((e) =>
			log.error('Failed to enqueue team summary task:', e),
		);

		return ok(c, { agent: agentRow, issue: null, approval: null, bootstrap: true }, 201);
	}

	const ceoId = ceoResult.rows[0].id;
	const projectId = opsProject.rows[0].id;

	const auth = c.get('auth');
	let requestedByMemberId: string | null = null;
	if (auth.type === AuthType.Board && !auth.isSuperuser) {
		const me = await db.query<{ id: string }>(
			`SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id
			 WHERE mu.user_id = $1 AND m.company_id = $2`,
			[auth.userId, companyId],
		);
		requestedByMemberId = me.rows[0]?.id ?? null;
	}

	await db.query('BEGIN');
	try {
		const approvalResult = await db.query<Record<string, unknown>>(
			`INSERT INTO approvals (company_id, type, requested_by_member_id, payload, status)
			 VALUES ($1, $2::approval_type, $3, $4::jsonb, $5::approval_status)
			 RETURNING *`,
			[
				companyId,
				ApprovalType.Hire,
				requestedByMemberId,
				JSON.stringify(proposal),
				ApprovalStatus.Pending,
			],
		);
		const approvalId = approvalResult.rows[0].id as string;

		const existingAgents = await db.query<{ title: string; role_description: string }>(
			`SELECT ma.title, ma.role_description
			 FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.company_id = $1 AND ma.admin_status = $2::agent_admin_status`,
			[companyId, AgentAdminStatus.Enabled],
		);
		const teamRoster = existingAgents.rows
			.map((a) => `- **${a.title}**: ${a.role_description || 'No description'}`)
			.join('\n');

		const description = `## New Agent Hire Request

The board has requested a new agent. Expand the draft prompt if needed, post the revised prompt as a comment, and @-mention the board for review. Iterate until the board approves the linked hire approval. The agent will be created automatically on approval.

**Draft title**: ${proposal.title}
**Draft slug**: \`${proposal.slug}\`
**Role description**: ${proposal.role_description || 'Not provided'}
**Heartbeat**: every ${proposal.heartbeat_interval_min} min — **Budget**: $${(proposal.monthly_budget_cents / 100).toFixed(2)}/mo — **Touches code**: ${proposal.touches_code ? 'yes' : 'no'}

**Approval ID**: \`${approvalId}\`
Use \`update_hire_proposal\` to revise the draft.

### Draft system prompt
${proposal.system_prompt ? `\n\`\`\`\n${proposal.system_prompt}\n\`\`\`\n` : '_(empty — write one from the role description)_'}

### Existing team
${teamRoster}`;

		const { number: issueNumber, identifier } = await allocateIssueIdentifier(db, projectId);

		const issueResult = await db.query<Record<string, unknown>>(
			`INSERT INTO issues (company_id, project_id, assignee_id, number, identifier,
			                     title, description, status, priority, labels)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::issue_status, $9::issue_priority, $10::jsonb)
			 RETURNING *`,
			[
				companyId,
				projectId,
				ceoId,
				issueNumber,
				identifier,
				`Onboard new agent: ${proposal.title}`,
				description,
				IssueStatus.Backlog,
				IssuePriority.High,
				JSON.stringify(['onboarding', 'hire']),
			],
		);
		const issue = issueResult.rows[0];

		await db.query(
			`UPDATE approvals SET payload = payload || jsonb_build_object('issue_id', $1::text) WHERE id = $2`,
			[issue.id, approvalId],
		);
		const finalApproval = await db.query<Record<string, unknown>>(
			'SELECT * FROM approvals WHERE id = $1',
			[approvalId],
		);

		await db.query('COMMIT');

		broadcastChange(c, wsRoom.company(companyId), 'approvals', 'INSERT', finalApproval.rows[0]);
		broadcastChange(c, wsRoom.company(companyId), 'issues', 'INSERT', issue);

		createWakeup(db, ceoId, companyId, WakeupSource.Assignment, { issue_id: issue.id }).catch((e) =>
			log.error('Failed to wake CEO for hire request:', e),
		);

		return ok(c, { agent: null, issue, approval: finalApproval.rows[0], bootstrap: false }, 201);
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}
});

agentsRoutes.get('/companies/:companyId/agents/:agentId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const ts2 = terminalStatusParams(3);
	const result = await db.query(
		`SELECT ${AGENT_BASE_COLUMNS},
			(SELECT ma2.title FROM member_agents ma2 WHERE ma2.id = ma.reports_to) AS reports_to_title,
			(SELECT count(*) FROM issues i WHERE i.assignee_id = m.id AND i.status NOT IN (${ts2.placeholders}))::int AS assigned_issue_count
		 FROM members m
		 JOIN member_agents ma ON ma.id = m.id
		 WHERE m.id = $1 AND m.company_id = $2`,
		[c.req.param('agentId'), companyId, ...ts2.values],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Agent not found', 404);
	}

	return ok(c, result.rows[0]);
});

agentsRoutes.get('/companies/:companyId/agents/:agentId/system-prompt', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const agentId = c.req.param('agentId');

	const agent = await db.query(
		'SELECT m.id FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1 AND m.company_id = $2',
		[agentId, companyId],
	);
	if (agent.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Agent not found', 404);
	}

	const doc = await getDocument(db, {
		type: DocumentType.AgentSystemPrompt,
		companyId,
		memberAgentId: agentId,
	});
	return ok(c, doc);
});

agentsRoutes.get('/companies/:companyId/agents/:agentId/system-prompt/revisions', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const agentId = c.req.param('agentId');

	const doc = await getDocument(db, {
		type: DocumentType.AgentSystemPrompt,
		companyId,
		memberAgentId: agentId,
	});
	if (!doc) return err(c, 'NOT_FOUND', 'Agent system prompt not found', 404);

	const revisions = await listRevisions(db, doc.id);
	return ok(c, revisions);
});

agentsRoutes.post('/companies/:companyId/agents/:agentId/system-prompt/restore', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const auth = c.get('auth');
	if (auth.type === AuthType.Agent) {
		return err(c, 'FORBIDDEN', 'Only board members can restore revisions', 403);
	}

	const db = c.get('db');
	const { companyId } = access;
	const agentId = c.req.param('agentId');

	const body = await c.req.json<{ revision_number: number }>();
	if (typeof body.revision_number !== 'number') {
		return err(c, 'INVALID_REQUEST', 'revision_number is required', 400);
	}

	const doc = await getDocument(db, {
		type: DocumentType.AgentSystemPrompt,
		companyId,
		memberAgentId: agentId,
	});
	if (!doc) return err(c, 'NOT_FOUND', 'Agent system prompt not found', 404);

	const restored = await restoreRevision(db, c.get('wsManager'), {
		documentId: doc.id,
		revisionNumber: body.revision_number,
		restoredByMemberId: null,
	});
	if (!restored) return err(c, 'NOT_FOUND', 'Revision not found', 404);

	return ok(c, restored);
});

agentsRoutes.patch('/companies/:companyId/agents/:agentId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const agentId = c.req.param('agentId');

	const existing = await db.query(
		'SELECT m.id FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1 AND m.company_id = $2',
		[agentId, companyId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Agent not found', 404);
	}

	const body = await c.req.json<{
		title?: string;
		role_description?: string;
		system_prompt?: string;
		system_prompt_change_summary?: string;
		reports_to?: string | null;
		default_effort?: string;
		heartbeat_interval_min?: number;
		monthly_budget_cents?: number;
		touches_code?: boolean;
		mcp_servers?: unknown[];
		model_override_provider?: string | null;
		model_override_model?: string | null;
	}>();

	if (body.default_effort !== undefined && !isAgentEffort(body.default_effort)) {
		return err(c, 'INVALID_REQUEST', `Invalid default_effort: ${body.default_effort}`, 400);
	}

	const providerSet = Object.hasOwn(body, 'model_override_provider');
	const modelSet = Object.hasOwn(body, 'model_override_model');
	let overrideProvider: AiProvider | null | undefined;
	let overrideModel: string | null | undefined;

	if (providerSet) {
		const raw = body.model_override_provider;
		if (raw === null || raw === '' || raw === undefined) {
			overrideProvider = null;
		} else if (typeof raw === 'string' && (ALL_AI_PROVIDERS as readonly string[]).includes(raw)) {
			overrideProvider = raw as AiProvider;
		} else {
			return err(c, 'INVALID_REQUEST', `Invalid model_override_provider: ${String(raw)}`, 400);
		}
	}

	if (modelSet) {
		const raw = body.model_override_model;
		if (raw === null || raw === '' || raw === undefined) {
			overrideModel = null;
		} else if (typeof raw === 'string') {
			overrideModel = raw.trim() || null;
		} else {
			return err(c, 'INVALID_REQUEST', 'Invalid model_override_model', 400);
		}
	}

	// Clearing the provider must also clear the model, matching the DB CHECK constraint.
	if (providerSet && overrideProvider === null) {
		overrideModel = null;
	}
	// Setting a model without a provider in the same request is only valid if a
	// provider is already stored; otherwise the CHECK constraint would fail.
	if (overrideModel && overrideProvider === undefined) {
		const existingProvider = await db.query<{ model_override_provider: AiProvider | null }>(
			'SELECT model_override_provider FROM member_agents WHERE id = $1',
			[agentId],
		);
		if (!existingProvider.rows[0]?.model_override_provider) {
			return err(
				c,
				'INVALID_REQUEST',
				'model_override_model requires model_override_provider',
				400,
			);
		}
	}

	const {
		clauses: sets,
		params,
		nextIdx,
	} = buildUpdateSet([
		{ column: 'title', value: body.title?.trim() },
		{ column: 'role_description', value: body.role_description },
		{ column: 'reports_to', value: body.reports_to },
		{ column: 'default_effort', value: body.default_effort, cast: 'agent_effort' },
		{ column: 'heartbeat_interval_min', value: body.heartbeat_interval_min },
		{ column: 'monthly_budget_cents', value: body.monthly_budget_cents },
		{ column: 'touches_code', value: body.touches_code },
		{ column: 'mcp_servers', value: body.mcp_servers, cast: 'jsonb' },
		{ column: 'model_override_provider', value: overrideProvider, cast: 'ai_provider' },
		{ column: 'model_override_model', value: overrideModel },
	]);
	const idx = nextIdx;

	if (sets.length === 0 && body.system_prompt === undefined) {
		const result = await db.query(
			`SELECT m.*, ma.* FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1`,
			[agentId],
		);
		return ok(c, result.rows[0]);
	}

	if (body.title?.trim()) {
		await db.query('UPDATE members SET display_name = $1 WHERE id = $2', [
			body.title.trim(),
			agentId,
		]);
	}

	let updatedRow: Record<string, unknown>;
	if (sets.length > 0) {
		params.push(agentId);
		const result = await db.query(
			`UPDATE member_agents SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
			params,
		);
		updatedRow = result.rows[0] as Record<string, unknown>;
	} else {
		const result = await db.query(`SELECT * FROM member_agents WHERE id = $1`, [agentId]);
		updatedRow = result.rows[0] as Record<string, unknown>;
	}

	if (body.system_prompt !== undefined) {
		await upsertDocument(db, undefined, {
			scope: {
				type: DocumentType.AgentSystemPrompt,
				companyId,
				memberAgentId: agentId,
			},
			content: body.system_prompt,
			changeSummary: body.system_prompt_change_summary ?? 'Manual edit by board member',
			authorMemberId: null,
		});
	}

	broadcastChange(c, wsRoom.company(companyId), 'member_agents', 'UPDATE', updatedRow);

	if (body.system_prompt !== undefined || body.role_description !== undefined) {
		const reason = body.system_prompt !== undefined ? 'prompt_updated' : 'role_updated';
		enqueueAgentSummaryTask(db, companyId, agentId, reason).catch((e) =>
			log.error('Failed to enqueue agent summary task:', e),
		);
		enqueueTeamSummaryTask(db, companyId, 'prompt_updated').catch((e) =>
			log.error('Failed to enqueue team summary task:', e),
		);
	}

	return ok(c, updatedRow);
});

agentsRoutes.post('/companies/:companyId/agents/:agentId/disable', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const agentId = c.req.param('agentId');

	const existing = await db.query<{ admin_status: string }>(
		'SELECT ma.admin_status FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1 AND m.company_id = $2',
		[agentId, companyId],
	);
	if (existing.rows.length === 0) return err(c, 'NOT_FOUND', 'Agent not found', 404);
	if (existing.rows[0].admin_status === AgentAdminStatus.Disabled) {
		return err(c, 'INVALID_STATE', 'Agent is already disabled', 409);
	}

	await db.query(`UPDATE member_agents SET admin_status = $1::agent_admin_status WHERE id = $2`, [
		AgentAdminStatus.Disabled,
		agentId,
	]);

	const ts = terminalStatusParams(2, false);
	await db.query(
		`UPDATE issues SET assignee_id = NULL WHERE assignee_id = $1 AND status NOT IN (${ts.placeholders})`,
		[agentId, ...ts.values],
	);

	broadcastChange(c, wsRoom.company(companyId), 'member_agents', 'UPDATE', {
		id: agentId,
		admin_status: AgentAdminStatus.Disabled,
	});

	enqueueTeamSummaryTask(db, companyId, 'enabled_changed').catch((e) =>
		log.error('Failed to enqueue team summary task:', e),
	);

	return ok(c, { admin_status: AgentAdminStatus.Disabled });
});

agentsRoutes.post('/companies/:companyId/agents/:agentId/enable', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const agentId = c.req.param('agentId');

	const existing = await db.query<{ admin_status: string }>(
		'SELECT ma.admin_status FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1 AND m.company_id = $2',
		[agentId, companyId],
	);
	if (existing.rows.length === 0) return err(c, 'NOT_FOUND', 'Agent not found', 404);
	if (existing.rows[0].admin_status === AgentAdminStatus.Enabled) {
		return err(c, 'INVALID_STATE', 'Agent is already enabled', 409);
	}

	await db.query(`UPDATE member_agents SET admin_status = $1::agent_admin_status WHERE id = $2`, [
		AgentAdminStatus.Enabled,
		agentId,
	]);

	broadcastChange(c, wsRoom.company(companyId), 'member_agents', 'UPDATE', {
		id: agentId,
		admin_status: AgentAdminStatus.Enabled,
	});

	enqueueTeamSummaryTask(db, companyId, 'enabled_changed').catch((e) =>
		log.error('Failed to enqueue team summary task:', e),
	);

	return ok(c, { admin_status: AgentAdminStatus.Enabled });
});

agentsRoutes.get('/companies/:companyId/org-chart', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const result = await db.query(
		`SELECT m.id, ma.title, ma.slug, ma.runtime_status, ma.admin_status, ma.reports_to
     FROM members m
     JOIN member_agents ma ON ma.id = m.id
     WHERE m.company_id = $1`,
		[companyId],
	);

	const agents = result.rows as {
		id: string;
		title: string;
		slug: string;
		runtime_status: string;
		admin_status: string;
		reports_to: string | null;
	}[];
	type AgentNode = (typeof agents)[number] & { children: AgentNode[] };
	const byId = new Map(agents.map((a) => [a.id, { ...a, children: [] as AgentNode[] }]));

	const roots: AgentNode[] = [];
	for (const agent of byId.values()) {
		if (agent.reports_to && byId.has(agent.reports_to)) {
			byId.get(agent.reports_to)?.children.push(agent);
		} else {
			roots.push(agent);
		}
	}

	return ok(c, { board: { children: roots } });
});

agentsRoutes.get('/companies/:companyId/agents/:agentId/heartbeat-runs', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const agentId = c.req.param('agentId');

	const result = await db.query(
		`SELECT ${HEARTBEAT_RUN_COLUMNS}
		 FROM heartbeat_runs hr
		 LEFT JOIN issues i ON i.id = hr.issue_id
		 LEFT JOIN projects p ON p.id = i.project_id
		 WHERE hr.member_id = $1
		 ORDER BY hr.started_at DESC
		 LIMIT 50`,
		[agentId],
	);

	return ok(c, result.rows);
});

agentsRoutes.get('/companies/:companyId/agents/:agentId/heartbeat-runs/:runId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const agentId = c.req.param('agentId');
	const runId = c.req.param('runId');

	const result = await db.query(
		`SELECT ${HEARTBEAT_RUN_COLUMNS}
		 FROM heartbeat_runs hr
		 LEFT JOIN issues i ON i.id = hr.issue_id
		 LEFT JOIN projects p ON p.id = i.project_id
		 WHERE hr.id = $1 AND hr.member_id = $2`,
		[runId, agentId],
	);

	if (result.rows.length === 0) return c.json({ error: 'Run not found' }, 404);
	return ok(c, result.rows[0]);
});
