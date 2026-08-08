import {
	AgentAdminStatus,
	AgentRuntimeStatus,
	type AiProvider,
	ALL_AI_PROVIDERS,
	AuthType,
	CAPTAIN_AGENT_SLUG,
	CEO_AGENT_SLUG,
	DEFAULT_EFFORT,
	DEFAULT_HEARTBEAT_INTERVAL_MIN,
	DEFAULT_TEAM_ID,
	DocumentType,
	HeartbeatRunStatus,
	hasFixedReportsTo,
	INSTANCE_AGENT_SLUGS,
	isAgentEffort,
	isAllowedProjectIconStoredMime,
	isBudgetPauseStatus,
	isReservedAgentSlug,
	MemberType,
	PROJECT_ICON_MAX_BYTES,
	PROJECT_ICON_MAX_DIMENSION,
	requiredSystemPromptVarsError,
	TaskPriority,
	TaskStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../db/database';
import { runLogLengthSql, runLogTextSql } from '../db/run-log-chunks';
import { trackBackground } from '../lib/background';
import { broadcastChange } from '../lib/broadcast';
import { budgetWindowsError } from '../lib/budget-validation';
import { signEntityIconUrl, verifyEntityIconUrl } from '../lib/entity-icon-urls';
import { readImageDimensions } from '../lib/image-dimensions';
import { buildMeta, parsePagination } from '../lib/pagination';
import {
	actorTypeFromAuth,
	resolveActor,
	resolveActorMemberId,
	resolveAgentId,
} from '../lib/resolve';
import { err, ok } from '../lib/response';
import { toSlug } from '../lib/slug';
import { buildUpdateSet, isFkViolation, terminalStatusParams, withTransaction } from '../lib/sql';
import { allocateTaskIdentifier } from '../lib/task-identifier';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireAdminEquivalent } from '../middleware/auth';
import { setAgentAdminStatus } from '../services/agent-admin';
import {
	AgentSystemPromptError,
	fetchAgentSystemPromptForBatch,
	type SystemPromptMode,
} from '../services/agent-system-prompts';
import { getChatMemory, upsertChatMemory } from '../services/chat-memory';
import { enqueueTeamCoherenceReviewTask } from '../services/description-tasks';
import {
	getDocument,
	initAgentSystemPrompt,
	listRevisions,
	restoreRevision,
	upsertDocument,
} from '../services/documents';
import { HAS_ACTIONABLE_WORK_SQL, NEXT_HEARTBEAT_AT_SQL } from '../services/heartbeat-schedule';
import {
	type HireProposalInput,
	insertHireApproval,
	prepareHireProposal,
} from '../services/hire-proposal';
import { insertHireProposalComment } from '../services/hire-proposal-comment';
import { loadTeamCoordinationContext } from '../services/internal-intake';
import { terminateHeartbeatRun } from '../services/run-termination';
import { resolveSystemPrompt } from '../services/template-resolver';
import { createWakeup } from '../services/wakeup';

const MAX_BATCH_AGENT_SYSTEM_PROMPTS = 50;
const VALID_PROMPT_MODES: ReadonlyArray<SystemPromptMode> = ['raw', 'placeholders', 'preview'];

const log = logger.child('routes');

export const agentsRoutes = new Hono<Env>();

/**
 * Common projection for agent rows. JOIN against `members m` and `member_agents ma`.
 * `assigned_task_count` requires the caller to bind terminal statuses via `terminalStatusParams`.
 * `next_heartbeat_at` is computed (not stored) — NULL when the agent is off the schedule.
 * `has_actionable_work` is computed — false when the agent's next heartbeat would no-op.
 */
const AGENT_BASE_COLUMNS = `m.id, m.team_id, m.display_name, m.created_at,
	ma.agent_type_id, ma.title, ma.slug, ma.role_description, ma.summary, ma.team_context,
	ma.default_effort,
	ma.heartbeat_interval_min, ma.run_timeout_min,
	ma.daily_budget_cents, ma.weekly_budget_cents, ma.monthly_budget_cents,
	ma.touches_code,
	ma.runtime_status, ma.admin_status, ma.last_heartbeat_at, ma.reports_to,
	ma.mcp_servers, ma.model_override_provider, ma.model_override_model, ma.updated_at,
	(SELECT ai.updated_at FROM agent_icons ai WHERE ai.member_id = m.id) AS icon_updated_at,
	${NEXT_HEARTBEAT_AT_SQL} AS next_heartbeat_at,
	${HAS_ACTIONABLE_WORK_SQL} AS has_actionable_work`;

// --- Agent avatar (icon) ------------------------------------------------------
// An optional user-uploaded image shown for an agent in place of its initials.
// Stored as bytes in the DB (agent_icons, 1:1 with member_agents). Served via an
// HMAC-signed public URL (rendered in an <img>, which can't carry a bearer
// token) — mirrors the project-icon feature, generalized in `entity-icon-urls`.
const AGENT_ICON_KEY_PURPOSE = 'agent-icon-url';
const AGENT_ICON_BASE_PATH = '/api/agents';

/** Sign an agent's icon URL from its `icon_updated_at` version, or null when unset. */
async function signAgentIcon(
	c: Context<Env>,
	id: string,
	iconUpdatedAt: unknown,
): Promise<string | null> {
	if (typeof iconUpdatedAt === 'string' || iconUpdatedAt instanceof Date) {
		const version = Math.floor(new Date(iconUpdatedAt).getTime() / 1000);
		return signEntityIconUrl(
			AGENT_ICON_BASE_PATH,
			AGENT_ICON_KEY_PURPOSE,
			id,
			c.get('masterKeyManager'),
			version,
		);
	}
	return null;
}

/**
 * Attach a freshly-signed `icon_url` to a serialized agent row (from the
 * correlated `icon_updated_at` subselect in AGENT_BASE_COLUMNS). The icon bytes
 * themselves are never selected onto the row.
 */
async function withAgentIconUrl(
	c: Context<Env>,
	row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	row.icon_url = await signAgentIcon(c, row.id as string, row.icon_updated_at);
	if (!row.icon_url) row.icon_updated_at = null;
	return row;
}

/**
 * Every run column except the log itself.
 *
 * The log is deliberately absent: `log_text` aggregates a run's chunks into one
 * string that reaches the 10 MB cap, and this projection also backs the
 * paginated list, where `per_page` goes to 200 - a single page could materialize
 * and serialize gigabytes. Single-run reads add it back via
 * `HEARTBEAT_RUN_COLUMNS_WITH_LOG`; the list ships `log_length` instead, which
 * is a cheap aggregate over lengths.
 */
