import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	CEO_AGENT_SLUG,
	IssuePriority,
	IssueStatus,
	OPERATIONS_PROJECT_SLUG,
	TERMINAL_ISSUE_STATUSES,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { logger } from '../logger';
import { createWakeup } from './wakeup';

const log = logger.child('description-tasks');

const DESCRIPTION_LABEL = 'description-update';
const TEAM_TARGET = 'team';

export type AgentSummaryReason = 'created' | 'prompt_updated' | 'role_updated';
export type TeamSummaryReason =
	| 'agent_added'
	| 'agent_removed'
	| 'prompt_updated'
	| 'enabled_changed';

interface CompanyContext {
	ceoMemberId: string | null;
	operationsProjectId: string | null;
	issuePrefix: string;
}

async function loadCompanyContext(db: PGlite, companyId: string): Promise<CompanyContext | null> {
	const ceo = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.company_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[companyId, AgentAdminStatus.Enabled, CEO_AGENT_SLUG],
	);

	const ops = await db.query<{ id: string }>(
		`SELECT id FROM projects
		 WHERE company_id = $1 AND is_internal = true AND slug = $2
		 LIMIT 1`,
		[companyId, OPERATIONS_PROJECT_SLUG],
	);

	const company = await db.query<{ issue_prefix: string }>(
		'SELECT issue_prefix FROM companies WHERE id = $1',
		[companyId],
	);

	if (company.rows.length === 0) return null;

	return {
		ceoMemberId: ceo.rows[0]?.id ?? null,
		operationsProjectId: ops.rows[0]?.id ?? null,
		issuePrefix: company.rows[0].issue_prefix,
	};
}

async function findOpenDescriptionIssue(
	db: PGlite,
	companyId: string,
	target: string,
): Promise<string | null> {
	const placeholders = TERMINAL_ISSUE_STATUSES.map((_, i) => `$${i + 3}::issue_status`).join(', ');
	const result = await db.query<{ id: string }>(
		`SELECT id FROM issues
		 WHERE company_id = $1
		   AND labels @> $2::jsonb
		   AND status NOT IN (${placeholders})
		   AND description LIKE '%target=' || $${TERMINAL_ISSUE_STATUSES.length + 3} || '%'
		 LIMIT 1`,
		[companyId, JSON.stringify([DESCRIPTION_LABEL]), ...TERMINAL_ISSUE_STATUSES, target],
	);
	return result.rows[0]?.id ?? null;
}

async function createDescriptionIssue(
	db: PGlite,
	companyId: string,
	ctx: CompanyContext,
	target: string,
	title: string,
	body: string,
): Promise<string | null> {
	if (!ctx.ceoMemberId || !ctx.operationsProjectId) return null;

	const numberResult = await db.query<{ number: number }>(
		'SELECT next_issue_number($1) AS number',
		[companyId],
	);
	const issueNumber = numberResult.rows[0].number;
	const identifier = `${ctx.issuePrefix}-${issueNumber}`;

	// Embed `target=...` in the description so dedup queries can find it without
	// adding a separate column or jsonb payload field.
	const description = `<!-- target=${target} -->\n\n${body}`;

	const insertResult = await db.query<{ id: string }>(
		`INSERT INTO issues (company_id, project_id, assignee_id, number, identifier,
		                     title, description, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::issue_status, $9::issue_priority, $10::jsonb)
		 RETURNING id`,
		[
			companyId,
			ctx.operationsProjectId,
			ctx.ceoMemberId,
			issueNumber,
			identifier,
			title,
			description,
			IssueStatus.Open,
			IssuePriority.Low,
			JSON.stringify(['internal', DESCRIPTION_LABEL]),
		],
	);

	const issueId = insertResult.rows[0].id;

	try {
		await createWakeup(db, ctx.ceoMemberId, companyId, WakeupSource.Assignment, {
			issue_id: issueId,
		});
	} catch (e) {
		log.error('Failed to wake CEO for description task:', e);
	}

	return issueId;
}

function buildAgentSummaryBody(
	agentId: string,
	agentTitle: string,
	reason: AgentSummaryReason,
): string {
	return `## Description maintenance task

Regenerate the human-readable summary for the agent "${agentTitle}" (reason: ${reason}).

**Steps**

1. Use \`get_agent_system_prompt(company_id, agent_id="${agentId}")\` to read the current prompt.
2. Distill it into a single plain-prose paragraph, no longer than five lines, describing what the agent does and how it works. Third person. No bullet lists. No greetings.
3. Call \`set_agent_summary(company_id, agent_id="${agentId}", summary="...")\` to save.
4. Then read the prompts of every enabled agent in the company via \`get_agent_system_prompt\` and synthesise an updated team summary describing reporting structure, handoffs, and escalation paths. Up to twenty lines, plain prose.
5. Call \`set_team_summary(company_id, summary="...")\` to save.
6. Move this issue to "done".`;
}

function buildTeamSummaryBody(reason: TeamSummaryReason): string {
	return `## Description maintenance task

Regenerate the team-collaboration summary for this company (reason: ${reason}).

**Steps**

1. Read the prompts of every enabled agent in the company via \`get_agent_system_prompt\`.
2. Synthesise a team summary describing reporting structure, handoffs, and escalation paths. Up to twenty lines, plain prose. May span multiple paragraphs.
3. Call \`set_team_summary(company_id, summary="...")\` to save.
4. Move this issue to "done".`;
}

export async function enqueueAgentSummaryTask(
	db: PGlite,
	companyId: string,
	agentId: string,
	reason: AgentSummaryReason,
): Promise<string | null> {
	const ctx = await loadCompanyContext(db, companyId);
	if (!ctx) return null;
	if (!ctx.ceoMemberId || !ctx.operationsProjectId) return null;

	const target = wsRoom.agent(agentId);
	const existing = await findOpenDescriptionIssue(db, companyId, target);
	if (existing) {
		log.debug(`Skipping duplicate agent summary task for ${agentId}; open issue ${existing}`);
		return existing;
	}

	const agentResult = await db.query<{ title: string }>(
		'SELECT title FROM member_agents WHERE id = $1',
		[agentId],
	);
	const agentTitle = agentResult.rows[0]?.title ?? 'Unknown agent';

	const body = buildAgentSummaryBody(agentId, agentTitle, reason);
	return createDescriptionIssue(
		db,
		companyId,
		ctx,
		target,
		`Update description for "${agentTitle}"`,
		body,
	);
}

export async function enqueueTeamSummaryTask(
	db: PGlite,
	companyId: string,
	reason: TeamSummaryReason,
): Promise<string | null> {
	const ctx = await loadCompanyContext(db, companyId);
	if (!ctx) return null;
	if (!ctx.ceoMemberId || !ctx.operationsProjectId) return null;

	const target = TEAM_TARGET;
	const existing = await findOpenDescriptionIssue(db, companyId, target);
	if (existing) {
		log.debug(`Skipping duplicate team summary task; open issue ${existing}`);
		return existing;
	}

	const body = buildTeamSummaryBody(reason);
	return createDescriptionIssue(db, companyId, ctx, target, 'Update team description', body);
}
