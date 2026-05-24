import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	CAPTAIN_AGENT_SLUG,
	OPERATIONS_PROJECT_SLUG,
	TaskPriority,
	TaskStatus,
	TERMINAL_TASK_STATUSES,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { allocateTaskIdentifier } from '../lib/task-identifier';
import { logger } from '../logger';
import { createWakeup } from './wakeup';

const log = logger.child('description-tasks');

const DESCRIPTION_LABEL = 'description-update';
const COHERENCE_LABEL = 'team-coherence-review';
const TEAM_TARGET = 'team';
const TEAM_COHERENCE_TARGET = 'team_coherence';

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
export type TeamCoherenceReviewReason =
	| 'template_applied'
	| 'agent_hired'
	| 'agent_removed'
	| 'reports_to_changed';

const TEAM_CONTEXT_TARGET_PREFIX = 'team_context:';

interface TeamContext {
	captainMemberId: string | null;
	operationsProjectId: string | null;
}

async function loadTeamContext(db: PGlite, teamId: string): Promise<TeamContext | null> {
	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[teamId, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG],
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
		captainMemberId: captain.rows[0]?.id ?? null,
		operationsProjectId: ops.rows[0]?.id ?? null,
	};
}

async function findOpenLabeledTaskByTarget(
	db: PGlite,
	teamId: string,
	label: string,
	target: string,
): Promise<string | null> {
	const placeholders = TERMINAL_TASK_STATUSES.map((_, i) => `$${i + 3}::task_status`).join(', ');
	const result = await db.query<{ id: string }>(
		`SELECT id FROM tasks
		 WHERE team_id = $1
		   AND labels @> $2::jsonb
		   AND status NOT IN (${placeholders})
		   AND description LIKE '%target=' || $${TERMINAL_TASK_STATUSES.length + 3} || '%'
		 LIMIT 1`,
		[teamId, JSON.stringify([label]), ...TERMINAL_TASK_STATUSES, target],
	);
	return result.rows[0]?.id ?? null;
}

async function findOpenDescriptionTask(
	db: PGlite,
	teamId: string,
	target: string,
): Promise<string | null> {
	return findOpenLabeledTaskByTarget(db, teamId, DESCRIPTION_LABEL, target);
}

async function createLabeledOperationsTask(
	db: PGlite,
	teamId: string,
	ctx: TeamContext,
	target: string,
	title: string,
	body: string,
	label: string,
	priority: TaskPriority,
): Promise<string | null> {
	if (!ctx.captainMemberId || !ctx.operationsProjectId) return null;

	const { number: taskNumber, identifier } = await allocateTaskIdentifier(
		db,
		ctx.operationsProjectId,
	);

	const description = `<!-- target=${target} -->\n\n${body}`;

	const insertResult = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier,
		                     title, description, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::task_status, $9::task_priority, $10::jsonb)
		 RETURNING id`,
		[
			teamId,
			ctx.operationsProjectId,
			ctx.captainMemberId,
			taskNumber,
			identifier,
			title,
			description,
			TaskStatus.Backlog,
			priority,
			JSON.stringify(['internal', label]),
		],
	);

	const taskId = insertResult.rows[0].id;

	try {
		await createWakeup(db, ctx.captainMemberId, teamId, WakeupSource.Assignment, {
			task_id: taskId,
		});
	} catch (e) {
		log.error(`Failed to wake Captain for ${label}:`, e);
	}

	return taskId;
}

async function createDescriptionTask(
	db: PGlite,
	teamId: string,
	ctx: TeamContext,
	target: string,
	title: string,
	body: string,
): Promise<string | null> {
	return createLabeledOperationsTask(
		db,
		teamId,
		ctx,
		target,
		title,
		body,
		DESCRIPTION_LABEL,
		TaskPriority.Low,
	);
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
6. Move this task to "done".`;
}

function buildTeamSummaryBody(reason: TeamSummaryReason): string {
	return `## Description maintenance task

Regenerate the team-collaboration summary for this team (reason: ${reason}).

**Steps**

1. Read the prompts of every enabled agent in the team via \`get_agent_system_prompt\`.
2. Synthesise a team summary describing reporting structure, handoffs, and escalation paths. Up to twenty lines, plain prose. May span multiple paragraphs.
3. Call \`set_team_summary(team_id, summary="...")\` to save.
4. Move this task to "done".`;
}