const HEARTBEAT_RUN_COLUMNS = `hr.id, hr.member_id, hr.team_id, hr.wakeup_id, hr.task_id, hr.kind,
	hr.status, hr.queued_reason, hr.started_at, hr.finished_at, hr.exit_code, hr.error,
	hr.input_tokens, hr.output_tokens, hr.cost_cents, hr.usage_partial,
	hr.invocation_command, hr.working_dir,
	hr.process_pid, hr.retry_of_run_id, hr.process_loss_retry_count,
	i.identifier AS task_identifier, i.title AS task_title,
	i.project_id AS project_id, p.slug AS project_slug, p.name AS project_name,
	aw.source AS trigger_source,
	aw.payload AS trigger_payload,
	tic.id AS trigger_comment_id,
	tic.public_id AS trigger_comment_public_id,
	tic.author_member_id AS trigger_actor_member_id,
	tama.slug AS trigger_actor_slug,
	tama.title AS trigger_actor_title,
	tii.id AS trigger_comment_task_id,
	tii.identifier AS trigger_comment_task_identifier,
	tip.slug AS trigger_comment_project_slug,
	hrc.id AS run_comment_id,
	hrc.public_id AS run_comment_public_id,
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
		FROM tasks ci
		JOIN projects cp ON cp.id = ci.project_id
		WHERE ci.created_by_run_id = hr.id),
		'[]'::jsonb
	) AS created_tasks,
	-- Project docs the agent added/updated during this run. Docs aren't stamped
	-- with a run id, so they're attributed to the run's agent within its
	-- wall-clock window (started_at .. finished_at). Mirrors created_tasks.
	COALESCE(
		(SELECT jsonb_agg(
			jsonb_build_object('filename', d.slug, 'project_slug', p.slug)
			ORDER BY d.updated_at ASC
		)
		FROM documents d
		JOIN projects p ON p.id = d.project_id
		WHERE d.type = 'project_doc'
		  AND d.team_id = hr.team_id
		  AND d.last_updated_by_member_id = hr.member_id
		  AND hr.started_at IS NOT NULL
		  AND d.updated_at >= hr.started_at
		  AND (hr.finished_at IS NULL OR d.updated_at <= hr.finished_at)),
		'[]'::jsonb
	) AS created_docs,
	-- Skills the agent added/updated directly in the skills database this run.
	-- project_slug is the owning project's slug for a project-scoped skill, or
	-- NULL for a global skill — the frontend links a scoped skill to the project
	-- Skills page and a global one to /settings/skills.
	COALESCE(
		(SELECT jsonb_agg(
			jsonb_build_object('name', s.name, 'slug', s.slug, 'source_url', s.source_url, 'created', (s.created_at >= hr.started_at), 'project_slug', sp.slug)
			ORDER BY s.updated_at ASC
		)
		FROM skills s
		LEFT JOIN projects sp ON sp.id = s.project_id
		WHERE s.created_by_member_id = hr.member_id
		  AND hr.started_at IS NOT NULL
		  AND s.updated_at >= hr.started_at
		  AND (hr.finished_at IS NULL OR s.updated_at <= hr.finished_at)),
		'[]'::jsonb
	) AS created_skills,
	-- Skills the agent proposed this run (propose_skill) — pending approval.
	COALESCE(
		(SELECT jsonb_agg(
			jsonb_build_object(
				'name', a.payload->>'skill_name',
				'slug', a.payload->>'skill_slug'
			)
			ORDER BY a.created_at ASC
		)
		FROM approvals a
		WHERE a.type = 'skill_proposal'
		  AND a.status = 'pending'
		  AND a.team_id = hr.team_id
		  AND a.requested_by_member_id = hr.member_id
		  AND hr.started_at IS NOT NULL
		  AND a.created_at >= hr.started_at
		  AND (hr.finished_at IS NULL OR a.created_at <= hr.finished_at)),
		'[]'::jsonb
	) AS proposed_skills`;

/** Run columns plus the full log, for single-run reads only. */
const HEARTBEAT_RUN_COLUMNS_WITH_LOG = `${HEARTBEAT_RUN_COLUMNS}, ${runLogTextSql('hr.id')} AS log_text`;

/** Run columns plus a cheap log-size hint, for the paginated list. */
const HEARTBEAT_RUN_COLUMNS_WITH_LOG_LENGTH = `${HEARTBEAT_RUN_COLUMNS}, ${runLogLengthSql('hr.id')} AS log_length`;

const HEARTBEAT_RUN_TRIGGER_JOINS = `LEFT JOIN agent_wakeup_requests aw ON aw.id = hr.wakeup_id
	LEFT JOIN task_comments tic ON tic.id = NULLIF(aw.payload->>'comment_id', '')::uuid
	LEFT JOIN member_agents tama ON tama.id = tic.author_member_id
	LEFT JOIN tasks tii ON tii.id = tic.task_id
	LEFT JOIN projects tip ON tip.id = tii.project_id
	LEFT JOIN task_comments hrc ON hrc.task_id = hr.task_id
		AND hrc.content_type = 'run'
		AND hrc.content->>'run_id' = hr.id::text`;

agentsRoutes.get('/projects/:projectId/agents', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const adminFilter = c.req.query('admin_status');

	const ts = terminalStatusParams(2);
	const params: unknown[] = [teamId, ...ts.values];
	const hqIdx = params.length + 1;
	params.push(DEFAULT_TEAM_ID);
	// HQ agents are virtual members of every project team: include them alongside
	// the team's own roster (flagged is_instance), except when this project IS HQ.
	let query = `
		SELECT ${AGENT_BASE_COLUMNS},
			(m.team_id <> $1) AS is_instance,
			(SELECT ma2.title FROM member_agents ma2 WHERE ma2.id = ma.reports_to) AS reports_to_title,
			(SELECT count(*) FROM tasks i WHERE i.assignee_id = m.id AND i.status NOT IN (${ts.placeholders}))::int AS assigned_task_count,
			CASE WHEN hr.run_status IS NOT NULL THEN json_build_object(
				'task_id', hr.task_id,
				'task_identifier', hr.task_identifier,
				'task_project_id', hr.task_project_id,
				'run_status', hr.run_status
			) ELSE NULL END AS active_run
		FROM members m
		JOIN member_agents ma ON ma.id = m.id
		LEFT JOIN LATERAL (
			SELECT hr2.task_id, i.identifier AS task_identifier, i.project_id AS task_project_id,
			       hr2.status AS run_status
			FROM heartbeat_runs hr2
			LEFT JOIN tasks i ON i.id = hr2.task_id
			WHERE hr2.member_id = m.id AND hr2.status IN ('running', 'queued')
			ORDER BY CASE hr2.status WHEN 'running' THEN 0 ELSE 1 END,
			         hr2.started_at DESC NULLS LAST,
			         hr2.created_at DESC
			LIMIT 1
		) hr ON true
		WHERE (m.team_id = $1 OR (m.team_id = $${hqIdx} AND $1 <> $${hqIdx}))`;

	if (adminFilter) {
		const statuses = adminFilter.split(',').map((s) => s.trim());
		const placeholders = statuses
			.map((_, i) => `$${params.length + 1 + i}::agent_admin_status`)
			.join(', ');
		query += ` AND ma.admin_status IN (${placeholders})`;
		params.push(...statuses);
	}

	query += ' ORDER BY is_instance ASC, ma.title ASC';

	const result = await db.query(query, params);
	const rows = await Promise.all(
		result.rows.map((r) => withAgentIconUrl(c, r as Record<string, unknown>)),
	);
	return ok(c, rows);
});

