import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	CAPTAIN_AGENT_SLUG,
	COACH_AGENT_SLUG,
	CommentContentType,
	TaskStatus,
	TERMINAL_TASK_STATUSES,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { trackBackground } from '../lib/background';
import { broadcastRowChange } from '../lib/broadcast';
import { recomputeDownstreamReadiness } from '../lib/dependencies';
import { assertChildrenAllClosed } from '../lib/task-relationships';
import { logger } from '../logger';
import { OAUTH_VERIFICATION_LABEL } from './oauth-verification-tasks';
import { recordStatusChange } from './task-events';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('automation');

const OAUTH_MARKER_RE = /oauth-verify platform=([a-z0-9_-]+)/;

function platformDisplayName(platform: string): string {
	const map: Record<string, string> = {
		github: 'GitHub',
		gmail: 'Gmail',
		gitlab: 'GitLab',
		stripe: 'Stripe',
		posthog: 'PostHog',
		railway: 'Railway',
		vercel: 'Vercel',
		digitalocean: 'DigitalOcean',
		x: 'X',
		anthropic: 'Anthropic',
		openai: 'OpenAI',
		google: 'Google',
	};
	return map[platform] ?? platform;
}

async function notifyParentOfOAuthVerification(
	db: PGlite,
	teamId: string,
	taskId: string,
	wsManager?: WebSocketManager,
): Promise<void> {
	const result = await db.query<{
		parent_task_id: string | null;
		labels: unknown;
		description: string;
	}>(
		`SELECT parent_task_id, labels, description FROM tasks
		 WHERE id = $1 AND team_id = $2`,
		[taskId, teamId],
	);
	const row = result.rows[0];
	if (!row?.parent_task_id) return;

	const labels = Array.isArray(row.labels) ? row.labels : [];
	if (!labels.includes(OAUTH_VERIFICATION_LABEL)) return;

	const markerMatch = row.description.match(OAUTH_MARKER_RE);
	const platform = markerMatch ? markerMatch[1] : 'external';

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[teamId, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG],
	);
	const captainId = captain.rows[0]?.id ?? null;

	const text = `${platformDisplayName(platform)} connector is set up and verified. You can resume work here.`;
	const commentResult = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
		 RETURNING *`,
		[row.parent_task_id, captainId, CommentContentType.Text, JSON.stringify({ text })],
	);

	if (wsManager && commentResult.rows[0]) {
		broadcastRowChange(
			wsManager,
			wsRoom.team(teamId),
			'task_comments',
			'INSERT',
			commentResult.rows[0],
		);
	}

	if (captainId) {
		try {
			await createWakeup(db, captainId, teamId, WakeupSource.Automation, {
				task_id: row.parent_task_id,
				trigger: 'oauth_verified',
			});
		} catch (e) {
			log.error('Failed to wake Captain on OAuth verification completion:', e);
		}
	}
}

/**
 * Wake the parent task's assigned agent when the transitioning sub-task
 * pushes the parent past its child-closure gate. Mirrors the blocked-by
 * cascade in `recomputeDownstreamReadiness` but walks the parent edge.
 * The idempotency key collapses sibling closes that land near-simultaneously
 * into a single queued wakeup; the dispatch-time `assignmentWakeupAlreadyServed`
 * guard suppresses runs that already covered this state.
 */
async function wakeParentIfChildrenClosed(
	db: PGlite,
	teamId: string,
	taskId: string,
): Promise<void> {
	const parentRow = await db.query<{ parent_task_id: string | null }>(
		'SELECT parent_task_id FROM tasks WHERE id = $1 AND team_id = $2',
		[taskId, teamId],
	);
	const parentTaskId = parentRow.rows[0]?.parent_task_id;
	if (!parentTaskId) return;

	const childrenCheck = await assertChildrenAllClosed(db, teamId, parentTaskId);
	if (!childrenCheck.ok) return;

	const parent = await db.query<{ assignee_id: string | null; team_id: string }>(
		'SELECT assignee_id, team_id FROM tasks WHERE id = $1',
		[parentTaskId],
	);
	const parentInfo = parent.rows[0];
	if (!parentInfo?.assignee_id) return;

	const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [
		parentInfo.assignee_id,
	]);
	if (isAgent.rows.length === 0) return;

	await createWakeup(
		db,
		parentInfo.assignee_id,
		parentInfo.team_id,
		WakeupSource.Assignment,
		{ task_id: parentTaskId, reason: 'children_closed' },
		`children-closed:${parentTaskId}`,
	);
}

/**
 * Trigger automations when an task's status changes.
 * Called from both the REST handler and MCP tool to ensure consistent behavior.
 */
export async function triggerStatusAutomations(
	db: PGlite,
	teamId: string,
	taskId: string,
	oldStatus: string,
	newStatus: string,
	actorMemberId: string | null,
	actorApiKeyId: string | null,
	wsManager?: WebSocketManager,
): Promise<void> {
	await recordStatusChange(
		db,
		teamId,
		taskId,
		oldStatus,
		newStatus,
		actorMemberId,
		actorApiKeyId,
		wsManager,
	);

	// Downstream blocker state only flips when this task crosses the
	// terminal boundary. Same-bucket transitions (e.g. done → cancelled,
	// or backlog → in_progress at run start) leave every downstream's
	// blocker count unchanged, so skip the recompute — otherwise it fires
	// a redundant `wakeIfReady` that queues a duplicate assignment wakeup
	// behind the current run.
	const oldTerminal = (TERMINAL_TASK_STATUSES as readonly string[]).includes(oldStatus);
	const newTerminal = (TERMINAL_TASK_STATUSES as readonly string[]).includes(newStatus);
	if (oldTerminal !== newTerminal) {
		try {
			await recomputeDownstreamReadiness(db, teamId, taskId, actorMemberId, wsManager);
		} catch (e) {
			log.error('Failed to recompute downstream readiness:', e);
		}
	}

	if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(newStatus)) {
		try {
			await wakeParentIfChildrenClosed(db, teamId, taskId);
		} catch (e) {
			log.error('Failed to wake parent on child closure:', e);
		}
	}

	if (newStatus === TaskStatus.Done) {
		// The Coach is a single instance-level agent. It reviews completed work in
		// every project; the wakeup carries the completed task's team so the Coach
		// runs scoped to that project (see the run-team split in agent-runner).
		const coach = await db.query<{ id: string }>(
			`SELECT id FROM member_agents
			 WHERE slug = $2 AND admin_status = $1::agent_admin_status
			 LIMIT 1`,
			[AgentAdminStatus.Enabled, COACH_AGENT_SLUG],
		);
		if (coach.rows.length > 0) {
			trackBackground(
				createWakeup(db, coach.rows[0].id, teamId, WakeupSource.Automation, {
					task_id: taskId,
					trigger: 'task_done',
				}).catch((e) => log.error('Failed to wake Coach:', e)),
			);
		}

		try {
			await notifyParentOfOAuthVerification(db, teamId, taskId, wsManager);
		} catch (e) {
			log.error('Failed to notify parent of OAuth verification:', e);
		}
	}
}
