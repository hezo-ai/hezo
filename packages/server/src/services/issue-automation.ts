import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	CEO_AGENT_SLUG,
	COACH_AGENT_SLUG,
	CommentContentType,
	IssueStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { broadcastRowChange } from '../lib/broadcast';
import { logger } from '../logger';
import { recordStatusChange } from './issue-events';
import { OAUTH_VERIFICATION_LABEL } from './oauth-verification-tasks';
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
	companyId: string,
	issueId: string,
	wsManager?: WebSocketManager,
): Promise<void> {
	const result = await db.query<{
		parent_issue_id: string | null;
		labels: unknown;
		description: string;
	}>(
		`SELECT parent_issue_id, labels, description FROM issues
		 WHERE id = $1 AND company_id = $2`,
		[issueId, companyId],
	);
	const row = result.rows[0];
	if (!row?.parent_issue_id) return;

	const labels = Array.isArray(row.labels) ? row.labels : [];
	if (!labels.includes(OAUTH_VERIFICATION_LABEL)) return;

	const markerMatch = row.description.match(OAUTH_MARKER_RE);
	const platform = markerMatch ? markerMatch[1] : 'external';

	const ceo = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.company_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[companyId, AgentAdminStatus.Enabled, CEO_AGENT_SLUG],
	);
	const ceoId = ceo.rows[0]?.id ?? null;

	const text = `${platformDisplayName(platform)} connector is set up and verified. You can resume work here.`;
	const commentResult = await db.query<Record<string, unknown>>(
		`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
		 RETURNING *`,
		[row.parent_issue_id, ceoId, CommentContentType.Text, JSON.stringify({ text })],
	);

	if (wsManager && commentResult.rows[0]) {
		broadcastRowChange(
			wsManager,
			wsRoom.company(companyId),
			'issue_comments',
			'INSERT',
			commentResult.rows[0],
		);
	}

	if (ceoId) {
		try {
			await createWakeup(db, ceoId, companyId, WakeupSource.Automation, {
				issue_id: row.parent_issue_id,
				trigger: 'oauth_verified',
			});
		} catch (e) {
			log.error('Failed to wake CEO on OAuth verification completion:', e);
		}
	}
}

/**
 * Trigger automations when an issue's status changes.
 * Called from both the REST handler and MCP tool to ensure consistent behavior.
 */
export async function triggerStatusAutomations(
	db: PGlite,
	companyId: string,
	issueId: string,
	oldStatus: string,
	newStatus: string,
	actorMemberId: string | null,
	wsManager?: WebSocketManager,
): Promise<void> {
	await recordStatusChange(db, companyId, issueId, oldStatus, newStatus, actorMemberId, wsManager);

	if (newStatus === IssueStatus.Done) {
		const coach = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.company_id = $1 AND ma.slug = $3
			   AND ma.admin_status = $2::agent_admin_status
			 LIMIT 1`,
			[companyId, AgentAdminStatus.Enabled, COACH_AGENT_SLUG],
		);
		if (coach.rows.length > 0) {
			createWakeup(db, coach.rows[0].id, companyId, WakeupSource.Automation, {
				issue_id: issueId,
				trigger: 'issue_done',
			}).catch((e) => log.error('Failed to wake Coach:', e));
		}

		try {
			await notifyParentOfOAuthVerification(db, companyId, issueId, wsManager);
		} catch (e) {
			log.error('Failed to notify parent of OAuth verification:', e);
		}
	}
}