agentsRoutes.post('/projects/:projectId/agents', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const teamCheck = await db.query('SELECT id FROM teams WHERE id = $1', [teamId]);
	if (teamCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Team not found', 404);
	}

	const body = await c.req.json<{
		title: string;
		role_description?: string;
		system_prompt?: string;
		reports_to?: string;
		default_effort?: string;
		heartbeat_interval_min?: number;
		daily_budget_cents?: number;
		weekly_budget_cents?: number;
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

	const budgetError = budgetWindowsError({
		daily_budget_cents: body.daily_budget_cents ?? 0,
		weekly_budget_cents: body.weekly_budget_cents ?? 0,
		monthly_budget_cents: body.monthly_budget_cents ?? 3000,
	});
	if (budgetError) {
		return err(c, 'INVALID_REQUEST', budgetError, 400);
	}

	// A supplied prompt must keep the required substitution variables; an
	// omitted/empty one keeps the existing default behaviour.
	if (body.system_prompt?.trim()) {
		const promptError = requiredSystemPromptVarsError(body.system_prompt);
		if (promptError) return err(c, 'INVALID_REQUEST', promptError, 400);
	}

	const slug = toSlug(body.title);

	if (isReservedAgentSlug(slug)) {
		return err(c, 'INVALID_REQUEST', `Agent slug '${slug}' is reserved`, 400);
	}

	const slugCheck = await db.query(
		`SELECT ma.id FROM member_agents ma
     JOIN members m ON m.id = ma.id
     WHERE m.team_id = $1 AND ma.slug = $2`,
		[teamId, slug],
	);
	if (slugCheck.rows.length > 0) {
		return err(c, 'CONFLICT', `Agent with slug '${slug}' already exists in this team`, 409);
	}

	let memberId: string;
	try {
		memberId = await withTransaction(db, async () => {
			const memberResult = await db.query<{ id: string }>(
				`INSERT INTO members (team_id, member_type, display_name)
       VALUES ($1, $2, $3)
       RETURNING id`,
				[teamId, MemberType.Agent, body.title.trim()],
			);
			const newMemberId = memberResult.rows[0].id;

			await db.query(
				`INSERT INTO member_agents (id, title, slug, role_description, reports_to, default_effort, heartbeat_interval_min, daily_budget_cents, weekly_budget_cents, monthly_budget_cents, touches_code, mcp_servers)
       VALUES ($1, $2, $3, $4, $5, $6::agent_effort, $7, $8, $9, $10, $11, $12::jsonb)`,
				[
					newMemberId,
					body.title.trim(),
					slug,
					body.role_description ?? '',
					body.reports_to ?? null,
					body.default_effort ?? DEFAULT_EFFORT,
					body.heartbeat_interval_min ?? DEFAULT_HEARTBEAT_INTERVAL_MIN,
					body.daily_budget_cents ?? 0,
					body.weekly_budget_cents ?? 0,
					body.monthly_budget_cents ?? 3000,
					body.touches_code ?? false,
					JSON.stringify(body.mcp_servers ?? []),
				],
			);

			await initAgentSystemPrompt(db, teamId, newMemberId, body.system_prompt ?? '', null);
			return newMemberId;
		});
	} catch (e) {
		if (isFkViolation(e, 'member_agents_reports_to_fkey')) {
			return err(c, 'INVALID_REQUEST', 'reports_to: agent does not exist', 400);
		}
		throw e;
	}

	const result = await db.query(
		`SELECT ${AGENT_BASE_COLUMNS}
		 FROM members m
		 JOIN member_agents ma ON ma.id = m.id
		 WHERE m.id = $1`,
		[memberId],
	);

	broadcastChange(
		c,
		wsRoom.team(teamId),
		'member_agents',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);

	trackBackground(
		enqueueTeamCoherenceReviewTask(db, teamId, 'agent_hired').catch((e) =>
			log.error('Failed to enqueue team coherence review after agent create:', e),
		),
	);

	const createActor = await resolveActor(db, c.get('auth'), teamId);
	c.get('events').emit({
		type: 'agent.created',
		teamId,
		actorType: createActor.actorType,
		actorMemberId: createActor.actorMemberId,
		actorApiKeyId: createActor.actorApiKeyId,
		agentMemberId: memberId,
	});

	return ok(c, result.rows[0], 201);
});

