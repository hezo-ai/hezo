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
import { allocateIssueIdentifier } from '../lib/issue-identifier';
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
	| 'enabled_changed'
	| 'reports_to_changed';
export type AgentTeamContextReason =
	| 'initial'
	| 'agent_added'
	| 'agent_removed'
	| 'reports_to_changed'
	| 'prompt_updated'
	| 'summary_updated';

const TEAM_CONTEXT_TARGET_PREFIX = 'team_context:';

interface TeamContext {
	ceoMemberId: string | null;
	operationsProjectId: string | null;
}

async function loadTeamContext(db: PGlite, teamId: string): Promise<TeamContext | null> {
	const ceo = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[teamId, AgentAdminStatus.Enabled, CEO_AGENT_SLUG],
	);

	const ops = await db.query<{ id: string }>(
		`SELECT id FROM projects
		 WHERE team_id = $1 AND is_internal = true AND slug = $2
		 LIMIT 1`,
		[teamId, OPERATIONS_PROJECT_SLUG],
	);

	const teamExists = await db.query('SELECT 1 FROM teams WHERE id = $1', [teamId]);
	if (teamExists.rows.length === 0) return null;

	return {
		ceoMemberId: ceo.rows[0]?.id ?? null,
		operationsProjectId: ops.rows[0]?.id ?? null,
	};
}

async function findOpenDescriptionIssue(
	db: PGlite,
	teamId: string,
	target: string,
): Promise<string | null> {
	const placeholders = TERMINAL_ISSUE_STATUSES.map((_, i) => `$${i + 3}::issue_status`).join(', ');
	const result = await db.query<{ id: string }>(
		`SELECT id FROM issues
		 WHERE team_id = $1
		   AND labels @> $2::jsonb
		   AND status NOT IN (${placeholders})
		   AND description LIKE '%target=' || $${TERMINAL_ISSUE_STATUSES.length + 3} || '%'
		 LIMIT 1`,
		[teamId, JSON.stringify([DESCRIPTION_LABEL]), ...TERMINAL_ISSUE_STATUSES, target],
	);
	return result.rows[0]?.id ?? null;
}

async function createDescriptionIssue(
	db: PGlite,
	teamId: string,
	ctx: TeamContext,
	target: string,
	title: string,
	body: string,
): Promise<string | null> {
	if (!ctx.ceoMemberId || !ctx.operationsProjectId) return null;

	const { number: issueNumber, identifier } = await allocateIssueIdentifier(
		db,
		ctx.operationsProjectId,
	);

	// Embed `target=...` in the description so dedup queries can find it without
	// adding a separate column or jsonb payload field.
	const description = `<!-- target=${target} -->\n\n${body}`;

	const insertResult = await db.query<{ id: string }>(
		`INSERT INTO issues (team_id, project_id, assignee_id, number, identifier,
		                     title, description, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::issue_status, $9::issue_priority, $10::jsonb)
		 RETURNING id`,
		[
			teamId,
			ctx.operationsProjectId,
			ctx.ceoMemberId,
			issueNumber,
			identifier,
			title,
			description,
			IssueStatus.Backlog,
			IssuePriority.Low,
			JSON.stringify(['internal', DESCRIPTION_LABEL]),
		],
	);

	const issueId = insertResult.rows[0].id;

	try {
		await createWakeup(db, ctx.ceoMemberId, teamId, WakeupSource.Assignment, {
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

1. Use \`get_agent_system_prompt(team_id, agent_id="${agentId}")\` to read the current prompt.
2. Distill it into a single plain-prose paragraph, no longer than five lines, describing what the agent does and how it works. Third person. No bullet lists. No greetings.
3. Call \`set_agent_summary(team_id, agent_id="${agentId}", summary="...")\` to save.
4. Then read the prompts of every enabled agent in the team via \`get_agent_system_prompt\` and synthesise an updated team summary describing reporting structure, handoffs, and escalation paths. Up to twenty lines, plain prose.
5. Call \`set_team_summary(team_id, summary="...")\` to save.
6. Move this issue to "done".`;
}

function buildTeamSummaryBody(reason: TeamSummaryReason): string {
	return `## Description maintenance task

Regenerate the team-collaboration summary for this team (reason: ${reason}).

**Steps**

1. Read the prompts of every enabled agent in the team via \`get_agent_system_prompt\`.
2. Synthesise a team summary describing reporting structure, handoffs, and escalation paths. Up to twenty lines, plain prose. May span multiple paragraphs.
3. Call \`set_team_summary(team_id, summary="...")\` to save.
4. Move this issue to "done".`;
}

export async function enqueueAgentSummaryTask(
	db: PGlite,
	teamId: string,
	agentId: string,
	reason: AgentSummaryReason,
): Promise<string | null> {
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) return null;
	if (!ctx.ceoMemberId || !ctx.operationsProjectId) return null;

	const target = wsRoom.agent(agentId);
	const existing = await findOpenDescriptionIssue(db, teamId, target);
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
		teamId,
		ctx,
		target,
		`Update description for "${agentTitle}"`,
		body,
	);
}

export async function enqueueTeamSummaryTask(
	db: PGlite,
	teamId: string,
	reason: TeamSummaryReason,
): Promise<string | null> {
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) return null;
	if (!ctx.ceoMemberId || !ctx.operationsProjectId) return null;

	const target = TEAM_TARGET;
	const existing = await findOpenDescriptionIssue(db, teamId, target);
	if (existing) {
		log.debug(`Skipping duplicate team summary task; open issue ${existing}`);
		return existing;
	}

	const body = buildTeamSummaryBody(reason);
	return createDescriptionIssue(db, teamId, ctx, target, 'Update team description', body);
}

