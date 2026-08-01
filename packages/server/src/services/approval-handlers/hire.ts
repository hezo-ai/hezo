import {
	AgentAdminStatus,
	ApprovalStatus,
	DEFAULT_HEARTBEAT_INTERVAL_MIN,
	DocumentType,
	MemberType,
} from '@hezo/shared';
import { trackBackground } from '../../lib/background';
import { resolveAgentId } from '../../lib/resolve';
import { logger } from '../../logger';
import { enqueueTeamCoherenceReviewTask } from '../description-tasks';
import { upsertDocument } from '../documents';
import { resolveHireProposalCommentAndWake } from '../hire-proposal-comment';
import type { ApprovalHandler, ApprovalSideEffectCtx, SideEffectBroadcast } from './types';

const log = logger.child('approval-handlers:hire');

/**
 * Materialise an approved agent hire: member + agent rows, system prompt, then flip
 * the proposal comment to "hired" and re-wake the requester. Denial flips the comment
 * to "denied" and re-wakes too. Neither path closes the originating ticket — the
 * requester does that once the team is set up.
 */
export const hireHandler: ApprovalHandler = {
	async applyApproved(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]> {
		const { db, approval, payload, wsManager } = ctx;
		const broadcasts: SideEffectBroadcast[] = [];

		const teamId = approval.team_id as string;
		const title = (payload.title as string)?.trim();
		const slug = payload.slug as string;
		if (!title || !slug) {
			throw new Error('hire approval payload missing title/slug');
		}

		const slugCheck = await db.query(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = $2`,
			[teamId, slug],
		);
		if (slugCheck.rows.length > 0) {
			throw new Error(`cannot materialise hire: slug '${slug}' already exists in this team`);
		}

		const memberResult = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, $2, $3) RETURNING id`,
			[teamId, MemberType.Agent, title],
		);
		const memberId = memberResult.rows[0].id;

		// The payload stores the manager as a slug (or id); resolve it to a member
		// id now. Null when absent or no longer resolvable (manager retired between
		// proposal and approval) — the agent is created unmanaged rather than failing.
		const reportsToRaw = (payload.reports_to as string | null) ?? null;
		const reportsToId = reportsToRaw ? await resolveAgentId(db, teamId, reportsToRaw) : null;

		await db.query(
			`INSERT INTO member_agents (id, title, slug, role_description, reports_to,
			                            default_effort, heartbeat_interval_min,
			                            daily_budget_cents, weekly_budget_cents, monthly_budget_cents,
			                            touches_code, admin_status)
			 VALUES ($1, $2, $3, $4, $5, $6::agent_effort, $7, $8, $9, $10, $11, $12::agent_admin_status)`,
			[
				memberId,
				title,
				slug,
				(payload.role_description as string) ?? '',
				reportsToId,
				(payload.default_effort as string) ?? 'medium',
				(payload.heartbeat_interval_min as number) ?? DEFAULT_HEARTBEAT_INTERVAL_MIN,
				(payload.daily_budget_cents as number) ?? 0,
				(payload.weekly_budget_cents as number) ?? 0,
				(payload.monthly_budget_cents as number) ?? 3000,
				(payload.touches_code as boolean) ?? false,
				AgentAdminStatus.Enabled,
			],
		);

		const promptDoc = await upsertDocument(db, undefined, {
			scope: {
				type: DocumentType.AgentSystemPrompt,
				teamId,
				memberAgentId: memberId,
			},
			content: (payload.system_prompt as string) ?? '',
			changeSummary: 'Initial system prompt',
			authorMemberId: (approval.requested_by_member_id as string) ?? null,
		});
		broadcasts.push({
			table: 'documents',
			op: 'INSERT',
			row: promptDoc.row as unknown as Record<string, unknown>,
		});

		const newAgent = await db.query<Record<string, unknown>>(
			`SELECT m.id, m.team_id, m.display_name, m.created_at,
			        ma.agent_type_id, ma.title, ma.slug, ma.role_description, ma.summary,
			        ma.default_effort, ma.heartbeat_interval_min,
			        ma.daily_budget_cents, ma.weekly_budget_cents, ma.monthly_budget_cents,
			        ma.touches_code, ma.runtime_status, ma.admin_status,
			        ma.last_heartbeat_at, ma.reports_to, ma.mcp_servers, ma.updated_at
			 FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1`,
			[memberId],
		);
		if (newAgent.rows[0]) {
			broadcasts.push({ table: 'member_agents', op: 'INSERT', row: newAgent.rows[0] });
		}

		trackBackground(
			enqueueTeamCoherenceReviewTask(db, teamId, 'agent_hired').catch((e) =>
				log.error('Failed to enqueue team coherence review after hire:', e),
			),
		);

		// Flip the proposal comment on the originating ticket to "hired" and re-wake
		// the requester (the CEO) so it can review the new hire and resume setup. The
		// ticket is intentionally left open — the requester closes it once the team is
		// fully set up, rather than the approval auto-closing it prematurely.
		await resolveHireProposalCommentAndWake(
			db,
			{ approval, status: ApprovalStatus.Approved, memberAgentSlug: slug },
			wsManager,
		);

		return broadcasts;
	},

	async applyDenied(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]> {
		const { db, approval, resolutionNote, wsManager } = ctx;
		// Flip the proposal comment to "denied" and re-wake the requester so it can
		// react (revise and re-propose, or drop the role).
		await resolveHireProposalCommentAndWake(
			db,
			{ approval, status: ApprovalStatus.Denied, resolutionNote },
			wsManager,
		);
		return [];
	},
};