agentsRoutes.post('/projects/:projectId/agents/onboard', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const body = await c.req.json<HireProposalInput>();

	const prepared = await prepareHireProposal(db, teamId, body);
	if ('error' in prepared) {
		return err(
			c,
			prepared.conflict ? 'CONFLICT' : 'INVALID_REQUEST',
			prepared.error,
			prepared.conflict ? 409 : 400,
		);
	}
	const proposal = prepared.payload;
	const slug = proposal.slug;

	// Hiring is per-team coordination: the hire ticket lives in the team's own
	// project and is actioned by the instance CEO (which runs cross-team there).
	const coord = await loadTeamCoordinationContext(db, teamId);

	if (!coord) {
		await withTransaction(db, async () => {
			const memberResult = await db.query<{ id: string }>(
				`INSERT INTO members (team_id, member_type, display_name)
				 VALUES ($1, $2, $3)
				 RETURNING id`,
				[teamId, MemberType.Agent, proposal.title],
			);
			const memberId = memberResult.rows[0].id;

			// Resolve the manager slug (if any) to a member id for the structural link.
			const reportsToId = proposal.reports_to
				? await resolveAgentId(db, teamId, proposal.reports_to)
				: null;

			await db.query(
				`INSERT INTO member_agents (id, title, slug, role_description, reports_to,
				                            default_effort, heartbeat_interval_min,
				                            daily_budget_cents, weekly_budget_cents, monthly_budget_cents,
				                            touches_code, admin_status)
				 VALUES ($1, $2, $3, $4, $5, $6::agent_effort, $7, $8, $9, $10, $11, $12::agent_admin_status)`,
				[
					memberId,
					proposal.title,
					proposal.slug,
					proposal.role_description,
					reportsToId,
					proposal.default_effort,
					proposal.heartbeat_interval_min,
					proposal.daily_budget_cents,
					proposal.weekly_budget_cents,
					proposal.monthly_budget_cents,
					proposal.touches_code,
					AgentAdminStatus.Enabled,
				],
			);

			await initAgentSystemPrompt(db, teamId, memberId, proposal.system_prompt, null);
		});

		const agentResult = await db.query(
			`SELECT ${AGENT_BASE_COLUMNS}
			 FROM members m
			 JOIN member_agents ma ON ma.id = m.id
			 WHERE ma.slug = $1 AND m.team_id = $2`,
			[slug, teamId],
		);
		const agentRow = agentResult.rows[0] as Record<string, unknown>;

		broadcastChange(c, wsRoom.team(teamId), 'member_agents', 'INSERT', agentRow);
		trackBackground(
			enqueueTeamCoherenceReviewTask(db, teamId, 'agent_hired').catch((e) =>
				log.error('Failed to enqueue team coherence review after onboard:', e),
			),
		);

		return ok(c, { agent: agentRow, task: null, approval: null, bootstrap: true }, 201);
	}

	const { ceoMemberId, teamProjectId } = coord;

	const auth = c.get('auth');
	let requestedByMemberId: string | null = null;
	if (auth.type === AuthType.Admin && !auth.isSuperuser) {
		const me = await db.query<{ id: string }>(
			`SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id
			 WHERE mu.user_id = $1 AND m.team_id = $2`,
			[auth.userId, teamId],
		);
		requestedByMemberId = me.rows[0]?.id ?? null;
	}

	const { task, finalApproval } = await withTransaction(db, async () => {
		const approvalRow = await insertHireApproval(db, teamId, proposal, requestedByMemberId);
		const approvalId = approvalRow.id as string;

		const existingAgents = await db.query<{ title: string; role_description: string }>(
			`SELECT ma.title, ma.role_description
			 FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.admin_status = $2::agent_admin_status`,
			[teamId, AgentAdminStatus.Enabled],
		);
		const teamRoster = existingAgents.rows
			.map((a) => `- **${a.title}**: ${a.role_description || 'No description'}`)
			.join('\n');

		const description = `## New Agent Hire Request

The admin has requested a new agent. Expand the draft prompt if needed, post the revised prompt as a comment, and @-mention the admin for review. Iterate until the admin approves the linked hire approval. The agent will be created automatically on approval.

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

		const { number: taskNumber, identifier } = await allocateTaskIdentifier(db, teamProjectId);

		const taskResult = await db.query<Record<string, unknown>>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier,
			                     title, description, status, priority, labels)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::task_status, $9::task_priority, $10::jsonb)
			 RETURNING *`,
			[
				teamId,
				teamProjectId,
				ceoMemberId,
				taskNumber,
				identifier,
				`Onboard new agent: ${proposal.title}`,
				description,
				TaskStatus.Backlog,
				TaskPriority.High,
				JSON.stringify(['onboarding', 'hire']),
			],
		);
		const task = taskResult.rows[0];

		await db.query(
			`UPDATE approvals SET payload = payload || jsonb_build_object('task_id', $1::text) WHERE id = $2`,
			[task.id, approvalId],
		);
		const finalApprovalResult = await db.query<Record<string, unknown>>(
			'SELECT * FROM approvals WHERE id = $1',
			[approvalId],
		);

		return { task, finalApproval: finalApprovalResult.rows[0] };
	});

	broadcastChange(c, wsRoom.team(teamId), 'approvals', 'INSERT', finalApproval);
	broadcastChange(c, wsRoom.team(teamId), 'tasks', 'INSERT', task);

	// Surface the proposal as a comment on the freshly-created hire ticket so the
	// thread mirrors the admin inbox and flips to hired/denied on resolution.
	await insertHireProposalComment(
		db,
		{
			taskId: task.id as string,
			approvalId: finalApproval.id as string,
			payload: proposal as unknown as Record<string, unknown>,
			teamId,
			projectId: teamProjectId,
		},
		c.get('wsManager'),
	);

	trackBackground(
		createWakeup(db, ceoMemberId, teamId, WakeupSource.Assignment, {
			task_id: task.id as string,
		}).catch((e) => log.error('Failed to wake CEO for hire request:', e)),
	);

	return ok(c, { agent: null, task, approval: finalApproval, bootstrap: false }, 201);
});

agentsRoutes.get('/projects/:projectId/agents/:agentId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
	if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);

	const ts2 = terminalStatusParams(3);
	const result = await db.query(
		`SELECT ${AGENT_BASE_COLUMNS},
			(m.team_id <> $2) AS is_instance,
			EXISTS (SELECT 1 FROM chat_conversations cc WHERE cc.member_id = m.id) AS chat_enabled,
			(SELECT ma2.title FROM member_agents ma2 WHERE ma2.id = ma.reports_to) AS reports_to_title,
			(SELECT count(*) FROM tasks i WHERE i.assignee_id = m.id AND i.status NOT IN (${ts2.placeholders}))::int AS assigned_task_count
		 FROM members m
		 JOIN member_agents ma ON ma.id = m.id
		 WHERE m.id = $1`,
		[agentId, teamId, ...ts2.values],
	);

	const row = result.rows[0];
	if (!row) return err(c, 'NOT_FOUND', 'Agent not found', 404);
	return ok(c, await withAgentIconUrl(c, row as Record<string, unknown>));
});