function buildAgentTeamContextBody(
	agentId: string,
	agentTitle: string,
	reason: AgentTeamContextReason,
): string {
	return `## Description maintenance task

Regenerate the team-relationships context for "${agentTitle}" (reason: ${reason}).

This blob is injected into the agent's own system prompt at the start of every run so it doesn't need to derive its place in the org chart from scratch. It should describe how *this specific agent* relates to every other employee in the team.

**Steps**

1. Use \`list_agents(team_id)\` to enumerate all enabled agents and their reporting structure.
2. For each agent that relates to "${agentTitle}" (manager, direct reports, peers, indirect reports), read their \`summary\` (or \`get_agent_system_prompt\` if the summary is empty) to understand what they do.
3. Identify any humans on the team board.
4. Write a relationships narrative for "${agentTitle}" in plain prose, second-person ("you"), up to ~30 lines. Cover:
   - Manager and how to escalate to them
   - Direct reports (if any) and how to delegate to each
   - Peers and typical handoff patterns
   - Indirect reports / agents two+ levels away and the correct routing path
   - Humans on the board and when to involve them
5. Call \`set_agent_team_context(team_id, agent_id="${agentId}", content="...")\` to save.
6. Move this issue to "done".`;
}

export async function enqueueAgentTeamContextTask(
	db: PGlite,
	teamId: string,
	agentId: string,
	reason: AgentTeamContextReason,
): Promise<string | null> {
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) return null;
	if (!ctx.ceoMemberId || !ctx.operationsProjectId) return null;

	const target = `${TEAM_CONTEXT_TARGET_PREFIX}${agentId}`;
	const existing = await findOpenDescriptionIssue(db, teamId, target);
	if (existing) {
		log.debug(`Skipping duplicate agent team_context task for ${agentId}; open issue ${existing}`);
		return existing;
	}

	const agentResult = await db.query<{ title: string }>(
		'SELECT title FROM member_agents WHERE id = $1',
		[agentId],
	);
	const agentTitle = agentResult.rows[0]?.title ?? 'Unknown agent';

	const body = buildAgentTeamContextBody(agentId, agentTitle, reason);
	return createDescriptionIssue(
		db,
		teamId,
		ctx,
		target,
		`Update team relationships for "${agentTitle}"`,
		body,
	);
}

export async function enqueueTeamContextTaskForAllAgents(
	db: PGlite,
	teamId: string,
	reason: AgentTeamContextReason,
	exceptAgentId?: string,
): Promise<void> {
	// On 'initial' fan-outs we only want agents that don't already have a
	// precomputed default team_context (built-in templates ship with them).
	// Other reasons signal an actual structural change, so we regenerate
	// regardless of current content.
	const skipNonEmpty = reason === 'initial';

	const agents = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1
		   AND ma.admin_status = $2::agent_admin_status
		   AND ($3::uuid IS NULL OR ma.id <> $3::uuid)
		   AND ($4::bool = false OR ma.team_context = '')`,
		[teamId, AgentAdminStatus.Enabled, exceptAgentId ?? null, skipNonEmpty],
	);

	for (const { id } of agents.rows) {
		try {
			await enqueueAgentTeamContextTask(db, teamId, id, reason);
		} catch (e) {
			log.error(`Failed to enqueue team_context task for agent ${id}:`, e);
		}
	}
}
