import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	CAPTAIN_AGENT_SLUG,
	COACH_AGENT_SLUG,
	CommentContentType,
	TaskStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { trackBackground } from '../lib/background';
import { broadcastRowChange } from '../lib/broadcast';
import { recomputeDownstreamReadiness } from '../lib/dependencies';
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
	wsManager?: WebSocketManager,
): Promise<void> {
	await recordStatusChange(db, teamId, taskId, oldStatus, newStatus, actorMemberId, wsManager);

	try {
		await recomputeDownstreamReadiness(db, teamId, taskId, actorMemberId, wsManager);
	} catch (e) {
		log.error('Failed to recompute downstream readiness:', e);
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
