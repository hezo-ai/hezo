import type { PGlite } from '@electric-sql/pglite';
import { AgentAdminStatus, IssueStatus, WakeupSource } from '@hezo/shared';
import { logger } from '../logger';
import { createWakeup } from './wakeup';

const log = logger.child('automation');

/**
 * Trigger automations when an issue's status changes.
 * Called from both the REST handler and MCP tool to ensure consistent behavior.
 *
 * Currently the only hard-coded automation:
 * - Done → wake the Coach agent for post-completion review
 */
export async function triggerStatusAutomations(
	db: PGlite,
	companyId: string,
	issueId: string,
	newStatus: string,
): Promise<void> {
	if (newStatus === IssueStatus.Done) {
		const coach = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.company_id = $1 AND ma.slug = 'coach'
			   AND ma.admin_status = $2::agent_admin_status
			 LIMIT 1`,
			[companyId, AgentAdminStatus.Enabled],
		);
		if (coach.rows.length > 0) {
			createWakeup(db, coach.rows[0].id, companyId, WakeupSource.Automation, {
				issue_id: issueId,
				trigger: 'issue_done',
			}).catch((e) => log.error('Failed to wake Coach:', e));
		}
	}
}
