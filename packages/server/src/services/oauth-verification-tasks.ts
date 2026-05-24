import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	CAPTAIN_AGENT_SLUG,
	CommentContentType,
	INTERNAL_PROJECT_SLUG,
	type PlatformType,
	TaskPriority,
	TaskStatus,
	TERMINAL_TASK_STATUSES,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { broadcastRowChange } from '../lib/broadcast';
import { allocateTaskIdentifier } from '../lib/task-identifier';
import { logger } from '../logger';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('oauth-verification-tasks');

export const OAUTH_VERIFICATION_LABEL = 'oauth-verification';

interface TeamContext {
	captainMemberId: string;
	internalProjectId: string;
}

async function loadTeamContext(db: PGlite, teamId: string): Promise<TeamContext | null> {
	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[teamId, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG],
	);
	const internalProject = await db.query<{ id: string }>(
		`SELECT id FROM projects
		 WHERE team_id = $1 AND is_internal = true AND slug = $2
		 LIMIT 1`,
		[teamId, INTERNAL_PROJECT_SLUG],
	);
	if (!captain.rows[0] || !internalProject.rows[0]) return null;
	return {
		captainMemberId: captain.rows[0].id,
		internalProjectId: internalProject.rows[0].id,
	};
}

function platformDisplayName(platform: PlatformType): string {
	const map: Record<PlatformType, string> = {
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

function buildVerificationBody(
	platform: PlatformType,
	metadata: Record<string, unknown>,
	originatingTaskIdentifier: string | null,
): string {
	const name = platformDisplayName(platform);
	const metadataBlock =
		Object.keys(metadata).length > 0
			? `\n**Connector metadata**\n\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n`
			: '';
	const parentRef = originatingTaskIdentifier
		? `\nThis ticket was created because ${originatingTaskIdentifier} requested ${name} access. When you move this ticket to **done**, the system will post a confirmation comment on ${originatingTaskIdentifier} automatically.\n`
		: `\nThis ticket was opened because a human connected a ${name} account from team settings. There is no originating ticket to notify.\n`;

	return `<!-- oauth-verify platform=${platform} -->

## Verify the ${name} connector

A human has just completed the ${name} OAuth flow for this team. Confirm the connection works end-to-end before marking this ticket done.
${parentRef}${metadataBlock}
**Steps**

1. Use the appropriate tool to exercise the ${name} connector (for GitHub, list the connected user's orgs; for other platforms use the equivalent smoke-test call).
2. If the call succeeds and returns the expected data, post a brief confirmation comment here and move the ticket to **done**.
3. If the call fails or additional human configuration is required (e.g. org approval, scopes mismatch, webhook setup), open a Q&A comment here describing exactly what the human needs to do. The human will follow up in this ticket.
4. Once everything works, move the ticket to **done** — the system will notify the originating ticket.`;
}

export interface EnqueueResult {
	taskId: string;
	identifier: string;
	created: boolean;
}

export async function enqueueOAuthVerificationTask(
	db: PGlite,
	teamId: string,
	platform: PlatformType,
	originatingTaskId: string | null,
	metadata: Record<string, unknown>,
	wsManager?: WebSocketManager,
): Promise<EnqueueResult | null> {
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) {
		log.warn(
			`Cannot enqueue OAuth verification task; missing Captain or Internal project for ${teamId}`,
		);
		return null;
	}

	const terminalPlaceholders = TERMINAL_TASK_STATUSES.map((_, i) => `$${i + 3}::task_status`).join(
		', ',
	);
	const marker = `oauth-verify platform=${platform}`;
	const existing = await db.query<{ id: string; identifier: string }>(
		`SELECT id, identifier FROM tasks
		 WHERE team_id = $1
		   AND labels @> $2::jsonb
		   AND status NOT IN (${terminalPlaceholders})
		   AND description LIKE '%${marker}%'
		 LIMIT 1`,
		[teamId, JSON.stringify([OAUTH_VERIFICATION_LABEL]), ...TERMINAL_TASK_STATUSES],
	);

	if (existing.rows[0]) {
		const existingId = existing.rows[0].id;
		await db.query(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, $2::comment_content_type, $3::jsonb)`,
			[
				existingId,
				CommentContentType.System,
				JSON.stringify({
					text: `A new ${platformDisplayName(platform)} OAuth flow completed. Re-verify the connector.`,
				}),
			],
		);
		try {
			await createWakeup(db, ctx.captainMemberId, teamId, WakeupSource.Comment, {
				task_id: existingId,
			});
		} catch (e) {
			log.error('Failed to wake Captain for repeat OAuth verification:', e);
		}
		return { taskId: existingId, identifier: existing.rows[0].identifier, created: false };
	}

	let parentIdentifier: string | null = null;
	if (originatingTaskId) {
		const parent = await db.query<{ identifier: string; team_id: string }>(
			'SELECT identifier, team_id FROM tasks WHERE id = $1',
			[originatingTaskId],
		);
		if (parent.rows[0] && parent.rows[0].team_id === teamId) {
			parentIdentifier = parent.rows[0].identifier;
		}
	}

	const { number: taskNumber, identifier } = await allocateTaskIdentifier(
		db,
		ctx.internalProjectId,
	);

	const title = `Verify ${platformDisplayName(platform)} connector`;
	const description = buildVerificationBody(platform, metadata, parentIdentifier);

	const insertResult = await db.query<Record<string, unknown>>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, parent_task_id, number, identifier,
		                     title, description, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::task_status, $10::task_priority, $11::jsonb)
		 RETURNING *`,
		[
			teamId,
			ctx.internalProjectId,
			ctx.captainMemberId,
			parentIdentifier ? originatingTaskId : null,
			taskNumber,
			identifier,
			title,
			description,
			TaskStatus.Backlog,
			TaskPriority.High,
			JSON.stringify(['internal', OAUTH_VERIFICATION_LABEL]),
		],
	);
	const task = insertResult.rows[0];
	const taskId = task.id as string;

	if (wsManager) {
		broadcastRowChange(wsManager, wsRoom.team(teamId), 'tasks', 'INSERT', task);
	}

	try {
		await createWakeup(db, ctx.captainMemberId, teamId, WakeupSource.Assignment, {
			task_id: taskId,
		});
	} catch (e) {
		log.error('Failed to wake Captain for OAuth verification task:', e);
	}

	return { taskId, identifier, created: true };
}