// Upload (or replace) an agent's avatar. The client normalizes any picked image
// to a square PNG ≤ PROJECT_ICON_MAX_DIMENSION before upload; the server
// re-validates content-type, byte size, and pixel dimensions defensively.
agentsRoutes.put(
	'/projects/:projectId/agents/:agentId/icon',
	bodyLimit({
		maxSize: PROJECT_ICON_MAX_BYTES,
		onError: (c) => err(c, 'TOO_LARGE', 'Image exceeds the size limit', 400),
	}),
	async (c) => {
		const teamId = c.get('teamId') as string;
		const db = c.get('db');
		const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
		if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);

		let form: Awaited<ReturnType<typeof c.req.parseBody>>;
		try {
			form = await c.req.parseBody({ all: false });
		} catch (e) {
			log.error('agent icon parseBody failed:', e);
			return err(c, 'INVALID_REQUEST', 'Malformed upload', 400);
		}
		const file = form.file;
		if (!(file instanceof Blob)) {
			return err(c, 'INVALID_REQUEST', 'Missing file field', 400);
		}

		const contentType = file.type || 'application/octet-stream';
		if (!isAllowedProjectIconStoredMime(contentType)) {
			return err(c, 'INVALID_ATTACHMENT', `Unsupported content type: ${contentType}`, 400);
		}
		if (file.size > PROJECT_ICON_MAX_BYTES) {
			return err(c, 'TOO_LARGE', 'Image exceeds the size limit', 400);
		}

		const buf = Buffer.from(await file.arrayBuffer());
		const dims = readImageDimensions(buf);
		if (!dims) {
			return err(c, 'INVALID_ATTACHMENT', 'Could not read image dimensions', 400);
		}
		if (dims.width > PROJECT_ICON_MAX_DIMENSION || dims.height > PROJECT_ICON_MAX_DIMENSION) {
			return err(
				c,
				'INVALID_ATTACHMENT',
				`Image exceeds ${PROJECT_ICON_MAX_DIMENSION}×${PROJECT_ICON_MAX_DIMENSION} pixels`,
				400,
			);
		}

		const updated = await db.query<{ updated_at: string }>(
			`INSERT INTO agent_icons (member_id, content_type, data, byte_size, width, height, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, now())
			 ON CONFLICT (member_id) DO UPDATE SET
			   content_type = EXCLUDED.content_type,
			   data         = EXCLUDED.data,
			   byte_size    = EXCLUDED.byte_size,
			   width        = EXCLUDED.width,
			   height       = EXCLUDED.height,
			   updated_at   = now()
			 RETURNING updated_at`,
			[agentId, contentType, buf, buf.byteLength, dims.width, dims.height],
		);

		broadcastChange(c, wsRoom.team(teamId), 'member_agents', 'UPDATE', {
			id: agentId,
			team_id: teamId,
		});

		const version = Math.floor(new Date(updated.rows[0].updated_at).getTime() / 1000);
		const iconUrl = await signEntityIconUrl(
			AGENT_ICON_BASE_PATH,
			AGENT_ICON_KEY_PURPOSE,
			agentId,
			c.get('masterKeyManager'),
			version,
		);
		return ok(c, { icon_url: iconUrl, icon_updated_at: updated.rows[0].updated_at });
	},
);

agentsRoutes.delete('/projects/:projectId/agents/:agentId/icon', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
	if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);

	await db.query('DELETE FROM agent_icons WHERE member_id = $1', [agentId]);
	broadcastChange(c, wsRoom.team(teamId), 'member_agents', 'UPDATE', {
		id: agentId,
		team_id: teamId,
	});
	return ok(c, { icon_url: null, icon_updated_at: null });
});

// The agent's long-term chat memory (the compacted history shown on the Chat
// history tab). Only chat-enabled agents — those with a conversation — have one;
// today that is just the CEO.
async function isChatEnabledAgent(db: Db, memberId: string): Promise<boolean> {
	const r = await db.query('SELECT 1 FROM chat_conversations WHERE member_id = $1 LIMIT 1', [
		memberId,
	]);
	return r.rows.length > 0;
}

agentsRoutes.get('/projects/:projectId/agents/:agentId/chat-memory', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
	if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);
	if (!(await isChatEnabledAgent(db, agentId))) {
		return err(c, 'NOT_FOUND', 'Agent has no chat memory', 404);
	}
	const memory = await getChatMemory(db, agentId);
	return ok(c, { content: memory?.content ?? '', updated_at: memory?.updated_at ?? null });
});

agentsRoutes.put('/projects/:projectId/agents/:agentId/chat-memory', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
	if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);
	if (!(await isChatEnabledAgent(db, agentId))) {
		return err(c, 'NOT_FOUND', 'Agent has no chat memory', 404);
	}
	const body = await c.req.json<{ content?: unknown }>().catch(() => ({}) as { content?: unknown });
	if (typeof body.content !== 'string') {
		return err(c, 'INVALID_REQUEST', 'content must be a string', 400);
	}
	const mem = await upsertChatMemory(db, agentId, body.content);
	return ok(c, { content: mem.content, updated_at: mem.updated_at });
});

agentsRoutes.get('/projects/:projectId/agents/:agentId/system-prompt', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
	if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);

	const doc = await getDocument(db, {
		type: DocumentType.AgentSystemPrompt,
		teamId,
		memberAgentId: agentId,
	});
	return ok(c, doc);
});

agentsRoutes.get('/projects/:projectId/agents/:agentId/system-prompt/preview', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
	if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);

	const doc = await getDocument(db, {
		type: DocumentType.AgentSystemPrompt,
		teamId,
		memberAgentId: agentId,
	});
	if (!doc) return err(c, 'NOT_FOUND', 'Agent system prompt not found', 404);

	const resolved = await resolveSystemPrompt(db, doc.content, {
		teamId,
		agentId,
		mode: 'preview',
	});
	return ok(c, { content: resolved });
});

agentsRoutes.post('/projects/:projectId/agents/system-prompts/batch', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const body = await c.req.json<{ items?: unknown }>();
	const raw = body.items;
	if (!Array.isArray(raw)) {
		return err(c, 'INVALID_REQUEST', 'items must be an array', 400);
	}
	if (raw.length === 0) {
		return err(c, 'INVALID_REQUEST', 'items must contain at least one entry', 400);
	}
	if (raw.length > MAX_BATCH_AGENT_SYSTEM_PROMPTS) {
		return err(
			c,
			'INVALID_REQUEST',
			`items array may not exceed ${MAX_BATCH_AGENT_SYSTEM_PROMPTS} entries`,
			400,
		);
	}

	const items = raw as Array<Record<string, unknown>>;
	const results = await Promise.all(
		items.map(async (item, index) => {
			const agentRef = typeof item.agent_id === 'string' ? item.agent_id : '';
			const requestedMode = item.mode;
			const mode: SystemPromptMode =
				typeof requestedMode === 'string' &&
				VALID_PROMPT_MODES.includes(requestedMode as SystemPromptMode)
					? (requestedMode as SystemPromptMode)
					: 'placeholders';

			if (!agentRef) {
				return {
					index,
					ok: false as const,
					agent_id: agentRef,
					error: 'agent_id is required',
				};
			}

			try {
				const out = await fetchAgentSystemPromptForBatch(db, teamId, agentRef, mode);
				return { index, ok: true as const, ...out };
			} catch (e) {
				if (e instanceof AgentSystemPromptError) {
					return { index, ok: false as const, agent_id: agentRef, error: e.message };
				}
				log.error('Unexpected error in system-prompts/batch:', e);
				return {
					index,
					ok: false as const,
					agent_id: agentRef,
					error: e instanceof Error ? e.message : 'internal_error',
				};
			}
		}),
	);

	return ok(c, results);
});