export async function enqueueAgentSummaryTask(
	db: PGlite,
	teamId: string,
	agentId: string,
	reason: AgentSummaryReason,
): Promise<string | null> {
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) return null;
	if (!ctx.captainMemberId || !ctx.operationsProjectId) return null;

	const target = wsRoom.agent(agentId);
	const existing = await findOpenDescriptionTask(db, teamId, target);
	if (existing) {
		log.debug(`Skipping duplicate agent summary task for ${agentId}; open task ${existing}`);
		return existing;
	}

	const agentResult = await db.query<{ title: string }>(
		'SELECT title FROM member_agents WHERE id = $1',
		[agentId],
	);
	const agentTitle = agentResult.rows[0]?.title ?? 'Unknown agent';

	const body = buildAgentSummaryBody(agentId, agentTitle, reason);
	return createDescriptionTask(
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
	if (!ctx.captainMemberId || !ctx.operationsProjectId) return null;

	const target = TEAM_TARGET;
	const existing = await findOpenDescriptionTask(db, teamId, target);
	if (existing) {
		log.debug(`Skipping duplicate team summary task; open task ${existing}`);
		return existing;
	}

	const body = buildTeamSummaryBody(reason);
	return createDescriptionTask(db, teamId, ctx, target, 'Update team description', body);
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
6. Move this task to "done".`;
}

export async function enqueueAgentTeamContextTask(
	db: PGlite,
	teamId: string,
	agentId: string,
	reason: AgentTeamContextReason,
): Promise<string | null> {
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) return null;
	if (!ctx.captainMemberId || !ctx.operationsProjectId) return null;

	const target = `${TEAM_CONTEXT_TARGET_PREFIX}${agentId}`;
	const existing = await findOpenDescriptionTask(db, teamId, target);
	if (existing) {
		log.debug(`Skipping duplicate agent team_context task for ${agentId}; open task ${existing}`);
		return existing;
	}

	const agentResult = await db.query<{ title: string }>(
		'SELECT title FROM member_agents WHERE id = $1',
		[agentId],
	);
	const agentTitle = agentResult.rows[0]?.title ?? 'Unknown agent';

	const body = buildAgentTeamContextBody(agentId, agentTitle, reason);
	return createDescriptionTask(
		db,
		teamId,
		ctx,
		target,
		`Update team relationships for "${agentTitle}"`,
		body,
	);
}

function buildTeamCoherenceReviewBody(reason: TeamCoherenceReviewReason): string {
	return `## Team coherence review

The team roster changed (reason: ${reason}). Review the team to make sure everyone fits together and reports to the right place.

**Steps**

1. Call \`list_agents(team_id)\` to enumerate every enabled agent and their \`reports_to\` relationships.
2. For each agent, call \`get_agent_system_prompt(team_id, agent_id=...)\` to read its current system prompt.
3. Identify problems:
   - **Orphans** — agents with no manager who should report to someone (only you and the Coach legitimately report to the board).
   - **Cycles** — reports_to chains that loop.
   - **Stale prompts** — system prompts that describe a manager, peer, or report that no longer matches the actual team structure.
   - **Coverage gaps** — responsibilities the team is expected to own but no agent describes itself as covering.
   - **Conflicts** — two agents claiming the same responsibility with no division of work.
4. Reconcile what you can:
   - Use \`update_agent_system_prompt(agent_id, content)\` to rewrite a prompt so it matches the current team structure.
   - Use \`set_agent_team_context(agent_id, content)\` to refresh an agent's relationships narrative if needed.
   - Use \`set_agent_summary(agent_id, summary)\` and \`set_team_summary(summary)\` after substantive changes.
5. For changes you cannot make through MCP tools (re-parenting an agent, removing an agent, hiring a new role), post a single summary comment on this ticket explaining what should change and request board confirmation.
6. Move this task to **done** once the team is coherent.`;
}

export async function enqueueTeamCoherenceReviewTask(
	db: PGlite,
	teamId: string,
	reason: TeamCoherenceReviewReason,
): Promise<string | null> {
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) return null;
	if (!ctx.captainMemberId || !ctx.operationsProjectId) return null;

	const existing = await findOpenLabeledTaskByTarget(
		db,
		teamId,
		COHERENCE_LABEL,
		TEAM_COHERENCE_TARGET,
	);
	if (existing) {
		log.debug(`Skipping duplicate team coherence review; open task ${existing}`);
		return existing;
	}

	const body = buildTeamCoherenceReviewBody(reason);
	return createLabeledOperationsTask(
		db,
		teamId,
		ctx,
		TEAM_COHERENCE_TARGET,
		'Review team coherence after roster change',
		body,
		COHERENCE_LABEL,
		TaskPriority.High,
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