agentsRoutes.get('/projects/:projectId/agents/:agentId/system-prompt/revisions', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
	if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);

	const doc = await getDocument(db, {
		type: DocumentType.AgentSystemPrompt,
		teamId,
		memberAgentId: agentId,
	});
	if (!doc) return err(c, 'NOT_FOUND', 'Agent system prompt not found', 404);

	const revisions = await listRevisions(db, doc.id);
	return ok(c, revisions);
});

agentsRoutes.post('/projects/:projectId/agents/:agentId/system-prompt/restore', async (c) => {
	const teamId = c.get('teamId') as string;

	const auth = c.get('auth');
	if (auth.type === AuthType.Agent) {
		return err(c, 'FORBIDDEN', 'Only the admin can restore revisions', 403);
	}

	const db = c.get('db');
	const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
	if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);

	const body = await c.req.json<{ revision_number: number }>();
	if (typeof body.revision_number !== 'number') {
		return err(c, 'INVALID_REQUEST', 'revision_number is required', 400);
	}

	const doc = await getDocument(db, {
		type: DocumentType.AgentSystemPrompt,
		teamId,
		memberAgentId: agentId,
	});
	if (!doc) return err(c, 'NOT_FOUND', 'Agent system prompt not found', 404);

	const restored = await restoreRevision(db, c.get('wsManager'), {
		documentId: doc.id,
		revisionNumber: body.revision_number,
		restoredByMemberId: null,
		audit: { events: c.get('events'), actorType: actorTypeFromAuth(auth) },
	});
	// 'archived' is unreachable here — only project docs are ever archived — but
	// the union makes that explicit rather than assumed.
	if (restored.status !== 'restored') return err(c, 'NOT_FOUND', 'Revision not found', 404);

	return ok(c, restored.row);
});

agentsRoutes.patch('/projects/:projectId/agents/:agentId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
	if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);

	const body = await c.req.json<{
		title?: string;
		role_description?: string;
		system_prompt?: string;
		system_prompt_change_summary?: string;
		reports_to?: string | null;
		default_effort?: string;
		heartbeat_interval_min?: number;
		run_timeout_min?: number;
		daily_budget_cents?: number;
		weekly_budget_cents?: number;
		monthly_budget_cents?: number;
		touches_code?: boolean;
		mcp_servers?: unknown[];
		model_override_provider?: string | null;
		model_override_model?: string | null;
	}>();

	if (body.default_effort !== undefined && !isAgentEffort(body.default_effort)) {
		return err(c, 'INVALID_REQUEST', `Invalid default_effort: ${body.default_effort}`, 400);
	}

	// Structurally-fixed reporting lines (Captain → CEO, CEO/Coach → admin) are
	// immutable. Reject any PATCH that moves one off its stored value; a no-op
	// resubmission of the current value (as the settings form always sends) passes.
	// The fetched current value is reused below as priorReportsTo.
	let priorReportsTo: string | null | undefined;
	if (body.reports_to !== undefined) {
		const cur = await db.query<{ slug: string; reports_to: string | null }>(
			'SELECT slug, reports_to FROM member_agents WHERE id = $1',
			[agentId],
		);
		priorReportsTo = cur.rows[0]?.reports_to ?? null;
		const slug = cur.rows[0]?.slug;
		if (slug && hasFixedReportsTo(slug) && (body.reports_to ?? null) !== priorReportsTo) {
			return err(
				c,
				'INVALID_REQUEST',
				slug === CAPTAIN_AGENT_SLUG
					? 'The Captain always reports to the CEO; its reporting line cannot be changed'
					: 'This role reports to the admin; its reporting line cannot be changed',
				400,
			);
		}
	}

	// A supplied system prompt must keep the required substitution variables.
	// Instance singletons (CEO/Coach) are exempt — they have no in-team manager,
	// so the {{reports_to}} requirement does not apply to them.
	if (body.system_prompt?.trim()) {
		const agentMeta = await db.query<{ slug: string }>(
			'SELECT slug FROM member_agents WHERE id = $1',
			[agentId],
		);
		const slug = agentMeta.rows[0]?.slug;
		const isInstanceSingleton =
			!!slug && (INSTANCE_AGENT_SLUGS as readonly string[]).includes(slug);
		if (!isInstanceSingleton) {
			const promptError = requiredSystemPromptVarsError(body.system_prompt);
			if (promptError) return err(c, 'INVALID_REQUEST', promptError, 400);
		}
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

	// Budget limits: 0 = unlimited. Validate the *merged* trio (incoming ?? stored)
	// since a PATCH may touch only one window — per-field integer ≥ 0 plus the
	// cross-window consistency rules (shared with the web forms).
	if (
		body.daily_budget_cents !== undefined ||
		body.weekly_budget_cents !== undefined ||
		body.monthly_budget_cents !== undefined
	) {
		const current = await db.query<{
			daily_budget_cents: number;
			weekly_budget_cents: number;
			monthly_budget_cents: number;
		}>(
			`SELECT daily_budget_cents, weekly_budget_cents, monthly_budget_cents
			 FROM member_agents WHERE id = $1`,
			[agentId],
		);
		const stored = current.rows[0];
		const budgetError = budgetWindowsError({
			daily_budget_cents: body.daily_budget_cents ?? stored.daily_budget_cents,
			weekly_budget_cents: body.weekly_budget_cents ?? stored.weekly_budget_cents,
			monthly_budget_cents: body.monthly_budget_cents ?? stored.monthly_budget_cents,
		});
		if (budgetError) {
			return err(c, 'INVALID_REQUEST', budgetError, 400);
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
		{ column: 'run_timeout_min', value: body.run_timeout_min },
		{ column: 'daily_budget_cents', value: body.daily_budget_cents },
		{ column: 'weekly_budget_cents', value: body.weekly_budget_cents },
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
				teamId,
				memberAgentId: agentId,
			},
			content: body.system_prompt,
			changeSummary: body.system_prompt_change_summary ?? 'Manual edit by the admin',
			authorMemberId: null,
			audit: { events: c.get('events'), actorType: actorTypeFromAuth(c.get('auth')) },
		});
	}

	broadcastChange(c, wsRoom.team(teamId), 'member_agents', 'UPDATE', updatedRow);

	const agentName = (updatedRow.title as string) || (updatedRow.slug as string) || 'an agent';

	if (body.system_prompt !== undefined || body.role_description !== undefined) {
		const reason = body.system_prompt !== undefined ? 'prompt_updated' : 'role_updated';
		const detail =
			body.system_prompt !== undefined
				? body.system_prompt_change_summary
					? `Updated ${agentName}'s system prompt: ${body.system_prompt_change_summary}`
					: `Updated ${agentName}'s system prompt.`
				: `Updated ${agentName}'s role description.`;
		trackBackground(
			enqueueTeamCoherenceReviewTask(db, teamId, reason, { changeSummary: detail }).catch((e) =>
				log.error('Failed to enqueue team coherence review on prompt/role change:', e),
			),
		);
	}

	if (body.reports_to !== undefined && (body.reports_to ?? null) !== (priorReportsTo ?? null)) {
		trackBackground(
			enqueueTeamCoherenceReviewTask(db, teamId, 'reports_to_changed', {
				changeSummary: `Reporting line changed for ${agentName}.`,
			}).catch((e) =>
				log.error('Failed to enqueue team coherence review on reports_to change:', e),
			),
		);
	}

	// System-prompt-only edits are audited via the document event from upsertDocument;
	// emit agent.updated for the other settings/profile changes.
	if (sets.length > 0 || body.title?.trim()) {
		const changes = Object.keys(body).filter(
			(k) => k !== 'system_prompt' && k !== 'system_prompt_change_summary',
		);
		const updateActor = await resolveActor(db, c.get('auth'), teamId);
		c.get('events').emit({
			type: 'agent.updated',
			teamId,
			actorType: updateActor.actorType,
			actorMemberId: updateActor.actorMemberId,
			actorApiKeyId: updateActor.actorApiKeyId,
			agentMemberId: agentId,
			changes,
		});
	}

	return ok(c, updatedRow);
});

agentsRoutes.post('/projects/:projectId/agents/:agentId/disable', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
	if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);

	// The HQ instance singletons (CEO/Coach) run all cross-project coordination and
	// review, so the instance can't function without them — they must never be
	// disabled, even by the admin from the web UI. The MCP `set_agent_status` tool
	// already blocks agents from disabling them; this closes the admin/REST path too.
	const meta = await db.query<{ slug: string }>('SELECT slug FROM member_agents WHERE id = $1', [
		agentId,
	]);
	const slug = meta.rows[0]?.slug;
	if (slug && (INSTANCE_AGENT_SLUGS as readonly string[]).includes(slug)) {
		return err(
			c,
			'FORBIDDEN',
			`The ${slug} role is essential to the instance and cannot be disabled`,
			403,
		);
	}

	const actor = await resolveActor(db, c.get('auth'), teamId);
	const result = await setAgentAdminStatus(
		{ db, wsManager: c.get('wsManager'), events: c.get('events') },
		{ teamId, agentId, status: AgentAdminStatus.Disabled, ...actor },
	);
	if (!result.ok && result.reason === 'not_found') {
		return err(c, 'NOT_FOUND', 'Agent not found', 404);
	}
	if (!result.ok && result.reason === 'already_in_state') {
		return err(c, 'INVALID_STATE', 'Agent is already disabled', 409);
	}

	return ok(c, { admin_status: AgentAdminStatus.Disabled });
});

agentsRoutes.post('/projects/:projectId/agents/:agentId/enable', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
	if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);

	const actor = await resolveActor(db, c.get('auth'), teamId);
	const result = await setAgentAdminStatus(
		{ db, wsManager: c.get('wsManager'), events: c.get('events') },
		{ teamId, agentId, status: AgentAdminStatus.Enabled, ...actor },
	);
	if (!result.ok && result.reason === 'not_found') {
		return err(c, 'NOT_FOUND', 'Agent not found', 404);
	}
	if (!result.ok && result.reason === 'already_in_state') {
		return err(c, 'INVALID_STATE', 'Agent is already enabled', 409);
	}

	return ok(c, { admin_status: AgentAdminStatus.Enabled });
});

agentsRoutes.get('/projects/:projectId/org-chart', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const ORG_COLUMNS = `m.id, ma.title, ma.slug, ma.role_description, ma.runtime_status, ma.admin_status, ma.reports_to,
     (SELECT ai.updated_at FROM agent_icons ai WHERE ai.member_id = m.id) AS icon_updated_at`;
	const result = await db.query(
		`SELECT ${ORG_COLUMNS}
     FROM members m
     JOIN member_agents ma ON ma.id = m.id
     WHERE m.team_id = $1`,
		[teamId],
	);

	type OrgAgentRow = {
		id: string;
		title: string;
		slug: string;
		role_description: string;
		runtime_status: string;
		admin_status: string;
		reports_to: string | null;
		icon_updated_at: string | null;
		icon_url?: string | null;
	};
	const agents = result.rows as OrgAgentRow[];
	// Sign each node's avatar URL (null when the agent has no icon).
	for (const a of agents) a.icon_url = await signAgentIcon(c, a.id, a.icon_updated_at);
	type AgentNode = OrgAgentRow & { children: AgentNode[] };
	const byId = new Map<string, AgentNode>(
		agents.map((a) => [a.id, { ...a, children: [] as AgentNode[] }]),
	);

	// The instance CEO manages every team's Captain but lives in HQ, so the
	// team-scoped query above never returns it (except when this project *is* HQ,
	// where it is already a member). Pull it in so the chart renders the real
	// reporting line CEO → Captain → … instead of a headless Captain at the root.
	const ceoResult = await db.query(
		`SELECT ${ORG_COLUMNS}
     FROM members m
     JOIN member_agents ma ON ma.id = m.id
     WHERE ma.slug = $1
     LIMIT 1`,
		[CEO_AGENT_SLUG],
	);
	const ceoRow = ceoResult.rows[0] as OrgAgentRow | undefined;
	if (ceoRow && !byId.has(ceoRow.id)) {
		ceoRow.icon_url = await signAgentIcon(c, ceoRow.id, ceoRow.icon_updated_at);
		byId.set(ceoRow.id, { ...ceoRow, children: [] });
	}

	// The CEO works across every project, so its global runtime_status may read
	// 'active' because of a run in another team. Scope the "running" indicator to
	// the current team: show active only when the CEO has an in-flight run *here*.
	// Its global budget-pause / disabled states are left untouched.
	const ceoNode = ceoRow ? byId.get(ceoRow.id) : undefined;
	if (ceoNode && !isBudgetPauseStatus(ceoNode.runtime_status)) {
		const runningHere = await db.query(
			`SELECT 1 FROM heartbeat_runs
       WHERE member_id = $1 AND team_id = $2
         AND status IN ($3::heartbeat_run_status, $4::heartbeat_run_status)
       LIMIT 1`,
			[ceoNode.id, teamId, HeartbeatRunStatus.Running, HeartbeatRunStatus.Queued],
		);
		ceoNode.runtime_status =
			runningHere.rows.length > 0 ? AgentRuntimeStatus.Active : AgentRuntimeStatus.Idle;
	}

	const roots: AgentNode[] = [];
	for (const agent of byId.values()) {
		if (agent.reports_to && byId.has(agent.reports_to)) {
			byId.get(agent.reports_to)?.children.push(agent);
		} else {
			roots.push(agent);
		}
	}

	return ok(c, { admin: { children: roots } });
});

agentsRoutes.get('/projects/:projectId/agents/:agentId/heartbeat-runs', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
	if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);

	const { page, perPage, offset } = parsePagination(c);
	const countResult = await db.query<{ total: number }>(
		`SELECT count(*)::int AS total FROM heartbeat_runs hr WHERE hr.member_id = $1`,
		[agentId],
	);
	const total = countResult.rows[0]?.total ?? 0;
	const result = await db.query(
		`SELECT ${HEARTBEAT_RUN_COLUMNS_WITH_LOG_LENGTH}
		 FROM heartbeat_runs hr
		 LEFT JOIN tasks i ON i.id = hr.task_id
		 LEFT JOIN projects p ON p.id = i.project_id
		 ${HEARTBEAT_RUN_TRIGGER_JOINS}
		 WHERE hr.member_id = $1
		 ORDER BY hr.started_at DESC
		 LIMIT $2 OFFSET $3`,
		[agentId, perPage, offset],
	);

	return c.json({ data: result.rows, meta: buildMeta(page, perPage, total) });
});

agentsRoutes.get('/projects/:projectId/agents/:agentId/heartbeat-runs/:runId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
	if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);
	const runId = c.req.param('runId');

	const result = await db.query(
		`SELECT ${HEARTBEAT_RUN_COLUMNS_WITH_LOG}
		 FROM heartbeat_runs hr
		 LEFT JOIN tasks i ON i.id = hr.task_id
		 LEFT JOIN projects p ON p.id = i.project_id
		 ${HEARTBEAT_RUN_TRIGGER_JOINS}
		 WHERE hr.id = $1 AND hr.member_id = $2`,
		[runId, agentId],
	);

	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'Run not found', 404);
	return ok(c, result.rows[0]);
});

agentsRoutes.post(
	'/projects/:projectId/agents/:agentId/heartbeat-runs/:runId/terminate',
	async (c) => {
		const teamId = c.get('teamId') as string;
		const db = c.get('db');
		const agentId = await resolveAgentId(db, teamId, c.req.param('agentId'));
		if (!agentId) return err(c, 'NOT_FOUND', 'Agent not found', 404);
		const runId = c.req.param('runId');

		const existing = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1 AND team_id = $2 AND member_id = $3',
			[runId, teamId, agentId],
		);
		if (existing.rows.length === 0) return err(c, 'NOT_FOUND', 'Run not found', 404);
		const currentStatus = existing.rows[0].status;
		if (currentStatus !== 'queued' && currentStatus !== 'running') {
			return err(c, 'CONFLICT', `Run is already ${currentStatus} and cannot be terminated`, 409);
		}

		const actorMemberId = await resolveActorMemberId(db, c.get('auth'), teamId);
		const result = await terminateHeartbeatRun(
			{ db, wsManager: c.get('wsManager'), jobManager: c.get('jobManager') },
			runId,
			'Terminated by user',
			actorMemberId,
		);

		const refreshed = await db.query<Record<string, unknown>>(
			`SELECT ${HEARTBEAT_RUN_COLUMNS_WITH_LOG}
		 FROM heartbeat_runs hr
		 LEFT JOIN tasks i ON i.id = hr.task_id
		 LEFT JOIN projects p ON p.id = i.project_id
		 ${HEARTBEAT_RUN_TRIGGER_JOINS}
		 WHERE hr.id = $1 AND hr.member_id = $2`,
			[runId, agentId],
		);
		const row = refreshed.rows[0] ?? {};
		return ok(c, { ...row, terminated: result.terminated });
	},
);

// Public signed-URL read endpoint for an agent avatar. Rendered in an `<img>`
// tag, which can't carry a bearer token, so the HMAC `sig` query param is the
// credential. Must be mounted before the `/api/*` auth middleware.
export const publicAgentsRoutes = new Hono<Env>();

publicAgentsRoutes.get('/api/agents/:agentId/icon', async (c) => {
	const agentId = c.req.param('agentId');
	const expRaw = c.req.query('exp');
	const sig = c.req.query('sig');
	if (!expRaw || !sig) {
		return err(c, 'UNAUTHORIZED', 'Missing signature', 401);
	}
	const exp = Number.parseInt(expRaw, 10);
	const masterKeyManager = c.get('masterKeyManager');
	const valid = await verifyEntityIconUrl(
		AGENT_ICON_KEY_PURPOSE,
		agentId,
		exp,
		sig,
		masterKeyManager,
	);
	if (!valid) {
		return err(c, 'UNAUTHORIZED', 'Invalid or expired signature', 401);
	}

	const row = await c.get('db').query<{
		content_type: string;
		data: Uint8Array;
		updated_at: string;
	}>('SELECT content_type, data, updated_at FROM agent_icons WHERE member_id = $1', [agentId]);
	if (row.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Icon not found', 404);
	}
	const { content_type, data, updated_at } = row.rows[0];
	const src = data instanceof Uint8Array ? data : new Uint8Array(data);
	// Copy into a fresh ArrayBuffer so the body type is Uint8Array<ArrayBuffer>
	// (PGlite hands back a Uint8Array<ArrayBufferLike>).
	const ab = new ArrayBuffer(src.byteLength);
	new Uint8Array(ab).set(src);

	return c.body(new Uint8Array(ab), 200, {
		'Content-Type': content_type,
		'Content-Length': String(src.byteLength),
		'Cache-Control': 'private, max-age=3600',
		ETag: `"${new Date(updated_at).getTime()}"`,
	});
});
